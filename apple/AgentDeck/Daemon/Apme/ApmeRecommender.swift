#if os(macOS)
// ApmeRecommender.swift — Model recommendation engine.
//
// Swift port of bridge/src/apme/recommend.ts. Reads the v_model_scorecard
// view (pre-aggregated in SQLite) and returns a ranked list of model
// candidates based on historical performance + cost.
//
// Ranking:
//   - With tight budget (budgetUsd < 5): sort by cost_per_quality ascending
//   - Otherwise: sort by avg_overall descending
//
// Confidence is proportional to runs/20, clamped to [0, 1] — a model with
// 20+ runs gets full confidence, fewer means "we're guessing".
//
// Phase 2 parity with TS: same filter/sort/slice logic, same output shape.
// Phase 3 (stretch, not in this commit) would layer in local embedding-
// based task similarity so the recommendation is context-aware.

import Foundation

struct ApmeRecommendInput {
    var taskKind: String?
    var budgetUsd: Double?
    var latencyBudgetMs: Double?
    var preferLocal: Bool = false
    /// Models the user actually has access to. Filter applied BEFORE
    /// ranking so we don't recommend subscriptions they can't use.
    var availableModels: [String]?
}

struct ApmeRecommendCandidate {
    let modelId: String
    let agentType: String
    let expectedScore: Double
    let expectedCostUsd: Double
    let confidence: Double
    let rationale: String
}

enum ApmeRecommender {
    /// Return up to 3 ranked candidates from the historical scorecard.
    /// Empty list when the store is offline or has no eligible models.
    static func recommend(store: ApmeStore, input: ApmeRecommendInput = ApmeRecommendInput()) -> [ApmeRecommendCandidate] {
        guard store.isOpen else { return [] }

        // Raw scorecard dicts — matches v_model_scorecard columns.
        let rows = store.scorecard()

        // Filter by availableModels if user provided a subscription list.
        let filtered: [[String: Any]] = {
            guard let available = input.availableModels, !available.isEmpty else {
                return rows
            }
            return rows.filter { row in
                guard let modelId = row["model_id"] as? String else { return false }
                return available.contains(modelId)
            }
        }()

        // Eligibility: at least 3 runs AND non-zero avg_overall.
        let eligible = filtered.filter { row in
            let runs = (row["runs"] as? Int) ?? 0
            let avgOverall = (row["avg_overall"] as? Double) ?? 0
            return runs >= 3 && avgOverall > 0
        }

        // Sort by budget preference.
        let sorted = eligible.sorted { a, b in
            if let budget = input.budgetUsd, budget < 5 {
                // Tight budget: lower cost-per-quality wins.
                let aCost = (a["cost_per_quality"] as? Double) ?? .greatestFiniteMagnitude
                let bCost = (b["cost_per_quality"] as? Double) ?? .greatestFiniteMagnitude
                return aCost < bCost
            }
            let aScore = (a["avg_overall"] as? Double) ?? 0
            let bScore = (b["avg_overall"] as? Double) ?? 0
            return aScore > bScore
        }

        // Top 3 → map to candidates.
        return sorted.prefix(3).map { row -> ApmeRecommendCandidate in
            let modelId = (row["model_id"] as? String) ?? "unknown"
            let agentType = (row["agent_type"] as? String) ?? "unknown"
            let runs = (row["runs"] as? Int) ?? 0
            let avgOverall = (row["avg_overall"] as? Double) ?? 0
            let totalCost = (row["total_cost"] as? Double) ?? 0
            let avgTests = row["avg_tests_pass"] as? Double

            var rationale = "\(runs) runs, avg \(Int((avgOverall * 100).rounded()))%"
            if let t = avgTests {
                rationale += ", tests \(Int((t * 100).rounded()))%"
            }

            return ApmeRecommendCandidate(
                modelId: modelId,
                agentType: agentType,
                expectedScore: avgOverall,
                expectedCostUsd: totalCost / Double(max(runs, 1)),
                confidence: min(1.0, Double(runs) / 20.0),
                rationale: rationale
            )
        }
    }
}
#endif
