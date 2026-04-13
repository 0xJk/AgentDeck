#if os(macOS)
// ApmeOutcome.swift — Swift port of bridge/src/apme/outcome.ts.
//
// Detects what happened with each run (committed / iterated / abandoned /
// exploratory / interrupted), computes an efficiency snapshot, and rolls
// everything into a composite score.
//
// Phase 1 sandbox constraints:
//   - No `git` subprocess calls — `countDiffLines` and post-session HEAD
//     checks are unavailable. All diff-dependent efficiency metrics return
//     nil, and code-category git detection degrades to "trust whatever was
//     captured at session_end via gitBefore/gitAfter fields".
//   - A/B sibling detection still works (pure sqlite lookup against listRuns).
//
// The non-code branch (conversation / planning / research / review) is the
// critical path — response captured → outcome=committed, composite built from
// turn_judge overall score when available. This is the feature that drove
// porting APME to macOS in the first place.

import Foundation

// MARK: - Types

enum ApmeOutcome: String {
    case committed      // positive — code committed or non-code response delivered
    case abandoned      // no commit + no follow-up within threshold
    case iterated       // follow-up session on same project
    case abWinner       = "ab_winner"
    case abLoser        = "ab_loser"
    case interrupted    // very short session, likely Ctrl+C
    case exploratory    // short, few tools, no changes — neutral
    case pending        // not enough time to judge yet
}

enum ApmeConfidence: String {
    case high, medium, low
}

struct ApmeOutcomeResult {
    let outcome: ApmeOutcome
    let confidence: ApmeConfidence
    let reason: String
}

struct ApmeEfficiencyMetrics: Codable {
    var tokensPerChange: Int?
    var costPerChange: Double?
    var timeToCompleteSec: Int?
    var toolEfficiency: Double?
    var diffLines: Int?
}

struct ApmeCompositeBreakdown {
    let outcomeScore: Double
    let outcomeWeight: Double
    let judgeScore: Double?
    let judgeWeight: Double
    let efficiencyScore: Double?
    let efficiencyWeight: Double
    let vibeScore: Double?
    let vibeWeight: Double
    let composite: Double
}

enum ApmeOutcomeEngine {
    private static let outcomeScores: [ApmeOutcome: Double] = [
        .committed: 1.0,
        .abWinner: 1.0,
        .iterated: 0.6,
        .exploratory: 0.5,
        .pending: 0.5,
        .interrupted: 0.3,
        .abandoned: 0.2,
        .abLoser: 0.1,
    ]

    private static let nonCodeCategories: Set<String> = [
        "conversation", "planning", "research", "review",
    ]

    // MARK: - Outcome detection

