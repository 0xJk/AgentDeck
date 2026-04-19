#if os(macOS)
// SessionLauncher.swift — Launch terminal agent sessions from the app.
//
// App Store builds never create shell scripts or open command-line tools. They
// monitor Claude Code through the opt-in hook pipeline instead.

import Foundation
import AppKit

// MARK: - Agent Type

enum LaunchAgentType: String, CaseIterable {
    case claudeCode = "claude-code"   // agentdeck claude (with bridge)
    case codex                         // agentdeck codex
    case opencode                      // agentdeck opencode
    case claudePlain = "claude"        // plain claude, no bridge

    var displayName: String {
        switch self {
        case .claudeCode: return "Claude"
        case .codex: return "Codex"
        case .opencode: return "OpenCode"
        case .claudePlain: return "Plain"
        }
    }

    var usesBridge: Bool { self != .claudePlain }

    var bridgeSubcommand: String? {
        switch self {
        case .claudeCode: return "claude"
        case .codex: return "codex"
        case .opencode: return "opencode"
        case .claudePlain: return nil
        }
    }
}

// MARK: - Terminal App

enum TerminalApp: String, CaseIterable {
    case system
    case terminal
    case iterm
    case alacritty
    case wezterm
    case ghostty
    case warp

    var displayName: String {
        switch self {
        case .system: return "System Default"
        case .terminal: return "Terminal"
        case .iterm: return "iTerm2"
        case .alacritty: return "Alacritty"
        case .wezterm: return "WezTerm"
        case .ghostty: return "Ghostty"
        case .warp: return "Warp"
        }
    }

    var bundleIds: [String] {
        switch self {
        case .system: return []
        case .terminal: return ["com.apple.Terminal"]
        case .iterm: return ["com.googlecode.iterm2"]
        case .alacritty: return ["org.alacritty"]
        case .wezterm: return ["com.github.wez.wezterm"]
        case .ghostty: return ["com.mitchellh.ghostty"]
        case .warp: return ["dev.warp.Warp-Stable", "dev.warp.Warp"]
        }
    }

    func appURL() -> URL? {
        for bid in bundleIds {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) { return url }
        }
        return nil
    }

    func isInstalled() -> Bool {
        self == .system || appURL() != nil
    }

    static func installed() -> [TerminalApp] {
        TerminalApp.allCases.filter { $0.isInstalled() }
    }
}

enum SessionLauncher {
    enum LaunchMode: Equatable {
        case agentdeckCli
        case bundledBridge
        case plainClaude
    }

    struct LaunchPlan: Equatable {
        let mode: LaunchMode
        let command: String
    }

    /// Back-compat entry point: launches Claude Code session with system default terminal
    @MainActor
    static func launchSession(project: String? = nil, daemonPort: UInt16? = nil) {
        launchSession(project: project, agent: .claudeCode, terminalApp: .system, daemonPort: daemonPort)
    }

    /// Launch a session with full control over agent type and terminal app
    @MainActor
    static func launchSession(
        project: String?,
        agent: LaunchAgentType,
        terminalApp: TerminalApp,
        daemonPort: UInt16?
    ) {
        #if AGENTDECK_APP_STORE
        showAppStoreLaunchInfo(agent: agent)
        return
        #else
        guard let plan = resolveLaunchPlan(
            project: project,
            agent: agent,
            daemonPort: daemonPort.flatMap { Int($0) } ?? SessionRegistry.shared.findDaemonPort(),
            installedBridgePath: findInstalledBridge(),
            // App Store build ships no bundled helpers (Apple 2.5.2 — see
            // copy-adb.sh gate); pass nil so the resolver can never try to
            // invoke an embedded Node runtime.
            bundledBridgePath: findBundledBridge(),
            bundledNodePath: findBundledNode(),
            claudePath: findClaude()
        ) else {
            DaemonLogger.shared.info("Agent CLI not found, showing install prompt")
            showAgentInstallPrompt(agent: agent)
            return
        }

        openInTerminal(plan.command, terminal: terminalApp)
        #endif
    }

    /// Check if Claude Code CLI is installed
    static func isClaudeInstalled() -> Bool {
        findClaude() != nil
    }

    /// Check if agentdeck bridge CLI is installed
    static func isBridgeInstalled() -> Bool {
        findInstalledBridge() != nil
    }

