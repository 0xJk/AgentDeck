// ControlTowerPanel.swift — Rich MenuBarExtra panel for macOS
// Replaces the simple .menu style with a window-style control tower

#if os(macOS)
import SwiftUI

struct ControlTowerPanel: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var daemonService: DaemonService
    @EnvironmentObject private var preferences: AppPreferences
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 0) {
            headerSection
            Divider().overlay(Color.gray.opacity(0.3))

            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 12) {
                    if !attentionSessions.isEmpty {
                        attentionSection
                    }
                    if !activeSessions.isEmpty {
                        activeSection
                    }
                    if !idleSessions.isEmpty {
                        idleSection
                    }
                    modelsAndServicesSection
                    devicesSection
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }

            Divider().overlay(Color.gray.opacity(0.3))
            actionsBar
            Divider().overlay(Color.gray.opacity(0.3))
            footerSection
        }
        .frame(width: 340, height: 560)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Session Classification

    private var sortedSessions: [SessionInfo] {
        stateHolder.state.siblingSessions
            .filter { $0.alive }
            .sorted { lhs, rhs in
                let lr = sessionRank(lhs)
                let rr = sessionRank(rhs)
                if lr != rr { return lr < rr }
                return (lhs.projectName ?? "") < (rhs.projectName ?? "")
            }
    }

    private var attentionSessions: [SessionInfo] {
        sortedSessions.filter { sessionState($0).isAwaiting }
    }

    private var activeSessions: [SessionInfo] {
        sortedSessions.filter { sessionState($0) == .processing }
    }

    private var idleSessions: [SessionInfo] {
        sortedSessions.filter {
            let s = sessionState($0)
            return s == .idle || s == .disconnected
        }
    }

    private func sessionState(_ session: SessionInfo) -> AgentConnectionState {
        AgentConnectionState(rawValue: session.state ?? "idle") ?? .idle
    }

    private func sessionRank(_ session: SessionInfo) -> Int {
        switch sessionState(session) {
        case .processing: return 0
        case .awaitingPermission, .awaitingOption, .awaitingDiff: return 1
        case .idle: return 2
        case .disconnected: return 3
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("AgentDeck Control Tower")
                    .font(.system(size: 13, weight: .semibold))
                let sessionCount = sortedSessions.count
                let activeCount = activeSessions.count
                let attentionCount = attentionSessions.count
                HStack(spacing: 0) {
                    Text("\(sessionCount) session\(sessionCount == 1 ? "" : "s")")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    if activeCount > 0 {
                        Text(" · \(activeCount) active")
                            .font(.system(size: 11))
                            .foregroundStyle(.cyan)
                    }
                    if attentionCount > 0 {
                        Text(" · \(attentionCount) attention")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.orange)
                    }
                }
            }
            Spacer()
            daemonStatusBadge
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var daemonStatusBadge: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(daemonService.isRunning || daemonService.isUsingExternalDaemon
                      ? Color.green : Color.red)
                .frame(width: 7, height: 7)
            if daemonService.isRunning {
                Text(verbatim: ":\(daemonService.port)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
            } else if daemonService.isUsingExternalDaemon {
                Text(verbatim: daemonService.ownsExternalDaemon ? "d2h :\(daemonService.port)" : "ext :\(daemonService.port)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Attention Section

    private var attentionSection: some View {
        SectionContainer(title: "ATTENTION", titleColor: .orange) {
            ForEach(attentionSessions) { session in
                sessionRow(session, stateLabel: sessionState(session).displayLabel, stateLabelColor: .orange)
            }
            Button {
                openDashboard()
            } label: {
                Text("Open in Dashboard")
                    .font(.system(size: 11))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    // MARK: - Active Section

    private var activeSection: some View {
        SectionContainer(title: "PROCESSING", titleColor: .cyan) {
            ForEach(activeSessions) { session in
                sessionRow(session, extraDetail: currentToolFor(session))
            }
        }
    }

    // MARK: - Idle Section

    private var idleSection: some View {
        SectionContainer(title: "IDLE", titleColor: .green) {
            ForEach(idleSessions) { session in
                sessionRow(session)
            }
        }
    }

    // MARK: - Unified Session Row

    @ViewBuilder
    private func sessionRow(
        _ session: SessionInfo,
        stateLabel: String? = nil,
        stateLabelColor: Color? = nil,
        extraDetail: String? = nil
    ) -> some View {
        HStack(spacing: 8) {
            sessionIcon(session)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.projectName ?? "Unknown")
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                // Subtitle: agentType · modelName · Xm ago
                HStack(spacing: 0) {
                    if let stateLabel {
                        Text(stateLabel)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(stateLabelColor ?? .secondary)
                        Text(" · ")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                    if let type = session.agentType {
                        Text(agentTypeLabel(type))
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                    if let model = session.modelName {
                        Text(" · ")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                        Text(shortModelName(model))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    if let time = relativeTimeString(from: session.startedAt) {
                        Text(" · \(time)")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                    if let extra = extraDetail {
                        Text(" · ")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                        Text(extra)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            Spacer()
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture {
            stateHolder.sendCommand(.focusSession(sessionId: session.id))
            openDashboard()
        }
    }

    // MARK: - Session Icon (Creature asset in brand color + state dot)

    private func sessionIcon(_ session: SessionInfo) -> some View {
        let state = sessionState(session)
        return ZStack(alignment: .topTrailing) {
            SessionCreatureIcon(
                agentType: session.agentType,
                tint: SessionBrand.color(for: session.agentType),
                size: 22
            )
            .opacity(state == .disconnected ? 0.35 : 1.0)
            // Small state dot anchored to the creature so both brand and
            // state are visible at a glance.
            Circle()
                .fill(stateColor(state))
                .frame(width: 6, height: 6)
                .overlay(
                    Circle()
                        .stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 1)
                )
                .offset(x: 2, y: -2)
        }
        .frame(width: 24, height: 24)
    }

    private func stateColor(_ state: AgentConnectionState) -> Color {
        switch state {
        case .processing: .cyan
        case .awaitingPermission, .awaitingOption, .awaitingDiff: .orange
        case .idle: .green
        case .disconnected: .gray
        }
    }

    // MARK: - Models & Services

    private var modelsAndServicesSection: some View {
        SectionContainer(title: "MODELS & SERVICES", titleColor: .secondary) {
            // Claude / OAuth
            claudeRow

            // OpenClaw / Gateway
            if stateHolder.state.gatewayAvailable || stateHolder.state.gatewayHasError {
                gatewayRow
            }

            // Ollama
            if let ollama = stateHolder.state.ollamaStatus {
                ollamaRow(ollama)
            }

            // MLX
            if !stateHolder.state.mlxModels.isEmpty {
                mlxRow
            }

            // Rate Limits
            rateLimitsRow

            // Subscriptions
            if !stateHolder.state.subscriptions.isEmpty {
                subscriptionsRow
            }
        }
    }

    private var claudeRow: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: "cloud.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                Text("Claude")
                    .font(.system(size: 11, weight: .medium))
                Spacer()
                if stateHolder.state.oauthConnected == true {
                    Text("OAuth")
                        .font(.system(size: 10))
                        .foregroundStyle(.green)
                } else if stateHolder.state.oauthConnected == false {
                    Text("Not connected")
                        .font(.system(size: 10))
                        .foregroundStyle(.orange)
                }
            }
            let available = DashboardDataRules.sortedModelCatalog(stateHolder.state.modelCatalog)
                .filter(\.available)
            if !available.isEmpty {
                Text(available.map(\.name).joined(separator: ", "))
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }

    private var gatewayRow: some View {
        HStack(spacing: 4) {
            Image(systemName: "network")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
            Text("OpenClaw")
                .font(.system(size: 11, weight: .medium))
            Spacer()
            if stateHolder.state.gatewayHasError {
                Text("Error")
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
            } else {
                Text("Connected")
                    .font(.system(size: 10))
                    .foregroundStyle(.green)
            }
        }
    }

    private func ollamaRow(_ status: OllamaStatus) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: "cpu")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                Text("Ollama")
                    .font(.system(size: 11, weight: .medium))
                Spacer()
                Text(status.available ? "Running" : "Stopped")
                    .font(.system(size: 10))
                    .foregroundStyle(status.available ? .green : .secondary)
            }
            if !status.models.isEmpty {
                let modelDescs = status.models.map { m in
                    let sizeGB = String(format: "%.1fG", Double(m.size) / 1_073_741_824)
                    let vramGB = String(format: "%.1fG", Double(m.sizeVram) / 1_073_741_824)
                    return "\(m.name) \(sizeGB)/\(vramGB)"
                }
                Text(modelDescs.joined(separator: ", "))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }

    private var mlxRow: some View {
        HStack(spacing: 4) {
            Image(systemName: "apple.terminal")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
            Text("MLX")
                .font(.system(size: 11, weight: .medium))
            Spacer()
            Text(stateHolder.state.mlxModels.joined(separator: ", "))
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private var rateLimitsRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: "gauge.medium")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                Text("Rate Limits")
                    .font(.system(size: 11, weight: .medium))
                if stateHolder.state.usageStale == true {
                    Text("stale")
                        .font(.system(size: 9))
                        .foregroundStyle(.orange)
                }
            }
            if let pct5h = stateHolder.state.fiveHourPercent {
                rateLimitGauge(
                    label: "5h",
                    percent: pct5h,
                    previousPercent: stateHolder.state.previousFiveHourPercent,
                    resetTime: stateHolder.state.fiveHourResetsAt
                )
            }
            if let pct7d = stateHolder.state.sevenDayPercent {
                rateLimitGauge(
                    label: "7d",
                    percent: pct7d,
                    previousPercent: stateHolder.state.previousSevenDayPercent,
                    resetTime: stateHolder.state.sevenDayResetsAt
                )
            }
            if stateHolder.state.fiveHourPercent == nil && stateHolder.state.sevenDayPercent == nil {
                Text("No data")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func rateLimitGauge(label: String, percent: Double, previousPercent: Double?, resetTime: String?) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 20, alignment: .trailing)
            Text(gaugeString(percent))
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(gaugeColor(percent))
            // Trend arrow
            let arrow = trendArrow(percent, previousPercent)
            if !arrow.isEmpty {
                Text(arrow)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(arrow == "↑" ? .red : .green)
            }
            if let reset = resetTime {
                let formatted = formatResetTime(reset)
                if !formatted.isEmpty {
                    Text(formatted)
                        .font(.system(size: 10, weight: percent >= 70 ? .semibold : .regular))
                        .foregroundStyle(percent >= 70 ? .orange : .secondary)
                }
            }
        }
    }

    private var subscriptionsRow: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: "creditcard")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                Text("Subscriptions")
                    .font(.system(size: 11, weight: .medium))
            }
            ForEach(Array(stateHolder.state.subscriptions.enumerated()), id: \.offset) { _, sub in
                HStack(spacing: 4) {
                    Text(sub.name)
                        .font(.system(size: 10))
                    if let until = sub.until {
                        Spacer()
                        Text(formatSubscriptionDate(until))
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    // MARK: - Devices

    private var devicesSection: some View {
        SectionContainer(title: "DEVICES", titleColor: .secondary) {
            let entries = daemonService.deviceSummary.allEntries
            if entries.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "cable.connector.slash")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                    Text("No devices connected")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Spacer()
                    if daemonService.connectedClients > 0 {
                        Text("\(daemonService.connectedClients) client\(daemonService.connectedClients == 1 ? "" : "s")")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                ForEach(entries) { entry in
                    deviceRow(entry)
                }
                if daemonService.connectedClients > 0 {
                    HStack {
                        Spacer()
                        Text("\(daemonService.connectedClients) dashboard client\(daemonService.connectedClients == 1 ? "" : "s")")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 2)
                }
            }
        }
    }

    @ViewBuilder
    private func deviceRow(_ entry: DeviceEntry) -> some View {
        HStack(spacing: 6) {
            Image(systemName: entry.kind.symbolName)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .frame(width: 14, height: 14)
            VStack(alignment: .leading, spacing: 0) {
                Text(entry.title)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                if let subtitle = entry.subtitle {
                    Text(subtitle)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 4)
            statusDot(entry.status)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func statusDot(_ status: DeviceStatus) -> some View {
        let color: Color = switch status {
        case .connected:    .green
        case .reconnecting: .orange
        case .idle:         .gray
        case .error:        .red
        }
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            if case .error(let msg) = status {
                Text(msg)
                    .font(.system(size: 9))
                    .foregroundStyle(.red)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 90, alignment: .leading)
            }
        }
    }

    // MARK: - Actions Bar

    private var actionsBar: some View {
        HStack(spacing: 8) {
            Button {
                openLaunchSession()
            } label: {
                Label("Launch Session", systemImage: "play.fill")
                    .font(.system(size: 11))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            Button {
                openDashboard()
            } label: {
                Label("Dashboard", systemImage: "square.grid.2x2")
                    .font(.system(size: 11))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            Button {
                openApmeDashboard()
            } label: {
                Label("APME", systemImage: "chart.bar.fill")
                    .font(.system(size: 11))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(daemonService.port == 0)
            .help("Open the APME evaluation dashboard in your browser")

            Spacer()

            // SettingsLink is the only reliable way to open Settings from a
            // MenuBarExtra window — `NSApp.sendAction(showSettingsWindow:)`
            // races against the popover auto-dismiss and swallows the action.
            // Available macOS 14+; accessory apps fall back to activating
            // the (presumably already open) existing Settings window.
            if #available(macOS 14.0, *) {
                SettingsLink {
                    Image(systemName: "gear")
                        .font(.system(size: 11))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Open Settings")
                .simultaneousGesture(TapGesture().onEnded {
                    NSApp.activate(ignoringOtherApps: true)
                })
            } else {
                Button {
                    NSApp.activate(ignoringOtherApps: true)
                    NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
                } label: {
                    Image(systemName: "gear")
                        .font(.system(size: 11))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    // MARK: - Footer

    private var footerSection: some View {
        HStack {
            Toggle("Start at Login", isOn: Binding(
                get: { daemonService.isLoginItemEnabled },
                set: { enabled in
                    if enabled { daemonService.registerLoginItem() }
                    else { daemonService.unregisterLoginItem() }
                }
            ))
            .toggleStyle(.checkbox)
            .font(.system(size: 11))

            Spacer()

            Button("Quit") {
                Task {
                    await daemonService.stop()
                    NSApplication.shared.terminate(nil)
                }
            }
            .font(.system(size: 11))
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    // MARK: - Helpers

    private func agentTypeLabel(_ type: String) -> String {
        switch type {
        case "claude-code": "Claude"
        case "openclaw": "OpenClaw"
        case "codex-cli": "Codex"
        case "opencode": "OpenCode"
        case "daemon": "Daemon"
        default: type.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    /// Shorten model names for compact display (e.g., "claude-opus-4-6-20261001" → "opus-4")
    private func shortModelName(_ name: String) -> String {
        // Strip common prefixes
        var s = name
        for prefix in ["claude-", "gpt-", "o1-", "o3-"] {
            if s.hasPrefix(prefix) { s = String(s.dropFirst(prefix.count)) }
        }
        // Strip date suffixes (e.g., -20261001)
        if let range = s.range(of: #"-\d{8}$"#, options: .regularExpression) {
            s = String(s[s.startIndex..<range.lowerBound])
        }
        return s
    }

    /// Get current tool name for a session (only available for primary session)
    private func currentToolFor(_ session: SessionInfo) -> String? {
        if session.id == stateHolder.state.sessionId {
            return stateHolder.state.currentTool
        }
        return nil
    }

    /// Convert ISO 8601 startedAt to relative time string (e.g., "2m", "1h", "3d")
    private func relativeTimeString(from isoString: String?) -> String? {
        guard let isoString, !isoString.isEmpty else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: isoString)
                ?? ISO8601DateFormatter().date(from: isoString) else { return nil }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "<1m" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        return "\(days)d"
    }

    private func openDashboard() {
        // SwiftUI's openWindow brings an existing window of this scene to front
        // if one exists, otherwise creates it. Avoids fragile title string matching.
        openWindow(id: "dashboard")
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func openLaunchSession() {
        openWindow(id: "launch-session")
        // Activate app so window gets focus (menu bar apps default to .accessory)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    /// Open the in-app APME dashboard window (WKWebView pointing at the
    /// rich SPA served by the local daemon at /apme). One click → full
    /// APME UI with run history, category scorecard, timeline, and eval
    /// axes breakdown — no more digging through sqlite, no browser
    /// roundtrip, no token in address bar history.
    private func openApmeDashboard() {
        guard daemonService.port > 0 else { return }
        openWindow(id: "apme-dashboard")
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    // MARK: - Gauge Helpers

    private func gaugeString(_ percent: Double) -> String {
        let filled = Int((percent / 100.0) * 10)
        let clamped = max(0, min(10, filled))
        let bar = String(repeating: "\u{2588}", count: clamped)
            + String(repeating: "\u{2591}", count: 10 - clamped)
        return "\(bar) \(Int(percent))%"
    }

    private func gaugeColor(_ percent: Double) -> Color {
        if percent >= 90 { return .red }
        if percent >= 70 { return .orange }
        return .green
    }

    /// Returns "↑" if usage increased, "↓" if decreased, "" if no significant change
    private func trendArrow(_ current: Double?, _ previous: Double?) -> String {
        guard let current, let previous else { return "" }
        let diff = current - previous
        if diff > 1 { return "↑" }
        if diff < -1 { return "↓" }
        return ""
    }

    /// Format subscription renewal date — accepts ISO 8601 or passthrough.
    /// Produces compact "Apr 19" style output; falls back to input when
    /// parsing fails (some backends return short-form strings already).
    private func formatSubscriptionDate(_ input: String) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed = iso.date(from: input) ?? ISO8601DateFormatter().date(from: input)
        guard let date = parsed else { return input }
        let fmt = DateFormatter()
        fmt.dateFormat = "MMM d"
        return fmt.string(from: date)
    }

    private func formatResetTime(_ isoString: String?) -> String {
        guard let isoString, !isoString.isEmpty else { return "" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: isoString)
                ?? ISO8601DateFormatter().date(from: isoString) else { return isoString }
        let interval = date.timeIntervalSinceNow
        if interval <= 0 { return "now" }
        let hours = Int(interval) / 3600
        let minutes = (Int(interval) % 3600) / 60
        if hours > 0 { return "\(hours)h\(minutes)m" }
        return "\(minutes)m"
    }
}

// MARK: - Session Brand Colors

/// Canonical per-agent brand colors. Mirrors `D200hHidModule.agentBrandColor`
/// and `SessionListPanel.agentIconView` — keep these three in sync if any
/// agent brand color shifts. Creature SVG assets are authored as
/// `currentColor` silhouettes, so the tint applied here is what the user
/// actually sees.
enum SessionBrand {
    static func color(for agentType: String?) -> Color {
        switch agentType {
        case "claude-code": return Color(red: 0.753, green: 0.439, blue: 0.345) // #C07058
        case "codex-cli":   return Color(red: 0.38,  green: 0.40,  blue: 0.88)  // indigo
        case "openclaw":    return Color(red: 1.0,   green: 0.30,  blue: 0.30)  // #FF4D4D
        case "opencode":    return Color(red: 0.945, green: 0.925, blue: 0.925) // near-white
        case "daemon":      return Color(red: 0.55,  green: 0.55,  blue: 0.60)
        default:            return Color.secondary
        }
    }
}

// MARK: - Session Creature Icon

/// Renders an agent's branded creature from the app's asset catalog in its
/// brand color. Falls back to a generic SF Symbol when the agent type is
/// unknown so the layout never collapses on new agents.
private struct SessionCreatureIcon: View {
    let agentType: String?
    let tint: Color
    let size: CGFloat

    var body: some View {
        Group {
            if let asset = Self.assetName(for: agentType) {
                Image(asset)
                    .resizable()
                    .renderingMode(.template)
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                Image(systemName: "questionmark.circle")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            }
        }
        .frame(width: size, height: size)
        .foregroundStyle(tint)
        .accessibilityLabel(Self.accessibilityLabel(for: agentType))
    }

    private static func assetName(for type: String?) -> String? {
        switch type {
        case "claude-code": return "CreatureClaudeCode"
        case "openclaw":    return "CreatureOpenClaw"
        case "codex-cli":   return "CreatureCodex"
        case "opencode":    return "CreatureOpenCode"
        default:            return nil
        }
    }

    private static func accessibilityLabel(for type: String?) -> String {
        switch type {
        case "claude-code": return "Claude Code session"
        case "openclaw":    return "OpenClaw session"
        case "codex-cli":   return "Codex session"
        case "opencode":    return "OpenCode session"
        case "daemon":      return "Daemon"
        default:            return "Unknown agent session"
        }
    }
}

// MARK: - Section Container

private struct SectionContainer<Content: View>: View {
    let title: String
    let titleColor: Color
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(titleColor)
            content
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}
#endif
