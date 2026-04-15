#if os(macOS)
// ApmeTuner.swift — Rubric auto-tuner (OPRO-style).
//
// Swift port of bridge/src/apme/tuner.ts. Closes the improvement loop
// between deterministic signals, the LLM judge, and user vibe feedback.
//
// Algorithm (unchanged from TS):
//   1. Collect recent runs + evals + vibe verdicts.
//   2. Flag disagreement samples:
//        - tests pass AND judge < 0.5 → false negative
//        - tests fail AND judge > 0.8 → false positive
//        - vibe rejected AND judge > 0.7
//        - vibe approved AND judge < 0.5
//   3. Compute baseline correlation(judge.overall, vibe).
//   4. Ask the configured judge backend to propose a new rubric.
//   5. Shadow-score the disagreements under the proposed rubric.
//   6. Accept only if correlation improves by ≥0.05.
//
// Cost posture: tuning uses whatever judge backend the user picked. On
// the default (Foundation Models) backend it's free; on MLX it's free;
// on API it costs Anthropic credits so tuning is rate-limited to one
// pass per daemon tick via `shouldRetune`.

import Foundation

// MARK: - Public types

struct ApmeDisagreementSample {
    let runId: String
    let taskPrompt: String
    let judgeOverall: Double?
    let testsPass: Double?
    let vibe: String?   // "approve", "reject", "neutral", or nil
    let note: String
}

struct ApmeTuneOutcome {
    let accepted: Bool
    let reason: String
    let baselineCorrelation: Double?
    let proposedCorrelation: Double?
    let newVersion: Int?
}

struct ApmeRubricProposal {
    let prompt: String
    let weights: [String: Double]
    let notes: String?
}

// MARK: - Tuner

enum ApmeTuner {
    /// Run one tuning pass. Returns the new rubric version if accepted.
    /// Call site: the daemon 30s loop, gated by `shouldRetune`.
    static func tune(store: ApmeStore) async -> ApmeTuneOutcome {
        guard store.isOpen else {
            return ApmeTuneOutcome(
                accepted: false, reason: "store disabled",
                baselineCorrelation: nil, proposedCorrelation: nil, newVersion: nil
            )
        }
        let cfg = ApmeSettings.load()
        guard cfg.autoTune else {
            return ApmeTuneOutcome(
                accepted: false, reason: "autoTune disabled",
                baselineCorrelation: nil, proposedCorrelation: nil, newVersion: nil
            )
        }

        let samples = collectDisagreements(store: store, limit: 30)
        guard samples.count >= 3 else {
            return ApmeTuneOutcome(
                accepted: false, reason: "insufficient samples (\(samples.count)/3)",
                baselineCorrelation: nil, proposedCorrelation: nil, newVersion: nil
            )
        }

        guard let rubric = store.getCurrentRubric(purpose: "general"),
              let rubricPrompt = rubric["prompt"] as? String,
              let rubricWeights = rubric["weights"] as? String,
              let rubricVersion = rubric["version"] as? Int
        else {
            return ApmeTuneOutcome(
                accepted: false, reason: "no base rubric",
                baselineCorrelation: nil, proposedCorrelation: nil, newVersion: nil
            )
        }

        let baseline = vibeCorrelation(samples: samples)
        DaemonLogger.shared.debug(
            "APME",
            "tune baseline correlation=\(baseline.map { String($0) } ?? "n/a") samples=\(samples.count)"
        )

        // Ask the judge to propose a new rubric.
        let metaPrompt = buildMetaPrompt(
            currentPrompt: rubricPrompt,
            currentWeights: rubricWeights,
            samples: samples
        )
        guard let proposalText = await callConfiguredJudge(prompt: metaPrompt, config: cfg.judge),
              let proposed = parseProposal(text: proposalText)
        else {
            return ApmeTuneOutcome(
                accepted: false, reason: "proposal unparseable or judge unavailable",
                baselineCorrelation: baseline, proposedCorrelation: nil, newVersion: nil
            )
        }

        // Shadow-score: rescore disagreements under the proposed rubric.
        var shadowScores: [(judge: Double, vibe: Double)] = []
        for sample in samples {
            guard let vibe = sample.vibe, vibe != "neutral" else { continue }
            let shadowPrompt = buildShadowPrompt(newRubricPrompt: proposed.prompt, sample: sample)
            guard let text = await callConfiguredJudge(prompt: shadowPrompt, config: cfg.judge),
                  let overall = extractOverall(text: text)
            else { continue }
            shadowScores.append((overall, vibeToNumber(vibe)))
        }

        let proposedCorr: Double? = shadowScores.count >= 3
            ? correlation(shadowScores.map { $0.judge }, shadowScores.map { $0.vibe })
            : nil

        DaemonLogger.shared.debug(
            "APME",
            "tune proposed correlation=\(proposedCorr.map { String($0) } ?? "n/a") shadow=\(shadowScores.count)"
        )

        // Accept only if correlation improves by ≥0.05.
        let baselineScore = baseline ?? -Double.infinity
        let proposedScore = proposedCorr ?? -Double.infinity
        guard proposedScore > baselineScore + 0.05 else {
            return ApmeTuneOutcome(
                accepted: false,
                reason: "correlation did not improve (baseline=\(baseline.map { String($0) } ?? "n/a"), proposed=\(proposedCorr.map { String($0) } ?? "n/a"))",
                baselineCorrelation: baseline,
                proposedCorrelation: proposedCorr,
                newVersion: nil
            )
        }

        let weightsJson = encodeWeights(proposed.weights)
        let newVersion = store.appendRubric(
            purpose: "general",
            prompt: proposed.prompt,
            weights: weightsJson,
            parentVer: rubricVersion,
            notes: "auto-tune: baseline=\(baseline.map { String($0) } ?? "n/a") → proposed=\(proposedCorr.map { String($0) } ?? "n/a") over \(shadowScores.count) samples"
        )
        DaemonLogger.shared.debug("APME", "tune accepted v\(newVersion) (parent=\(rubricVersion))")

        return ApmeTuneOutcome(
            accepted: true,
            reason: "correlation improved \(baseline.map { String($0) } ?? "n/a") → \(proposedCorr.map { String($0) } ?? "n/a")",
            baselineCorrelation: baseline,
            proposedCorrelation: proposedCorr,
            newVersion: newVersion
        )
    }