    static func resolveLaunchPlan(
        project: String?,
        agent: LaunchAgentType = .claudeCode,
        daemonPort: Int?,
        installedBridgePath: String?,
        bundledBridgePath: String?,
        bundledNodePath: String?,
        claudePath: String?
    ) -> LaunchPlan? {
        let projectPrefix = project.map { "cd \(shellEscape($0)) && " } ?? ""
        let daemonPrefix = daemonPort.map { "AGENTDECK_PORT=\($0) " } ?? ""

        // Plain claude (no bridge) path
        if agent == .claudePlain {
            guard let claudePath else { return nil }
            let command = "\(projectPrefix)\(shellEscape(claudePath))"
            return LaunchPlan(mode: .plainClaude, command: command)
        }

        guard let sub = agent.bridgeSubcommand else { return nil }

        if let installedBridgePath {
            let command = "\(projectPrefix)\(daemonPrefix)\(shellEscape(installedBridgePath)) \(sub)"
            return LaunchPlan(mode: .agentdeckCli, command: command)
        }

        #if !AGENTDECK_APP_STORE
        // CLI / Homebrew build: fall through to the bundled Node + bridge CLI
        // that ships under `Contents/Resources/agentdeck-runtime/`. The App
        // Store build strips those assets (see copy-adb.sh AGENTDECK_APP_STORE
        // gate) so this branch is compile-out to make it impossible for the
        // reviewed binary to invoke a bundled interpreter (Apple Guideline 2.5.2).
        if let bundledBridgePath {
            let nodePath = bundledNodePath ?? "node"
            let command = "\(projectPrefix)\(daemonPrefix)\(shellEscape(nodePath)) \(shellEscape(bundledBridgePath)) \(sub)"
            return LaunchPlan(mode: .bundledBridge, command: command)
        }
        #endif

        // Last-resort fallback for claude-code: plain claude without bridge.
        // Still pass AGENTDECK_PORT so the Claude Code hooks (installed
        // separately by HookInstaller) can find our daemon even when the
        // bridge binary isn't available. Claude itself ignores the var.
        if agent == .claudeCode, let claudePath {
            let command = "\(projectPrefix)\(daemonPrefix)\(shellEscape(claudePath))"
            return LaunchPlan(mode: .plainClaude, command: command)
        }

        return nil
    }

    // MARK: - Bridge Discovery

    private static func findInstalledBridge() -> String? {
        // App Sandbox has a restricted PATH — check common locations first
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/Library/pnpm/agentdeck",
            "\(home)/.local/bin/agentdeck",
            "/usr/local/bin/agentdeck",
            "/opt/homebrew/bin/agentdeck",
            "\(home)/.npm-global/bin/agentdeck",
            "\(home)/.nvm/current/bin/agentdeck",
        ]
        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    private static func findClaude() -> String? {
        // App Sandbox has a restricted PATH — check common locations first
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.local/bin/claude",
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
            "\(home)/.npm-global/bin/claude",
            "\(home)/.nvm/current/bin/claude",
        ]
        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    #if !AGENTDECK_APP_STORE
    private static func findBundledBridge() -> String? {
        // Check app bundle Resources. App Store builds never ship this —
        // the build script's AGENTDECK_APP_STORE gate keeps the CLI out of
        // Resources entirely (Apple 2.5.2).
        guard let resourcePath = Bundle.main.resourcePath else { return nil }
        let bridgePath = (resourcePath as NSString).appendingPathComponent("bridge/cli.js")
        return FileManager.default.fileExists(atPath: bridgePath) ? bridgePath : nil
    }

    private static func findBundledNode() -> String? {
        guard let resourcePath = Bundle.main.resourcePath else { return nil }
        let nodePath = (resourcePath as NSString).appendingPathComponent("node")
        return FileManager.default.isExecutableFile(atPath: nodePath) ? nodePath : nil
    }
    #else
    // App Store build: never returns a path. These stubs exist so call
    // sites keep compiling without needing #if guards of their own.
    private static func findBundledBridge() -> String? { nil }
    private static func findBundledNode() -> String? { nil }
    #endif

    // MARK: - Terminal Launch

