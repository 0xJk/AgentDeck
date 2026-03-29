// AgentDeckApp.swift — Universal app entry point (iOS + macOS)

import SwiftUI
#if os(macOS)
import ServiceManagement
#endif

@main
struct AgentDeckApp: App {
    @State private var stateHolder = AgentStateHolder()
    #if os(macOS)
    @State private var daemonService = DaemonService()
    @Environment(\.openWindow) private var openWindow
    #endif

    var body: some Scene {
        WindowGroup("AgentDeck Dashboard", id: "dashboard") {
            ContentView()
                .environment(stateHolder)
                #if os(macOS)
                .onAppear { startDaemonAndConnect() }
                #endif
        }
        #if os(macOS)
        Settings {
            SettingsScreen()
                .environment(stateHolder)
        }
        MenuBarExtra("AgentDeck", systemImage: daemonService.isRunning
            ? "antenna.radiowaves.left.and.right"
            : "antenna.radiowaves.left.and.right.slash"
        ) {
            Button("Show Dashboard") {
                openWindow(id: "dashboard")
                NSApplication.shared.activate(ignoringOtherApps: true)
            }.keyboardShortcut("d")

            if daemonService.isRunning {
                Text("Daemon on port \(daemonService.port)")
                    .font(.caption).foregroundStyle(.secondary)
            } else if let error = daemonService.errorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
            } else {
                Text("Connecting...").font(.caption).foregroundStyle(.secondary)
            }

            Divider()

            Toggle("Start at Login", isOn: Binding(
                get: { daemonService.isLoginItemEnabled },
                set: { enabled in
                    if enabled { daemonService.registerLoginItem() }
                    else { daemonService.unregisterLoginItem() }
                }
            ))

            Button("Launch Claude Session") {
                SessionLauncher.launchSession()
            }

            Divider()

            Button("Quit AgentDeck") {
                Task {
                    await daemonService.stop()
                    NSApplication.shared.terminate(nil)
                }
            }.keyboardShortcut("q")
        }
        #endif
    }

    #if os(macOS)
    private func startDaemonAndConnect() {
        daemonService.onReady = { [stateHolder] wsUrl in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                stateHolder.connectTo(url: wsUrl)
            }
        }
        daemonService.start()
    }
    #endif
}
