#if os(macOS)
// ApmeJudgeApi.swift — Anthropic API judge adapter (opt-in, paid).
//
// Per feedback_cost_sensitive_defaults memory: API calls are NEVER the
// default. The user must explicitly pick "api" in Settings AND have a key
// available. Both conditions fail → return nil → caller skips the eval.
//
// Key lookup order:
//   1. `ANTHROPIC_API_KEY` environment variable
//   2. `~/.agentdeck/settings.json` → `apme.judge.apiKey`
//
// No Keychain in Phase 2 — Keychain access in a sandboxed app requires
// the `keychain-access-groups` entitlement and triggers a permission
// prompt. settings.json is already readable via the existing
// temporary-exception entitlement set and matches how the Node bridge
// stores the key. One source of truth across both stacks.
//
// Sandbox: api.anthropic.com is reached via `com.apple.security.network.client`
// which is already granted. No ATS exception needed (HTTPS).

import Foundation

enum ApmeJudgeApi {
    static let judgeModelLabel = "api:claude-opus-4-6"

    /// Run the Anthropic API judge. Returns nil if:
    ///   - No API key available
    ///   - Network failure
    ///   - Non-200 response (caller sees nil and skips)
    ///
    /// Does NOT silently fall back to another backend — cost-sensitive
    /// defaults memory says API failures stay failures so the user sees
    /// the cost they opted into (zero calls on failure).
    static func judge(prompt: String, config: ApmeJudgeConfig) async -> String? {
        guard let apiKey = loadApiKey() else {
            // Log once-ish for diagnostics but don't spam — tasks run every 30s.
            DaemonLogger.shared.debug("APME", "API judge selected but no key found in env or settings.json")
            return nil
        }

        // Model selection: config.model if set to a real id, else a safe default.
        let model = (config.model == "default" || config.model.isEmpty)
            ? "claude-opus-4-6"
            : config.model

        let endpoint = config.endpoint ?? "https://api.anthropic.com/v1/messages"
        guard let url = URL(string: endpoint) else { return nil }

        let body: [String: Any] = [
            "model": model,
            "max_tokens": 1024,
            "temperature": 0,
            "system": "You are an exacting code evaluator. Reply with strict JSON only.",
            "messages": [
                ["role": "user", "content": prompt],
            ],
        ]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.httpBody = bodyData
        request.timeoutInterval = 60

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            if http.statusCode != 200 {
                DaemonLogger.shared.debug("APME", "API judge HTTP \(http.statusCode)")
                return nil
            }
            // Anthropic response shape: { content: [ { type: "text", text: "..." } ] }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let content = json["content"] as? [[String: Any]]
            else { return nil }
            // Concatenate all text blocks — claude typically returns one but
            // the schema allows multiple.
            var combined = ""
            for block in content {
                if let type = block["type"] as? String, type == "text",
                   let text = block["text"] as? String {
                    combined += text
                }
            }
            return combined.isEmpty ? nil : combined
        } catch {
            DaemonLogger.shared.debug("APME", "API judge network error: \(error.localizedDescription)")
            return nil
        }
    }

    /// Whether an API key is currently available. Used by the Settings
    /// Picker to gate the "api" option with a helpful subtitle.
    static var isConfigured: Bool { loadApiKey() != nil }

    /// Priority: env var, then settings.json apme.judge.apiKey.
    private static func loadApiKey() -> String? {
        if let env = ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"],
           !env.isEmpty {
            return env
        }
        let path = AuthManager.agentDeckDir.appendingPathComponent("settings.json").path
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let apme = json["apme"] as? [String: Any],
              let judge = apme["judge"] as? [String: Any],
              let key = judge["apiKey"] as? String,
              !key.isEmpty
        else { return nil }
        return key
    }
}
#endif