    /// Check if the current rubric should be re-tuned. Low correlation with
    /// user vibe ⇒ rubric drifted. Called by the daemon to gate tune() calls.
    static func shouldRetune(store: ApmeStore) -> Bool {
        guard store.isOpen else { return false }
        let samples = collectDisagreements(store: store, limit: 30)
        if samples.count < 10 { return false }
        guard let corr = vibeCorrelation(samples: samples) else { return false }
        return corr < 0.4
    }

    // MARK: - Disagreement collection

    static func collectDisagreements(store: ApmeStore, limit: Int) -> [ApmeDisagreementSample] {
        let runs = store.listRuns(limit: max(limit * 3, 60))
        var out: [ApmeDisagreementSample] = []
        for run in runs {
            let evals = store.listEvalsForRun(run.id)
            let tests = evals.first(where: { $0.layer == "deterministic" && $0.metric == "tests_pass" })
            let judge = evals.first(where: { $0.layer == "llm_judge" && $0.metric == "overall" })
            let vibeRow = store.latestVibeForRun(run.id)
            let vibe = vibeRow?.verdict

            let judgeOverall = judge?.score
            let testsPass = tests?.score

            var note = ""
            if let t = tests, let j = judge, t.score == 1, j.score < 0.5 {
                note = "tests pass but judge fails"
            } else if let t = tests, let j = judge, t.score == 0, j.score > 0.8 {
                note = "tests fail but judge passes"
            } else if vibe == "reject", let j = judge, j.score > 0.7 {
                note = "user rejected but judge approved"
            } else if vibe == "approve", let j = judge, j.score < 0.5 {
                note = "user approved but judge rejected"
            } else if let v = vibe, v != "neutral", judge != nil {
                note = "vibe labeled"
            } else {
                continue
            }

            out.append(ApmeDisagreementSample(
                runId: run.id,
                taskPrompt: String((run.taskPrompt ?? "").prefix(400)),
                judgeOverall: judgeOverall,
                testsPass: testsPass,
                vibe: vibe,
                note: note
            ))
            if out.count >= limit { break }
        }
        return out
    }

    // MARK: - Correlation math

    static func vibeCorrelation(samples: [ApmeDisagreementSample]) -> Double? {
        let pairs = samples
            .filter { $0.vibe != nil && $0.vibe != "neutral" && $0.judgeOverall != nil }
            .map { ($0.judgeOverall!, vibeToNumber($0.vibe!)) }
        if pairs.count < 3 { return nil }
        return correlation(pairs.map { $0.0 }, pairs.map { $0.1 })
    }

    static func correlation(_ xs: [Double], _ ys: [Double]) -> Double? {
        guard xs.count == ys.count, xs.count >= 2 else { return nil }
        let n = Double(xs.count)
        let mx = xs.reduce(0, +) / n
        let my = ys.reduce(0, +) / n
        var num = 0.0, dx = 0.0, dy = 0.0
        for i in 0..<xs.count {
            let a = xs[i] - mx
            let b = ys[i] - my
            num += a * b
            dx += a * a
            dy += b * b
        }
        let denom = (dx * dy).squareRoot()
        if denom == 0 { return nil }
        return num / denom
    }

    private static func vibeToNumber(_ verdict: String) -> Double {
        switch verdict {
        case "approve": return 1.0
        case "reject":  return 0.0
        default:        return 0.5
        }
    }

    // MARK: - Prompt builders

