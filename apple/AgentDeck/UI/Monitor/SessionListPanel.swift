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
    @EnvironmentObject private var stateHolder: AgentStateHolder

    /// Maximum visible sessions before showing overflow summary
    private let maxVisibleSessions = 10

    /// Id of the session row with its "Jump to…" grid expanded. macOS-only
    /// because `SessionJumpLauncher` launches AppKit workspace URLs.
    @State private var expandedSessionId: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Brand logo — stacked-deck mark + "AgentDeck" wordmark. Unified
            // with the menubar brand direction so the same logo shape appears
            // in both surfaces, just retinted (neon cyan for the aquarium
            // HUD vs the menubar's system-primary).
            HStack(spacing: 6) {
                AgentDeckLogo(size: 20, color: TerrariumHUD.tetraNeon)
                Text("AgentDeck")
                    .font(.system(size: 22, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
            }
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

            Spacer().frame(height: 4)

            // Build unified entry list
            let entries = buildEntries()
            let nameCounts = Dictionary(grouping: entries, by: { "\($0.projectName)|\($0.agentType ?? "")" })
                .mapValues(\.count)
            var counters: [String: Int] = [:]

            let visibleEntries = entries.count > maxVisibleSessions
                ? Array(entries.prefix(maxVisibleSessions))
                : entries

            ForEach(Array(visibleEntries.enumerated()), id: \.offset) { _, entry in
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

                sessionRowInteractive(entry: entry, suffix: suffix)
            }

            // Overflow indicator
            if entries.count > maxVisibleSessions {
                Text("and \(entries.count - maxVisibleSessions) more...")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
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
        .opacity(stateHolder.state.bridgeConnected ? 1.0 : 0.6)
    }

    // MARK: - Entry Builder

    private struct SessionEntry {
        let projectName: String
        let agentType: String?
        let modelName: String?
        let effortLevel: String?
        let state: AgentConnectionState
        let isPrimary: Bool
        /// Underlying `SessionInfo.id` for siblings. Nil for the primary
        /// (local) session, which uses `stateHolder.state.sessionId` as
        /// the focus target.
        let sessionId: String?

        /// Stable key used for `expandedSessionId` so tapping the same row
        /// twice toggles it closed even when the underlying sibling list
        /// re-orders. Primary session falls back to a composite key since
        /// it doesn't have a session.id from the SessionInfo list.
        func stableId(suffix: String) -> String {
            if let sid = sessionId { return sid }
            return "primary|\(projectName)|\(agentType ?? "")\(suffix)"
        }
    }

    private func buildEntries() -> [SessionEntry] {
        var entries: [SessionEntry] = []

        // Daemon/gateway state_updates are aggregate rows, not user sessions.
        // Focus-relayed state_updates, however, promote one real session into
        // the primary fields while the canonical sessions_list still contains
        // the same session. Deduplicate by session id only; using agentType
        // hid the focused Codex/Claude row whenever another session of the same
        // type was present, while the terrarium still rendered the promoted
        // creature.
        let primarySessionId = stateHolder.state.sessionId
        let primaryBackedBySibling = primarySessionId != nil &&
            stateHolder.state.siblingSessions.contains(where: { $0.id == primarySessionId })
        let duplicatePrimaryWithoutId = primarySessionId == nil &&
            stateHolder.state.agentType != nil &&
            stateHolder.state.siblingSessions.contains(where: {
                $0.agentType == stateHolder.state.agentType
            })
        let shouldShowPrimary = stateHolder.state.agentType != "daemon" &&
            stateHolder.state.agentType != "openclaw" &&
            (primaryBackedBySibling || !duplicatePrimaryWithoutId)

        if shouldShowPrimary {
            entries.append(SessionEntry(
                projectName: stateHolder.state.projectName ?? "Agent",
                agentType: stateHolder.state.agentType,
                modelName: stateHolder.state.modelName,
                effortLevel: stateHolder.state.effortLevel,
                state: stateHolder.state.state,
                isPrimary: true,
                sessionId: stateHolder.state.sessionId
            ))
        }

        // Siblings (skip daemon, and the focused session iff primary already
        // represents it). Suppressing the focused id unconditionally hid newly
        // started sessions for 5–15 s in daemon/openclaw mode: the daemon
        // stamps `state.sessionId` with `currentHookSessionId` on every
        // `state_update`, but `shouldShowPrimary` is false there, so the
        // session disappeared from both primary and sibling rows until another
        // hook flipped `currentHookSessionId` away. Mirrors the
        // `primaryIsOctopus &&` gate in TerrariumState.toTerrariumState.
        let siblings = stateHolder.state.siblingSessions
            .filter { sibling in
                guard sibling.agentType != "daemon" else { return false }
                if shouldShowPrimary && sibling.id == stateHolder.state.sessionId {
                    return false
                }
                return true
            }
            .sorted {
                let r0 = Self.agentTypeRank($0.agentType), r1 = Self.agentTypeRank($1.agentType)
                if r0 != r1 { return r0 < r1 }
                return ($0.projectName ?? "") < ($1.projectName ?? "")
            }
        for sibling in siblings {
            entries.append(SessionEntry(
                projectName: sibling.projectName ?? "Agent",
                agentType: sibling.agentType,
                modelName: sibling.modelName,
                effortLevel: sibling.effortLevel,
                // alive=true (we already filter siblings via isDaemonLike, and the
                // wire payload always sets alive=true for the OC virtual session)
                // — fall back to .idle for unknown/empty state to match
                // ControlTowerPanel.sessionState(_:) and Android mapSessionState.
                // .disconnected fallback caused OC to render as OFF during the
                // brief race window before stateMachine transitioned out of
                // .disconnected on gateway connect.
                state: AgentConnectionState(rawValue: sibling.state ?? "") ?? .idle,
                isPrimary: false,
                sessionId: sibling.id
            ))
        }

        return entries
    }

    // MARK: - Session Row (interactive wrapper + row)

    /// Row wrapper that handles taps:
    /// * Always: `focusSession` so the dashboard/terrarium centers this
    ///   session. Mirrors the existing creature-tap behavior.
    /// * macOS: toggles a "Jump to…" grid beneath the row (iTerm / VS Code /
    ///   Cursor / Reveal folder). Dashboard itself isn't a jump target from
    ///   here since we're already in it.
    @ViewBuilder
    private func sessionRowInteractive(entry: SessionEntry, suffix: String) -> some View {
        let rowId = entry.stableId(suffix: suffix)
        VStack(alignment: .leading, spacing: 2) {
            Button {
                if let sid = entry.sessionId {
                    stateHolder.sendCommand(.focusSession(sessionId: sid))
                }
                #if os(macOS)
                expandedSessionId = (expandedSessionId == rowId) ? nil : rowId
                #endif
            } label: {
                sessionRow(entry: entry, suffix: suffix)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            #if os(macOS)
            if expandedSessionId == rowId {
                jumpGrid(for: entry)
                    .transition(.opacity)
            }
            #endif
        }
    }

    #if os(macOS)
    /// 4-cell "Jump to…" grid rendered in terrarium dark palette. Dashboard
    /// is absent (we're already here); Reveal folder is included but only
    /// fires if we have a project path — today SessionInfo doesn't carry
    /// one, so it falls back to just launching Finder.
    private func jumpGrid(for entry: SessionEntry) -> some View {
        let targets: [SessionJumpRow.JumpTarget] = [.iterm, .vscode, .cursor, .finder]
        return HStack(spacing: 3) {
            ForEach(targets) { target in
                Button {
                    SessionJumpLauncher.launch(target, projectPath: nil)
                } label: {
                    VStack(spacing: 1) {
                        Image(systemName: target.symbol)
                            .font(.system(size: 11))
                        Text(target.label)
                            .font(.system(size: 8, design: .monospaced))
                            .lineLimit(1)
                    }
                    .foregroundStyle(TerrariumHUD.text)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.black.opacity(0.5))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(TerrariumHUD.tetraNeon.opacity(0.25), lineWidth: 0.5)
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 2)
        .padding(.bottom, 4)
    }
    #endif

    private func sessionRow(entry: SessionEntry, suffix: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            // Icon + session name
            HStack(spacing: 4) {
                agentIconView(for: entry.agentType)
                Text("\(entry.projectName)\(suffix)")
                    .font(.system(size: 12, weight: entry.isPrimary ? .bold : .regular))
                    .foregroundStyle(TerrariumHUD.text)
                    .lineLimit(2)
            }

            // Model · effort · state (state colored)
            let subLine = buildSubLine(entry: entry)
            Text(subLine)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(stateColor(entry.state))
                .lineLimit(1)
        }
    }

    private func buildSubLine(entry: SessionEntry) -> String {
        let stateMarker = compactStateMarker(entry.state)
        var parts: [String] = []
        if let model = entry.modelName {
            parts.append(model)
        }
        // Skip neutral efforts — "medium" (legacy default) and "default"
        // (Claude Code 2.1+ per-model default). Show everything else
        // (max/xhigh/high/low/fast) so users can see non-default choices.
        if let effort = entry.effortLevel, effort != "medium", effort != "default" {
            parts.append(effort)
        }
        if !parts.isEmpty {
            return parts.joined(separator: " · ") + " · " + stateMarker
        }
        return stateMarker
    }

    // MARK: - Helpers

    // MARK: - Brand Icons (SVG path data, viewBox 0 0 24 24)

    @ViewBuilder
    private func agentIconView(for agentType: String?) -> some View {
        switch agentType {
        case "claude-code", "codex-cli", "openclaw", "opencode":
            SessionCreatureIcon(
                agentType: agentType,
                tint: SessionBrand.color(for: agentType),
                size: 13
            )
            .padding(1.5)
            .frame(width: 16, height: 16)
        default:
            Text("●")
                .font(.system(size: 8))
                .foregroundStyle(TerrariumHUD.subtext)
                .frame(width: 16, height: 16)
        }
    }

}

// MARK: - Brand Icon (SVG path rendered as SwiftUI Shape)

private struct BrandIcon: View {
    let paths: [String]
    let color: Color
    let eoFill: Bool
    private static let viewBox: CGFloat = 24

    init(pathData: String, color: Color, eoFill: Bool = false) {
        self.paths = [pathData]
        self.color = color
        self.eoFill = eoFill
    }

    init(paths: [String], color: Color, eoFill: Bool = false) {
        self.paths = paths
        self.color = color
        self.eoFill = eoFill
    }

    // Claude — sparkle mark
    static let claudePath =
        "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"

    // OpenAI — knot mark (Codex CLI)
    static let openaiPath =
        "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"

    // OpenCode — nested-square logo (viewBox 0 0 24 24, evenodd)
    static let opencodePath =
        "M18 19.2H6V9.6H18V19.2ZM18 4.8H6V19.2H18V4.8ZM24 24H0V0H24V24Z"

    // OpenClaw — front-facing crayfish (multi-path)
    static let openclawPaths: [String] = [
        "M9.046 7.104a.527.527 0 110 1.055.527.527 0 010-1.055z",
        "M15.376 7.104a.528.528 0 110 1.056.528.528 0 010-1.056z",
        "M16.877 1.912c.58-.27 1.14-.323 1.616-.037a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.068-.352.165-.765.45-1.234.866 2.683 1.17 4.4 3.5 5.148 5.921a6.421 6.421 0 00-.704.184c-.578.016-1.174.204-1.502.735-.338.55-.268 1.276.072 2.069l.005.012.007.014c.523 1.045 1.318 1.91 2.2 2.284-.912 3.274-3.44 6.144-5.972 6.988v2.109h-2.11v-2.11c-1.043.417-2.086.01-2.11 0v2.11h-2.11v-2.11c-2.531-.843-5.061-3.713-5.973-6.987.882-.373 1.678-1.238 2.2-2.284l.007-.014.006-.012c.34-.793.41-1.518.071-2.069-.327-.531-.923-.719-1.503-.735a6.409 6.409 0 00-.704-.183c.749-2.421 2.466-4.751 5.149-5.922-.47-.416-.88-.701-1.234-.866-.474-.221-.794-.204-1.021-.068a.318.318 0 01-.435-.109.317.317 0 01.109-.433c.476-.286 1.036-.233 1.615.037.49.229 1.031.628 1.621 1.182A9.924 9.924 0 0112 2.568c1.199 0 2.284.19 3.256.526.59-.554 1.13-.953 1.62-1.182zM8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532zm6.33 0a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z",
        "M.395 13.118c-.966-1.932-.163-3.863 2.41-3.365v-.001l.05.01c.084.018.17.038.26.06.033.009.067.017.1.027.084.022.168.048.255.076l.09.027c.528 0 .95.158 1.16.501.212.343.212.87-.105 1.61-.085.17-.178.333-.276.489l-.01.017a4.967 4.967 0 01-.62.791l-.019.02c-1.092 1.117-2.496 1.336-3.295-.262z",
        "M21.193 9.753c2.574-.5 3.378 1.433 2.411 3.365-.58 1.159-1.476 1.361-2.342.96l-.011-.005a2.419 2.419 0 01-.114-.056l-.019-.01a2.751 2.751 0 01-.115-.067l-.023-.014c-.035-.022-.071-.044-.106-.068l-.05-.035c-.55-.388-1.062-1.007-1.44-1.76-.276-.647-.311-1.132-.174-1.472.176-.439.636-.639 1.23-.639.032-.011.066-.02.099-.03.08-.026.16-.05.238-.072l.117-.03a5.502 5.502 0 01.3-.067z",
    ]

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / Self.viewBox
            context.drawLayer { ctx in
                ctx.scaleBy(x: scale, y: scale)
                let style = FillStyle(eoFill: eoFill)
                for pathData in paths {
                    let path = CrayfishCreature.parseSvgPath(pathData)
                    ctx.fill(path, with: .color(color), style: style)
                }
            }
        }
        .frame(width: 13, height: 13)
    }
}

private extension SessionListPanel {
    static func agentTypeRank(_ agentType: String?) -> Int {
        DashboardDataRules.agentTypeRank(agentType)
    }

    static func stateRank(_ state: AgentConnectionState) -> Int {
        switch state {
        case .processing: 0
        case .awaitingPermission, .awaitingOption, .awaitingDiff: 1
        case .idle: 2
        case .disconnected: 3
        }
    }

    func compactStateMarker(_ state: AgentConnectionState) -> String {
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
