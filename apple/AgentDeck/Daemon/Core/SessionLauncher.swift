#if os(macOS)
// SessionLauncher.swift — Launch agentdeck claude session from app
// Bundles Node.js + bridge JS in app Resources, opens Terminal.app

import Foundation
import AppKit

enum SessionLauncher {
    /// Launch a Claude Code session in Terminal.app using bundled or installed bridge
    static func launchSession(project: String? = nil) {
        // Priority: 1) installed CLI 2) bundled in app Resources
        let command: String
        if let installedPath = findInstalledBridge() {
            command = "\(installedPath) claude"
        } else if let bundledPath = findBundledBridge() {
            let nodePath = findBundledNode() ?? "node"
            command = "\(nodePath) \(bundledPath) claude"
        } else {
            // No bridge available — open install instructions
            DaemonLogger.shared.info("Session bridge not found, showing install prompt")
            showInstallPrompt()
            return
        }

        let fullCommand = project != nil ? "\(command) --project \(project!)" : command
        openInTerminal(fullCommand)
    }

    /// Check if Claude Code CLI is installed
    static func isClaudeInstalled() -> Bool {
        shell("which", "claude") != nil
    }

    /// Check if agentdeck bridge CLI is installed
    static func isBridgeInstalled() -> Bool {
        findInstalledBridge() != nil
    }

    // MARK: - Bridge Discovery

    private static func findInstalledBridge() -> String? {
        // Check common locations
        let candidates = [
            "/usr/local/bin/agentdeck",
            "/opt/homebrew/bin/agentdeck",
        ]
        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        // Try which
        return shell("which", "agentdeck")
    }

    private static func findBundledBridge() -> String? {
        // Check app bundle Resources
        guard let resourcePath = Bundle.main.resourcePath else { return nil }
        let bridgePath = (resourcePath as NSString).appendingPathComponent("bridge/cli.js")
        return FileManager.default.fileExists(atPath: bridgePath) ? bridgePath : nil
    }

    private static func findBundledNode() -> String? {
        guard let resourcePath = Bundle.main.resourcePath else { return nil }
        let nodePath = (resourcePath as NSString).appendingPathComponent("node")
        return FileManager.default.isExecutableFile(atPath: nodePath) ? nodePath : nil
    }

    // MARK: - Terminal Launch

    private static func openInTerminal(_ command: String) {
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
                DaemonLogger.shared.error("Failed to launch Terminal: \(error)")
            }
        }
    }

    // MARK: - Install Prompt

    private static func showInstallPrompt() {
        let alert = NSAlert()
        alert.messageText = "Session Bridge Not Found"
        alert.informativeText = """
        To launch Claude Code sessions with full Stream Deck control, install the AgentDeck bridge:

        npm install -g @agentdeck/bridge

        Without it, you can still use Claude Code normally — monitoring and permissions work via hooks.
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Copy Install Command")
        alert.addButton(withTitle: "OK")

        if alert.runModal() == .alertFirstButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString("npm install -g @agentdeck/bridge", forType: .string)
        }
    }

    // MARK: - Helpers

    private static func shell(_ args: String...) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch { return nil }
    }
}
#endif