    private static func buildMetaPrompt(
        currentPrompt: String,
        currentWeights: String,
        samples: [ApmeDisagreementSample]
    ) -> String {
        var lines: [String] = []
        lines.append("You are a rubric meta-optimizer. The current judge rubric disagrees with ground truth on the following samples.")
        lines.append("Propose a *revised* rubric prompt and axis weights that would resolve these disagreements while staying concise (<800 chars).")
        lines.append("")
        lines.append("--- CURRENT RUBRIC PROMPT ---")
        lines.append(currentPrompt)
        lines.append("")
        lines.append("--- CURRENT WEIGHTS ---")
        lines.append(currentWeights)
        lines.append("")
        lines.append("--- DISAGREEMENT SAMPLES ---")
        for s in samples {
            let tests = s.testsPass.map { String($0) } ?? "n/a"
            let judge = s.judgeOverall.map { String($0) } ?? "n/a"
            let vibe = s.vibe ?? "n/a"
            lines.append("- runId=\(s.runId) tests_pass=\(tests) judge_overall=\(judge) vibe=\(vibe) :: \(s.note)")
            if !s.taskPrompt.isEmpty {
                lines.append("  task: \(s.taskPrompt)")
            }
        }
        lines.append("")
        lines.append("Respond with strict JSON only:")
        lines.append(#"{"prompt":"...","weights":{"intent":N,"correctness":N,"style":N,"convention":N},"notes":"..."}"#)
        return lines.joined(separator: "\n")
    }

    private static func buildShadowPrompt(newRubricPrompt: String, sample: ApmeDisagreementSample) -> String {
        return [
            newRubricPrompt,
            "",
            "--- SAMPLE ---",
            "task: \(sample.taskPrompt.isEmpty ? "(not captured)" : sample.taskPrompt)",
            "tests_pass: \(sample.testsPass.map { String($0) } ?? "n/a")",
            "prior_judge_overall: \(sample.judgeOverall.map { String($0) } ?? "n/a")",
            "user_vibe: \(sample.vibe ?? "n/a")",
            "",
            #"Respond with strict JSON only: {"overall":N,"reasoning":"..."}"#,
        ].joined(separator: "\n")
    }

    // MARK: - Proposal parsing

    static func parseProposal(text: String) -> ApmeRubricProposal? {
        guard let jsonBlock = extractFirstJsonBlock(text),
              let data = jsonBlock.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }

        guard let prompt = obj["prompt"] as? String, prompt.count >= 20,
              let weightsRaw = obj["weights"] as? [String: Any]
        else { return nil }

        var weights: [String: Double] = [:]
        for (k, v) in weightsRaw {
            if let d = v as? Double, d.isFinite, d >= 0 { weights[k] = d }
            else if let i = v as? Int { weights[k] = Double(i) }
        }
        guard !weights.isEmpty else { return nil }

        let notes = obj["notes"] as? String
        return ApmeRubricProposal(prompt: prompt, weights: weights, notes: notes)
    }

    static func extractOverall(text: String) -> Double? {
        guard let jsonBlock = extractFirstJsonBlock(text),
              let data = jsonBlock.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        let raw: Double
        if let d = obj["overall"] as? Double, d.isFinite {
            raw = d
        } else if let i = obj["overall"] as? Int {
            raw = Double(i)
        } else {
            return nil
        }
        // Same clamp logic as parseJudgeJson: 0..10 rescale.
        var n = raw
        if n > 1 && n <= 10 { n /= 10 }
        return max(0, min(1, n))
    }

    private static func extractFirstJsonBlock(_ text: String) -> String? {
        guard let first = text.firstIndex(of: "{") else { return nil }
        var depth = 0
        var i = first
        var inString = false
        var escaped = false
        while i < text.endIndex {
            let c = text[i]
            if escaped { escaped = false }
            else if c == "\\" && inString { escaped = true }
            else if c == "\"" { inString.toggle() }
            else if !inString {
                if c == "{" { depth += 1 }
                else if c == "}" {
                    depth -= 1
                    if depth == 0 { return String(text[first...i]) }
                }
            }
            i = text.index(after: i)
        }
        return nil
    }

    private static func encodeWeights(_ weights: [String: Double]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: weights, options: [.sortedKeys]),
              let s = String(data: data, encoding: .utf8)
        else { return "{}" }
        return s
    }

    // MARK: - Judge dispatch

    /// Route to the configured judge backend. Same dispatch as ApmeRunner
    /// but scoped to tuner's needs (nil on any failure — we never silently
    /// fall back to a different backend).
    private static func callConfiguredJudge(prompt: String, config: ApmeJudgeConfig) async -> String? {
        switch config.backend {
        case .foundationModels:
            return await ApmeJudgeFoundationModels.judge(prompt: prompt)
        case .mlx:
            return await ApmeJudgeMlx.judge(prompt: prompt, config: config)
        case .api:
            return await ApmeJudgeApi.judge(prompt: prompt, config: config)
        case .openclaw:
            return await ApmeJudgeFoundationModels.judge(prompt: prompt)
        }
    }
}
#endif
