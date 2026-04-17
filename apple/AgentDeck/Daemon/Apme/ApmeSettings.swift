#if os(macOS)
// ApmeSettings.swift — APME configuration loader (Swift mirror of settings.ts).
//
// Phase 1 (App Store MVP): only the `foundationModels` judge backend is supported.
// MLX, API, OpenClaw backends remain in the enum for schema forward-compatibility
// with bridge/src/apme/settings.ts but are NOT wired in Phase 1 — if the user's
// settings.json specifies them, the runner degrades gracefully to `foundationModels`.
//
// Config source of truth: ~/.agentdeck/settings.json  { "apme": { ... } }
// The file is shared with the Node.js bridge, so both stacks read/write the same
// schema. Callers must not mutate the file from multiple processes concurrently.

import Foundation

// MARK: - Judge backend

/// Supported judge backends. Phase 1 hardcodes `foundationModels`; other cases
/// exist so the settings file can round-trip values written by the Node bridge
/// without data loss. Runner falls back to `foundationModels` when selected
/// backend is unavailable in the current build.
enum ApmeJudgeBackend: String, Codable {
    case foundationModels = "foundationModels"
    case mlx
    case api
    case openclaw
}

struct ApmeJudgeConfig: Codable {
    var backend: ApmeJudgeBackend = .foundationModels
    /// Model id — unused for `foundationModels` (system picks on-device model),
    /// retained for forward-compat with other backends.
    var model: String = "default"
    /// Fraction of closed runs that trigger a layer-2 judge call (0..1).
    var sampleRate: Double = 1.0
    /// Only judge runs where layer-1 signal is ambiguous. Phase 1 has no layer-1,
    /// so this has no effect for code runs; for turn-level evals it's also bypassed.
    var onlyWhenDisagreement: Bool = false
    /// Optional custom endpoint — unused for `foundationModels`.
    var endpoint: String?
}

struct ApmeDeterministicConfig: Codable {
    /// Phase 1: deterministic layer is never run from the Swift daemon (sandbox
    /// can't spawn processes into user project paths). The flag is preserved for
    /// config round-trip but `runner.runOne` always reports layer1Ran=false.
    var enabled: Bool = false
    var timeoutSec: Int = 180
}

struct ApmeConfig: Codable {
    var enabled: Bool = true
    /// Rubric auto-tuning (Phase 2 in Swift). Preserved for round-trip.
    var autoTune: Bool = true
    var deterministic: ApmeDeterministicConfig = ApmeDeterministicConfig()
    var judge: ApmeJudgeConfig = ApmeJudgeConfig()
    var availableModels: [String] = []
}

// MARK: - LLM MLX pin

/// Single source of truth for which MLX model AgentDeck uses across
/// probe, timeline summarizer, and APME judge. Mirrors
/// shared/src/llm-settings.ts (MlxSettings). See plan mlx-atomic-minsky.
struct LlmMlxConfig: Codable {
    /// Base URL (no /chat/completions suffix). Default: 127.0.0.1:8800.
    var endpoint: String = "http://127.0.0.1:8800"
    /// Pinned model id. `nil` means auto-detect from `/v1/models`.
    var model: String?
}

private let placeholderModelIds: Set<String> = ["", "default", "qwen3-30b"]

private func isPlaceholderModel(_ m: String?) -> Bool {
    guard let m = m?.trimmingCharacters(in: .whitespaces) else { return true }
    return placeholderModelIds.contains(m)
}

private func stripChatSuffix(_ url: String) -> String {
    var s = url
    for suffix in ["/v1/chat/completions", "/chat/completions"] {
        if s.hasSuffix(suffix) {
            s = String(s.dropLast(suffix.count))
        }
    }
    return s
}

// MARK: - Loader

enum ApmeSettings {
    /// Path to the shared settings file. Env override (used by tests) takes
    /// precedence; otherwise we route through `AgentDeckPaths` so signed
    /// App Store builds land in the App Group container.
    static var settingsPath: String {
        if let override = ProcessInfo.processInfo.environment["AGENTDECK_DATA_DIR"] {
            return (override as NSString).appendingPathComponent("settings.json")
        }
        return AgentDeckPaths.settingsJson.path
    }

