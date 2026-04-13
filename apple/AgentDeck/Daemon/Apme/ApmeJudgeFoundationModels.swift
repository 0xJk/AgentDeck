#if os(macOS)
// ApmeJudgeFoundationModels.swift — Apple Intelligence judge adapter.
//
// Uses the FoundationModels framework (macOS 26+, Apple Silicon only). Zero
// marginal cost, on-device, network-free. Default backend for the App Store
// build. No API key, no MLX server, no Node.js dependency.
//
// Fallback policy (matches cost-sensitive-defaults memory):
//   - If the framework can't import or availability != .available, the judge
//     returns nil — runner skips layer 2 for that call without erroring.
//   - Never silently fall back to a network backend; require explicit user opt-in.
//
// Probe-verified on macOS 26.3.1 + Xcode 26.4 (2026-04-13): session prompts at
// temperature=0 reliably return JSON wrapped in ```json fences, which
// ApmeRunner.parseJudgeJson extracts via its first-`{...}`-block regex.

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

enum ApmeJudgeFoundationModels {
    /// Returns true when the framework + Apple Intelligence are ready to use.
    /// Phase 1 treats any `!available` state as "judge disabled for this run"
    /// — no download prompts, no user-visible errors from APME itself.
    static var isAvailable: Bool {
#if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability {
                return true
            }
        }
#endif
        return false
    }

    /// A short human-readable reason when `isAvailable` is false — surfaced
    /// in logs and optionally in the Dashboard info card.
    static var unavailableReason: String {
#if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return "available"
            case .unavailable(let reason):
                return "unavailable: \(reason)"
            @unknown default:
                return "unavailable: unknown state"
            }
        } else {
            return "macOS 26 or later required"
        }
#else
        return "FoundationModels framework not present in this build"
#endif
    }

    /// Run the judge with a rubric-filled prompt. Returns the raw text from
    /// the model — caller feeds it to `ApmeRunner.parseJudgeJson` which is
    /// robust to code-fence wrapping and prose prefixes.
    ///
    /// Returns nil when:
    ///   - framework unavailable
    ///   - session throws (timeout, content filter, etc.)
    ///
    /// The runner interprets nil as "skip this eval" and does not retry.
    static func judge(prompt: String) async -> String? {
#if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else {
                return nil
            }
            do {
                let session = LanguageModelSession(
                    instructions: "You are an exacting code evaluator. Reply with strict JSON only."
                )
                let options = GenerationOptions(temperature: 0)
                let response = try await session.respond(to: prompt, options: options)
                return response.content
            } catch {
                // Intentionally swallow errors per cost-sensitive-defaults —
                // judge is best-effort and must never block eval pipeline.
                return nil
            }
        }
#endif
        return nil
    }

    /// Stable identifier used for the `evals.judge_model` column.
    /// Matches the TS runner's "backend:model" format so analytics queries
    /// aggregate correctly across stacks.
    static let judgeModelLabel = "foundationModels:apple-intelligence"
}
#endif
