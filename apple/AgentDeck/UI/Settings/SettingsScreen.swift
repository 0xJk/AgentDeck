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
    #if os(macOS)
    @State private var portInput: String = ""
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

                    // Connection Card
                    settingsCard(title: "Connection") {
                        connectionContent
                    }

                    // Discovery Card
                    settingsCard(title: "Discovery") {
                        discoveryContent
                    }

                    // Display Card
                    settingsCard(title: "Display") {
                        displayContent
                    }

                    settingsCard(title: "Dashboard") {
                        dashboardContent
                    }

                    settingsCard(title: "Services") {
                        servicesContent
                    }

                    // About Card
                    settingsCard(title: "About") {
                        aboutContent
                    }

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
    private var macOSSettings: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Settings")
                .font(.title2.bold())

            GroupBox("Connection") {
                connectionContent
                    .padding(8)
            }

            GroupBox("Daemon") {
                daemonContent
                    .padding(8)
            }

            GroupBox("Discovery") {
                discoveryContent
                    .padding(8)
            }

            GroupBox("Display") {
                displayContent
                    .padding(8)
            }

            GroupBox("Dashboard") {
                dashboardContent
                    .padding(8)
            }

            GroupBox("Services") {
                servicesContent
                    .padding(8)
            }

            GroupBox("APME") {
                apmeContent
                    .padding(8)
            }

            GroupBox("About") {
                aboutContent
                    .padding(8)
            }

            Spacer()
        }
        .padding(20)
        .frame(width: 460, height: 720)
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
            }
        }
    }

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
                                Text(":\(proc.port)")
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

                Button("Switch D200H to Bundled Helper Now") {
                    Task { await daemonService.startBundledD200HHelper() }
                }
                .buttonStyle(.bordered)
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
            return "Local daemon on port \(daemonService.port)"
        }
        if daemonService.isUsingExternalDaemon {
            return daemonService.ownsExternalDaemon
                ? "Bundled D200H helper on port \(daemonService.port)"
                : "External daemon on port \(daemonService.port)"
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
        VStack(spacing: 4) {
            infoRow("App", "AgentDeck")
            infoRow("Version", "1.0.0")
            infoRow("Bundle", "bound.serendipity.agentdeck.dashboard")
        }
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
            .pickerStyle(.radioGroup)
            .labelsHidden()

            // Inline availability hint for the current selection.
            Group {
                switch preferences.apmeJudgeBackend {
                case "foundationModels":
                    let ready = ApmeJudgeFoundationModels.isAvailable
                    Label(
                        ready ? "Apple Intelligence ready" : ApmeJudgeFoundationModels.unavailableReason,
                        systemImage: ready ? "checkmark.circle.fill" : "exclamationmark.triangle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(ready ? .green : .orange)
                case "mlx":
                    Label(
                        "Requires a local MLX server at http://127.0.0.1:8800. Start it before scoring runs.",
                        systemImage: "info.circle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
                case "api":
                    let configured = ApmeJudgeApi.isConfigured
                    Label(
                        configured
                            ? "ANTHROPIC_API_KEY detected. Calls cost Anthropic credits."
                            : "Set ANTHROPIC_API_KEY in env or ~/.agentdeck/settings.json. Paid backend — opt-in only.",
                        systemImage: configured ? "dollarsign.circle.fill" : "key.slash"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(configured ? .yellow : .orange)
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

    private var servicesContent: some View {
        VStack(alignment: .leading, spacing: 10) {
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