    static func detectOutcome(store: ApmeStore, run: ApmeRun) -> ApmeOutcomeResult {
        guard let endedAt = run.endedAt else {
            return ApmeOutcomeResult(outcome: .pending, confidence: .low, reason: "run still in progress")
        }
        let durationSec = Double(endedAt - run.startedAt) / 1000.0

        // Non-code categories: response completion = success (no git needed)
        if let cat = run.taskCategory, nonCodeCategories.contains(cat) {
            let turns = store.listTurns(runId: run.id)
            if !turns.isEmpty {
                return ApmeOutcomeResult(
                    outcome: .committed,
                    confidence: .high,
                    reason: "\(cat) session completed — \(turns.count) turn(s)"
                )
            }
            if durationSec < 10 {
                return ApmeOutcomeResult(
                    outcome: .interrupted,
                    confidence: .medium,
                    reason: "very short \(cat) session (\(Int(durationSec))s)"
                )
            }
            return ApmeOutcomeResult(
                outcome: .exploratory,
                confidence: .low,
                reason: "\(cat) session with no captured turns"
            )
        }

        // Code category: trust what was captured at session_end.
        // Sandbox prevents live git lookups (runner.ts does execSync here).
        if let before = run.gitBefore, let after = run.gitAfter, before != after {
            let reason = "committed — git \(before.prefix(7))→\(after.prefix(7))"
            let confidence: ApmeConfidence = durationSec < 120 ? .high : .high
            return ApmeOutcomeResult(outcome: .committed, confidence: confidence, reason: reason)
        }

        // A/B sibling detection (pure sqlite — no subprocess).
        // Written out as an explicit loop because SourceKit's type-checker
        // struggles with 5-clause Optional-heavy filter closures.
        let recent = store.listRuns(limit: 20)
        var siblings: [ApmeRun] = []
        for r in recent {
            if r.id == run.id { continue }
            if r.projectName != run.projectName { continue }
            if r.endedAt == nil { continue }
            if abs(r.startedAt - run.startedAt) >= 30 * 60 * 1000 { continue }
            if r.modelId == run.modelId { continue }  // same model → not A/B
            siblings.append(r)
        }
        if !siblings.isEmpty {
            let anyCommitted = siblings.contains { s in
                if let b = s.gitBefore, let a = s.gitAfter, b != a { return true }
                return false
            }
            if anyCommitted {
                let winnerModel = siblings.first(where: {
                    ($0.gitBefore ?? "") != ($0.gitAfter ?? "")
                })?.modelId ?? "unknown"
                return ApmeOutcomeResult(
                    outcome: .abLoser,
                    confidence: .medium,
                    reason: "A/B test — sibling \(winnerModel) was committed instead"
                )
            }
        }

        // Iteration — same project, new session soon after this one ended.
        var followUps: [ApmeRun] = []
        for r in recent {
            if r.id == run.id { continue }
            if r.projectName != run.projectName { continue }
            if r.startedAt <= endedAt { continue }
            if r.startedAt - endedAt >= 10 * 60 * 1000 { continue }
            followUps.append(r)
        }
        if let first = followUps.first {
            let gapSec = (first.startedAt - endedAt) / 1000
            return ApmeOutcomeResult(
                outcome: .iterated,
                confidence: .medium,
                reason: "follow-up session \(gapSec)s later"
            )
        }

        // Very short session → interrupted or exploratory
        let steps = store.listSteps(runId: run.id)
        let toolCalls = steps.filter { $0.kind == "PreToolUse" || $0.kind == "tool_start" }.count
        if durationSec < 30 && toolCalls <= 1 {
            return ApmeOutcomeResult(
                outcome: .interrupted,
                confidence: .low,
                reason: "very short session (\(Int(durationSec))s, \(toolCalls) tools)"
            )
        }
        if durationSec < 120 && toolCalls <= 3 {
            return ApmeOutcomeResult(
                outcome: .exploratory,
                confidence: .low,
                reason: "short session (\(Int(durationSec))s, \(toolCalls) tools) — likely exploration"
            )
        }

        // Long session with no commit → abandoned
        if durationSec > 300 {
            return ApmeOutcomeResult(
                outcome: .abandoned,
                confidence: .medium,
                reason: "\(Int(durationSec / 60))min session with no commit"
            )
        }
        return ApmeOutcomeResult(
            outcome: .exploratory,
            confidence: .low,
            reason: "\(Int(durationSec))s session, \(toolCalls) tools, no commit"
        )
    }

    // MARK: - Efficiency

    /// Phase 1: no git subprocess, so diffLines + tokensPerChange + costPerChange
    /// are always nil for sandboxed code runs. timeToCompleteSec is always
    /// available from the run row. Matches outcome.ts shape for JSON parity.
    static func computeEfficiency(run: ApmeRun) -> ApmeEfficiencyMetrics {
        var m = ApmeEfficiencyMetrics()
        if let endedAt = run.endedAt {
            m.timeToCompleteSec = (endedAt - run.startedAt) / 1000
        }
        // diffLines / tokensPerChange / costPerChange / toolEfficiency all nil —
        // degrade gracefully.
        return m
    }

    // MARK: - Composite

