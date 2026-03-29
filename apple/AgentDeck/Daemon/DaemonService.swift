#if os(macOS)
// DaemonService.swift — In-process daemon lifecycle manager
// Wraps DaemonServer for use within the macOS SwiftUI app
import Foundation
import ServiceManagement

/// Manages the daemon lifecycle within the main app process.
/// On macOS, starts WS server, mDNS, hook server, etc. as part of the app.
@MainActor
@Observable
final class DaemonService {
    private(set) var isRunning = false
    private(set) var port: UInt16 = 0
    private(set) var connectedClients = 0
    private(set) var errorMessage: String?

    /// Called when daemon starts — provides ws://localhost:PORT URL for dashboard connection
    var onReady: ((String) -> Void)?

    private var server: DaemonServer?

    /// Start daemon in-process
    func start() {
        guard !isRunning else { return }

        Task {
            do {
                let daemon = try await DaemonServer(port: nil, debug: false)
                self.server = daemon
                self.port = daemon.port
                self.isRunning = true
                self.errorMessage = nil

                // Run daemon (sets up routes, handlers, polling — does NOT block)
                await daemon.startServices()

                // Notify dashboard to connect to local daemon
                let wsUrl = "ws://127.0.0.1:\(daemon.port)"
                DaemonLogger.shared.info("Daemon ready — dashboard can connect to \(wsUrl)")
                self.onReady?(wsUrl)
            } catch DaemonError.alreadyRunning {
                // Another daemon (e.g. Node.js) is running — connect as client instead
                self.errorMessage = nil
                self.isRunning = false
                DaemonLogger.shared.info("External daemon detected, running as client only")
            } catch {
                self.errorMessage = "Daemon failed: \(error.localizedDescription)"
                DaemonLogger.shared.error(self.errorMessage!)
            }
        }
    }

    /// Stop daemon
    func stop() async {
        await server?.shutdown()
        server = nil
        isRunning = false
        port = 0
    }

    // MARK: - Login Item (auto-start at login)

    func registerLoginItem() {
        if #available(macOS 13.0, *) {
            let service = SMAppService.mainApp
            do {
                try service.register()
                DaemonLogger.shared.info("Registered as login item")
            } catch {
                DaemonLogger.shared.error("Failed to register login item: \(error)")
            }
        }
    }

    func unregisterLoginItem() {
        if #available(macOS 13.0, *) {
            let service = SMAppService.mainApp
            do {
                try service.unregister()
            } catch {
                DaemonLogger.shared.error("Failed to unregister login item: \(error)")
            }
        }
    }

    var isLoginItemEnabled: Bool {
        if #available(macOS 13.0, *) {
            return SMAppService.mainApp.status == .enabled
        }
        return false
    }
}
#endif