    #if !AGENTDECK_APP_STORE
    private static func openInTerminal(_ command: String, terminal: TerminalApp = .system) {
        // iTerm2 branch uses NSAppleScript — that requires Apple Events
        // entitlement + usage description, which we deliberately don't ship
        // in the App Store build. CLI/Homebrew builds keep the richer path.
        if terminal == .iterm {
            openInITerm(command)
            return
        }

        // Everyone else: write .command script, open with chosen app or system default
        let tmpDir = FileManager.default.temporaryDirectory
        let scriptFile = tmpDir.appendingPathComponent("agentdeck-launch-\(UUID().uuidString.prefix(8)).command")
        let scriptContent = """
        #!/bin/bash
        # Auto-generated by AgentDeck — this file self-deletes
        rm -f "\(scriptFile.path)"
        \(command)
        """
        do {
            try scriptContent.write(to: scriptFile, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o755], ofItemAtPath: scriptFile.path
            )

            if terminal == .system {
                NSWorkspace.shared.open(scriptFile)
                DaemonLogger.shared.info("Launched session via .command (system default)")
            } else if let appURL = terminal.appURL() {
                let cfg = NSWorkspace.OpenConfiguration()
                NSWorkspace.shared.open([scriptFile], withApplicationAt: appURL, configuration: cfg) { _, err in
                    if let err {
                        DaemonLogger.shared.error("Failed to open in \(terminal.displayName): \(err)")
                    } else {
                        DaemonLogger.shared.info("Launched session in \(terminal.displayName)")
                    }
                }
            } else {
                // App no longer installed — fallback to system default
                NSWorkspace.shared.open(scriptFile)
                DaemonLogger.shared.info("\(terminal.displayName) not found, fell back to system default")
            }
        } catch {
            DaemonLogger.shared.error("Failed to create launch script: \(error)")
            // AppleScript fallback requires automation entitlement; omit in
            // App Store build and surface the failure via the log only.
            openInTerminalViaAppleScript(command)
        }
    }

    private static func openInITerm(_ command: String) {
        let escaped = command
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let script = """
        tell application "iTerm"
            activate
            if (count of windows) = 0 then
                create window with default profile
            else
                tell current window to create tab with default profile
            end if
            tell current session of current window
                write text "\(escaped)"
            end tell
        end tell
        """
        if let appleScript = NSAppleScript(source: script) {
            var error: NSDictionary?
            appleScript.executeAndReturnError(&error)
            if let error {
                DaemonLogger.shared.error("iTerm AppleScript failed: \(error)")
            } else {
                DaemonLogger.shared.info("Launched session in iTerm2")
            }
        }
    }

    private static func openInTerminalViaAppleScript(_ command: String) {
        let script = """
        tell application "Terminal"
            activate
            do script "\(command.replacingOccurrences(of: "\"", with: "\\\""))"
        end tell
        """
        if let appleScript = NSAppleScript(source: script) {
            var error: NSDictionary?
            appleScript.executeAndReturnError(&error)
            if let error {
                DaemonLogger.shared.error("Failed to launch Terminal via AppleScript: \(error)")
            }
        }
    }
    #endif

    // MARK: - Install Prompt

    #if AGENTDECK_APP_STORE
    @MainActor
    private static func showAppStoreLaunchInfo(agent: LaunchAgentType) {
        let alert = NSAlert()
        switch agent {
        case .claudeCode, .claudePlain:
            alert.messageText = "Start Claude Code from Terminal"
            alert.informativeText = """
            The App Store build does not create shell scripts or launch command-line tools.

            Start Claude Code in Terminal. After hooks are enabled in AgentDeck Settings, live sessions appear here automatically.
            """
        case .codex, .opencode:
            alert.messageText = "\(agent.displayName) launch is unavailable"
            alert.informativeText = """
            The App Store build does not launch PTY-backed command-line sessions.

            Claude Code monitoring still works through the approved hook pipeline.
            """
        }
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
    #else
    /// Install guide URLs for each supported agent CLI. Prefer the project's
    /// official docs over a generic install.sh so users land on a maintained
    /// page and can follow the current install method (npm, brew, pipx…).
    private static let installGuideURLs: [LaunchAgentType: URL] = [
        .claudeCode: URL(string: "https://docs.claude.com/en/docs/claude-code/quickstart")!,
        .codex: URL(string: "https://github.com/openai/codex")!,
        .opencode: URL(string: "https://opencode.ai/docs")!,
        .claudePlain: URL(string: "https://docs.claude.com/en/docs/claude-code/quickstart")!,
    ]

    /// User-facing install prompt that avoids the "copy this terminal command"
    /// cliff. Non-developers dismiss clipboard-only dialogs because the next
    /// step (opening Terminal, pasting, pressing Return) is invisible. Instead
    /// we surface the official installation guide URL and a "re-check" button
    /// that re-runs discovery so the user can complete the install in a browser
    /// and keep the Launch Session flow moving without re-opening AgentDeck.
    private static func showClaudeInstallPrompt() {
        showAgentInstallPrompt(agent: .claudeCode)
    }

    /// Generic agent install prompt. Caller passes in the agent type so the
    /// message + guide URL match what the user was trying to launch.
    static func showAgentInstallPrompt(agent: LaunchAgentType) {
        let alert = NSAlert()
        alert.messageText = "\(agent.displayName) CLI Not Found"
        alert.informativeText = """
        AgentDeck needs the \(agent.displayName) command-line tool to launch this session.

        Open the installation guide to get it set up, then click "Check Again" to continue.

        Monitoring and permissions still work through hooks once the CLI is installed.
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Open Installation Guide")
        alert.addButton(withTitle: "Check Again")
        alert.addButton(withTitle: "Cancel")

        let response = alert.runModal()
        switch response {
        case .alertFirstButtonReturn:
            if let url = installGuideURLs[agent] {
                NSWorkspace.shared.open(url)
            }
            // Re-open the prompt after the user has a chance to follow the
            // guide — this keeps the flow alive without requiring them to
            // re-click "Launch Session" in the menu bar.
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                showAgentInstallPrompt(agent: agent)
            }
        case .alertSecondButtonReturn:
            // Re-check installation. If now installed, silently return — the
            // caller re-runs findClaude()/findInstalledBridge() on next launch
            // attempt. If still missing, show the prompt again so the user
            // isn't stuck in a dead end.
            let stillMissing: Bool
            switch agent {
            case .claudeCode, .claudePlain:
                stillMissing = !isClaudeInstalled() && !isBridgeInstalled()
            case .codex, .opencode:
                stillMissing = !isBridgeInstalled()
            }
            if stillMissing {
                showAgentInstallPrompt(agent: agent)
            }
        default:
            return
        }
    }
    #endif

    // MARK: - Helpers

    private static func shellEscape(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }
}
#endif
