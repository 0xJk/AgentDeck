// SessionJumpRow.swift — Session list row with expandable "Jump to…" grid
// Ported from design prototype `option-d.jsx::SessionRowD`.
// Tap row → expands a 5-cell grid (iTerm2 / VS Code / Cursor / Dashboard /
// Reveal folder) that launches the matching app. `projectPath` on the
// underlying `SessionInfo` is not populated today, so path-aware launches
// fall back to launching the target app's default state.

#if os(macOS)
import SwiftUI
import AppKit

struct SessionJumpRow: View {
    let session: SessionInfo
    /// Live tool name (e.g., "Bash", "Write file"). Only populated for the
    /// focused session — the bridge protocol streams tool state for one
    /// session at a time. Matches `session.tool` from the JS prototype.
    var tool: String? = nil
    let expanded: Bool
    let onToggle: () -> Void
    let onJumpDashboard: () -> Void
    let onJumpExternal: (JumpTarget) -> Void

    enum JumpTarget: String, CaseIterable, Identifiable {
        case iterm, vscode, cursor, dashboard, finder
        var id: String { rawValue }

        var label: String {
            switch self {
            case .iterm:     return "iTerm2"
            case .vscode:    return "VS Code"
            case .cursor:    return "Cursor"
            case .dashboard: return "Dashboard"
            case .finder:    return "Reveal folder"
            }
        }

        var symbol: String {
            switch self {
            case .iterm:     return "terminal"
            case .vscode:    return "chevron.left.forwardslash.chevron.right"
            case .cursor:    return "cursorarrow"
            case .dashboard: return "square.grid.2x2"
            case .finder:    return "folder"
            }
        }
    }

    private var state: AgentConnectionState {
        AgentConnectionState(rawValue: session.state ?? "idle") ?? .idle
    }

    private var stateDotColor: Color {
        switch state {
        case .processing: .cyan
        case .awaitingPermission, .awaitingOption, .awaitingDiff: .orange
        case .idle: .green
        case .disconnected: .gray
        }
    }

    private var brandColor: Color { SessionBrand.color(for: session.agentType) }

    private var agentLabel: String { displayAgentLabel(session.agentType) }

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onToggle) {
                HStack(spacing: 8) {
                    ZStack(alignment: .topTrailing) {
                        SessionCreatureIcon(
                            agentType: session.agentType,
                            tint: brandColor,
                            size: 22
                        )
                        .opacity(state == .disconnected ? 0.35 : 1.0)
                        Circle()
                            .fill(stateDotColor)
                            .frame(width: 7, height: 7)
                            .overlay(
                                Circle()
                                    .stroke(TerrariumColors.deepSea, lineWidth: 1.5)
                            )
                            .offset(x: 3, y: -2)
                    }
                    .frame(width: 24, height: 22)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(session.projectName ?? "Unknown")
                            .font(.system(size: 12, weight: .semibold))
                            .lineLimit(1)
                        Text(subtitleText)
                            .font(.system(size: 10))
                            .foregroundColor(TerrariumHUD.subtext)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 4)

                    if let started = relativeTime(session.startedAt) {
                        Text(started)
                            .font(.system(size: 9.5, design: .monospaced))
                            .foregroundColor(TerrariumHUD.subtext)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(TerrariumHUD.subtext)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    Text("JUMP TO")
                        .font(.system(size: 9.5, weight: .semibold))
                        .kerning(0.5)
                        .foregroundColor(TerrariumHUD.subtext)
                        .padding(.horizontal, 4)
                        .padding(.top, 5)
                        .padding(.bottom, 3)

                    HStack(spacing: 4) {
                        ForEach(JumpTarget.allCases) { t in
                            jumpCell(t)
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
                .overlay(
                    Rectangle()
                        .fill(Color.white.opacity(0.08))
                        .frame(height: 0.5),
                    alignment: .top
                )
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(expanded ? Color.white.opacity(0.07) : Color.white.opacity(0.04))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.white.opacity(0.10), lineWidth: 0.5)
        )
    }

    private var subtitleText: String {
        var parts: [String] = [agentLabel]
        if let model = session.modelName, !model.isEmpty {
            parts.append(shortModel(model))
        }
        if let tool, !tool.isEmpty {
            parts.append(tool)
        }
        return parts.joined(separator: " · ")
    }

    private func jumpCell(_ target: JumpTarget) -> some View {
        Button {
            if target == .dashboard {
                onJumpDashboard()
            } else {
                onJumpExternal(target)
            }
        } label: {
            VStack(spacing: 2) {
                Image(systemName: target.symbol)
                    .font(.system(size: 13))
                Text(target.label)
                    .font(.system(size: 9))
                    .foregroundColor(TerrariumHUD.subtext)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.white.opacity(0.08))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(Color.white.opacity(0.12), lineWidth: 0.5)
            )
            .foregroundColor(TerrariumHUD.text)
        }
        .buttonStyle(.plain)
    }

    private func shortModel(_ name: String) -> String { displayShortModelName(name) }

    private func relativeTime(_ iso: String?) -> String? { displayRelativeTime(iso) }
}

// MARK: - Jump launcher

/// Light wrapper around `NSWorkspace.open(_:configuration:)` that launches
/// external apps by bundle identifier. We prefer bundle IDs over .app paths
/// so sandbox-friendly operations keep working even when the user installs
/// a target app outside /Applications.
enum SessionJumpLauncher {
    static func launch(_ target: SessionJumpRow.JumpTarget, projectPath: String? = nil) {
        let bundleId: String?
        switch target {
        case .iterm:  bundleId = "com.googlecode.iterm2"
        case .vscode: bundleId = "com.microsoft.VSCode"
        case .cursor: bundleId = "com.todesktop.230313mzl4w4u92"   // Cursor's Electron bundle id
        case .dashboard, .finder: bundleId = nil
        }

        // Reveal a path in Finder (or launch Finder bare).
        if target == .finder {
            if let projectPath, !projectPath.isEmpty,
               FileManager.default.fileExists(atPath: projectPath) {
                NSWorkspace.shared.activateFileViewerSelecting(
                    [URL(fileURLWithPath: projectPath)]
                )
            } else if let finder = NSWorkspace.shared.urlForApplication(
                withBundleIdentifier: "com.apple.finder"
            ) {
                let cfg = NSWorkspace.OpenConfiguration()
                cfg.activates = true
                NSWorkspace.shared.openApplication(at: finder, configuration: cfg, completionHandler: nil)
            }
            return
        }

        guard let bundleId else { return }

        // App-specific path-aware launches. The `open(_:withApplicationAt:)`
        // API accepts a list of files to pass to the target application, so
        // if we know the project path we hand it over; otherwise we just
        // launch the app.
        if let projectPath, !projectPath.isEmpty,
           FileManager.default.fileExists(atPath: projectPath),
           let appUrl = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.activates = true
            NSWorkspace.shared.open(
                [URL(fileURLWithPath: projectPath)],
                withApplicationAt: appUrl,
                configuration: cfg,
                completionHandler: nil
            )
            return
        }

        // No path → just bring the app forward.
        if let appUrl = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.activates = true
            NSWorkspace.shared.openApplication(at: appUrl, configuration: cfg, completionHandler: nil)
        }
    }
}
#endif
