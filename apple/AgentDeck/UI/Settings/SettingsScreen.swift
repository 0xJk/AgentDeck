// SettingsScreen.swift — Settings dialog (matches Android TabletSettingsDialog.kt)

import SwiftUI

struct SettingsScreen: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences
    #if os(macOS)
    @EnvironmentObject private var daemonService: DaemonService
    #endif
    @Environment(\.dismiss) private var dismiss
    @State private var manualUrl = ""
    @State private var showRemoveAntigravityConfirm = false
    @State private var openClawGatewayTokenInput: String = ""
    @State private var openClawGatewayTokenSaved: Bool = false
    @State private var openClawGatewayTokenError: String?
    @State private var anthropicAdminApiKeyInput: String = ""
    @State private var anthropicAdminApiKeySaved: Bool = false
    @State private var anthropicAdminApiKeyError: String?
    #if os(macOS)
    @State private var portInput: String = ""
    /// Which section is visible in the macOS NavigationSplitView detail.
    /// Default lands on Integrations so first-run users see the actions
    /// that actually unblock quota / OpenClaw / hooks, not an "Advanced"
    /// section that's mostly informational.
    @State private var selectedSection: SettingsSection = .integrations
    /// Whether the Advanced group in the sidebar is expanded. Collapsed
    /// by default so the first read is only 4 rows (Integrations, Dashboard,
    /// About, Advanced ►).
    @State private var advancedExpanded: Bool = false
    #endif
    #if os(iOS)
    /// iOS QR pairing scanner modal presentation flag.
    @State private var showQRScanner: Bool = false
    /// User-facing error message shown below the Scan QR button when a
    /// scanned payload isn't a valid AgentDeck pairing URL.
    @State private var scanError: String?
    #endif

    var body: some View {
        #if os(macOS)
        macOSSettings
        #else
        iOSSettings
        #endif
    }

    // MARK: - iOS (matches Android TabletSettingsDialog)

    private var iOSSettings: some View {
        ZStack {
            // Semi-transparent background
            Color.black.opacity(0.4)
                .ignoresSafeArea()
                .onTapGesture { dismiss() }

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Title
                    Text("Settings")
                        .font(.title2.bold())
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, alignment: .center)

                    // ─────── Essentials ───────
                    // Integrations first — this is where a first-run user
                    // wires up Claude / OpenClaw / Anthropic API.
                    settingsCard(title: "Integrations") {
                        servicesContent
                    }

                    settingsCard(title: "Dashboard") {
                        dashboardContent
                    }

                    settingsCard(title: "Connection") {
                        connectionContent
                    }

                    settingsCard(title: "About") {
                        aboutContent
                    }

                    // ─────── Advanced (collapsed by default) ───────
                    // mDNS pairing + display/sleep behaviour are rarely
                    // touched after first setup. Hide behind a disclosure
                    // group so the main list stays short.
                    DisclosureGroup("Advanced") {
                        VStack(alignment: .leading, spacing: 16) {
                            settingsCard(title: "iPad / iPhone pairing") {
                                discoveryContent
                            }
                            settingsCard(title: "Display & sleep") {
                                displayContent
                            }
                        }
                        .padding(.top, 8)
                    }
                    .foregroundStyle(.white)
                    .tint(.white)
                    .padding(.horizontal, 4)

                    // Close button (matches Android)
                    Button {
                        dismiss()
                    } label: {
                        Text("Close")
                            .font(.body.bold())
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(
                                Color(red: 0.278, green: 0.318, blue: 0.373), // #475569
                                in: RoundedRectangle(cornerRadius: 8)
                            )
                    }
                }
                .padding(24)
            }
            .frame(maxWidth: 500)
            .background(
                Color(red: 0.118, green: 0.161, blue: 0.231).opacity(0.9), // #1E293B
                in: RoundedRectangle(cornerRadius: 16)
            )
            .padding(.vertical, 40)
        }
        .presentationBackground(.clear)
    }

    // MARK: - macOS

    #if os(macOS)
    /// Navigable sections in the macOS Settings scene. Grouped into
    /// "Essentials" (shown first, relevant to every user) and "Advanced"
    /// (collapsed by default, network/hardware/developer concerns).
    /// Labels are rewritten from the original GroupBox titles to avoid
    /// jargon like "Daemon" / "Discovery" — first-run users shouldn't
    /// have to know what those mean to find the right setting.
    enum SettingsSection: Hashable, Identifiable {
        case integrations
        case dashboard
        case about
        case connection
        case daemon
        case pairing
        case display
        case hardware
        case evaluation

        var id: Self { self }

        var title: String {
            switch self {
            case .integrations: "Integrations"
            case .dashboard:    "Dashboard"
            case .about:        "About"
            case .connection:   "Connection"
            case .daemon:       "Local server"
            case .pairing:      "iPad / iPhone pairing"
            case .display:      "Display & sleep"
            case .hardware:     "ESP32 & Pixoo"
            case .evaluation:   "Agent evaluation (APME)"
            }
        }

        var icon: String {
            switch self {
            case .integrations: "link"
            case .dashboard:    "macwindow"
            case .about:        "info.circle"
            case .connection:   "network"
            case .daemon:       "server.rack"
            case .pairing:      "ipad.and.iphone"
            case .display:      "display"
            case .hardware:     "cpu"
            case .evaluation:   "chart.bar.doc.horizontal"
            }
        }

        /// One-line subtitle shown under the section title in the detail
        /// pane. Written as "what this section does" so the user can tell
        /// at a glance whether they're in the right place without
        /// reading every control. Avoids terms that require AgentDeck
        /// internals knowledge (daemon, mDNS, hook JSON, etc.).
        var subtitle: String {
            switch self {
            case .integrations:
                "Wire up Claude Code, OpenClaw, and Anthropic API — everything AgentDeck talks to."
            case .dashboard:
                "What shows up on the terrarium and in the menu bar."
            case .about:
                "Version, attributions, and support links."
            case .connection:
                "How this Mac/iPad finds the AgentDeck server and handles reconnects."
            case .daemon:
                "Port the local server listens on. Leave at 9120 unless something else already uses it."
            case .pairing:
                "How iPad or iPhone discovers this Mac. Usually automatic over Wi-Fi."
            case .display:
                "Sleep and wake behaviour for the Mac display."
            case .hardware:
                "Optional ESP32 boards and Pixoo LED matrix displays."
            case .evaluation:
                "APME scores agent turns. Pick a judge backend — local MLX is free."
            }
        }
    }

    private static let essentialSections: [SettingsSection] = [.integrations, .dashboard, .about]
    private static let advancedSections: [SettingsSection] = [.connection, .daemon, .pairing, .display, .hardware, .evaluation]

    private var macOSSettings: some View {
        NavigationSplitView {
            macOSSidebar
                .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 260)
        } detail: {
            macOSDetail
        }
        .frame(minWidth: 720, minHeight: 520)
    }

    private var macOSSidebar: some View {
        List(selection: $selectedSection) {
            Section("Essentials") {
                ForEach(Self.essentialSections) { section in
                    Label(section.title, systemImage: section.icon)
                        .tag(section)
                }
            }
            Section(isExpanded: $advancedExpanded) {
                ForEach(Self.advancedSections) { section in
                    Label(section.title, systemImage: section.icon)
                        .tag(section)
                }
            } header: {
                Text("Advanced")
            }
        }
        .listStyle(.sidebar)
    }

    @ViewBuilder
    private var macOSDetail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(selectedSection.title)
                        .font(.title2.bold())
                    Text(selectedSection.subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                sectionContent(for: selectedSection)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Renders the content view for the selected section. Integrations
    /// is a composite (Claude Code hooks + every third-party service
    /// row in one place) so first-run users don't have to visit two
    /// sections to wire up Claude + OpenClaw + Admin API.
    @ViewBuilder
    private func sectionContent(for section: SettingsSection) -> some View {
        switch section {
        case .integrations:
            VStack(alignment: .leading, spacing: 14) {
                claudeHooksContent
                Divider()
                servicesContent
            }
        case .dashboard:
            dashboardContent
        case .about:
            aboutContent
        case .connection:
            connectionContent
        case .daemon:
            daemonContent
        case .pairing:
            discoveryContent
        case .display:
            displayContent
        case .hardware:
            hardwareContent
        case .evaluation:
            apmeContent
        }
    }
    #endif

    // MARK: - Settings Card (Android Card style)

    private func settingsCard(title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(TerrariumHUD.subtext)

            VStack(alignment: .leading, spacing: 10) {
                content()
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(red: 0.2, green: 0.255, blue: 0.333), // #334155
                in: RoundedRectangle(cornerRadius: 12)
            )
        }
    }

    // MARK: - Connection Content

    private var connectionContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Status badge
            HStack(spacing: 6) {
                Circle()
                    .fill(stateHolder.connection.status == .connected
                          ? TerrariumHUD.ledGreen : TerrariumHUD.ledRed.opacity(0.6))
                    .frame(width: 8, height: 8)
                Text(stateHolder.connection.status == .connected ? "Connected" : "Disconnected")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white)
            }

            if stateHolder.connection.status == .connected {
                if let url = stateHolder.connection.url {
                    Text(url)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext)
                }

                Button("Disconnect") {
                    stateHolder.disconnectBridge()
                }
                .buttonStyle(.bordered)
                .tint(.red)
            } else {
                // Manual URL input
                HStack {
                    TextField("ws://192.168.1.x:9120", text: $manualUrl)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, design: .monospaced))
                        #if os(iOS)
                        .autocapitalization(.none)
                        .keyboardType(.URL)
                        #endif

                    Button("Connect") {
                        guard !manualUrl.isEmpty else { return }
                        stateHolder.connectTo(url: manualUrl)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(red: 0.231, green: 0.51, blue: 0.965))
                    .disabled(manualUrl.isEmpty)
                }

                if stateHolder.connection.isReconnecting {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.orange)
                        Text("Reconnecting (attempt \(stateHolder.connection.reconnectAttempt))...")
                            .font(.system(size: 11))
                            .foregroundStyle(.orange)
                    }
                }

                if let error = stateHolder.connection.lastError {
                    Text(error)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.ledRed)
                }

                #if os(iOS)
                // QR scan pairing — secondary path when mDNS can't find the
                // Mac (different Wi-Fi networks, Local Network permission
                // denied, etc.). Shows a camera view that decodes the URL
                // printed by `QRPairingWindow` on the Mac side.
                Button {
                    showQRScanner = true
                } label: {
                    Label("Scan QR to Pair", systemImage: "qrcode.viewfinder")
                        .font(.system(size: 13, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color(red: 0.231, green: 0.51, blue: 0.965))
                .padding(.top, 4)

                if let scanError {
                    Text(scanError)
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                }
                #endif
            }
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $showQRScanner) {
            QRScannerView(
                onScan: { payload in
                    showQRScanner = false
                    handleQRScan(payload)
                },
                onCancel: {
                    showQRScanner = false
                }
            )
        }
        #endif
    }

    #if os(iOS)
    /// Validate the QR payload and feed it to the connection state holder.
    /// Expected format: `ws://<host>:<port>?token=<token>` (produced by
    /// `QRPairingWindow` on the Mac). Reject anything else so a malformed
    /// or random QR never silently hijacks the connection.
    private func handleQRScan(_ payload: String) {
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              url.host != nil
        else {
            scanError = "That QR doesn't look like an AgentDeck pairing link."
            return
        }
        scanError = nil
        stateHolder.connectTo(url: trimmed)
    }
    #endif

    // MARK: - Daemon Content (macOS)

    #if os(macOS)
    private var daemonContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(daemonService.isRunning
                          ? TerrariumHUD.ledGreen
                          : (daemonService.bindFailureReason != nil
                             ? TerrariumHUD.ledRed
                             : TerrariumHUD.ledRed.opacity(0.6)))
                    .frame(width: 8, height: 8)
                Text(daemonStatusText)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white)
            }

            HStack(spacing: 8) {
                Text("Port")
                    .font(.system(size: 12))
                    .foregroundStyle(TerrariumHUD.subtext)
                TextField("9120", text: $portInput)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                    .frame(width: 80)
                    .onSubmit(commitPortChange)
                Button("Apply & Restart") {
                    commitPortChange()
                }
                .buttonStyle(.borderedProminent)
                .disabled(!isPortInputDirty || !isPortInputValid)
            }

            Text("Default 9120. Range 1024–65535. Plugin/TUI discover via mDNS so any port works.")
                .font(.system(size: 10))
                .foregroundStyle(TerrariumHUD.subtext)

            if let reason = daemonService.bindFailureReason {
                Text(reason)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.ledRed)
                    .fixedSize(horizontal: false, vertical: true)

                if !daemonService.blockingProcesses.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Blocking Processes")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.white)
                        ForEach(daemonService.blockingProcesses) { proc in
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(proc.isAlive ? (proc.isZombie ? .orange : .red) : .gray)
                                    .frame(width: 6, height: 6)
                                Text("PID \(proc.id)")
                                    .font(.system(size: 10, design: .monospaced))
                                Text(proc.name)
                                    .font(.system(size: 10))
                                if let project = proc.project {
                                    Text("(\(project))")
                                        .font(.system(size: 10))
                                        .foregroundStyle(TerrariumHUD.subtext)
                                }
                                Text(verbatim: ":\(portString(proc.port))")
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(TerrariumHUD.subtext)
                                Spacer()
                                Text(proc.statusLabel)
                                    .font(.system(size: 9))
                                    .foregroundStyle(TerrariumHUD.subtext)
                            }
                        }
                    }
                    .padding(8)
                    .background(Color.white.opacity(0.05))
                    .cornerRadius(6)

                    HStack(spacing: 8) {
                        Button("Clean Up & Retry") {
                            let result = PortDiagnostics.cleanup()
                            if result.killed > 0 || result.pruned > 0 {
                                daemonService.start()
                            }
                        }
                        .buttonStyle(.borderedProminent)

                        let cmd = PortDiagnostics.terminalCommand(for: daemonService.blockingProcesses)
                        if !cmd.isEmpty {
                            Button("Copy Terminal Command") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(cmd, forType: .string)
                            }
                            .buttonStyle(.bordered)
                            .help("Copies `\(cmd)` to clipboard — paste in Terminal to kill external processes")
                        }
                    }
                }
            } else if let error = daemonService.errorMessage {
                Text(error)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                #if !AGENTDECK_APP_STORE
                Text("D200H Helper")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white)
                Text("AgentDeck.app can keep D200H under app control by launching its bundled helper when the sandboxed Swift daemon is denied HID access.")
                    .font(.system(size: 10))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .fixedSize(horizontal: false, vertical: true)

                Toggle(isOn: $preferences.autoUseBundledD200HHelper) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Auto-switch D200H to bundled helper")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.white)
                        Text("Recommended when Swift HID open fails with missing USB entitlement or kIOReturnNotPermitted.")
                            .font(.system(size: 10))
                            .foregroundStyle(TerrariumHUD.subtext)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Divider()
                #endif

                Toggle(isOn: $preferences.d200hBakeSessionText) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Bake Stream Deck-style session text")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.white)
                        Text("Experimental. Draw project, model, and state inside the session PNG instead of relying on the native D200H label.")
                            .font(.system(size: 10))
                            .foregroundStyle(TerrariumHUD.subtext)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Toggle(isOn: $preferences.d200hHideNativeSessionLabels) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Hide native labels in session mode")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.white)
                        Text("When enabled, AgentDeck sends `ShowTitle: 0` only for the session grid and switches labels back on in option mode.")
                            .font(.system(size: 10))
                            .foregroundStyle(TerrariumHUD.subtext)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .disabled(!preferences.d200hBakeSessionText)

                #if !AGENTDECK_APP_STORE
                Button("Switch D200H to Bundled Helper Now") {
                    Task { await daemonService.startBundledD200HHelper() }
                }
                .buttonStyle(.bordered)
                #endif
            }
        }
        .onAppear {
            if portInput.isEmpty {
                portInput = String(preferences.daemonPort)
            }
        }
    }

    private var daemonStatusText: String {
        if daemonService.isRunning {
            return "Local daemon on port \(portString(daemonService.port))"
        }
        if daemonService.isUsingExternalDaemon {
            #if AGENTDECK_APP_STORE
            return "External daemon on port \(portString(daemonService.port))"
            #else
            return daemonService.ownsExternalDaemon
                ? "Bundled D200H helper on port \(portString(daemonService.port))"
                : "External daemon on port \(portString(daemonService.port))"
            #endif
        }
        if daemonService.bindFailureReason != nil {
            return "Daemon bind failed"
        }
        return "Daemon starting…"
    }

    private var parsedPortInput: Int? {
        Int(portInput.trimmingCharacters(in: .whitespaces))
    }

    private var isPortInputValid: Bool {
        guard let p = parsedPortInput else { return false }
        return p >= 1024 && p <= 65535
    }

    private var isPortInputDirty: Bool {
        parsedPortInput != preferences.daemonPort
    }

    private func commitPortChange() {
        guard isPortInputValid, let newPort = parsedPortInput else { return }
        guard newPort != preferences.daemonPort else { return }
        preferences.daemonPort = newPort
        Task { await daemonService.restart() }
    }
    #endif

    // MARK: - Discovery Content

    private var discoveryContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("mDNS Auto-Discovery")
                    .font(.system(size: 13))
                    .foregroundStyle(.white)
                Spacer()
                if stateHolder.discovery.isSearching {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if stateHolder.discovery.bridges.isEmpty {
                Text("Searching for bridges...")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
            } else {
                ForEach(stateHolder.discovery.bridges) { bridge in
                    Button {
                        stateHolder.connectTo(bridge)
                    } label: {
                        HStack {
                            Text(bridge.project ?? bridge.name)
                                .foregroundStyle(.white)
                            Spacer()
                            Text(verbatim: "\(bridge.host):\(bridge.port)")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(TerrariumHUD.subtext)
                        }
                        .padding(.vertical, 6)
                        .padding(.horizontal, 10)
                        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                }
            }

            // Local sessions removed — sandbox prevents reading ~/.agentdeck/sessions.json
            // mDNS discovery with daemon preference is used instead
        }
    }

    // MARK: - Display Content

    private var displayContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            #if os(iOS)
            Toggle(isOn: Binding(
                get: { stateHolder.displaySync.enabled },
                set: { stateHolder.displaySync.enabled = $0 }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sync Display Sleep")
                        .font(.system(size: 13))
                        .foregroundStyle(.white)
                    Text("Dim screen when host Mac display sleeps")
                        .font(.system(size: 11))
                        .foregroundStyle(TerrariumHUD.subtext)
                }
            }
            .tint(Color(red: 0.231, green: 0.51, blue: 0.965))
            #else
            HStack {
                Text("Sync Display Sleep")
                    .font(.system(size: 13))
                Spacer()
                Text("N/A on macOS")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            #endif

            // Status indicator
            HStack(spacing: 6) {
                Circle()
                    .fill(stateHolder.state.hostDisplayOn
                          ? Color.green : Color.orange)
                    .frame(width: 6, height: 6)
                Text(stateHolder.state.hostDisplayOn ? "Host display on" : "Host display off")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
            }
        }
    }

    // MARK: - About Content

    private var aboutContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Stop Chatting. Start Steering.")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.primary)

            Text("AgentDeck gives you real-time monitoring and evaluation for Claude Code, Codex, OpenCode, and OpenClaw sessions. See what your agents are doing across every device — Stream Deck+, Apple Watch, E-ink readers, ESP32 boards, matrix displays, and more. Stop context-switching between chat windows. Start steering.")
                .font(.system(size: 12))
                .foregroundStyle(TerrariumHUD.subtext)
                .fixedSize(horizontal: false, vertical: true)

            Divider()

            VStack(spacing: 4) {
                infoRow("App", "AgentDeck")
                infoRow("Version", "1.0.0")
                infoRow("Bundle", "bound.serendipity.agentdeck.dashboard")
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Independent project. Not affiliated with Anthropic, OpenAI, Google, Elgato, DIVOOM, or other third parties referenced. All trademarks are property of their respective owners.")
                    .font(.system(size: 10))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .fixedSize(horizontal: false, vertical: true)
                if let url = URL(string: "https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md") {
                    Link("Third-party attributions & licenses →", destination: url)
                        .font(.system(size: 11, weight: .semibold))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var dashboardContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("Open dashboard on launch", isOn: $preferences.openDashboardOnLaunch)

            Picker("Menu bar icon", selection: $preferences.menuBarIconStyle) {
                ForEach(AppPreferences.MenuBarIconStyle.allCases) { style in
                    Text(style.title).tag(style)
                }
            }

            Divider()

            Text("Visible Panels")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(TerrariumHUD.subtext)

            Toggle("Session list", isOn: $preferences.showSessionList)
            Toggle("Tank status", isOn: $preferences.showTankStatus)
            Toggle("Device diagnostic", isOn: $preferences.showDeviceDiagnostic)
            Toggle("Timeline strip", isOn: $preferences.showTimeline)
            Toggle("Settings button", isOn: $preferences.showSettingsButton)

            Divider()

            Text("Tank Status Sections")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(TerrariumHUD.subtext)

            Toggle("OpenClaw", isOn: $preferences.showOpenClawSection)
            Toggle("MLX", isOn: $preferences.showMLXSection)
            Toggle("OLLAMA", isOn: $preferences.showOllamaSection)
            Toggle("Subscriptions", isOn: $preferences.showSubscriptionsSection)
            Toggle("Antigravity", isOn: $preferences.showAntigravitySection)
                .disabled(!preferences.antigravityAccessEnabled)

            if !preferences.antigravityAccessEnabled {
                Text("Antigravity is hidden until you explicitly grant access below.")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
            }
        }
    }

    // MARK: - APME section

    /// APME judge backend picker + inline status for each option.
    /// Writes the selection to both `UserDefaults` (fast local access)
    /// and `~/.agentdeck/settings.json` (shared with the Node bridge).
    ///
    /// Availability semantics:
    ///   - foundationModels: requires macOS 26 + Apple Intelligence on Apple
    ///     Silicon. Status line shows availability from SystemLanguageModel.
    ///   - mlx: requires user-run local MLX server. Status is "server
    ///     required — check /apme in the dashboard after starting it".
    ///   - api: requires ANTHROPIC_API_KEY in env or settings.json.
    ///     Paid, opt-in, highlighted so users don't pick it accidentally.
    private var apmeContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Judge Backend")
                .font(.system(size: 13, weight: .semibold))

            Text("Which model scores your agent turns. Changes apply immediately and the next eval uses the new backend.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext)

            Picker("Backend", selection: $preferences.apmeJudgeBackend) {
                Text("Foundation Models (on-device, free)").tag("foundationModels")
                Text("MLX (local server, free)").tag("mlx")
                Text("Anthropic API (paid)").tag("api")
            }
#if os(macOS)
            .pickerStyle(.radioGroup)
#else
            .pickerStyle(.inline)
#endif
            .labelsHidden()

            // Inline availability hint for the current selection.
            Group {
                switch preferences.apmeJudgeBackend {
                case "foundationModels":
#if os(macOS)
                    let ready = ApmeJudgeFoundationModels.isAvailable
                    Label(
                        ready ? "Apple Intelligence ready" : ApmeJudgeFoundationModels.unavailableReason,
                        systemImage: ready ? "checkmark.circle.fill" : "exclamationmark.triangle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(ready ? .green : .orange)
#else
                    Label(
                        "Apple Intelligence judge runs on the macOS daemon.",
                        systemImage: "info.circle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
#endif
                case "mlx":
                    Label(
                        "Requires a local MLX server at http://127.0.0.1:8800. Start it before scoring runs.",
                        systemImage: "info.circle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
                case "api":
#if os(macOS)
                    let configured = ApmeJudgeApi.isConfigured
                    Label(
                        configured
                            ? "ANTHROPIC_API_KEY detected. Calls cost Anthropic credits."
                            : "Set ANTHROPIC_API_KEY in env or ~/.agentdeck/settings.json. Paid backend — opt-in only.",
                        systemImage: configured ? "dollarsign.circle.fill" : "key.slash"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(configured ? .yellow : .orange)
#else
                    Label(
                        "Anthropic API judge runs on the macOS daemon.",
                        systemImage: "info.circle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
#endif
                default:
                    EmptyView()
                }
            }
            .fixedSize(horizontal: false, vertical: true)

            Divider()

            Text("APME data lives in ~/.agentdeck/apme.sqlite and the dashboard is accessible from the menu bar APME button.")
                .font(.system(size: 10))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Codex auth status row

    /// Codex CLI web-auth status. When the daemon runs inside App Sandbox it
    /// cannot read `~/.codex/auth.json` (outside container), and the reviewed
    /// app does not launch PTY-backed Codex sessions.
    private var codexAuthRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "person.badge.key")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
                Text("Codex CLI")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                if let mode = stateHolder.state.codexAuthMode, !mode.isEmpty {
                    Text(mode)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.green)
                } else {
                    Text("Not detected")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
            if stateHolder.state.codexAuthMode == nil && AgentDeckRuntime.isSandboxed {
                Text("Codex PTY launch is unavailable in the App Store build. Claude Code monitoring still works through hooks.")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - OpenClaw integration status row

    /// App Store builds use a separate AgentDeck Dashboard device identity and
    /// pair through the OpenClaw Gateway. Non-sandbox builds keep the legacy
    /// CLI identity file path.
    private var openClawIntegrationRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "network")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
                Text("OpenClaw Gateway")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                if AgentDeckRuntime.isSandboxed {
                    Text(openClawGatewayStatusLabel)
                        .font(.system(size: 11))
                        .foregroundStyle(openClawGatewayStatusColor)
                }
            }
            if AgentDeckRuntime.isSandboxed {
                Text(openClawGatewayHelpText)
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                openClawGatewayTokenSection
            } else {
                Text("Connects to `ws://127.0.0.1:18789`. Run `openclaw devices approve <requestId>` after first launch to authorize this Mac app.")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear {
            loadOpenClawGatewayTokenState()
        }
    }

    private var openClawGatewayStatusLabel: String {
        switch stateHolder.state.gatewayAuthStatus {
        case "connected":
            return "Connected"
        case "approval_pending":
            return "Approval pending"
        case "pairing_required":
            return "Pairing required"
        case "gateway_token_missing":
            return "Gateway token required"
        case "token_mismatch", "device_auth_invalid", "auth_failed":
            return "Auth failed"
        case "unsupported_protocol":
            return "Unsupported"
        case "gateway_reachable":
            return "Gateway reachable"
        default:
            return stateHolder.state.gatewayAvailable ? "Gateway reachable" : "Gateway not found"
        }
    }

    private var openClawGatewayStatusColor: Color {
        switch stateHolder.state.gatewayAuthStatus {
        case "connected":
            return .green
        case "approval_pending", "pairing_required", "gateway_reachable":
            return .orange
        case "gateway_token_missing", "auth_failed", "token_mismatch", "device_auth_invalid", "unsupported_protocol":
            return .red
        default:
            return .secondary
        }
    }

    private var openClawGatewayHelpText: String {
        let base = "AgentDeck registers as a separate device with the local OpenClaw Gateway. Approve this Mac in OpenClaw's Web UI."
        let approve = stateHolder.state.gatewayAuthRequestId.map {
            "Approval request: \($0). Open `http://localhost:18789` in your browser and approve this AgentDeck device."
        } ?? "Open `http://localhost:18789` in your browser and approve this AgentDeck device."

        let tokenHint = "The token is the shared secret set on the OpenClaw Gateway itself — the value you passed as `OPENCLAW_GATEWAY_TOKEN` (env) or `gateway.auth.token` (config). Paste that same value here. AgentDeck cannot read it from the Gateway's config in the App Store build."

        switch stateHolder.state.gatewayAuthStatus {
        case "connected":
            return "Connected through the local OpenClaw Gateway. \(base)"
        case "approval_pending", "pairing_required":
            return "\(base) \(approve)"
        case "unsupported_protocol":
            return "OpenClaw Gateway version not supported. Update OpenClaw to a compatible 2026.4.14+ Gateway."
        case "gateway_token_missing":
            return "OpenClaw Gateway requires a shared token before device approval. \(tokenHint)"
        case "auth_failed", "token_mismatch", "device_auth_invalid":
            return stateHolder.state.gatewayAuthMessage ?? "OpenClaw Gateway authentication failed. Revoke this AgentDeck device in OpenClaw and approve it again."
        case "gateway_reachable":
            return "\(base) Waiting for OpenClaw Gateway approval. If OpenClaw was launched with a shared token, paste it below before approving this device. \(tokenHint)"
        default:
            return "Start OpenClaw Gateway on `ws://127.0.0.1:18789`. \(base) If the Gateway is launched with a shared token, paste it below. \(tokenHint)"
        }
    }

    @ViewBuilder
    private var openClawGatewayTokenSection: some View {
        #if os(macOS) && AGENTDECK_APP_STORE
        if shouldShowOpenClawGatewayTokenEditor {
            openClawGatewayTokenEditor
        } else {
            Text("A shared Gateway token is only needed when OpenClaw reports token-required auth. Normal pairing continues through OpenClaw approval.")
                .font(.system(size: 10))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.75))
                .fixedSize(horizontal: false, vertical: true)
        }
        #else
        EmptyView()
        #endif
    }

    /// Show the Gateway token editor eagerly in the App Store build. Users
    /// land on Settings without knowing OpenClaw needs a shared secret, so
    /// hiding the input until auth *already* fails was a dead-end — the UI
    /// gave no entry path. Exception: once the Gateway reports `connected`,
    /// collapse to the "Saved in Keychain" confirmation so the input field
    /// doesn't clutter an already-working setup (the user can still use
    /// "Clear" to drop the stored token and re-open the editor).
    private var shouldShowOpenClawGatewayTokenEditor: Bool {
        if stateHolder.state.gatewayAuthStatus == "connected" {
            return openClawGatewayTokenSaved ? false : !openClawGatewayTokenInput.isEmpty
        }
        return true
    }

    @ViewBuilder
    private var openClawGatewayTokenEditor: some View {
        #if os(macOS) && AGENTDECK_APP_STORE
        VStack(alignment: .leading, spacing: 6) {
            SecureField(
                openClawGatewayTokenSaved
                    ? "Shared Gateway token saved — paste to replace"
                    : "Shared Gateway token (OPENCLAW_GATEWAY_TOKEN)",
                text: $openClawGatewayTokenInput
            )
            .textFieldStyle(.roundedBorder)
            HStack(spacing: 8) {
                Button("Save token") {
                    saveOpenClawGatewayToken()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(openClawGatewayTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button("Clear") {
                    clearOpenClawGatewayToken()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(!openClawGatewayTokenSaved && openClawGatewayTokenInput.isEmpty)

                if openClawGatewayTokenSaved {
                    Text("Saved in Keychain")
                        .font(.system(size: 10))
                        .foregroundStyle(.green)
                }
            }
            if let openClawGatewayTokenError {
                Text(openClawGatewayTokenError)
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Paste the token configured on the OpenClaw Gateway, not an AgentDeck token. Saving stores it in Keychain and restarts the local daemon.")
                    .font(.system(size: 10))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.75))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        #else
        EmptyView()
        #endif
    }

    private func loadOpenClawGatewayTokenState() {
        #if os(macOS) && AGENTDECK_APP_STORE
        openClawGatewayTokenSaved = OpenClawGatewayTokenStore.loadToken() != nil
        openClawGatewayTokenError = nil
        #endif
    }

    private func saveOpenClawGatewayToken() {
        #if os(macOS) && AGENTDECK_APP_STORE
        do {
            try OpenClawGatewayTokenStore.saveToken(openClawGatewayTokenInput)
            openClawGatewayTokenInput = ""
            openClawGatewayTokenSaved = true
            openClawGatewayTokenError = nil
            Task { await daemonService.restart() }
        } catch {
            openClawGatewayTokenError = "Could not save token: \(error.localizedDescription)"
        }
        #endif
    }

    private func clearOpenClawGatewayToken() {
        #if os(macOS) && AGENTDECK_APP_STORE
        do {
            try OpenClawGatewayTokenStore.deleteToken()
            openClawGatewayTokenInput = ""
            openClawGatewayTokenSaved = false
            openClawGatewayTokenError = nil
            Task { await daemonService.restart() }
        } catch {
            openClawGatewayTokenError = "Could not clear token: \(error.localizedDescription)"
        }
        #endif
    }

    // MARK: - Anthropic Admin API (org-wide token usage)

    /// Optional: paste a Console Admin API key to surface org-wide token
    /// consumption (today + last 30 days). This is the only sanctioned
    /// third-party path for Anthropic usage in App Store builds —
    /// subscription OAuth tokens were closed off by Anthropic's Feb 2026
    /// policy update. Users on Pro/Max without an API key still get live
    /// session monitoring through the hook pipeline.
    private var anthropicAdminApiRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("Anthropic API Usage")
                    .font(.system(size: 13, weight: .semibold))
                Text(anthropicAdminApiStatusLabel)
                    .font(.system(size: 11))
                    .foregroundStyle(anthropicAdminApiStatusColor)
            }
            Text("Optional. Paste an Admin API key from console.anthropic.com/settings/keys to track org-wide token consumption (today + last 30 days). This is API-usage billing, not Pro/Max subscription quota.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
            #if os(macOS) && AGENTDECK_APP_STORE
            anthropicAdminApiEditor
            #endif
            if let usage = latestAdminApiUsageSummary {
                Text(usage)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { loadAnthropicAdminApiKeyState() }
    }

    private var anthropicAdminApiStatusLabel: String {
        if anthropicAdminApiKeySaved { return "Connected" }
        return "Not configured"
    }

    private var anthropicAdminApiStatusColor: Color {
        anthropicAdminApiKeySaved ? .green : .secondary
    }

    private var latestAdminApiUsageSummary: String? {
        guard anthropicAdminApiKeySaved else { return nil }
        let todayIn = stateHolder.state.adminApiTodayInputTokens ?? 0
        let todayOut = stateHolder.state.adminApiTodayOutputTokens ?? 0
        let monthIn = stateHolder.state.adminApiMonthInputTokens ?? 0
        let monthOut = stateHolder.state.adminApiMonthOutputTokens ?? 0
        let todayTotal = todayIn + todayOut
        let monthTotal = monthIn + monthOut
        if todayTotal == 0 && monthTotal == 0 {
            return "Awaiting first fetch (~5 min data delay from Anthropic)…"
        }
        return "Today: \(formatTokenCount(todayTotal)) · 30d: \(formatTokenCount(monthTotal))"
    }

    private func formatTokenCount(_ n: Int) -> String {
        if n >= 1_000_000 {
            return String(format: "%.1fM", Double(n) / 1_000_000)
        } else if n >= 1_000 {
            return String(format: "%.1fK", Double(n) / 1_000)
        }
        return "\(n)"
    }

    @ViewBuilder
    private var anthropicAdminApiEditor: some View {
        #if os(macOS) && AGENTDECK_APP_STORE
        VStack(alignment: .leading, spacing: 6) {
            SecureField(
                anthropicAdminApiKeySaved
                    ? "Admin API key saved — paste to replace"
                    : "sk-ant-admin01-… (Console Admin API key)",
                text: $anthropicAdminApiKeyInput
            )
            .textFieldStyle(.roundedBorder)
            HStack(spacing: 8) {
                Button("Save key") {
                    saveAnthropicAdminApiKey()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(anthropicAdminApiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button("Clear") {
                    clearAnthropicAdminApiKey()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(!anthropicAdminApiKeySaved && anthropicAdminApiKeyInput.isEmpty)

                if anthropicAdminApiKeySaved {
                    Text("Saved in Keychain")
                        .font(.system(size: 10))
                        .foregroundStyle(.green)
                }
            }
            if let anthropicAdminApiKeyError {
                Text(anthropicAdminApiKeyError)
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        #else
        EmptyView()
        #endif
    }

    private func loadAnthropicAdminApiKeyState() {
        #if os(macOS) && AGENTDECK_APP_STORE
        anthropicAdminApiKeySaved = AnthropicAdminApiKeyStore.loadKey() != nil
        anthropicAdminApiKeyError = nil
        #endif
    }

    private func saveAnthropicAdminApiKey() {
        #if os(macOS) && AGENTDECK_APP_STORE
        do {
            try AnthropicAdminApiKeyStore.saveKey(anthropicAdminApiKeyInput)
            anthropicAdminApiKeyInput = ""
            anthropicAdminApiKeySaved = true
            anthropicAdminApiKeyError = nil
            Task { await daemonService.restart() }
        } catch {
            anthropicAdminApiKeyError = "Could not save key: \(error.localizedDescription)"
        }
        #endif
    }

    private func clearAnthropicAdminApiKey() {
        #if os(macOS) && AGENTDECK_APP_STORE
        do {
            try AnthropicAdminApiKeyStore.deleteKey()
            anthropicAdminApiKeyInput = ""
            anthropicAdminApiKeySaved = false
            anthropicAdminApiKeyError = nil
            Task { await daemonService.restart() }
        } catch {
            anthropicAdminApiKeyError = "Could not clear key: \(error.localizedDescription)"
        }
        #endif
    }

    // MARK: - ADB / Android integration status row

    /// Android device bridging shells out to the `adb` binary, which App
    /// Sandbox blocks (no external-binary spawn). Flag that inline so users
    /// on the App Store build don't think AgentDeck forgot their phone.
    private var adbIntegrationRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "iphone.and.arrow.forward")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
                Text("Android / ADB")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                if AgentDeckRuntime.isSandboxed {
                    Text("Unavailable")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
            if AgentDeckRuntime.isSandboxed {
                Text("Android/ADB bridging requires subprocess access and is disabled in the App Store build.")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Runs `adb` from PATH. Install with `brew install android-platform-tools` if it's missing.")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    #if os(macOS)
    @State private var showESP32Sheet: Bool = false
    @State private var showPixooSheet: Bool = false
    #endif

    /// Hardware integrations that ship with in-app setup UI. D200H is plug
    /// and play (no setup sheet needed), ESP32 needs Wi-Fi credentials, and
    /// Pixoo needs an IP. We colocate the entry points so users don't have
    /// to hunt through the app for "how do I add my device?".
    #if os(macOS)
    private var hardwareContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            hardwareRow(
                icon: "antenna.radiowaves.left.and.right",
                title: "ESP32 boards",
                subtitle: "Send Wi-Fi credentials over USB. Works with 86Box, IPS 3.5\" and round AMOLED displays.",
                buttonLabel: "Set up…",
                action: { showESP32Sheet = true }
            )
            Divider()
            hardwareRow(
                icon: "square.grid.3x3.fill",
                title: "Pixoo matrix displays",
                subtitle: "Add Divoom Pixoo devices by IP. Restart the daemon after adding for changes to take effect.",
                buttonLabel: "Manage…",
                action: { showPixooSheet = true }
            )
            Divider()
            Text("Ulanzi D200H Deck Dock connects over USB automatically — no setup required. Plug it in and it appears in the session list.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
        }
        .sheet(isPresented: $showESP32Sheet) {
            ESP32ProvisionSheet()
        }
        .sheet(isPresented: $showPixooSheet) {
            PixooSheet()
        }
    }

    private func hardwareRow(
        icon: String,
        title: String,
        subtitle: String,
        buttonLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 13))
                .foregroundStyle(TerrariumHUD.subtext)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button(buttonLabel, action: action)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
    }
    #endif

    private var servicesContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            codexAuthRow
            Divider()

            adbIntegrationRow
            Divider()

            openClawIntegrationRow
            Divider()

            anthropicAdminApiRow
            Divider()

            Text("Antigravity")
                .font(.system(size: 13, weight: .semibold))

            Text("Off by default for App Store compatibility. Grant access only if you want AgentDeck to read Antigravity's local plan state.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext)

            Text("App Sandbox requires explicit file access. Select the state.vscdb file to enable.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))

            if let path = preferences.antigravitySelectedPath, preferences.antigravityAccessEnabled {
                Text(path)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            } else {
                Text("No Antigravity database selected")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
            }

            #if os(macOS)
            HStack {
                Button("Choose state.vscdb") {
                    _ = preferences.chooseAntigravityDatabase()
                }
                .buttonStyle(.borderedProminent)

                if preferences.antigravityAccessEnabled {
                    Button("Remove Access") {
                        showRemoveAntigravityConfirm = true
                    }
                    .buttonStyle(.bordered)
                    .confirmationDialog(
                        "Remove Antigravity access?",
                        isPresented: $showRemoveAntigravityConfirm,
                        titleVisibility: .visible
                    ) {
                        Button("Remove", role: .destructive) {
                            preferences.clearAntigravityAccess()
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("This will revoke file access to the Antigravity database. You can re-enable it later.")
                    }
                }
            }
            #else
            Text("This integration can only be configured on macOS.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext)
            #endif
        }
    }

    // MARK: - Claude Code Hooks (macOS)

    #if os(macOS)
    /// Explicit opt-in surface for `~/.claude/settings.local.json` hook
    /// registration. Replaces the old auto-install behaviour — App Store
    /// review 2.5.2 requires user consent before we touch files outside
    /// the sandbox.
    private var claudeHooksContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(preferences.hooksInstalled
                          ? TerrariumHUD.ledGreen
                          : TerrariumHUD.ledRed.opacity(0.6))
                    .frame(width: 8, height: 8)
                Text(hookStatusText)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white)
            }

            Text("AgentDeck can register hooks in ~/.claude/settings.local.json so Claude Code sessions report state to the dashboard. You'll be asked to grant access to that file before any write happens.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext)
                .fixedSize(horizontal: false, vertical: true)

            if let path = UserDefaults.standard.string(forKey: "prefs.claudeSettingsPath") {
                Text(path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            HStack(spacing: 8) {
                Button("Enable Claude Code Hooks…") {
                    _ = HookInstaller.promptAndInstall()
                }
                .buttonStyle(.borderedProminent)
                .disabled(preferences.hookInstallConsent == .accepted && preferences.hooksInstalled)

                Button("Remove") {
                    HookInstaller.uninstallAndRevoke()
                }
                .buttonStyle(.bordered)
                .disabled(!preferences.hooksInstalled)
            }
        }
    }

    private var hookStatusText: String {
        if preferences.hooksInstalled {
            return "Hooks installed"
        }
        switch preferences.hookInstallConsent {
        case .unknown: return "Not configured"
        case .declined: return "Declined — click Enable to revisit"
        case .accepted: return "Consent granted, not yet written"
        }
    }
    #endif

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(TerrariumHUD.subtext)
            Spacer()
            Text(value)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.white)
        }
    }
}
