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

// MARK: - Loader

enum ApmeSettings {
    /// Path to the shared settings file.
    static var settingsPath: String {
        let dir = ProcessInfo.processInfo.environment["AGENTDECK_DATA_DIR"]
            ?? (NSHomeDirectory() as NSString).appendingPathComponent(".agentdeck")
        return (dir as NSString).appendingPathComponent("settings.json")
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
