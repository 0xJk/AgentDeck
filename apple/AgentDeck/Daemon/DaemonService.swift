#if os(macOS)
// DaemonService.swift — In-process daemon lifecycle manager
// Wraps DaemonServer for use within the macOS SwiftUI app
import Foundation
import ServiceManagement
import Combine
import IOKit

/// Manages the daemon lifecycle within the main app process.
/// On macOS, starts WS server, mDNS, hook server, etc. as part of the app.
@MainActor
final class DaemonService: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var isUsingExternalDaemon = false
    @Published private(set) var ownsExternalDaemon = false
    @Published private(set) var port: UInt16 = 0
    @Published private(set) var connectedClients = 0
    @Published private(set) var errorMessage: String?

    /// Called when daemon starts — provides ws://localhost:PORT URL for dashboard connection
    var onReady: ((String) -> Void)? {
        didSet {
            if let readyUrl, let onReady {
                onReady(readyUrl)
            }
        }
    }

    private var server: DaemonServer?
    private var isStarting = false
    private var readyUrl: String?
    private var healthMonitorTask: Task<Void, Never>?
    private var externalFailureCount = 0
    private var localFailureCount = 0
    private var signalSource: DispatchSourceSignal?
    private var sigintSource: DispatchSourceSignal?
    private var externalDaemonProcess: Process?
    private var listenerFailureRetries = 0
    private var squatterCleanupAttempted = false
    private var fallbackAttempted = false
    private var d200hHelperPromotionAttempted = false
    private var sessionOverridePort: Int?
    /// Ports that NWListener has observed to fail `.failed(EADDRINUSE)` this
    /// launch. These may still look bindable via raw BSD sockets (NECP is a
    /// higher-level check), so we exclude them explicitly from findAvailablePort.
    private var failedBindPorts: Set<Int> = []
    private static let maxListenerFailureRetries = 3

    /// Human-readable explanation for the last bind failure, shown in Settings.
    /// Set when bind retries are exhausted; cleared on successful start.
    @Published private(set) var bindFailureReason: String?

    /// Processes that may be blocking the daemon port. Populated on bind failure.
    @Published private(set) var blockingProcesses: [BlockingProcess] = []

    /// True while the daemon is running on a fallback port (user's configured
    /// port was held by something we can't terminate). Surface this in the UI.
    @Published private(set) var isOnFallbackPort = false

    /// The port the daemon is attempting to bind. A session-scoped override
    /// (set by auto-fallback when the configured port is stuck) takes
    /// precedence; otherwise falls back to user's Settings value.
    private var effectivePort: Int {
        sessionOverridePort ?? AppPreferences.shared.daemonPort
    }

    nonisolated static func promotionTargetPort(currentPort: UInt16, effectivePort: Int) -> Int {
        let activePort = Int(currentPort)
        return activePort > 0 ? activePort : effectivePort
    }

    nonisolated static func resolvedSessionOverridePort(configuredPort: Int, actualPort: Int) -> Int? {
        actualPort == configuredPort ? nil : actualPort
    }

    init() {
        start()
        setupSignalHandler()
    }

    /// Start daemon in-process
    func start() {
        guard !isRunning, !isUsingExternalDaemon, !isStarting else { return }
        isStarting = true
        errorMessage = nil
        bindFailureReason = nil; blockingProcesses = []

        let port = effectivePort
        Task {
            defer { self.isStarting = false }
            do {
                // Pass nil only when we're binding the default and the user
                // didn't force an override; that preserves the singleton-guard
                // path (health probe + stale registry cleanup). Otherwise we
                // pass an explicit port and skip that path.
                let usingDefault = (port == AppPreferences.defaultDaemonPort && sessionOverridePort == nil)
                let portArg: Int? = usingDefault ? nil : port
                let daemon = try await DaemonServer(port: portArg, debug: false)
                self.server = daemon
                self.port = daemon.port
                self.isRunning = true
                self.isUsingExternalDaemon = false
                self.ownsExternalDaemon = false
                self.localFailureCount = 0
                self.externalFailureCount = 0
                self.errorMessage = nil

                // Wire listener-failed callback BEFORE starting — catches POST-bind
                // listener failures (network changes, system-sleep edge cases).
                // Pre-bind/EADDRINUSE now surfaces as a throw from startServices().
                await daemon.setListenerFailedHandler { [weak self] error in
                    Task { @MainActor [weak self] in
                        await self?.handleListenerFailure(error: error)
                    }
                }

                // Run daemon (awaits NWListener `.ready`; throws on bind failure).
                do {
                    try await daemon.startServices()
                } catch {
                    // Bind failed — tear down partial state and route to startup-failure handler.
                    await daemon.shutdown()
                    self.server = nil
                    self.isRunning = false
                    self.port = 0
                    self.readyUrl = nil
                    await self.handleStartupBindFailure(error: error, attemptedPort: Int(daemon.port))
                    return
                }
                self.startHealthMonitor()

                // Notify dashboard to connect to local daemon (listener is actually bound now).
                let wsUrl = "ws://127.0.0.1:\(daemon.port)"
                self.readyUrl = wsUrl
                self.listenerFailureRetries = 0  // reset backoff on success
                self.squatterCleanupAttempted = false
                self.syncResolvedPortState(actualPort: Int(daemon.port))
                DaemonLogger.shared.info("Daemon ready — dashboard can connect to \(wsUrl)")
                self.onReady?(wsUrl)
            } catch DaemonError.alreadyRunning(let port) {
                // Another daemon (e.g. Node.js) is running — connect as client instead
                await self.connectToExternalDaemon(port: port)
            } catch {
                self.server = nil
                self.isRunning = false
                self.isUsingExternalDaemon = false
                self.port = 0
                self.readyUrl = nil
                self.errorMessage = "Daemon failed: \(error.localizedDescription)"
                DaemonLogger.shared.error(self.errorMessage!)
            }
        }
    }

    /// Tear down the current daemon (local or external) and start fresh. Used
    /// after the user changes the daemon port in Settings. Clears any
    /// session-scoped fallback so the new user choice is honored exactly.
    func restart() async {
        await stop()
        listenerFailureRetries = 0
        squatterCleanupAttempted = false
        fallbackAttempted = false
        d200hHelperPromotionAttempted = false
        sessionOverridePort = nil
        failedBindPorts.removeAll()
        isOnFallbackPort = false
        bindFailureReason = nil; blockingProcesses = []
        errorMessage = nil
        start()
    }

    /// Stop daemon
    func stop() async {
        healthMonitorTask?.cancel()
        healthMonitorTask = nil
        await server?.shutdown()
        await stopOwnedExternalDaemonIfNeeded()
        server = nil
        isRunning = false
        isUsingExternalDaemon = false
        ownsExternalDaemon = false
        d200hHelperPromotionAttempted = false
        port = 0
        readyUrl = nil
    }

    func startBundledD200HHelper() async {
        errorMessage = nil
        bindFailureReason = nil; blockingProcesses = []

        let targetPort = Self.promotionTargetPort(currentPort: port, effectivePort: effectivePort)
        let registry = SessionRegistry.shared

        if let health = await registry.probeDaemonHealth(port: targetPort),
           health["mode"] as? String == "daemon" {
            let remotePid = health["pid"] as? Int
            let myPid = Int(ProcessInfo.processInfo.processIdentifier)
            if remotePid != myPid {
                // Genuine external helper already running — connect as client
                externalDaemonProcess = nil
                await connectToExternalDaemon(port: targetPort)
                return
            }
            DaemonLogger.shared.info("D200H promotion: replacing local daemon on port \(targetPort) with bundled helper")
        }

        await stop()

        let process = Process()
        if let bundledHelper = Self.resolveBundledD200HHelper() {
            process.executableURL = URL(fileURLWithPath: bundledHelper)
            process.arguments = ["-p", String(targetPort)]
        } else if let launch = Self.resolveRepoNodeDaemonLaunch() {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node", launch.cliPath, "start", "-p", String(targetPort)]
            process.currentDirectoryURL = URL(fileURLWithPath: launch.repoRoot, isDirectory: true)
            process.environment = Self.helperEnvironment()
        } else {
            errorMessage = "Bundled D200H helper unavailable: no bundled helper or local bridge build found."
            return
        }

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
            externalDaemonProcess = process
            DaemonLogger.shared.info("Spawned managed D200H helper on port \(targetPort)")
        } catch {
            externalDaemonProcess = nil
            errorMessage = "Failed to start bundled D200H helper: \(error.localizedDescription)"
            return
        }

        for _ in 0..<20 {
            if let health = await registry.probeDaemonHealth(port: targetPort),
               health["mode"] as? String == "daemon" {
                await connectToExternalDaemon(port: targetPort)
                return
            }
            try? await Task.sleep(for: .milliseconds(300))
        }

        let stderrData = stderrPipe.fileHandleForReading.availableData
        let stderrText = String(data: stderrData, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let detail = stderrText?.isEmpty == false
            ? "Bundled D200H helper failed: \(stderrText!)"
            : "Bundled D200H helper did not become healthy on port \(targetPort)."
        await stopOwnedExternalDaemonIfNeeded()

        // Helper spawn failed after stop() — without explicit recovery the app
        // sits in a "daemon down" state until the user toggles settings. Revive
        // the in-process daemon so dashboard/CLI/D200H paths keep working on
        // the local code path. d200hHelperPromotionAttempted stays true so the
        // health monitor doesn't immediately re-promote into the same failure.
        DaemonLogger.shared.error("\(detail) — reverting to local in-process daemon")
        errorMessage = "\(detail) Reverted to local daemon."
        start()
    }

    private func connectToExternalDaemon(port knownPort: Int? = nil) async {
        let registry = SessionRegistry.shared
        let resolvedPort = knownPort
            ?? registry.findDaemonPort()
            ?? registry.readDaemonInfo()?.port
            ?? registry.findExistingDaemon()?.port

        guard let resolvedPort else {
            self.server = nil
            self.isRunning = false
            self.isUsingExternalDaemon = false
            self.ownsExternalDaemon = false
            self.port = 0
            self.readyUrl = nil
            self.errorMessage = "External daemon detected, but port lookup failed"
            DaemonLogger.shared.error(self.errorMessage!)
            return
        }

        let maxAttempts = knownPort != nil ? 12 : 3
        var health: [String: Any]?
        for attempt in 0..<maxAttempts {
            health = await registry.probeDaemonHealth(port: resolvedPort)
            if health?["mode"] as? String == "daemon" {
                break
            }
            if attempt < maxAttempts - 1 {
                try? await Task.sleep(for: .milliseconds(knownPort != nil ? 300 : 200))
            }
        }

        guard let health, health["mode"] as? String == "daemon" else {
            // External daemon never responded — stale registry. Clean up and start our own.
            DaemonLogger.shared.info("External daemon on port \(resolvedPort) is stale — starting local daemon instead")
            self.server = nil
            self.isRunning = false
            self.isUsingExternalDaemon = false
            self.port = 0
            self.readyUrl = nil
            self.errorMessage = nil
            // Wait briefly for TIME_WAIT clearance then try starting local daemon
            try? await Task.sleep(for: .seconds(1))
            start()
            return
        }

        let wsUrl = "ws://127.0.0.1:\(resolvedPort)"
        self.server = nil
        self.port = UInt16(resolvedPort)
        self.isRunning = false
        self.isUsingExternalDaemon = true
        self.ownsExternalDaemon = (externalDaemonProcess?.isRunning == true)
        self.localFailureCount = 0
        self.externalFailureCount = 0
        self.errorMessage = nil
        self.readyUrl = wsUrl
        self.syncResolvedPortState(actualPort: resolvedPort)
        self.startHealthMonitor()
        DaemonLogger.shared.info("External daemon detected on port \(resolvedPort) — connecting as client")
        self.onReady?(wsUrl)
    }

    private func syncResolvedPortState(actualPort: Int) {
        let configuredPort = AppPreferences.shared.daemonPort
        sessionOverridePort = Self.resolvedSessionOverridePort(
            configuredPort: configuredPort,
            actualPort: actualPort
        )
        isOnFallbackPort = (sessionOverridePort != nil)
        if isOnFallbackPort {
            bindFailureReason = "Daemon moved to fallback port \(actualPort) because \(configuredPort) was held by another process. Clients will rediscover via mDNS."
            if blockingProcesses.isEmpty {
                blockingProcesses = PortDiagnostics.collectBlockers(port: configuredPort)
            }
        } else {
            bindFailureReason = nil; blockingProcesses = []
        }
    }

    private func stopOwnedExternalDaemonIfNeeded() async {
        guard let process = externalDaemonProcess else { return }
        let currentPort = Int(port)
        if process.isRunning, currentPort > 0 {
            let url = URL(string: "http://127.0.0.1:\(currentPort)/shutdown")!
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 1
            _ = try? await URLSession.shared.data(for: request)
            try? await Task.sleep(for: .milliseconds(300))
        }
        if process.isRunning {
            process.terminate()
        }
        externalDaemonProcess = nil
    }

    private static func helperEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let prefixes = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "\(home)/.local/bin",
            "\(home)/Library/pnpm",
            "\(home)/.npm-global/bin",
        ]
        let existing = env["PATH"] ?? ""
        env["PATH"] = (prefixes + [existing]).joined(separator: ":")
        return env
    }

    private static func resolveBundledD200HHelper() -> String? {
        let helperPath = Bundle.main.bundlePath + "/Contents/Helpers/agentdeck-d200h-helper"
        guard FileManager.default.isExecutableFile(atPath: helperPath) else { return nil }
        return helperPath
    }

    private static func resolveRepoNodeDaemonLaunch() -> (repoRoot: String, cliPath: String)? {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .path
        let cliPath = "\(repoRoot)/bridge/dist/cli.js"
        guard FileManager.default.fileExists(atPath: cliPath) else { return nil }
        return (repoRoot, cliPath)
    }

    /// Called when a running daemon's NWListener enters `.failed` state post-bind
    /// (e.g. network loss after successful bind). Tears down and retries.
    private func handleListenerFailure(error: Error) async {
        guard isRunning else { return }
        DaemonLogger.shared.error("Listener failure detected — tearing down and retrying: \(error)")
        let attemptedPort = Int(port)
        await server?.shutdown()
        server = nil
        isRunning = false
        isUsingExternalDaemon = false
        port = 0
        readyUrl = nil
        await retryOrFallback(error: error, attemptedPort: attemptedPort)
    }

    /// Called when startup-time NWListener bind fails (e.g. EADDRINUSE). Before
    /// retrying we probe the contested port — if a healthy external daemon owns
    /// it, we transition to client mode instead of spin-retrying forever.
    private func handleStartupBindFailure(error: Error, attemptedPort: Int) async {
        DaemonLogger.shared.error("Daemon listener bind failed: \(error)")
        await retryOrFallback(error: error, attemptedPort: attemptedPort)
    }

    /// Shared failure path: probe for external daemon → connect as client, else
    /// exponential backoff retry (1s/2s/4s, max 3). On retry exhaustion, clear
    /// daemon.json so stale entries don't leak to plugin/TUI clients.
    private func retryOrFallback(error: Error, attemptedPort: Int) async {
        let registry = SessionRegistry.shared
        let probePort = attemptedPort > 0 ? attemptedPort : AppPreferences.shared.daemonPort
        if attemptedPort > 0 { failedBindPorts.insert(attemptedPort) }
        if let health = await registry.probeDaemonHealth(port: probePort),
           health["mode"] as? String == "daemon" {
            DaemonLogger.shared.info("Port \(probePort) held by healthy external daemon — switching to client mode")
            listenerFailureRetries = 0
            squatterCleanupAttempted = false
            await connectToExternalDaemon(port: probePort)
            return
        }

        // Before spending retry budget on the same failing bind, try the one
        // App-Store-safe cleanup we're allowed: forceTerminate same-bundle-ID
        // zombies (crashed/suspended prior instances of this app).
        var squatterCleanupFoundNothing = false
        if !squatterCleanupAttempted {
            squatterCleanupAttempted = true
            let killed = SquatterCleaner.forceTerminateOwnBundleSiblings()
            if killed > 0 {
                DaemonLogger.shared.info("Squatter cleanup terminated \(killed) sibling instance(s); retrying immediately")
                // Short settle so the kernel releases the sockets before rebinding.
                // Scheduling via Task lets the current start()'s Task complete
                // (defer → isStarting=false) before we re-enter.
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(500))
                    self?.start()
                }
                return
            }
            squatterCleanupFoundNothing = true
        }

        let userExplicitPort = AppPreferences.shared.daemonPort
        let onDefault = (userExplicitPort == AppPreferences.defaultDaemonPort) && (sessionOverridePort == nil)
        let alt = await registry.findAvailablePort(excluding: failedBindPorts)
        DaemonLogger.shared.info("retryOrFallback diag: userExplicitPort=\(userExplicitPort) onDefault=\(onDefault) fallbackAttempted=\(fallbackAttempted) squatterNothing=\(squatterCleanupFoundNothing) findAvailable=\(alt.map(String.init) ?? "nil") attemptedPort=\(attemptedPort)")

        // If squatter cleanup found no owned siblings AND we're on the default
        // port, the squatter is an external process we can't touch. Retries
        // won't free the port, so jump straight to the fallback port now.
        if onDefault, !fallbackAttempted, squatterCleanupFoundNothing,
           let altPort = alt, altPort != userExplicitPort {
            fallbackAttempted = true
            sessionOverridePort = altPort
            listenerFailureRetries = 0
            squatterCleanupAttempted = false
            DaemonLogger.shared.info("Port \(userExplicitPort) held by external process — falling back to \(altPort) immediately")
            // Show diagnostic panel so user can clean up the squatter.
            blockingProcesses = PortDiagnostics.collectBlockers(port: userExplicitPort)
            bindFailureReason = "Port \(userExplicitPort) is held by another process. Daemon started on fallback port \(altPort). Clean up the blocking process to restore port \(userExplicitPort)."
            isOnFallbackPort = true
            Task { @MainActor [weak self] in self?.start() }
            return
        }

        // If the attempted port also failed, try the next available port
        // before burning a retry. Without this, retries repeatedly hit the
        // same blocked port (e.g., 9122 held by zombie node) instead of
        // advancing to 9123, 9124, etc.
        if fallbackAttempted, let nextPort = alt, nextPort != attemptedPort {
            sessionOverridePort = nextPort
            DaemonLogger.shared.info("Advancing fallback port \(attemptedPort) → \(nextPort)")
        }

        listenerFailureRetries += 1
        guard listenerFailureRetries <= Self.maxListenerFailureRetries else {
            // Retry budget exhausted. Try fallback port one more time (handles
            // the case where user-configured port or retry-loop scenarios
            // didn't match the fast-path above).
            if onDefault, !fallbackAttempted,
               let alt = await registry.findAvailablePort(excluding: failedBindPorts), alt != userExplicitPort {
                fallbackAttempted = true
                sessionOverridePort = alt
                listenerFailureRetries = 0
                squatterCleanupAttempted = false
                DaemonLogger.shared.info("Port \(userExplicitPort) stuck after retries — falling back to \(alt)")
                Task { @MainActor [weak self] in self?.start() }
                return
            }

            let stuckPort = probePort
            let reason: String
            if fallbackAttempted || !onDefault {
                reason = "Port \(stuckPort) is held by another process. " +
                    "Close any stale `agentdeck daemon` CLI processes (try " +
                    "`sudo lsof -nP -iTCP:\(stuckPort)` in Terminal), or " +
                    "change the daemon port in Settings."
            } else {
                reason = "All ports in range are busy. Close other agentdeck " +
                    "instances or change the port in Settings."
            }
            errorMessage = "Daemon failed to bind: \(error.localizedDescription)"
            bindFailureReason = reason
            blockingProcesses = PortDiagnostics.collectBlockers(port: stuckPort)
            DaemonLogger.shared.error("\(errorMessage!) — \(reason)")
            listenerFailureRetries = 0
            squatterCleanupAttempted = false
            // Don't leave a stale daemon.json pointing at a port we never actually owned.
            registry.removeDaemonInfo()
            return
        }

        // Exponential backoff: 1s, 2s, 4s — lets kernel release stale TCP sockets
        let backoffSec = UInt64(1 << (listenerFailureRetries - 1))
        DaemonLogger.shared.info("Retrying daemon start in \(backoffSec)s (attempt \(listenerFailureRetries)/\(Self.maxListenerFailureRetries))")
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(backoffSec))
            self?.start()
        }
    }

    private func startHealthMonitor() {
        healthMonitorTask?.cancel()
        healthMonitorTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await self.checkDaemonHealth()
            }
        }
    }

    private func checkDaemonHealth() async {
        let currentPort = Int(port)
        guard currentPort > 0 else { return }

        let registry = SessionRegistry.shared

        if isUsingExternalDaemon {
            let health = await registry.probeDaemonHealth(port: currentPort)
            let daemonAlive = (health?["mode"] as? String) == "daemon"
            if daemonAlive {
                externalFailureCount = 0
                return
            }

            externalFailureCount += 1
            guard externalFailureCount >= 2, !isStarting else { return }
            DaemonLogger.shared.error("External daemon on port \(currentPort) disappeared — promoting this app to own the daemon")
            server = nil
            isRunning = false
            isUsingExternalDaemon = false
            port = 0
            readyUrl = nil
            errorMessage = nil
            externalFailureCount = 0
            start()
            return
        }

        // In-process daemon: trust in-memory state. Self-HTTP probing created a
        // restart loop when URLSession got bogged down by dead sibling relays or
        // slow Pixoo pushes — a transient 2-second self-probe timeout was killing
        // a perfectly healthy server. If we hold a live `server` reference and
        // `isRunning`, the listener is up; no probe is needed for liveness.
        guard isRunning, server != nil else { return }
        localFailureCount = 0

        // Still probe once for D200H helper auto-promotion, but never let a probe
        // failure trigger a restart — promotion is best-effort.
        if !d200hHelperPromotionAttempted, !isStarting,
           AppPreferences.shared.autoUseBundledD200HHelper {
            if let health = await registry.probeDaemonHealth(port: currentPort),
               preferencesSuggestBundledD200HHelperPromotion(from: health) {
                let reason = d200hHelperPromotionReason(from: health)
                d200hHelperPromotionAttempted = true
                DaemonLogger.shared.info("Promoting D200H to bundled helper: \(reason)")
                errorMessage = reason
                await startBundledD200HHelper()
            }
        }
    }

    private func preferencesSuggestBundledD200HHelperPromotion(from health: [String: Any]?) -> Bool {
        guard AppPreferences.shared.autoUseBundledD200HHelper else { return false }
        guard let modules = health?["modules"] as? [String: Any],
              let d200h = modules["d200h"] as? [String: Any] else { return false }
        guard (d200h["connected"] as? Bool) != true else { return false }

        let sandboxEnabled = d200h["sandboxEnabled"] as? Bool ?? false
        let usbEntitlementPresent = d200h["usbEntitlementPresent"] as? Bool ?? true
        let lastOpenError = d200h["lastOpenError"] as? Int32 ?? 0
        let managerOpened = d200h["managerOpened"] as? Bool ?? false

        return (sandboxEnabled && !usbEntitlementPresent) ||
            (managerOpened && lastOpenError == kIOReturnNotPermitted)
    }

    private func d200hHelperPromotionReason(from health: [String: Any]?) -> String {
        guard let modules = health?["modules"] as? [String: Any],
              let d200h = modules["d200h"] as? [String: Any] else {
            return "D200H helper promotion requested."
        }

        let sandboxEnabled = d200h["sandboxEnabled"] as? Bool ?? false
        let usbEntitlementPresent = d200h["usbEntitlementPresent"] as? Bool ?? true
        let lastOpenError = d200h["lastOpenError"] as? Int32 ?? 0

        if sandboxEnabled && !usbEntitlementPresent {
            return "Swift daemon build lacks usable D200H USB entitlement. AgentDeck will switch D200H to the bundled helper."
        }
        if lastOpenError == kIOReturnNotPermitted {
            return "Swift daemon was denied D200H HID access (kIOReturnNotPermitted). AgentDeck will switch D200H to the bundled helper."
        }
        return "Swift daemon cannot open D200H HID. AgentDeck will switch D200H to the bundled helper."
    }

    // MARK: - Signal Handling

    private func setupSignalHandler() {
        // Ignore default SIGTERM/SIGINT behavior so DispatchSource handles them
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)

        let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSource.setEventHandler { [weak self] in
            Self.handleTerminationSignal(name: "SIGTERM", service: self)
        }
        termSource.resume()
        self.signalSource = termSource

        let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        intSource.setEventHandler { [weak self] in
            Self.handleTerminationSignal(name: "SIGINT", service: self)
        }
        intSource.resume()
        self.sigintSource = intSource
    }

    private static func handleTerminationSignal(name: String, service: DaemonService?) {
        DaemonLogger.shared.info("\(name) received — initiating clean shutdown")
        // Remove daemon.json immediately so next launch isn't blocked by stale guard
        let home = FileManager.default.homeDirectoryForCurrentUser
        let daemonFile = home.appendingPathComponent(".agentdeck/daemon.json")
        try? FileManager.default.removeItem(at: daemonFile)
        let crashLog = home.appendingPathComponent(".agentdeck/daemon-crash.log")
        let entry = "[\(ISO8601DateFormatter().string(from: Date()))] \(name) — clean shutdown initiated\n"
        if let data = entry.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: crashLog.path) {
                if let handle = try? FileHandle(forWritingTo: crashLog) {
                    handle.seekToEndOfFile()
                    handle.write(data)
                    handle.closeFile()
                }
            } else {
                try? data.write(to: crashLog)
            }
        }
        // Bounded shutdown: exit after 5s even if cleanup hangs
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
            NSLog("[AgentDeck] Signal shutdown timeout — forcing exit")
            Darwin.exit(0)
        }
        Task { @MainActor in
            await service?.stop()
            Darwin.exit(0)
        }
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
