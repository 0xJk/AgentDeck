// SettingsScreen.swift — Settings dialog (matches Android TabletSettingsDialog.kt)

import SwiftUI

struct SettingsScreen: View {
    @Environment(AgentStateHolder.self) private var stateHolder
    @Environment(\.dismiss) private var dismiss
    @State private var manualUrl = ""

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

    private var macOSSettings: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Settings")
                .font(.title2.bold())

            GroupBox("Connection") {
                connectionContent
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

            GroupBox("About") {
                aboutContent
                    .padding(8)
            }

            Spacer()
        }
        .padding(20)
        .frame(width: 420, height: 440)
    }

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

            #if os(macOS)
            if !stateHolder.localDiscovery.sessions.isEmpty {
                Text("Local Sessions")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .padding(.top, 4)

                ForEach(stateHolder.localDiscovery.sessions) { bridge in
                    Button {
                        stateHolder.connectTo(bridge)
                    } label: {
                        HStack {
                            Text(bridge.project ?? bridge.name)
                                .foregroundStyle(.white)
                            Spacer()
                            Text("local")
                                .font(.system(size: 9))
                                .foregroundStyle(.green)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.green.opacity(0.15), in: Capsule())
                        }
                        .padding(.vertical, 6)
                        .padding(.horizontal, 10)
                        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                }
            }
            #endif
        }
    }

    // MARK: - Display Content

    private var displayContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            #if os(iOS)
            Toggle(isOn: Bindable(stateHolder.displaySync).enabled) {
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
            infoRow("Bundle", "bound.serendipity.agentdeck")
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
