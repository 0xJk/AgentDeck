// SessionListPanel.swift — Agent session list panel (matches Android SessionListPanel.kt)

import SwiftUI

// MARK: - Terrarium HUD Colors (matching Android TerrariumColors)

enum TerrariumHUD {
    static let bg = Color.black.opacity(0.5)                       // 0x80000000
    static let text = Color(red: 0.886, green: 0.91, blue: 0.941) // #E2E8F0
    static let subtext = Color(red: 0.58, green: 0.64, blue: 0.72) // #94A3B8
    static let ledGreen = Color(red: 0.133, green: 0.773, blue: 0.369)  // #22C55E
    static let ledAmber = Color(red: 0.984, green: 0.749, blue: 0.141)  // #FBBF24
    static let ledRed = Color(red: 0.937, green: 0.267, blue: 0.267)    // #EF4444
    static let tetraNeon = Color(red: 0, green: 0.898, blue: 1)         // #00E5FF
    static let claudeBody = Color(red: 0.753, green: 0.439, blue: 0.345) // #C07058
}

struct SessionListPanel: View {
    @Environment(AgentStateHolder.self) private var stateHolder

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Brand logo (matches AgentDeckLogo TabletLogo)
            VStack(spacing: 3) {
                Text("AgentDeck")
                    .font(.system(size: 24, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
                    .frame(maxWidth: .infinity)

                // Neon cyan underline bar (glow + crisp)
                Canvas { context, size in
                    let barWidth = size.width * 0.8
                    let x = (size.width - barWidth) / 2

                    // Glow layer
                    let glowRect = CGRect(x: x, y: 0, width: barWidth, height: 3)
                    context.fill(Path(roundedRect: glowRect, cornerRadius: 1.5),
                                 with: .color(TerrariumHUD.tetraNeon.opacity(0.3)))

                    // Crisp bar
                    let barRect = CGRect(x: x, y: 3, width: barWidth, height: 2)
                    context.fill(Path(roundedRect: barRect, cornerRadius: 1),
                                 with: .color(TerrariumHUD.tetraNeon))
                }
                .frame(height: 5)
            }

            Spacer().frame(height: 4)

            // Build unified entry list
            let entries = buildEntries()
            let nameCounts = Dictionary(grouping: entries, by: { "\($0.projectName)|\($0.agentType ?? "")" })
                .mapValues(\.count)
            var counters: [String: Int] = [:]

            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                let key = "\(entry.projectName)|\(entry.agentType ?? "")"
                let needsSuffix = (nameCounts[key] ?? 1) > 1
                let suffix: String = {
                    if needsSuffix {
                        let idx = (counters[key] ?? 0) + 1
                        counters[key] = idx
                        return " #\(idx)"
                    }
                    return ""
                }()

                sessionRow(entry: entry, suffix: suffix)
            }

            // Worker count
            if let count = stateHolder.state.workerSessionCount, count > 0 {
                Text("Workers: \(count)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
            }
        }
        .padding(8)
        .background(TerrariumHUD.bg, in: RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Entry Builder

    private struct SessionEntry {
        let projectName: String
        let agentType: String?
        let modelName: String?
        let effortLevel: String?
        let state: AgentConnectionState
        let isPrimary: Bool
    }

    private func buildEntries() -> [SessionEntry] {
        var entries: [SessionEntry] = []

        // Daemon-like detection: skip primary if daemon, or if sessions already
        // contains an entry with the same agentType (daemon relaying OpenClaw
        // sets agentType='openclaw' but sessions_list already has the virtual entry)
        let isDaemonLike = stateHolder.state.agentType == "daemon" ||
            stateHolder.state.siblingSessions.contains(where: {
                $0.agentType == stateHolder.state.agentType
            })

        if !isDaemonLike {
            entries.append(SessionEntry(
                projectName: stateHolder.state.projectName ?? "Agent",
                agentType: stateHolder.state.agentType,
                modelName: stateHolder.state.modelName,
                effortLevel: stateHolder.state.effortLevel,
                state: stateHolder.state.state,
                isPrimary: true
            ))
        }

        // Siblings (skip self and daemon)
        for sibling in stateHolder.state.siblingSessions {
            if sibling.id == stateHolder.state.sessionId { continue }
            if sibling.agentType == "daemon" { continue }
            entries.append(SessionEntry(
                projectName: sibling.projectName ?? "Agent",
                agentType: sibling.agentType,
                modelName: nil,
                effortLevel: nil,
                state: AgentConnectionState(rawValue: sibling.state ?? "") ?? .disconnected,
                isPrimary: false
            ))
        }

        return entries
    }

    // MARK: - Session Row (matches Android CompactLogRow style)

    private func sessionRow(entry: SessionEntry, suffix: String) -> some View {
        HStack(spacing: 6) {
            // State color dot (6dp)
            Circle()
                .fill(stateColor(entry.state))
                .frame(width: 6, height: 6)
                .padding(.top, 4)

            VStack(alignment: .leading, spacing: 1) {
                // Icon + session name
                Text("\(agentIcon(for: entry.agentType)) \(entry.projectName)\(suffix)")
                    .font(.system(size: 12, weight: entry.isPrimary ? .bold : .regular))
                    .foregroundStyle(TerrariumHUD.text)
                    .lineLimit(2)

                // Model · effort · state (subline)
                let subLine = buildSubLine(entry: entry)
                Text(subLine)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .lineLimit(1)
            }

            Spacer()
        }
    }

    private func buildSubLine(entry: SessionEntry) -> String {
        let stateMarker = compactStateMarker(entry.state)
        var parts: [String] = []
        if let model = entry.modelName {
            parts.append(model)
        }
        if let effort = entry.effortLevel, effort != "medium" {
            parts.append(effort)
        }
        if !parts.isEmpty {
            return parts.joined(separator: " · ") + " · " + stateMarker
        }
        return stateMarker
    }

    // MARK: - Helpers

    private func agentIcon(for agentType: String?) -> String {
        switch agentType {
        case "openclaw": "🦞"
        case "claude-code": "🐙"
        default: "●"
        }
    }

    private func compactStateMarker(_ state: AgentConnectionState) -> String {
        switch state {
        case .idle: "● IDLE"
        case .processing: "◉ PROC"
        case .awaitingPermission: "⚠ PERM"
        case .awaitingOption: "◇ SEL"
        case .awaitingDiff: "□ DIFF"
        case .disconnected: "○ OFF"
        }
    }

    private func stateColor(_ state: AgentConnectionState) -> Color {
        switch state {
        case .idle: TerrariumHUD.ledGreen
        case .processing: Color(red: 0.231, green: 0.51, blue: 0.965) // #3B82F6
        case .awaitingPermission, .awaitingOption, .awaitingDiff: TerrariumHUD.ledAmber
        case .disconnected: TerrariumHUD.subtext
        }
    }
}
