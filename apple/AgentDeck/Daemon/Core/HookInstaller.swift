#if os(macOS)
// HookInstaller.swift — Auto-install Claude Code hooks on app launch
// Ported from hooks/src/install.ts

import Foundation

enum HookInstaller {
    private static let settingsFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/settings.local.json")

    private static let hookEvents = [
        "SessionStart", "SessionEnd", "PreToolUse",
        "PostToolUse", "Stop", "Notification", "UserPromptSubmit",
    ]

    /// Install AgentDeck hooks into Claude Code settings. Safe to call multiple times.
    static func installIfNeeded() {
        var settings = loadSettings()
        let before = settingsJSON(settings)

        settings = applyHooks(settings)

        let after = settingsJSON(settings)
        guard before != after else {
            DaemonLogger.shared.debug("Hooks", "Already installed, no changes needed")
            return
        }

        saveSettings(settings)
        DaemonLogger.shared.info("Claude Code hooks installed → \(settingsFile.path)")
    }

    /// Remove AgentDeck hooks from Claude Code settings
    static func uninstall() {
        var settings = loadSettings()
        settings = removeHooks(settings)
        saveSettings(settings)
        DaemonLogger.shared.info("Claude Code hooks removed")
    }

    // MARK: - Pure Logic

    private static func applyHooks(_ settings: [String: Any]) -> [String: Any] {
        var s = settings
        var hooks = s["hooks"] as? [String: Any] ?? [:]

        for event in hookEvents {
            var eventHooks = hooks[event] as? [[String: Any]] ?? []

            // Remove existing AgentDeck hooks (both old flat and new matcher format)
            eventHooks.removeAll { h in
                if let cmd = h["command"] as? String,
                   (cmd.contains("AGENTDECK_PORT") || cmd.contains("localhost:9120")) {
                    return true
                }
                if let inner = h["hooks"] as? [[String: Any]] {
                    return inner.contains { hh in
                        let cmd = hh["command"] as? String ?? ""
                        return cmd.contains("AGENTDECK_PORT") || cmd.contains("localhost:9120")
                    }
                }
                return false
            }

            // Add new hook (v2.1 matcher-group format)
            eventHooks.append(buildHookEntry(event))
            hooks[event] = eventHooks
        }

        s["hooks"] = hooks
        return s
    }

    private static func removeHooks(_ settings: [String: Any]) -> [String: Any] {
        var s = settings
        guard var hooks = s["hooks"] as? [String: Any] else { return s }

        for event in hookEvents {
            guard var eventHooks = hooks[event] as? [[String: Any]] else { continue }
            eventHooks.removeAll { h in
                if let cmd = h["command"] as? String,
                   (cmd.contains("AGENTDECK_PORT") || cmd.contains("localhost:9120")) {
                    return true
                }
                if let inner = h["hooks"] as? [[String: Any]] {
                    return inner.contains { hh in
                        let cmd = hh["command"] as? String ?? ""
                        return cmd.contains("AGENTDECK_PORT") || cmd.contains("localhost:9120")
                    }
                }
                return false
            }
            if eventHooks.isEmpty { hooks.removeValue(forKey: event) }
            else { hooks[event] = eventHooks }
        }

        if (hooks as NSDictionary).count == 0 { s.removeValue(forKey: "hooks") }
        else { s["hooks"] = hooks }
        return s
    }

    private static func buildHookEntry(_ event: String) -> [String: Any] {
        [
            "matcher": "",
            "hooks": [[
                "type": "command",
                "command": "curl -sf -X POST http://localhost:${AGENTDECK_PORT:-9120}/hooks/\(event) -H 'Content-Type: application/json' -d @- 2>/dev/null || true",
            ] as [String: Any]] as [[String: Any]],
        ]
    }

    // MARK: - File I/O

    private static func loadSettings() -> [String: Any] {
        guard let data = try? Data(contentsOf: settingsFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return json
    }

    private static func saveSettings(_ settings: [String: Any]) {
        let dir = settingsFile.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: settingsFile, options: .atomic)
        }
    }

    private static func settingsJSON(_ settings: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: settings, options: .sortedKeys) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
}
#endif