    /// Load APME config from ~/.agentdeck/settings.json.
    /// Returns defaults on any failure — the daemon must keep booting.
    static func load() -> ApmeConfig {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: settingsPath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return ApmeConfig()
        }
        guard let apme = json["apme"] as? [String: Any] else {
            return ApmeConfig()
        }

        var cfg = ApmeConfig()
        if let enabled = apme["enabled"] as? Bool { cfg.enabled = enabled }
        if let autoTune = apme["autoTune"] as? Bool { cfg.autoTune = autoTune }

        if let det = apme["deterministic"] as? [String: Any] {
            if let e = det["enabled"] as? Bool { cfg.deterministic.enabled = e }
            if let t = det["timeoutSec"] as? Int { cfg.deterministic.timeoutSec = max(5, min(1800, t)) }
        }

        if let judge = apme["judge"] as? [String: Any] {
            if let b = judge["backend"] as? String,
               let parsed = ApmeJudgeBackend(rawValue: b) {
                cfg.judge.backend = parsed
            }
            if let m = judge["model"] as? String { cfg.judge.model = m }
            if let s = judge["sampleRate"] as? Double { cfg.judge.sampleRate = max(0, min(1, s)) }
            if let s = judge["sampleRate"] as? Int { cfg.judge.sampleRate = max(0, min(1, Double(s))) }
            if let d = judge["onlyWhenDisagreement"] as? Bool { cfg.judge.onlyWhenDisagreement = d }
            if let ep = judge["endpoint"] as? String { cfg.judge.endpoint = ep }
        }

        if let models = apme["availableModels"] as? [String] { cfg.availableModels = models }

        return cfg
    }

    // MARK: LLM MLX pin

    nonisolated(unsafe) private static var mlxCache: (at: Date, value: LlmMlxConfig)?
    private static let mlxCacheTTL: TimeInterval = 30

    /// Load llm.mlx pin (shared across probe, timeline, judge).
    /// Falls back to legacy apme.judge.{endpoint,model} for backward compat.
    /// Result is cached for 30s to avoid re-parsing settings.json on every call.
    static func loadMlxConfig() -> LlmMlxConfig {
        if let c = mlxCache, Date().timeIntervalSince(c.at) < mlxCacheTTL {
            return c.value
        }
        var cfg = LlmMlxConfig()
        if let data = try? Data(contentsOf: URL(fileURLWithPath: settingsPath)),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {

            if let llmMlx = (json["llm"] as? [String: Any])?["mlx"] as? [String: Any] {
                if let ep = llmMlx["endpoint"] as? String, !ep.isEmpty {
                    cfg.endpoint = stripChatSuffix(ep)
                }
                if let m = llmMlx["model"] as? String, !isPlaceholderModel(m) {
                    cfg.model = m.trimmingCharacters(in: .whitespaces)
                }
            }

            // Legacy fallback: apme.judge.{endpoint,model}
            if cfg.model == nil || cfg.endpoint == "http://127.0.0.1:8800" {
                if let judge = (json["apme"] as? [String: Any])?["judge"] as? [String: Any] {
                    if cfg.model == nil, let m = judge["model"] as? String, !isPlaceholderModel(m) {
                        cfg.model = m.trimmingCharacters(in: .whitespaces)
                    }
                    if cfg.endpoint == "http://127.0.0.1:8800",
                       let ep = judge["endpoint"] as? String, !ep.isEmpty {
                        cfg.endpoint = stripChatSuffix(ep)
                    }
                }
            }
        }
        mlxCache = (Date(), cfg)
        return cfg
    }

    /// Clear the 30s mlx config cache — used by tests or after a settings write.
    static func clearMlxCache() {
        mlxCache = nil
    }

    /// Decide whether layer-2 (LLM judge) should run for this run.
    /// Mirrors bridge/src/apme/settings.ts shouldJudge() semantics.
    /// Phase 1: turn-level evals ignore this gate (they always run when a response
    /// is captured); this is used for the run-level path only.
    static func shouldJudge(_ cfg: ApmeJudgeConfig, deterministicPassed: Bool?) -> Bool {
        if cfg.sampleRate <= 0 { return false }
        if cfg.onlyWhenDisagreement {
            if deterministicPassed == true { return false }
        }
        return Double.random(in: 0..<1) < cfg.sampleRate
    }
}
#endif