    /// Weighted composite: outcome (0.4) + judge (0.3) + efficiency (0.2) + vibe (0.1).
    /// Only present axes contribute — `totalWeight` is the sum of axes that
    /// have values, so missing axes don't drag the score down.
    static func computeComposite(
        store: ApmeStore,
        run: ApmeRun,
        outcomeResult: ApmeOutcomeResult,
        efficiency: ApmeEfficiencyMetrics
    ) -> ApmeCompositeBreakdown {
        let outcomeScore = outcomeScores[outcomeResult.outcome] ?? 0.5
        let outcomeWeight = 0.4

        // LLM judge overall
        let evals = store.listEvalsForRun(run.id)
        let judgeOverall = evals.first(where: { $0.layer == "llm_judge" && $0.metric == "overall" })
        let judgeScore = judgeOverall?.score
        let judgeWeight = 0.3

        // Efficiency — normalize tokens_per_change via sigmoid.
        // Phase 1 almost always returns nil (no git), so this axis rarely contributes.
        let medianTpc = 200.0
        var efficiencyScore: Double? = nil
        if let tpc = efficiency.tokensPerChange, tpc > 0 {
            let raw = 1.0 / (1.0 + Double(tpc) / medianTpc)
            efficiencyScore = (raw * 100).rounded() / 100
        }
        let efficiencyWeight = 0.2

        // Vibe feedback
        var vibeScore: Double? = nil
        if let v = store.latestVibeForRun(run.id) {
            vibeScore = v.verdict == "approve" ? 1.0 : (v.verdict == "reject" ? 0.0 : 0.5)
        }
        let vibeWeight = 0.1

        var sum = outcomeScore * outcomeWeight
        var totalWeight = outcomeWeight
        if let s = judgeScore { sum += s * judgeWeight; totalWeight += judgeWeight }
        if let s = efficiencyScore { sum += s * efficiencyWeight; totalWeight += efficiencyWeight }
        if let s = vibeScore { sum += s * vibeWeight; totalWeight += vibeWeight }

        let composite = totalWeight > 0 ? ((sum / totalWeight) * 100).rounded() / 100 : 0.5

        return ApmeCompositeBreakdown(
            outcomeScore: outcomeScore, outcomeWeight: outcomeWeight,
            judgeScore: judgeScore, judgeWeight: judgeWeight,
            efficiencyScore: efficiencyScore, efficiencyWeight: efficiencyWeight,
            vibeScore: vibeScore, vibeWeight: vibeWeight,
            composite: composite
        )
    }

    // MARK: - Full pass

    /// Run outcome detection + efficiency + composite scoring on a single run
    /// and persist the results. Called from the 30s daemon loop.
    @discardableResult
    static func evaluateOutcome(store: ApmeStore, runId: String) -> (
        outcome: ApmeOutcomeResult,
        efficiency: ApmeEfficiencyMetrics,
        composite: ApmeCompositeBreakdown
    )? {
        guard let run = store.getRun(id: runId), run.endedAt != nil else { return nil }
        let outcome = detectOutcome(store: store, run: run)
        let efficiency = computeEfficiency(run: run)
        let composite = computeComposite(store: store, run: run, outcomeResult: outcome, efficiency: efficiency)

        var efficiencyJson: String? = nil
        if let data = try? JSONEncoder().encode(efficiency),
           let s = String(data: data, encoding: .utf8) {
            efficiencyJson = s
        }
        store.updateRun(id: runId, fields: [
            "outcome": outcome.outcome.rawValue,
            "outcomeConfidence": outcome.confidence.rawValue,
            "efficiencyJson": efficiencyJson,
            "compositeScore": composite.composite,
        ])
        DaemonLogger.shared.debug(
            "APME",
            "outcome \(runId.prefix(8)): \(outcome.outcome.rawValue)(\(outcome.confidence.rawValue)) composite=\(composite.composite)"
        )
        return (outcome, efficiency, composite)
    }

    /// Lightweight composite re-computation after judge evals are inserted.
    /// Persisted outcome + efficiency are reused; only the composite changes.
    static func recomputeComposite(store: ApmeStore, runId: String) {
        guard let run = store.getRun(id: runId),
              let outcomeRaw = run.outcome,
              let outcomeKind = ApmeOutcome(rawValue: outcomeRaw),
              let efficiencyJson = run.efficiencyJson
        else { return }
        let confidence = run.outcomeConfidence.flatMap(ApmeConfidence.init(rawValue:)) ?? .low
        let outcome = ApmeOutcomeResult(outcome: outcomeKind, confidence: confidence, reason: "")
        let efficiency: ApmeEfficiencyMetrics = (try? JSONDecoder().decode(
            ApmeEfficiencyMetrics.self,
            from: efficiencyJson.data(using: .utf8) ?? Data()
        )) ?? ApmeEfficiencyMetrics()
        let composite = computeComposite(
            store: store, run: run,
            outcomeResult: outcome, efficiency: efficiency
        )
        store.updateRun(id: runId, fields: ["compositeScore": composite.composite])
        DaemonLogger.shared.debug("APME", "recomputeComposite \(runId.prefix(8)): \(composite.composite)")
    }
}
#endif
