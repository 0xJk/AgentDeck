#if os(macOS)
// DaemonServer.swift — Main daemon orchestrator
// Ported from bridge/src/daemon-server.ts — FULL wiring of all modules

import Foundation
import IOKit
import IOKit.ps
import Network

private let kIOMessageSystemHasPoweredOn: UInt32 = 0xe0000300

@MainActor
final class DaemonServer {
    let port: UInt16
    let sessionId = UUID().uuidString
    private let wsServer = WebSocketServer()
    private let httpServer = HTTPServer()
    private let stateMachine = StateMachine()
    private let registry = SessionRegistry.shared
    private let auth = AuthManager.shared

    // Modules
    private let moduleManager = ModuleManager()
    private let displayMonitor = DisplayMonitor()
    private let gatewayProbe = GatewayProbe()
    private let voiceAssistant = DaemonVoiceAssistant()
    private let timelineRelay: TimelineRelay
    private let focusRelay: SessionFocusRelay
    private let timelineStore = DaemonTimelineStore()
    private let logStream = BridgeLogStream()
    private let usageAPI = UsageAPIClient.shared
    private var serialModule: SerialModule?
    private var pixooModule: PixooModule?
    private var adbModule: AdbModule?
    private var d200hModule: D200hHidModule?

    // APME
    private var apmeStore: ApmeStore?
    private var apmeCollector: ApmeCollector?
    private var apmeRunner: ApmeRunner?
    private var apmeEvalTimerTask: Task<Void, Never>?

    // Gateway
    private var gatewayAdapter: OpenClawAdapter?
    private var gatewayConnecting = false
    private var cachedGatewayHasError = false
    private var cachedGatewayConnected = false
    private var cachedGatewayAuthStatus: String = "gateway_not_found"
    private var cachedGatewayAuthRequestId: String?
    private var cachedGatewayAuthMessage: String?

    // State caches
    private var cachedSessions: [DaemonSessionEntry] = []
    private var cachedModelCatalog: [[String: Any]] = []
    private var cachedOllamaStatus: [String: Any]?
    private var cachedMlxModels: [String] = []
    private var preferredMlxModelsEndpoint: String?

    // Backoff state for local LLM discovery. Probe functions read/update these;
    // the polling task reads `nextInterval` on every iteration so the sleep
    // stretches exponentially while the service is absent (e.g. right after a
    // PC restart before `ollama serve` / mlx is up). See plan
    // unified-dreaming-gray.md + memory/bug_local_llm_probe_no_backoff.md.
    private var ollamaFailureCount: Int = 0
    private var ollamaNextInterval: TimeInterval = 5
    private var mlxFailureCount: Int = 0
    private var mlxNextInterval: TimeInterval = 5
    private static let probeBaseInterval: TimeInterval = 5
    private static let probeMaxInterval: TimeInterval = 300
    private static let probeStaleThreshold = 3
    private var cachedDisplayOn = true
    private var cachedGatewayAvailable = false
    private var cachedPairingUrl: String?
    private var lastStateEvent: [String: Any]?
    private var cachedApiUsage: ApiUsageData?
    private var lastApiFetchTime: Date = .distantPast
    private static let usageStaleTTL: TimeInterval = 600  // 10 minutes
    private var apiUsageStale = false
    /// True when cachedApiUsage was synced from relay's already-adjusted values
    private var apiUsagePreAdjusted = false
    private var oauthConnected = false

    // Voice TTS flow: track previous state for PROCESSING→IDLE detection
    private var previousDaemonState: AgentState?

    // Voice assistant state cache for piggybacking on state_update
    private var cachedVoiceAssistantState: String = "disabled"
    private var cachedVoiceAssistantText: String?
    private var cachedVoiceAssistantResponseText: String?

    // Network monitoring
    private var networkMonitor: NWPathMonitor?
    private var lastKnownIP: String?
    private var networkDebounceTask: Task<Void, Never>?

    // Polling tasks
    private var sessionPollTask: Task<Void, Never>?
    private var usagePollTask: Task<Void, Never>?
    private var ollamaPollTask: Task<Void, Never>?
    private var mlxPollTask: Task<Void, Never>?
    private var gatewayPollTask: Task<Void, Never>?
    private var gatewayHealthTask: Task<Void, Never>?
    private var usageTickTask: Task<Void, Never>?
    private var initialUsageTask: Task<Void, Never>?
    private var antigravityPollTask: Task<Void, Never>?

    // Antigravity cache
    private var cachedAntigravityStatus: AntigravityStatus?

    // MARK: - Init

    init(port: Int?, debug: Bool) async throws {
        self.timelineRelay = TimelineRelay(selfPort: port ?? SessionRegistry.defaultPort)
        self.focusRelay = SessionFocusRelay()

        let requestedPort = port ?? SessionRegistry.defaultPort
        var resolvedPort = UInt16(requestedPort)

        // Singleton guard — only when using default port
        if port == nil {
            if let existing = registry.readDaemonInfo() {
                if let health = await registry.probeDaemonHealth(port: existing.port),
                   health["mode"] as? String == "daemon" {
                    DaemonLogger.shared.info("Daemon already running on port \(existing.port) (PID \(existing.pid))")
                    throw DaemonError.alreadyRunning(port: existing.port)
                }
                if !(await registry.isPortBindable(existing.port)) {
                    DaemonLogger.shared.info("Daemon registry exists on port \(existing.port) but health probe is not ready yet; treating as startup race")
                    throw DaemonError.alreadyRunning(port: existing.port)
                }
                DaemonLogger.shared.debug("Daemon", "Stale daemon.json found for PID \(existing.pid) on port \(existing.port); removing")
                registry.removeDaemonInfo()
            }
            if let existing = registry.findExistingDaemon() {
                if let health = await registry.probeDaemonHealth(port: existing.port),
                   health["mode"] as? String == "daemon" {
                    DaemonLogger.shared.info("Daemon already running on port \(existing.port)")
                    throw DaemonError.alreadyRunning(port: existing.port)
                }
                if !(await registry.isPortBindable(existing.port)) {
                    DaemonLogger.shared.info("Daemon session entry exists on port \(existing.port) but health probe is not ready yet; treating as startup race")
                    throw DaemonError.alreadyRunning(port: existing.port)
                }
                DaemonLogger.shared.debug("Daemon", "Stale daemon session entry found for \(existing.id) on port \(existing.port); deregistering")
                registry.deregister(existing.id)
            }
            if let health = await registry.probeDaemonHealth(port: requestedPort) {
                if health["mode"] as? String == "daemon" {
                    throw DaemonError.alreadyRunning(port: requestedPort)
                }
                if let alt = await registry.findAvailablePort() {
                    resolvedPort = UInt16(alt)
                } else {
                    throw DaemonError.noPortAvailable
                }
            } else if !(await registry.isPortBindable(requestedPort)) {
                // No health response + port not bindable → likely TIME_WAIT from dead process.
                // Retry several times before falling back to a different port.
                DaemonLogger.shared.info("Port \(requestedPort) not bindable, no health response — waiting for TIME_WAIT clearance")
                var reclaimed = false
                for attempt in 1...3 {
                    try? await Task.sleep(for: .seconds(5))
                    if await registry.isPortBindable(requestedPort) {
                        DaemonLogger.shared.info("Port \(requestedPort) reclaimed after \(attempt * 5)s")
                        reclaimed = true
                        break
                    }
                    // Check if a real daemon appeared while we waited
                    if let health = await registry.probeDaemonHealth(port: requestedPort),
                       health["mode"] as? String == "daemon" {
                        throw DaemonError.alreadyRunning(port: requestedPort)
                    }
                }
                if !reclaimed {
                    // Port still stuck after 15s — use fallback port
                    if let alt = await registry.findAvailablePort() {
                        DaemonLogger.shared.info("Port \(requestedPort) still blocked after 15s, using fallback port \(alt)")
                        resolvedPort = UInt16(alt)
                    } else {
                        throw DaemonError.noPortAvailable
                    }
                }
            }
        }

        self.port = resolvedPort
        self.cachedPairingUrl = auth.getWsUrl(port: Int(resolvedPort))
    }

    // MARK: - Start (non-blocking)

    /// Register a handler for fatal listener failures (e.g. EADDRINUSE after bind).
    /// Should be called before `startServices()`.
    func setListenerFailedHandler(_ handler: @escaping @Sendable (Error) -> Void) async {
        await wsServer.setListenerFailedHandler(handler)
    }

    func startServices() async throws {
        // 0. Initialize APME store + collector + runner
        let store = ApmeStore()
        if store.open() {
            apmeStore = store
            let collector = ApmeCollector(store: store)
            apmeCollector = collector
            // Runner wraps the judge pipeline. In Phase 1 the only backend
            // is Apple Foundation Models (on-device, zero-config). If it's
            // unavailable (Intel Mac, Apple Intelligence off), turn_judge
            // evals silently skip — collector still records everything.
            let runner = ApmeRunner(store: store)
            apmeRunner = runner
            collector.runner = runner

            // Register the eval-result broadcaster. Mirrors the TS daemon's
            // `apme.runner.onResult` handler in bridge/src/daemon-server.ts
            // (lines 902-974). Persists turn-level outcome/composite, emits
            // apmeEval WS events, and appends ★ eval_result timeline entries.
            Task {
                await runner.onResult { [weak self] result in
                    guard let self else { return }
                    Task { @MainActor in
                        self.handleApmeResult(result)
                    }
                }
            }

            let fmReady = ApmeJudgeFoundationModels.isAvailable
            DaemonLogger.shared.info("APME enabled — data will be logged to \(store.dbPath); judge=\(fmReady ? "foundationModels ready" : ApmeJudgeFoundationModels.unavailableReason)")
        }

        // 1. Setup HTTP routes + Bonjour, then start unified server
        await setupHTTPRoutes()
        await wsServer.setHTTPHandler(httpServer)

        // Bonjour mDNS advertisement on the same listener
        let txtRecord = NWTXTRecord([
            "project": "daemon",
            "agent": "daemon",
            "port": "\(port)",
            "ip": AuthManager.getLanIP() ?? "127.0.0.1",
            "token": auth.token,
            "v": "3",
        ])
        await wsServer.setBonjourService(NWListener.Service(
            name: "daemon-\(port)",
            type: "_agentdeck._tcp",
            txtRecord: txtRecord
        ))

        // Await listener `.ready` — throws on bind failure (EADDRINUSE etc).
        // Registry writes must NOT happen before this succeeds.
        try await wsServer.start(port: port)

        // 2. Register session (only after listener is actually bound)
        let entry = DaemonSessionEntry(
            id: sessionId, port: Int(port),
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            projectName: "daemon", agentType: "daemon",
            startedAt: ISO8601DateFormatter().string(from: Date())
        )
        registry.register(entry)
        registry.writeDaemonInfo(DaemonInfo(
            port: Int(port),
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            startedAt: ISO8601DateFormatter().string(from: Date()),
            httpPort: nil
        ))

        // 3. Setup WS handlers
        await setupWSHandlers()

        // 4. Wire state machine
        stateMachine.onStateChanged = { [weak self] oldState, newState in
            self?.handleStateChanged()
        }

        // 5. Start timeline store
        await timelineStore.start()

        // 6. Start display monitor
        await displayMonitor.start()
        await displayMonitor.setOnStateChanged { [weak self] displayOn in
            Task { @MainActor in
                guard let self else { return }
                self.cachedDisplayOn = displayOn
                self.broadcastRaw(["type": "display_state", "displayOn": displayOn] as [String: Any])
                if displayOn {
                    DaemonLogger.shared.info("Display wake — recovering modules and state")
                    _ = self.registry.listActive()
                    self.broadcastSessionsList()
                    Task { await self.moduleManager.wakeAll() }
                    self.broadcastStateUpdate()
                }
            }
        }

        // 7. Start device modules
        DaemonLogger.shared.info("startServices: step7 startDeviceModules begin")
        await startDeviceModules()
        DaemonLogger.shared.info("startServices: step7 startDeviceModules done")

        // 8. Start timeline relay (subscribes to sibling WS)
        await timelineRelay.setEventHandler { [weak self] event in
            let box = SendableDict(event)
            Task { @MainActor in
                self?.handleRelayedEvent(box.value)
            }
        }
        await timelineRelay.start()
        DaemonLogger.shared.info("startServices: step8 timelineRelay done")

        // 8b. Set up focus relay event callback — merge daemon metadata before broadcasting
        await focusRelay.setBroadcast { [weak self] (box: SendableDict) in
            Task { @MainActor in
                guard let self else { return }
                var event = box.value
                if (event["type"] as? String) == "state_update" {
                    // Preserve daemon-level metadata that session bridges don't have
                    if event["modelCatalog"] == nil, !self.cachedModelCatalog.isEmpty {
                        event["modelCatalog"] = self.cachedModelCatalog
                    }
                    event["gatewayAvailable"] = self.cachedGatewayAvailable
                    event["gatewayConnected"] = self.cachedGatewayConnected
                    event["gatewayAuthStatus"] = self.cachedGatewayAuthStatus
                    if let requestId = self.cachedGatewayAuthRequestId { event["gatewayAuthRequestId"] = requestId }
                    if let message = self.cachedGatewayAuthMessage { event["gatewayAuthMessage"] = message }
                    if event["ollamaStatus"] == nil, let cached = self.cachedOllamaStatus {
                        event["ollamaStatus"] = cached
                    }
                    // Inject focused session's ID so clients can dedup the promoted
                    // session from the siblings list (prevents duplicate creatures).
                    let focusedId = await self.focusRelay.focusedSessionId
                    if let fid = focusedId { event["sessionId"] = fid }

                    // Always override mlxModels with daemon's filtered cache — sibling bridges may
                    // run older/unfiltered code that leaks nanoLLaVA into the list, causing flicker.
                    if !self.cachedMlxModels.isEmpty {
                        event["mlxModels"] = self.cachedMlxModels
                    } else {
                        event.removeValue(forKey: "mlxModels")
                    }
                }
                self.broadcastRaw(event)
            }
        }

        // 8c. Sync daemon usage cache when relay receives usage_update (prevents oscillation)
        await focusRelay.setOnUsageRelayed { [weak self] (box: SendableDict) in
            Task { @MainActor in
                guard let self else { return }
                let usage = box.value
                // Sync rate-limit values (already adjusted by bridge's adjustUsagePercent)
                if self.cachedApiUsage != nil {
                    if let fh = usage["fiveHourPercent"] as? Double {
                        self.cachedApiUsage?.fiveHourPercent = fh
                    }
                    if let sd = usage["sevenDayPercent"] as? Double {
                        self.cachedApiUsage?.sevenDayPercent = sd
                    }
                    self.cachedApiUsage?.fiveHourResetsAt = usage["fiveHourResetsAt"] as? String
                    self.cachedApiUsage?.sevenDayResetsAt = usage["sevenDayResetsAt"] as? String
                    self.apiUsagePreAdjusted = true
                }
            }
        }

        DaemonLogger.shared.info("startServices: step8c focusRelay done")

        // 9. Start polling
        startAllPolling()
        DaemonLogger.shared.info("startServices: step9 startAllPolling done")

        // 10. Initial delayed usage fetch
        initialUsageTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            await self?.fetchUsageRelayed()
        }

        DaemonLogger.shared.info("startServices: step10 initialUsageTask scheduled")

        // 11. Claude Code hooks — HookInstaller now requires explicit user
        // consent (App Store guideline 2.5.2). This call is a no-op unless
        // the user opted in via Settings → "Enable Claude Code Hooks…".
        HookInstaller.installIfNeeded()
        if AppPreferences.shared.hookInstallConsent != .accepted {
            DaemonLogger.shared.info("startServices: step11 HookInstaller skipped (no consent)")
        } else {
            DaemonLogger.shared.info("startServices: step11 HookInstaller done")
        }

        // 12. Voice assistant
        voiceAssistant.sendPrompt = { [weak self] text in
            guard let self else { return }
            // Route to gateway or session bridge
            if let gw = self.gatewayAdapter {
                Task { await gw.sendRPC(method: "chat.send", params: ["message": text]) }
                _ = self.stateMachine.transition(trigger: "user_prompt_submit", source: .hook)
                self.broadcastStateUpdate()
            } else {
                self.forwardCommandToSession(AgentCommand.sendPrompt(text: text).dictionary)
            }
        }
        voiceAssistant.onStateChanged = { [weak self] state, text, responseText in
            guard let self else { return }
            // Cache voice state for piggybacking on state_update
            self.cachedVoiceAssistantState = state.rawValue
            self.cachedVoiceAssistantText = text
            self.cachedVoiceAssistantResponseText = responseText
            self.broadcastRaw([
                "type": "voice_assistant_state",
                "state": state.rawValue,
                "deviceId": "mac-builtin",
                "text": text as Any,
                "responseText": responseText as Any,
            ])
            // Also trigger state_update so all clients get voice state
            self.broadcastStateUpdate()
        }
        voiceAssistant.onWakeWordDetected = { [weak self] deviceId, timestamp in
            self?.broadcastRaw([
                "type": "wake_word_detected",
                "deviceId": deviceId,
                "timestamp": timestamp,
            ])
        }
        _ = voiceAssistant.start()
        DaemonLogger.shared.info("startServices: step12 voiceAssistant done")

        // 13. System sleep/wake handling — immediate cleanup on wake
        // Use Darwin notification (IOKit power assertion) — works without AppKit
        let wakePort = IONotificationPortCreate(kIOMainPortDefault)
        if let wakePort {
            IONotificationPortSetDispatchQueue(wakePort, DispatchQueue.main)
            var notifier: io_object_t = 0
            let rootDomain = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
            IOServiceAddInterestNotification(wakePort, rootDomain, kIOGeneralInterest, { (refcon, _, messageType, _) in
                guard messageType == UInt32(kIOMessageSystemHasPoweredOn) else { return }
                guard let refcon else { return }
                let server = Unmanaged<DaemonServer>.fromOpaque(refcon).takeUnretainedValue()
                DaemonLogger.shared.info("System wake — recovering sessions and devices")
                // Force prune dead sessions (bridges killed during sleep)
                _ = server.registry.listActive()
                // Trigger immediate session list refresh for clients
                server.broadcastSessionsList()
                // Re-sync timeline relay (drops dead subscriptions)
                Task { await server.timelineRelay.sync() }
                // Re-advertise Bonjour (mDNSResponder may have stale state)
                Task { await server.wsServer.republishBonjour() }
                // Wake all device modules (D200H re-scan, ESP32 reconnect, Pixoo re-sync)
                Task { await server.moduleManager.wakeAll() }
                // Broadcast full state so reconnected devices get fresh data
                Task { @MainActor in server.broadcastStateUpdate() }
                // Refresh usage after network stabilizes (clears stale "!" indicator)
                Task {
                    try? await Task.sleep(for: .seconds(4))
                    await server.fetchUsageRelayed()
                    await MainActor.run { server.broadcastUsage() }
                }
            }, Unmanaged.passUnretained(self).toOpaque(), &notifier)
        }

        // 14. Network change detection — WiFi/VPN/IP changes trigger Bonjour re-publish + module recovery
        lastKnownIP = AuthManager.getLanIP()
        let monitor = NWPathMonitor()
        self.networkMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.networkDebounceTask?.cancel()
                self.networkDebounceTask = Task {
                    try? await Task.sleep(for: .seconds(2))  // 2s debounce
                    guard !Task.isCancelled else { return }

                    if path.status == .satisfied {
                        let newIP = AuthManager.getLanIP()
                        let ipChanged = newIP != self.lastKnownIP
                        if ipChanged {
                            DaemonLogger.shared.info("Network changed — IP: \(self.lastKnownIP ?? "none") → \(newIP ?? "none")")
                            self.lastKnownIP = newIP
                            // Full wake: re-advertise Bonjour, reconnect modules, re-sync timelines
                            await self.wsServer.republishBonjour()
                            await self.moduleManager.wakeAll()
                            await self.timelineRelay.sync()
                            self.broadcastStateUpdate()
                        } else {
                            // IP unchanged — likely WiFi flicker during display sleep or
                            // transient route change. Skip module churn; just refresh timeline
                            // relay (lightweight, drops dead sibling subscriptions).
                            DaemonLogger.shared.debug("Network", "Path update (IP unchanged, skipping wake)")
                            await self.timelineRelay.sync()
                        }
                    } else {
                        DaemonLogger.shared.info("Network unsatisfied — waiting for recovery")
                    }
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "dev.agentdeck.networkmonitor"))

        DaemonLogger.shared.info("Daemon running on port \(port) — all modules wired")
    }

    // MARK: - Device Modules

    private func startDeviceModules() async {
        let portInt = Int(port)

        // mDNS: Bonjour is attached to unified WebSocketServer listener — no separate module needed

        // ADB (reverse tunnel only — D200H uses HID now)
        let adb = AdbModule(daemonPort: portInt)
        adb.commandHandler = { [weak self] cmd in
            Task { @MainActor in self?.handleCommand(cmd) }
        }
        self.adbModule = adb
        moduleManager.register(adb)

        // D200H Deck Dock (HID protocol — IOKit)
        let d200h = D200hHidModule()
        d200h.commandHandler = { [weak self] cmd in
            Task { @MainActor in self?.handleCommand(cmd) }
        }
        self.d200hModule = d200h
        moduleManager.register(d200h)

        // Serial (ESP32)
        let serial = SerialModule()
        self.serialModule = serial
        moduleManager.register(serial)

        // ESP32 state providers — initial state on connect + heartbeat
        // nonisolated(unsafe) storage in ESP32Serial allows direct setting from @MainActor context
        serial.serial.setStateProviderFn { [weak self] in self?.lastStateEvent }
        serial.serial.setUsageProviderFn { [weak self] in self?.buildUsageEvent() }
        serial.serial.setInitialStateProviderFn { [weak self] in
            guard let self else { return [] }
            var events: [[String: Any]] = []
            if let state = self.lastStateEvent { events.append(state) }
            if let usage = self.buildUsageEvent() { events.append(usage) }
            events.append(["type": "display_state", "displayOn": self.cachedDisplayOn])
            return events
        }

        // Wire external client count (ESP32 serial connections count as clients for polling guards)
        await wsServer.setExternalClientCountProvider { await serial.serial.connectionCount }

        // Pixoo
        let pixoo = PixooModule()
        self.pixooModule = pixoo
        moduleManager.register(pixoo)

        // Start all
        await moduleManager.startAll()
        DaemonLogger.shared.info("startDeviceModules: moduleManager.startAll done")

        // Seed initial state so serial heartbeat has data from the start
        // (without this, lastStateEvent is nil until first WS client or hook event)
        let gwAlive = cachedGatewayConnected
        lastStateEvent = buildFullStateEvent(agentType: gwAlive ? "openclaw" : "daemon")
        DaemonLogger.shared.info("startDeviceModules: seed state done")

        // Wire serial broadcast hook
        let serialRef = serial
        let pixooRef = pixoo
        let d200hRef = d200h
        await wsServer.onBroadcast { [weak self] data in
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            
            // Mirror creature agent state in local state machine for metadata persistence
            if let type = json["type"] as? String, type == "state_update" {
                let jsonBox = SendableDict(json)
                Task { @MainActor in
                    guard let self else { return }
                    let json = jsonBox.value
                    if let model = json["model"] as? String ?? json["modelName"] as? String {
                        self.stateMachine.modelName = model
                    }
                    if let project = json["projectName"] as? String {
                        self.stateMachine.projectName = project
                    }
                    if let effort = json["effortLevel"] as? String {
                        self.stateMachine.effortLevel = effort
                    }
                }
            }

            adb.handleBroadcast(json)
            serialRef.wireBroadcast(json)
            pixooRef.handleEvent(json)
            d200hRef.handleBroadcast(json)
        }
        DaemonLogger.shared.info("startDeviceModules: wsServer.onBroadcast done")

        // Wire ESP32 WiFi auto-provisioning
        if let wifiConfig = WifiConfigManager.load(), wifiConfig.autoProvision {
            let lanIp = AuthManager.getLanIP() ?? "127.0.0.1"
            let provisionMsg = SendableDict([
                "type": "wifi_provision",
                "ssid": wifiConfig.ssid,
                "password": wifiConfig.password,
                "bridgeIp": lanIp,
                "bridgePort": Int(port),
                "authToken": auth.token,
            ])
            await serial.serial.setOnMessage { [weak self] portPath, msg in
                guard let self else { return }
                if let type = msg["type"] as? String {
                    if type == "device_info", msg["wifiConnected"] as? Bool != true {
                        Task { _ = await self.serialModule?.serial.sendWifiProvisionToAll(provisionMsg.value) }
                        DaemonLogger.shared.info("WiFi provision sent to ESP32 on \(portPath)")
                    }
                }
            }
        }
    }

    // MARK: - HTTP Routes

    private func setupHTTPRoutes() async {
        let daemonPort = self.port

        await httpServer.get("/health") { [weak self] _ in
            let health = await self?.buildModuleHealth().value ?? ["state": "disconnected"]
            let state = health["state"] as? String ?? "disconnected"
            return .json([
                "status": "ok", "mode": "daemon", "port": daemonPort,
                "pid": ProcessInfo.processInfo.processIdentifier,
                "uptime": ProcessInfo.processInfo.systemUptime,
                "state": state,
                "pairingToken": AuthManager.shared.token,
                "modules": health["modules"] as Any,
            ] as [String: Any])
        }

        await httpServer.get("/status") { [weak self] _ in
            let sessions = SessionRegistry.shared.listActive()
            let list = sessions.map { ["id": $0.id, "port": $0.port, "projectName": $0.projectName, "agentType": $0.agentType as Any] as [String: Any] }
            let health = await self?.buildModuleHealth().value ?? [:]
            return .json(["sessions": list, "daemon": ["port": daemonPort], "modules": health["modules"] as Any] as [String: Any])
        }

        await httpServer.get("/usage") { [weak self] _ in
            let usage = await self?.buildUsageEndpointPayload().value
            return .json([
                "status": "ok",
                "usage": usage?["usage"] as Any,
                "fetchedAt": usage?["fetchedAt"] as? Int ?? 0,
            ] as [String: Any])
        }

        await httpServer.get("/devices") { [weak self] _ in
            let devices = await self?.buildDevicesPayload().value ?? ["devices": []]
            return .json(devices)
        }

        await httpServer.post("/d200h/refresh") { [weak self] _ in
            let payload = await self?.forceD200hRefreshPayload().value
                ?? ["status": "error", "error": "daemon unavailable"]
            return .json(payload)
        }

        await httpServer.get("/diag") { [weak self] request in
            let tail = Int(request.queryParams["tail"] ?? "") ?? 200
            let diag = await self?.buildDiagPayload(tail: max(1, min(tail, 1000))).value ?? ["error": "daemon unavailable"]
            return .json(diag)
        }

        await httpServer.post("/shutdown") { [weak self] _ in
            Task { @MainActor in await self?.shutdown() }
            return .json(["status": "shutting_down"])
        }

        await httpServer.post("/hook") { [weak self] request in
            guard let body = request.body,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
                return .json(["status": "error"], status: 400)
            }
            Task { @MainActor in await self?.handleHookEvent(json) }
            return .json(["status": "ok"])
        }

        // Claude Code hooks POST to /hooks/:eventName (event name in URL path).
        // Prefix match: /hooks/* captures all hook events.
        await httpServer.post("/hooks/*") { [weak self] request in
            guard let body = request.body else {
                return .json(["received": true])
            }
            // Extract event name from URL path: "/hooks/PreToolUse" → "PreToolUse"
            // Convert to snake_case to match handleHookEvent expectations:
            // SessionStart → session_start, PreToolUse → tool_start, etc.
            let rawName = String(request.path.dropFirst("/hooks/".count))
            let eventName: String
            switch rawName {
            case "SessionStart": eventName = "session_start"
            case "SessionEnd":   eventName = "session_end"
            case "PreToolUse":   eventName = "tool_start"
            case "PostToolUse":  eventName = "tool_end"
            case "Stop":         eventName = "stop"
            case "UserPromptSubmit": eventName = "user_prompt_submit"
            case "Notification": eventName = "notification"
            default: eventName = rawName.lowercased()
            }
            var json = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            json["event"] = eventName
            Task { @MainActor in await self?.handleHookEvent(json) }
            return .json(["received": true])
        }

        await httpServer.get("/sse") { _ in
            .text("event: connected\ndata: {}\n\n")
        }

        // Pixoo endpoints
        await httpServer.get("/pixoo/preview") { [weak self] _ in
            guard let self else { return .text("No frame available", status: 204) }
            return await self.pixooPngResponse()
        }

        await httpServer.get("/pixoo/frame") { [weak self] _ in
            guard let self else { return .text("No frame available", status: 204) }
            return await self.pixooFrameResponse()
        }

        await httpServer.stream("/pixoo/stream") { [weak self] _, conn in
            guard let self else {
                let raw = Data((HTTPServer.formatHTTPHeaders(status: 503, headers: ["Content-Type": "text/plain"]) + "Connection: close\r\n\r\nPreview unavailable").utf8)
                conn.send(raw) { _ in conn.cancel() }
                return
            }
            await self.streamPixooFrames(on: conn)
        }

        await httpServer.get("/pixoo") { [weak self] _ in
            guard let self else { return .text("Preview unavailable", status: 503) }
            return await self.pixooPreviewResponse()
        }

        // APME routes
        if let store = apmeStore {
            await ApmeHttpRoutes.register(on: httpServer, store: store)
        }
    }

    private func pixooFrameResponse() -> HTTPServer.HTTPResponse {
        guard let rgb = pixooModule?.currentFrame(),
              let bmp = Self.rgbToBmp(rgb, width: 64, height: 64) else {
            return .text("No frame available", status: 204)
        }
        return HTTPServer.HTTPResponse(
            status: 200,
            headers: [
                "Content-Type": "image/bmp",
                "Cache-Control": "no-store",
            ],
            body: bmp
        )
    }

    private func pixooPngResponse() -> HTTPServer.HTTPResponse {
        guard let rgb = pixooModule?.currentFrame(),
              let png = Self.rgbToPng(rgb, width: 64, height: 64) else {
            return .text("No frame available", status: 204)
        }
        return HTTPServer.HTTPResponse(
            status: 200,
            headers: [
                "Content-Type": "image/png",
                "Cache-Control": "no-store",
            ],
            body: png
        )
    }

    private func pixooPreviewResponse() -> HTTPServer.HTTPResponse {
        let html = Self.pixooPreviewHtml()
        return HTTPServer.HTTPResponse(
            status: 200,
            headers: ["Content-Type": "text/html; charset=utf-8"],
            body: Data(html.utf8)
        )
    }

    private func streamPixooFrames(on conn: HTTPServer.StreamConnection) async {
        let header = HTTPServer.formatHTTPHeaders(status: 200, headers: [
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        ]) + "\r\n"

        let sentHeader = await Self.send(conn, data: Data(header.utf8))
        guard sentHeader else {
            conn.cancel()
            return
        }

        var lastFrameHash: Int?
        while true {
            let frame = await MainActor.run { pixooModule?.currentFrame() }
            if let frame, let bmp = Self.rgbToBmp(frame, width: 64, height: 64) {
                let frameHash = bmp.hashValue
                if frameHash != lastFrameHash {
                    lastFrameHash = frameHash
                    let payload = "event: frame\ndata: \(bmp.base64EncodedString())\n\n"
                    let ok = await Self.send(conn, data: Data(payload.utf8))
                    if !ok { break }
                }
            } else {
                let ok = await Self.send(conn, data: Data(":heartbeat\n\n".utf8))
                if !ok { break }
            }

            try? await Task.sleep(for: .milliseconds(250))
        }

        conn.cancel()
    }

    nonisolated private static func send(_ conn: HTTPServer.StreamConnection, data: Data) async -> Bool {
        await withCheckedContinuation { continuation in
            conn.send(data) { ok in continuation.resume(returning: ok) }
        }
    }

    nonisolated private static func rgbToBmp(_ rgb: Data, width: Int, height: Int) -> Data? {
        let expectedLength = width * height * 3
        guard rgb.count == expectedLength else { return nil }

        let rowBytes = width * 3
        let rowPadding = (4 - (rowBytes % 4)) % 4
        let paddedRowBytes = rowBytes + rowPadding
        let imageSize = paddedRowBytes * height
        let fileSize = 54 + imageSize

        var buffer = Data(count: fileSize)

        buffer.withUnsafeMutableBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }

            base[0] = 0x42
            base[1] = 0x4D
            writeLE32(UInt32(fileSize), to: base, offset: 2)
            writeLE32(54, to: base, offset: 10)
            writeLE32(40, to: base, offset: 14)
            writeLE32(UInt32(width), to: base, offset: 18)
            writeLE32(UInt32(height), to: base, offset: 22)
            writeLE16(1, to: base, offset: 26)
            writeLE16(24, to: base, offset: 28)
            writeLE32(UInt32(imageSize), to: base, offset: 34)

            rgb.withUnsafeBytes { sourceBuffer in
                guard let src = sourceBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
                for y in 0..<height {
                    let srcRow = (height - 1 - y) * rowBytes
                    let dstRow = 54 + (y * paddedRowBytes)
                    for x in 0..<width {
                        let srcIndex = srcRow + (x * 3)
                        let dstIndex = dstRow + (x * 3)
                        base[dstIndex] = src[srcIndex + 2]
                        base[dstIndex + 1] = src[srcIndex + 1]
                        base[dstIndex + 2] = src[srcIndex]
                    }
                }
            }
        }

        return buffer
    }

    nonisolated private static func writeLE16(_ value: UInt16, to base: UnsafeMutablePointer<UInt8>, offset: Int) {
        base[offset] = UInt8(value & 0x00ff)
        base[offset + 1] = UInt8((value >> 8) & 0x00ff)
    }

    nonisolated private static func writeLE32(_ value: UInt32, to base: UnsafeMutablePointer<UInt8>, offset: Int) {
        base[offset] = UInt8(value & 0x000000ff)
        base[offset + 1] = UInt8((value >> 8) & 0x000000ff)
        base[offset + 2] = UInt8((value >> 16) & 0x000000ff)
        base[offset + 3] = UInt8((value >> 24) & 0x000000ff)
    }

    /// Encode raw RGB bytes to PNG (no CoreGraphics dependency).
    /// Uses zlib (Foundation's built-in compression) for IDAT deflate.
    nonisolated private static func rgbToPng(_ rgb: Data, width: Int, height: Int) -> Data? {
        let expectedLength = width * height * 3
        guard rgb.count == expectedLength else { return nil }

        // Build raw IDAT payload: filter byte (0) + RGB row data for each row
        let rowBytes = width * 3
        var rawIDAT = Data(capacity: height * (1 + rowBytes))
        rgb.withUnsafeBytes { src in
            guard let base = src.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for y in 0..<height {
                rawIDAT.append(0) // filter: None
                rawIDAT.append(UnsafeBufferPointer(start: base + y * rowBytes, count: rowBytes))
            }
        }

        // Compress with zlib deflate
        guard let compressed = try? (rawIDAT as NSData).compressed(using: .zlib) as Data else { return nil }

        // Build PNG file
        var png = Data()

        // PNG signature
        png.append(contentsOf: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

        // IHDR chunk
        var ihdr = Data()
        ihdr.appendBE32(UInt32(width))
        ihdr.appendBE32(UInt32(height))
        ihdr.append(8)  // bit depth
        ihdr.append(2)  // color type: RGB
        ihdr.append(0)  // compression
        ihdr.append(0)  // filter
        ihdr.append(0)  // interlace
        png.appendPNGChunk(type: [0x49, 0x48, 0x44, 0x52], data: ihdr)

        // IDAT chunk (zlib-wrapped: CMF + FLG header + deflate + Adler32)
        var idat = Data()
        idat.append(0x78)  // CMF: deflate, window size 32K
        idat.append(0x01)  // FLG: no dict, check bits
        idat.append(compressed)
        // Adler-32 checksum of uncompressed data
        let adler = adler32(rawIDAT)
        idat.appendBE32(adler)
        png.appendPNGChunk(type: [0x49, 0x44, 0x41, 0x54], data: idat)

        // IEND chunk
        png.appendPNGChunk(type: [0x49, 0x45, 0x4E, 0x44], data: Data())

        return png
    }

    nonisolated private static func adler32(_ data: Data) -> UInt32 {
        var a: UInt32 = 1
        var b: UInt32 = 0
        data.withUnsafeBytes { buffer in
            guard let bytes = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for i in 0..<data.count {
                a = (a + UInt32(bytes[i])) % 65521
                b = (b + a) % 65521
            }
        }
        return (b << 16) | a
    }

    nonisolated private static func pixooPreviewHtml() -> String {
        """
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Pixoo Preview</title>
        <style>
        *{box-sizing:border-box}
        body{margin:0;min-height:100vh;background:#09090b;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center}
        .wrap{display:flex;flex-direction:column;gap:14px;align-items:center;padding:24px}
        h1{margin:0;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#a1a1aa}
        .frame{width:320px;height:320px;border-radius:18px;border:1px solid #27272a;background:#000;box-shadow:0 20px 60px rgba(0,0,0,0.45);image-rendering:pixelated}
        .meta{font-size:12px;color:#a1a1aa}
        </style>
        </head>
        <body>
        <div class="wrap">
        <h1>Pixoo 64x64 Preview</h1>
        <img id="frame" class="frame" alt="Pixoo frame" width="320" height="320">
        <div class="meta" id="meta">Waiting for first frame...</div>
        </div>
        <script>
        const img = document.getElementById('frame');
        const meta = document.getElementById('meta');
        let frameNumber = 0;
        let fallbackTimer = null;
        async function refresh() {
          const url = '/pixoo/frame?ts=' + Date.now();
          const res = await fetch(url, { cache: 'no-store' });
          if (res.status === 204) {
            meta.textContent = 'No frame available yet';
            return;
          }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          img.src = URL.createObjectURL(blob);
          frameNumber += 1;
          meta.textContent = 'Frames loaded: ' + frameNumber;
        }
        function startPolling(reason) {
          if (fallbackTimer) return;
          meta.textContent = reason;
          refresh().catch(err => {
            meta.textContent = 'Preview error: ' + (err && err.message ? err.message : err);
          });
          fallbackTimer = setInterval(() => {
            refresh().catch(err => {
              meta.textContent = 'Preview error: ' + (err && err.message ? err.message : err);
            });
          }, 250);
        }
        if (window.EventSource) {
          const es = new EventSource('/pixoo/stream');
          es.addEventListener('frame', e => {
            img.src = 'data:image/bmp;base64,' + e.data;
            frameNumber += 1;
            meta.textContent = 'Frames loaded: ' + frameNumber + ' (SSE)';
          });
          es.onerror = () => {
            es.close();
            startPolling('SSE unavailable, using polling preview');
          };
        } else {
          startPolling('EventSource unavailable, using polling preview');
        }
        </script>
        </body>
        </html>
        """
    }

    @MainActor
    private func buildUsageEndpointPayload() -> SendableDict {
        SendableDict([
            "usage": buildUsageEvent().map { event in
                var payload = event
                payload.removeValue(forKey: "type")
                return payload
            } as Any,
            "fetchedAt": cachedApiUsage == nil ? 0 : Int(lastApiFetchTime.timeIntervalSince1970 * 1000),
        ])
    }

    @MainActor
    private func buildDevicesPayload() async -> SendableDict {
        var devices: [[String: Any]] = []

        if let serialModule {
            let serial = await serialModule.statusSnapshot()
            devices.append([
                "type": "esp32_serial",
                "detectedPorts": serial["detectedPorts"] as Any,
                "connections": serial["connections"] as Any,
                "lastOpenError": serial["lastOpenError"] as Any,
                "lastReadError": serial["lastReadError"] as Any,
                "lastWriteError": serial["lastWriteError"] as Any,
            ])
        }

        if let adbModule {
            let adb = adbModule.statusSnapshot()
            devices.append([
                "type": "adb",
                "devices": adb["devices"] as Any,
                "reverseReadyCount": adb["reverseReadyCount"] as Any,
                "lastError": adb["lastError"] as Any,
            ])
        }

        if let pixooModule {
            let pixoo = pixooModule.statusSnapshot()
            devices.append([
                "type": "pixoo",
                "deviceIps": pixoo["deviceIps"] as Any,
                "configuredDeviceCount": pixoo["configuredDeviceCount"] as Any,
                "hasFrame": pixoo["hasFrame"] as Any,
                "lastPushError": pixoo["lastPushError"] as Any,
            ])
        }

        if let d200hModule {
            let d200h = d200hModule.statusSnapshot()
            devices.append([
                "type": "d200h",
                "connected": d200h["connected"] as Any,
                "hasConsumerDevice": d200h["hasConsumerDevice"] as Any,
                "hasKeyboardDevice": d200h["hasKeyboardDevice"] as Any,
            ])
        }

        return SendableDict(["devices": devices])
    }

    @MainActor
    private func forceD200hRefreshPayload() -> SendableDict {
        guard let d200hModule else {
            return SendableDict(["status": "error", "error": "d200h module unavailable"])
        }
        return SendableDict([
            "status": "ok",
            "d200h": d200hModule.forceFullRefresh(reason: "HTTP /d200h/refresh"),
        ])
    }

    @MainActor
    private func buildDiagPayload(tail: Int) async -> SendableDict {
        let modules = await buildModuleHealth().value["modules"] as? [String: Any] ?? [:]
        let recentLog = DaemonLogger.shared.recentLines(limit: tail)
        return SendableDict([
            "status": "ok",
            "state": stateMachine.state.rawValue,
            "sessionId": sessionId,
            "gatewayConnected": cachedGatewayConnected,
            "gatewayAvailable": cachedGatewayAvailable,
            "logStreamRunning": await logStream.isRunning,
            "modules": modules,
            "recentLog": recentLog,
        ])
    }

    // MARK: - WebSocket Handlers

    private func setupWSHandlers() async {
        await wsServer.setCommandHandler { [weak self] cmd in
            let box = SendableDict(cmd)
            Task { @MainActor in self?.handleCommand(box.value) }
        }

        await wsServer.setConnectHandler { [weak self] conn in
            Task { @MainActor in self?.handleClientConnect(conn) }
        }

        await wsServer.setDisconnectHandler { [weak self] in
            Task { @MainActor in self?.handleClientDisconnect() }
        }
    }

    // MARK: - Client Connect

    @MainActor
    private func handleClientConnect(_ conn: WebSocketConnection) {
        let connectionEvent: [String: Any] = [
            "type": "connection",
            "status": "connected",
            "sessionId": sessionId,
        ]
        if let data = connectionEvent.jsonData { conn.send(data) }

        let gwAlive = cachedGatewayConnected
        let stateEvent = buildFullStateEvent(agentType: gwAlive ? "openclaw" : "daemon")
        lastStateEvent = stateEvent
        if let data = stateEvent.jsonData { conn.send(data) }

        // Sessions list
        let sessionsEvent = buildSessionsListEvent()
        if let data = sessionsEvent.jsonData { conn.send(data) }

        // Usage
        let usageEvent = buildUsageEvent()
        if let data = usageEvent?.jsonData { conn.send(data) }

        // Fetch usage if stale
        if cachedApiUsage == nil || Date().timeIntervalSince(lastApiFetchTime) > 300 {
            Task { await fetchUsageRelayed() }
        }
    }

    @MainActor private func handleClientDisconnect() {}

    // MARK: - Commands

    @MainActor
    private func handleCommand(_ cmd: [String: Any]) {
        guard let type = cmd["type"] as? String else { return }
        DaemonLogger.shared.debug("Daemon", "cmd: \(type)")

        // Gateway adapter handles command if alive
        if let gw = gatewayAdapter {
            let cmdBox = SendableDict(cmd)
            switch type {
            case "respond": Task { await gw.sendRPC(method: "exec.approval.resolve", params: cmdBox.value) }
                _ = stateMachine.transition(trigger: "user_response", source: .user); broadcastStateUpdate()
            case "interrupt": Task { await gw.sendRPC(method: "chat.abort", params: [:]) }
                _ = stateMachine.transition(trigger: "interrupt", source: .user); broadcastStateUpdate()
            case "select_option": Task { await gw.sendRPC(method: "exec.approval.resolve", params: cmdBox.value) }
                _ = stateMachine.transition(trigger: "user_sㅈelection", source: .user); broadcastStateUpdate()
            case "send_prompt": Task { await gw.sendRPC(method: "chat.send", params: cmdBox.value) }
                _ = stateMachine.transition(trigger: "user_prompt_submit", source: .hook); broadcastStateUpdate()
            case "escape": Task { await gw.sendRPC(method: "chat.abort", params: [:]) }
                _ = stateMachine.transition(trigger: "interrupt", source: .user); broadcastStateUpdate()
            default: break
            }
            if type != "switch_agent" && type != "query_usage" && type != "focus_session"
                && type != "mode_toggle" && type != "session_switch" && type != "usage_toggle" { return }
        }

        switch type {
        case "focus_session":
            if let sessionId = cmd["sessionId"] as? String {
                Task { await focusRelay.focus(sessionId: sessionId) }
            }
            return
        case "session_command":
            guard let sessionId = cmd["sessionId"] as? String,
                  let innerCommand = cmd["command"] as? [String: Any] else { return }
            let sessions = cachedSessions
            guard sessions.contains(where: { $0.id == sessionId }) else {
                DaemonLogger.shared.debug("Daemon", "session_command: session \(sessionId) not found")
                return
            }
            let cmdBox = SendableDict(innerCommand)
            Task {
                await self.focusRelay.focus(sessionId: sessionId)
                try? await Task.sleep(for: .milliseconds(100))
                _ = await self.focusRelay.routeCommand(cmdBox.value)
            }
            return
        case "respond", "interrupt", "escape", "select_option", "send_prompt", "navigate_option", "switch_mode":
            // Route to focused session if available, otherwise legacy forwarding
            let cmdBox = SendableDict(cmd)
            Task {
                let routed = await self.focusRelay.routeCommand(cmdBox.value)
                if !routed {
                    await MainActor.run { self.forwardCommandToSession(cmdBox.value) }
                }
            }
            // Update local state machine
            switch type {
            case "respond":
                if stateMachine.state == .awaitingPermission || stateMachine.state == .awaitingDiff {
                    _ = stateMachine.transition(trigger: "user_response", source: .user); broadcastStateUpdate()
                }
            case "select_option":
                if stateMachine.state == .awaitingOption {
                    _ = stateMachine.transition(trigger: "user_selection", source: .user); broadcastStateUpdate()
                }
            case "interrupt":
                _ = stateMachine.transition(trigger: "interrupt", source: .user); broadcastStateUpdate()
            default: break
            }
            return
        case "query_usage":
            Task {
                await fetchUsageRelayed()
                await MainActor.run { self.broadcastUsage() }
            }
        case "switch_agent":
            Task { await focusRelay.unfocus() }
            handleSwitchAgent(cmd["agent"] as? String ?? "")
        case "mode_toggle":
            // D200H button 0: cycle mode via focused session (sends Shift+Tab to PTY)
            let modeCmd = SendableDict(AgentCommand.switchMode(mode: nil).dictionary)
            Task {
                let routed = await self.focusRelay.routeCommand(modeCmd.value)
                if !routed {
                    await MainActor.run { self.forwardCommandToSession(modeCmd.value) }
                }
            }
        case "session_switch":
            // D200H button 1: cycle focus to next session
            let sessions = cachedSessions
            guard !sessions.isEmpty else { break }
            Task {
                let currentId = await self.focusRelay.focusedSessionId
                let currentIdx = sessions.firstIndex(where: { $0.id == currentId }) ?? -1
                let nextIdx = (currentIdx + 1) % sessions.count
                await self.focusRelay.focus(sessionId: sessions[nextIdx].id)
            }
        case "usage_toggle":
            // D200H button 2: trigger usage fetch
            Task { await fetchUsageRelayed() }
        case "utility":
            let util = UtilityProxy()
            util.handleCommand(cmd["action"] as? String ?? "", value: cmd["value"] as? Int)
        default:
            DaemonLogger.shared.debug("Daemon", "Unknown command: \(type)")
        }
    }

    private func handleSwitchAgent(_ target: String) {
        if target == "openclaw", cachedGatewayConnected {
            let event = buildFullStateEvent(agentType: "openclaw")
            lastStateEvent = event
            broadcastRaw(event)
        } else if target == "claude-code" {
            let event = buildFullStateEvent(agentType: "daemon")
            lastStateEvent = event
            broadcastRaw(event)
        }
    }

    // MARK: - Hook Events

    @MainActor
    private func handleHookEvent(_ json: [String: Any]) async {
        guard let event = json["event"] as? String else { return }
        DaemonLogger.shared.debug("Hook", "Received: \(event)")

        switch event {
        case "session_start":
            _ = stateMachine.transition(trigger: "session_start", source: .hook)
            if let p = json["project_name"] as? String { stateMachine.projectName = p }
        case "user_prompt_submit":
            _ = stateMachine.transition(trigger: "user_prompt_submit", source: .hook)
        case "stop":
            _ = stateMachine.transition(trigger: "stop", source: .hook)
        case "session_end":
            _ = stateMachine.transition(trigger: "session_end", source: .hook)
        case "tool_start":
            stateMachine.currentTool = json["tool_name"] as? String
            stateMachine.toolInput = json["tool_input"] as? String
        case "tool_end":
            stateMachine.currentTool = nil; stateMachine.toolInput = nil
            stateMachine.toolCalls += 1
        default: break
        }

        // APME: route every hook event through the collector.
        // The collector manages its own session lifecycle (session_start opens
        // a run, session_end closes it, everything in between is a step).
        apmeCollector?.handleHook(event: event, data: json)

        broadcastStateUpdate()
    }

    // MARK: - State Changed (cascade)

    @MainActor
    private func handleStateChanged() {
        let currentState = stateMachine.state
        let gwAlive = cachedGatewayConnected
        let event = buildFullStateEvent(agentType: gwAlive ? "openclaw" : "daemon")
        lastStateEvent = event
        broadcastRaw(event)
        broadcastSessionsList()
        broadcastUsage()

        // Voice assistant: reset timeout on any activity during processing
        if currentState == .processing && voiceAssistant.state == .processing {
            voiceAssistant.resetResponseTimeout()
        }

        // PROCESSING→IDLE edge: agent finished a turn.
        // (1) Voice assistant TTS — existing behavior.
        // (2) APME turn-response capture — hands the response text to the
        //     collector, which persists it on the active turn, inline-classifies
        //     if needed, and fires a turn_judge eval for non-code categories.
        let wasProcessing = previousDaemonState == .processing
        previousDaemonState = currentState
        if wasProcessing && currentState == .idle {
            Task { [weak self] in
                guard let self else { return }
                let lastEntry = await self.timelineStore.getLastEntry(type: "chat_end")
                let responseText = (lastEntry?.detail ?? lastEntry?.raw) ?? ""
                await MainActor.run {
                    // APME: record the response even when voice assistant is inactive
                    if !responseText.isEmpty {
                        self.apmeCollector?.setTurnResponse(responseText)
                    }
                    if self.voiceAssistant.state == .processing {
                        self.voiceAssistant.handleResponse(responseText.isEmpty ? "완료했습니다." : responseText)
                    }
                }
            }
        }
    }

    // MARK: - Gateway Lifecycle

    private func connectGatewayAdapter() {
        guard gatewayAdapter == nil, !gatewayConnecting else { return }
        gatewayConnecting = true
        DaemonLogger.shared.info("OpenClaw Gateway detected, connecting...")

        let adapter = OpenClawAdapter()
        Task {
            await adapter.setOnEvent { [weak self] event in
                let box = SendableDict(event)
                Task { @MainActor in self?.handleGatewayEvent(box.value) }
            }
            await adapter.setOnConnectionChanged { [weak self] connected in
                Task { @MainActor in
                    if connected {
                        self?.cachedGatewayConnected = true
                        self?.cachedGatewayAuthStatus = "connected"
                        self?.cachedGatewayAuthRequestId = nil
                        self?.cachedGatewayAuthMessage = nil
                        DaemonLogger.shared.info("OpenClaw Gateway connected")
                        #if !AGENTDECK_APP_STORE
                        await self?.logStream.start()
                        #endif
                        if self?.stateMachine.state == .disconnected {
                            _ = self?.stateMachine.transition(trigger: "session_start", source: .hook)
                        }
                        self?.handleStateChanged()
                    } else {
                        self?.cachedGatewayConnected = false
                        if self?.cachedGatewayAvailable == true, self?.cachedGatewayAuthStatus == "connected" {
                            self?.cachedGatewayAuthStatus = "gateway_reachable"
                        }
                        DaemonLogger.shared.info("OpenClaw Gateway disconnected")
                        await self?.logStream.stop()
                        _ = self?.stateMachine.transition(trigger: "session_end", source: .hook)
                        self?.handleStateChanged()
                    }
                }
            }
            await adapter.start()
            self.gatewayAdapter = adapter
            self.gatewayConnecting = false
        }
    }

    private func disconnectGatewayAdapter() {
        guard let adapter = gatewayAdapter else { return }
        DaemonLogger.shared.info("OpenClaw Gateway lost, cleaning up...")
        Task { await adapter.stop() }
        gatewayAdapter = nil
        cachedGatewayConnected = false
        cachedGatewayAuthStatus = cachedGatewayAvailable ? "gateway_reachable" : "gateway_not_found"
        cachedGatewayAuthRequestId = nil
        cachedGatewayAuthMessage = nil
        _ = stateMachine.transition(trigger: "session_end", source: .hook)
        broadcastSessionsList()
        broadcastStateUpdate()
        broadcastUsage()
    }

    @MainActor
    private func handleGatewayEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "gateway_chat":
            let chatPayload = event["payload"] as? [String: Any] ?? [:]
            let chatState = chatPayload["state"] as? String
            switch chatState {
            case "final", "aborted", "error":
                _ = stateMachine.transition(trigger: "idle_detected", source: .pty)
            default:
                _ = stateMachine.transition(trigger: "spinner_start", source: .pty)
            }
            broadcastStateUpdate()
        case "gateway_approval":
            _ = stateMachine.transition(trigger: "permission_prompt", source: .pty)
            if let payload = event["payload"] as? [String: Any] {
                stateMachine.question = payload["message"] as? String
            }
            broadcastStateUpdate()
        case "gateway_approval_resolved":
            _ = stateMachine.transition(trigger: "spinner_start", source: .pty)
            broadcastStateUpdate()
        case "gateway_presence":
            break // Heartbeat
        case "gateway_auth":
            cachedGatewayAuthStatus = event["status"] as? String ?? cachedGatewayAuthStatus
            cachedGatewayAuthRequestId = event["requestId"] as? String
            cachedGatewayAuthMessage = event["message"] as? String
            if cachedGatewayAuthStatus != "connected" {
                cachedGatewayConnected = false
            }
            handleStateChanged()
        case "gateway_timeline_entry":
            if let entry = event["entry"] as? [String: Any] {
                appendGatewayTimelineEntry(entry)
            }
        case "gateway_health":
            let payload = event["payload"] as? [String: Any]
            let hasError = !((payload?["ok"] as? Bool) ?? false)
            let changed = hasError != cachedGatewayHasError
            cachedGatewayHasError = hasError
            if changed {
                handleStateChanged()
            }
        case "model_catalog":
            // Gateway sends full model catalog — replace entirely (same as Node.js)
            if let models = event["models"] as? [[String: Any]] {
                let previousModelName = stateMachine.modelName
                if stateMachine.modelName == nil, let defaultModel = event["defaultModel"] as? String {
                    stateMachine.modelName = defaultModel
                }
                let catalogChanged = updateModelCatalog(from: models, source: "gateway", replaceExisting: true)
                if !catalogChanged, stateMachine.modelName != previousModelName {
                    broadcastStateUpdate()
                    broadcastUsage()
                }
            }
        default:
            break
        }
    }

    // MARK: - Relayed Events (from sibling timelines)

    @MainActor
    private func handleRelayedEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "timeline_event":
            broadcastRaw(event)
        case "timeline_history":
            broadcastRaw(event)
        case "state_update":
            // Extract model catalog from sibling
            if let catalog = event["modelCatalog"] as? [[String: Any]] {
                updateModelCatalog(from: catalog, source: "sibling relay")
            }
        default:
            break
        }
    }

    static func normalizedModelCatalog(_ models: [[String: Any]]) -> [[String: Any]] {
        DashboardDataRules.canonicalizeModelCatalog(models)
    }

    static func mergedModelCatalog(existing: [[String: Any]], incoming: [[String: Any]]) -> [[String: Any]] {
        DashboardDataRules.mergedModelCatalog(existing: existing, incoming: incoming)
    }

    @discardableResult
    private func updateModelCatalog(from models: [[String: Any]], source: String, replaceExisting: Bool = false) -> Bool {
        let merged = replaceExisting
            ? Self.normalizedModelCatalog(models)
            : Self.mergedModelCatalog(existing: cachedModelCatalog, incoming: models)
        let changed = !(merged as NSArray).isEqual(cachedModelCatalog)
        guard changed else { return false }
        cachedModelCatalog = merged
        DaemonLogger.shared.debug("Daemon", "Model catalog updated from \(source): \(merged.count) models")
        broadcastStateUpdate()
        broadcastUsage()
        return true
    }

    // MARK: - Polling

    private func startAllPolling() {
        // Sessions — 10s (also self-heals daemon.json if deleted)
        sessionPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard let self else { break }
                await self.refreshSessions()
                // Self-heal: re-write daemon.json if it was deleted externally
                // (bridge instances may remove it due to PID-check race conditions)
                if self.registry.readDaemonInfo() == nil {
                    let info = DaemonInfo(
                        port: Int(self.port),
                        pid: Int(ProcessInfo.processInfo.processIdentifier),
                        startedAt: ISO8601DateFormatter().string(from: Date()),
                        httpPort: nil
                    )
                    self.registry.writeDaemonInfo(info)
                    DaemonLogger.shared.debug("Daemon", "Self-healed daemon.json (was deleted externally)")
                }
            }
        }

        // Usage — 60s
        usagePollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard let self, await self.wsServer.hasClients() else { continue }
                await self.fetchUsageRelayed()
            }
        }

        // Ollama — dynamic interval (5s base, exponential backoff up to 5m
        // when the service is absent). See probeOllama() for the backoff
        // state machine.
        ollamaPollTask = Task { [weak self] in
            while !Task.isCancelled {
                let interval = await MainActor.run { self?.ollamaNextInterval ?? 5 }
                try? await Task.sleep(for: .seconds(interval))
                guard let self, await self.wsServer.hasClients() else { continue }
                await self.probeOllama()
            }
        }

        // MLX — dynamic interval, same backoff pattern as ollama.
        mlxPollTask = Task { [weak self] in
            while !Task.isCancelled {
                let interval = await MainActor.run { self?.mlxNextInterval ?? 5 }
                try? await Task.sleep(for: .seconds(interval))
                guard let self, await self.wsServer.hasClients() else { continue }
                await self.probeMLX()
            }
        }

        // Gateway probe — 5s
        gatewayPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self else { break }
                let available = await self.gatewayProbe.isAvailable
                let changed = available != self.cachedGatewayAvailable
                self.cachedGatewayAvailable = available
                if !available {
                    self.cachedGatewayAuthStatus = "gateway_not_found"
                    self.cachedGatewayAuthRequestId = nil
                    self.cachedGatewayAuthMessage = nil
                } else if self.cachedGatewayAuthStatus == "gateway_not_found" {
                    self.cachedGatewayAuthStatus = "gateway_reachable"
                }
                if available && self.gatewayAdapter == nil {
                    self.connectGatewayAdapter()
                } else if !available && self.gatewayAdapter != nil {
                    self.disconnectGatewayAdapter()
                }
                if changed { self.broadcastStateUpdate() }
            }
        }
        Task { await gatewayProbe.start() }

        // Gateway health — 30s
        gatewayHealthTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self else { break }
                #if AGENTDECK_APP_STORE
                let adapterHealth = await self.gatewayAdapter?.fetchHealthHasError()
                let hasError: Bool
                if let adapterHealth {
                    hasError = adapterHealth
                } else {
                    hasError = await self.gatewayProbe.hasErrorSnapshot()
                }
                #else
                let hasError = await self.gatewayProbe.hasErrorSnapshot()
                #endif
                if hasError != self.cachedGatewayHasError {
                    self.cachedGatewayHasError = hasError
                    self.broadcastStateUpdate()
                }
            }
        }

        // APME eval loop — 30s, mirrors bridge/src/daemon-server.ts:951-990
        // Picks up runs that closed without eval, computes outcome on closed
        // runs, classifies stragglers, and backfills turn outcomes for
        // code-category turns that never go through turn_judge.
        apmeEvalTimerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self else { break }
                await self.apmeEvalTick()
            }
        }

        // Antigravity — 15s (local SQLite read for plan/credit status)
        cachedAntigravityStatus = usageAPI.antigravityStatus
        antigravityPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard let self else { break }
                let next = self.usageAPI.antigravityStatus
                let changed: Bool
                if let prev = self.cachedAntigravityStatus, let next {
                    changed = prev.planName != next.planName
                        || prev.availableCredits != next.availableCredits
                        || prev.minimumCreditAmountForUsage != next.minimumCreditAmountForUsage
                } else {
                    changed = (self.cachedAntigravityStatus == nil) != (next == nil)
                }
                self.cachedAntigravityStatus = next
                if changed { self.broadcastStateUpdate() }
            }
        }

        // Usage tick — 5s (for session duration display + stale TTL)
        usageTickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, await self.wsServer.hasClients() else { continue }
                // TTL: keep last good cache, but mark it stale after 10 minutes.
                // Clearing to nil makes the HUD look like usage disappeared entirely.
                if self.cachedApiUsage != nil,
                   self.lastApiFetchTime != .distantPast,
                   Date().timeIntervalSince(self.lastApiFetchTime) > Self.usageStaleTTL {
                    if !self.apiUsageStale {
                        DaemonLogger.shared.debug("Daemon", "API usage cache expired, keeping last good values as stale")
                        self.apiUsageStale = true
                    }
                }
                self.broadcastUsage()
            }
        }
    }

    // MARK: - Sessions

    @MainActor
    private func refreshSessions() async {
        let sessions = await registry.listActiveAndReachable().filter { $0.id != sessionId }
        cachedSessions = DashboardDataRules.sortSessions(await enrichSessionsWithState(sessions))
        broadcastSessionsList()
    }

    private func enrichSessionsWithState(_ sessions: [DaemonSessionEntry]) async -> [DaemonSessionEntry] {
        await withTaskGroup(of: DaemonSessionEntry.self) { group in
            for session in sessions {
                group.addTask {
                    var s = session
                    if let health = await SessionRegistry.shared.probeDaemonHealth(port: session.port) {
                        s.agentType = health["agentType"] as? String ?? s.agentType
                        s.state = health["state"] as? String
                        s.modelName = health["modelName"] as? String
                        s.currentTool = health["currentTool"] as? String
                        s.navigable = health["navigable"] as? Bool
                        if let rawOptions = health["options"] as? [[String: Any]] {
                            s.options = rawOptions.map { option in
                                option.mapValues(AnyCodable.init)
                            }
                        } else {
                            s.options = nil
                        }
                    }
                    return s
                }
            }
            var result: [DaemonSessionEntry] = []
            for await session in group { result.append(session) }
            return result
        }
    }

    @MainActor
    private func broadcastSessionsList() {
        let event = buildSessionsListEvent()
        broadcastRaw(event)
    }

    private func buildSessionsListEvent() -> [String: Any] {
        var sessions = cachedSessions.map { sessionToDict($0) }
        // Inject virtual OpenClaw session when Gateway is reachable
        if cachedGatewayAvailable || gatewayAdapter != nil {
            if !sessions.contains(where: { ($0["id"] as? String) == "openclaw-gateway" || ($0["agentType"] as? String) == "openclaw" }) {
                // Normalize state: when the gateway adapter is alive but the
                // shared stateMachine has not yet transitioned out of
                // .disconnected (the connect-time session_start hook only fires
                // from .disconnected, and may have raced with the broadcast),
                // emit "idle" rather than "disconnected" so downstream clients
                // never paint OC as an abnormal/OFF card. The earliest possible
                // sort tiebreaker (1970-01-01) keeps OC pinned to slot 0 even
                // if a real openclaw session were ever added later.
                let smState = stateMachine.state.rawValue
                let normalizedState = (cachedGatewayConnected && smState != "disconnected") ? smState : "idle"
                var gatewaySession: [String: Any] = [
                    "id": "openclaw-gateway", "port": 18789,
                    "projectName": "OpenClaw", "agentType": "openclaw",
                    "alive": true, "state": normalizedState,
                    "startedAt": "1970-01-01T00:00:00.000Z",
                ]
                if let tool = stateMachine.currentTool { gatewaySession["currentTool"] = tool }
                if let modelName = stateMachine.modelName { gatewaySession["modelName"] = modelName }
                if !stateMachine.options.isEmpty { gatewaySession["options"] = stateMachine.options }
                if stateMachine.navigable { gatewaySession["navigable"] = true }
                sessions.append(gatewaySession)
            }
        }
        sessions = DashboardDataRules.sortSessionPayloads(sessions)
        return ["type": "sessions_list", "sessions": sessions]
    }

    // MARK: - Usage (3-tier relay)

    @MainActor
    private func fetchUsageRelayed() async {
        let sessions = await registry.listActiveAndReachable().filter { $0.agentType != "daemon" && $0.id != sessionId }
        DaemonLogger.shared.sampledDebug("Daemon", key: "usage-relay:start", every: 10, "fetchUsageRelayed: \(sessions.count) siblings")

        // Tier 1: HTTP relay from sibling
        for sibling in sessions {
            DaemonLogger.shared.sampledDebug("Daemon", key: "usage-relay:tier1-port-\(sibling.port)", every: 10, "Usage Tier 1: HTTP relay from port \(sibling.port)")
            if let usage = await fetchUsageViaHTTP(port: sibling.port) {
                // Parse relayed dict back into ApiUsageData for caching
                cachedApiUsage = parseRelayedUsage(usage)
                lastApiFetchTime = Date()
                apiUsageStale = false
                apiUsagePreAdjusted = false  // raw data from HTTP, needs adjustment
                oauthConnected = true
                // Infer billing type
                if let inferred = cachedApiUsage?.inferredBillingType {
                    stateMachine.billingType = inferred
                }
                DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier1-ok", "Usage Tier 1 OK: 5h=\(cachedApiUsage?.fiveHourPercent ?? -1)%", minInterval: 30)
                broadcastUsage()
                return
            }
        }

        // Siblings exist but relay failed — do NOT call direct API (429 prevention)
        // But still broadcast cached data so clients aren't left empty
        if !sessions.isEmpty {
            DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier1-failed", "Usage Tier 1 failed for all \(sessions.count) siblings", minInterval: 30)
            oauthConnected = usageAPI.hasOAuthToken()
            // Don't mark stale here — usageTick's 10-min TTL handles staleness.
            // A transient relay failure with fresh cached data isn't stale.
            broadcastUsage()
            return
        }

        // Tier 3: Direct API (only if no siblings)
        DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier3-start", "Usage Tier 3: direct API", minInterval: 30)
        if let usage = await usageAPI.fetchUsage() {
            cachedApiUsage = usage
            lastApiFetchTime = Date()
            apiUsageStale = false
            apiUsagePreAdjusted = false  // raw data from API, needs adjustment
            oauthConnected = true
            if let inferred = usage.inferredBillingType {
                stateMachine.billingType = inferred
            }
            DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier3-ok", "Usage Tier 3 OK: 5h=\(usage.fiveHourPercent ?? -1)%", minInterval: 30)
            broadcastUsage()
        } else {
            DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier3-failed:\(usageAPI.tokenStatus.rawValue)", "Usage Tier 3 failed (token: \(usageAPI.tokenStatus.rawValue))", minInterval: 30)
            oauthConnected = usageAPI.hasOAuthToken()
            // Don't mark stale here — usageTick's 10-min TTL handles staleness.
            // A transient API failure with fresh cached data isn't stale.
            broadcastUsage()
        }
    }

    private func fetchUsageViaHTTP(port: Int) async -> [String: Any]? {
        let url = URL(string: "http://127.0.0.1:\(port)/usage")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  var usage = json["usage"] as? [String: Any] else { return nil }
            // Validate fetchedAt — skip stale data (>5 min)
            if let fetchedAt = json["fetchedAt"] as? Int, fetchedAt > 0 {
                let ageMs = Int(Date().timeIntervalSince1970 * 1000) - fetchedAt
                if ageMs > 5 * 60 * 1000 { return nil }
            }
            usage["type"] = "usage_update"
            return usage
        } catch { return nil }
    }

    /// Parse a relayed usage dict back into ApiUsageData for local caching
    private func parseRelayedUsage(_ dict: [String: Any]) -> ApiUsageData {
        ApiUsageData(
            fiveHourPercent: dict["fiveHourPercent"] as? Double,
            fiveHourResetsAt: dict["fiveHourResetsAt"] as? String,
            sevenDayPercent: dict["sevenDayPercent"] as? Double,
            sevenDayResetsAt: dict["sevenDayResetsAt"] as? String,
            extraUsageEnabled: dict["extraUsageEnabled"] as? Bool ?? false,
            extraUsageMonthlyLimit: dict["extraUsageMonthlyLimit"] as? Double,
            extraUsageUsedCredits: dict["extraUsageUsedCredits"] as? Double,
            extraUsageUtilization: dict["extraUsageUtilization"] as? Double,
            inferredBillingType: dict["fiveHourPercent"] != nil ? "subscription" : "api"
        )
    }

    // MARK: - Broadcasting

    @MainActor
    private func broadcastStateUpdate() {
        let gwAlive = cachedGatewayConnected
        let event = buildFullStateEvent(agentType: gwAlive ? "openclaw" : "daemon")
        lastStateEvent = event
        broadcastRaw(event)
    }

    @MainActor
    private func broadcastUsage() {
        if let event = buildUsageEvent() {
            broadcastRaw(event)
        }
    }

    @MainActor
    private func broadcastRaw(_ event: [String: Any]) {
        if let data = event.jsonData {
            Task { await wsServer.broadcastRaw(data) }
        }
    }

    /// In-process accessor for D200H module status. Same-process callers
    /// (e.g. `DaemonService` health monitor) must use this instead of HTTP
    /// self-probing `/health` — routing a loopback query through
    /// `URLSession.shared` creates a negative-feedback loop under connection
    /// pool contention (see memory: `bug_daemon_self_http_probe.md`).
    /// Returns the same dict that `/health` → `modules.d200h` would return,
    /// or `nil` if the D200H module isn't initialized.
    @MainActor
    func d200hStatusSnapshot() -> [String: Any]? {
        return d200hModule?.statusSnapshot()
    }

    /// In-process accessors for the other device modules. Same rationale as
    /// `d200hStatusSnapshot()` — callers inside the app (menu bar devices
    /// section) must not HTTP-probe `/health`. All return `nil` when the
    /// underlying module isn't initialized for this session.
    @MainActor
    func adbStatusSnapshot() -> [String: Any]? {
        return adbModule?.statusSnapshot()
    }

    @MainActor
    func pixooStatusSnapshot() -> [String: Any]? {
        return pixooModule?.statusSnapshot()
    }

    @MainActor
    func serialStatusSnapshot() async -> [String: Any]? {
        guard let serialModule else { return nil }
        return await serialModule.statusSnapshot()
    }

    @MainActor
    private func buildModuleHealth() async -> SendableDict {
        var modules: [String: Any] = [
            "gateway": [
                "available": cachedGatewayAvailable,
                "connected": cachedGatewayConnected,
                "hasError": cachedGatewayHasError,
            ]
        ]
        if let adbModule {
            modules["adb"] = adbModule.statusSnapshot()
        }
        if let d200hModule {
            modules["d200h"] = d200hModule.statusSnapshot()
        }
        if let pixooModule {
            modules["pixoo"] = pixooModule.statusSnapshot()
        }
        if let serialModule {
            modules["serial"] = await serialModule.statusSnapshot()
        }
        return SendableDict([
            "state": stateMachine.state.rawValue,
            "modules": modules,
        ])
    }

    // MARK: - Event Builders

    @MainActor
    private func buildFullStateEvent(agentType: String) -> [String: Any] {
        var e: [String: Any] = [
            "type": "state_update",
            "state": stateMachine.state.rawValue,
            "permissionMode": stateMachine.permissionMode,
            "agentType": agentType,
        ]
        if let t = stateMachine.currentTool { e["currentTool"] = t }
        if let t = stateMachine.toolInput { e["toolInput"] = t }
        if let t = stateMachine.toolProgress { e["toolProgress"] = t }
        if let p = stateMachine.projectName { e["projectName"] = p }
        if let m = stateMachine.modelName { e["modelName"] = m }
        if let ef = stateMachine.effortLevel { e["effortLevel"] = ef }
        e["billingType"] = stateMachine.billingType
        if !stateMachine.options.isEmpty { e["options"] = stateMachine.options }
        if let pt = stateMachine.promptType { e["promptType"] = pt }
        if let q = stateMachine.question { e["question"] = q }
        if stateMachine.navigable { e["navigable"] = true }
        e["cursorIndex"] = stateMachine.cursorIndex
        if let sp = stateMachine.suggestedPrompt { e["suggestedPrompt"] = sp }
        mergeEngineSnapshot(into: &e)
        e["gatewayAvailable"] = cachedGatewayAvailable
        e["gatewayConnected"] = cachedGatewayConnected
        e["gatewayHasError"] = cachedGatewayHasError
        e["gatewayAuthStatus"] = cachedGatewayAuthStatus
        if let requestId = cachedGatewayAuthRequestId { e["gatewayAuthRequestId"] = requestId }
        if let message = cachedGatewayAuthMessage { e["gatewayAuthMessage"] = message }
        if let url = cachedPairingUrl { e["pairingUrl"] = url }
        if let r = stateMachine.remoteUrl { e["remoteUrl"] = r }
        if oauthConnected { e["oauthConnected"] = true }
        // Voice assistant state (piggyback on state_update for all clients)
        if cachedVoiceAssistantState != "disabled" {
            e["voiceAssistantState"] = cachedVoiceAssistantState
            e["voiceAssistantText"] = cachedVoiceAssistantText as Any
            e["voiceAssistantResponseText"] = cachedVoiceAssistantResponseText as Any
        }
        // Module health for device diagnostic panel
        e["moduleHealth"] = buildModuleHealthSync()
        return e
    }

    private func buildModuleHealthSync() -> [String: Any] {
        var modules: [String: Any] = [:]
        if let adb = adbModule { modules["adb"] = adb.statusSnapshot() }
        if let d200h = d200hModule { modules["d200h"] = d200h.statusSnapshot() }
        if let pixoo = pixooModule { modules["pixoo"] = pixoo.statusSnapshot() }
        // SerialModule.statusSnapshot() is async — signal presence only
        if serialModule != nil {
            modules["serial"] = ["available": true] as [String: Any]
        }
        return modules
    }

    private func buildUsageEvent() -> [String: Any]? {
        var e: [String: Any] = ["type": "usage_update"]

        // Session fields from StateMachine
        e["sessionDurationSec"] = stateMachine.sessionDurationSec
        e["inputTokens"] = stateMachine.inputTokens
        e["outputTokens"] = stateMachine.outputTokens
        e["toolCalls"] = stateMachine.toolCalls
        if let v = stateMachine.estimatedCostUsd { e["estimatedCostUsd"] = v }
        if let v = stateMachine.sessionPercent { e["sessionPercent"] = v }
        if let v = stateMachine.costSpent { e["costSpent"] = v }
        if let v = stateMachine.costLimit { e["costLimit"] = v }
        if let v = stateMachine.resetTime { e["resetTime"] = v }
        if let v = stateMachine.resetDate { e["resetDate"] = v }

        // API usage data — skip adjustUsagePercent when values were synced from relay
        if let u = cachedApiUsage {
            if apiUsagePreAdjusted {
                e["fiveHourPercent"] = u.fiveHourPercent as Any
                e["sevenDayPercent"] = u.sevenDayPercent as Any
            } else {
                e["fiveHourPercent"] = adjustUsagePercent(u.fiveHourPercent, resetsAt: u.fiveHourResetsAt) as Any
                e["sevenDayPercent"] = adjustUsagePercent(u.sevenDayPercent, resetsAt: u.sevenDayResetsAt) as Any
            }
            if let v = u.fiveHourResetsAt { e["fiveHourResetsAt"] = v }
            if let v = u.sevenDayResetsAt { e["sevenDayResetsAt"] = v }
            e["extraUsageEnabled"] = u.extraUsageEnabled
            if let v = u.extraUsageMonthlyLimit { e["extraUsageMonthlyLimit"] = v }
            if let v = u.extraUsageUsedCredits { e["extraUsageUsedCredits"] = v }
            if let v = u.extraUsageUtilization { e["extraUsageUtilization"] = v }
        }

        if oauthConnected { e["oauthConnected"] = true }
        if apiUsageStale { e["usageStale"] = true }
        mergeEngineSnapshot(into: &e)
        let ts = usageAPI.tokenStatus
        if ts != .unknown { e["tokenStatus"] = ts.rawValue }
        if let codex = usageAPI.codexAuthStatus {
            if let mode = codex.authMode { e["codexAuthMode"] = mode }
            if codex.webAuthConnected { e["codexWebAuthConnected"] = true }
            if let plan = codex.planType { e["codexPlanType"] = plan }
            if let accountId = codex.accountId { e["codexAccountId"] = accountId }
            if let until = codex.subscriptionActiveUntil { e["codexSubscriptionActiveUntil"] = until }
            if let refresh = codex.lastRefreshAt { e["codexLastRefreshAt"] = refresh }
        }
        if let antigravity = cachedAntigravityStatus {
            e["antigravityStatus"] = antigravityPayload(antigravity)
        }
        let subscriptions = buildSubscriptions()
        if !subscriptions.isEmpty { e["subscriptions"] = subscriptions }
        return e
    }

    @MainActor
    private func mergeEngineSnapshot(into event: inout [String: Any]) {
        if !cachedModelCatalog.isEmpty { event["modelCatalog"] = cachedModelCatalog }
        if let ollama = cachedOllamaStatus { event["ollamaStatus"] = ollama }
        if !cachedMlxModels.isEmpty { event["mlxModels"] = cachedMlxModels }
        let subscriptions = buildSubscriptions()
        if !subscriptions.isEmpty { event["subscriptions"] = subscriptions }
        if let antigravity = cachedAntigravityStatus {
            event["antigravityStatus"] = antigravityPayload(antigravity)
        }
    }

    @MainActor
    private func buildSubscriptions() -> [[String: Any]] {
        var subscriptions: [[String: Any]] = []
        if let codex = usageAPI.codexAuthStatus {
            // keep usage metadata fields in usage_update only
            if let plan = codex.planType {
                subscriptions.append([
                    "name": Self.chatGptPlanDisplay(plan),
                    "until": codex.subscriptionActiveUntil as Any,
                ])
            }
        }
        if cachedApiUsage?.inferredBillingType == "subscription" || stateMachine.billingType == "subscription" {
            subscriptions.append(["name": "Claude"])
        }
        return subscriptions
    }

    /// Returns 0 if the usage window has already reset.
    /// Added 'sticky' 5-min buffer for high usage to avoid premature '0% (now)'.
    private static func chatGptPlanDisplay(_ raw: String) -> String {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "plus": return "ChatGPT Plus"
        case "pro": return "ChatGPT Pro"
        case "team": return "ChatGPT Team"
        case "enterprise": return "ChatGPT Enterprise"
        default: return "ChatGPT \(raw)"
        }
    }

    private func antigravityPayload(_ status: AntigravityStatus) -> [String: Any] {
        var payload: [String: Any] = [:]
        if let planName = status.planName { payload["planName"] = planName }
        if let availableCredits = status.availableCredits { payload["availableCredits"] = availableCredits }
        if let minimumCreditAmountForUsage = status.minimumCreditAmountForUsage {
            payload["minimumCreditAmountForUsage"] = minimumCreditAmountForUsage
        }
        return payload
    }

    private func adjustUsagePercent(_ percent: Double?, resetsAt: String?) -> Double? {
        guard let percent else { return nil }
        guard let resetsAt else { return percent }

        // Robust parsing
        let resetDate: Date?
        if let d = ISO8601DateFormatter().date(from: resetsAt) {
            resetDate = d
        } else {
            let pattern = #"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})"#
            if let regex = try? NSRegularExpression(pattern: pattern),
               let match = regex.firstMatch(in: resetsAt, range: NSRange(resetsAt.startIndex..., in: resetsAt)),
               let dateRange = Range(match.range(at: 1), in: resetsAt) {
                let baseDate = String(resetsAt[dateRange])
                let tz: String
                if match.range(at: 3).location != NSNotFound,
                   let tzRange = Range(match.range(at: 3), in: resetsAt) {
                    tz = String(resetsAt[tzRange])
                } else {
                    tz = "Z"
                }
                resetDate = ISO8601DateFormatter().date(from: baseDate + tz)
            } else {
                resetDate = nil
            }
        }

        guard let resetDate else {
            DaemonLogger.shared.debug("Daemon", "Failed to parse resetsAt: \(resetsAt)")
            return percent
        }

        let now = Date()
        let elapsed = now.timeIntervalSince(resetDate)

        // If time hasn't passed yet, show current percent
        if elapsed < 0 { return percent }

        // Far-past resets_at (>1h) means Anthropic's /oauth/usage is returning
        // a prior window's final value because no new window is active — or the
        // bridge cache is stuck in a 429 backoff loop. In either case, zeroing
        // would underreport real usage; keep the last-known percent and let the
        // `usageStale` flag surface uncertainty to the UI.
        if elapsed > 3600 { return percent }

        // High-usage sticky: hold 90%+ values for 5 minutes post-reset to mask
        // server propagation lag / clock skew. Note: percent is on a 0–100 scale,
        // so the threshold is 90.0 (prior code used 0.90 and silently behaved
        // like a 0.9% threshold).
        if percent > 90.0 {
            if elapsed < 300 {
                return percent
            }
        } else {
            if elapsed < 60 {
                return percent
            }
        }

        return 0
    }

    // MARK: - Ollama

    @MainActor
    private func probeOllama() async {
        let previous = cachedOllamaStatus as NSDictionary?
        var success = false
        do {
            guard let psUrl = URL(string: "http://127.0.0.1:11434/api/ps") else { return }
            var request = URLRequest(url: psUrl)
            request.timeoutInterval = 2
            let (data, _) = try await LocalProbeSession.shared.data(for: request)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let models = json["models"] as? [[String: Any]] {
                cachedOllamaStatus = [
                    "available": true,
                    "models": models.map { [
                        "name": $0["name"] ?? "",
                        "size": $0["size"] ?? 0,
                        "sizeVram": $0["size_vram"] ?? $0["sizeVram"] ?? 0,
                    ] }
                ]
                success = true
            }
        } catch {
            // Swallow; handled via success flag below.
        }

        if success {
            ollamaFailureCount = 0
            ollamaNextInterval = Self.probeBaseInterval
        } else {
            ollamaFailureCount += 1
            ollamaNextInterval = min(ollamaNextInterval * 2, Self.probeMaxInterval)
            // Preserve the last-known cache until we've seen N consecutive
            // failures — a single blip (e.g. URLSession contention) should not
            // flip the UI to "unavailable". Once stale, flip to unavailable.
            if ollamaFailureCount >= Self.probeStaleThreshold {
                cachedOllamaStatus = ["available": false, "models": [] as [Any]]
            }
        }

        if previous == nil || !(previous?.isEqual(to: cachedOllamaStatus ?? [:]) ?? false) {
            broadcastStateUpdate()
            broadcastUsage()
        }
    }

    @MainActor
    private func probeMLX() async {
        let previous = cachedMlxModels
        let fallbackCandidates = [
            "http://127.0.0.1:8800/v1/models",
            "http://127.0.0.1:8800/models",
        ]
        // Once an endpoint has been resolved, prefer it exclusively. Only when
        // discovery keeps failing do we broaden the search back to all
        // fallbacks — this avoids burning 2 × N seconds on every poll cycle
        // while the service is absent.
        let candidates: [String]
        if let preferred = preferredMlxModelsEndpoint, mlxFailureCount < Self.probeStaleThreshold {
            candidates = [preferred]
        } else {
            candidates = Array(Set(([preferredMlxModelsEndpoint].compactMap { $0 }) + fallbackCandidates))
        }
        var resolved: [String] = []
        var success = false

        for endpoint in candidates {
            guard let url = URL(string: endpoint) else { continue }
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 2
                let (data, response) = try await LocalProbeSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard status == 200,
                      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let rows = json["data"] as? [[String: Any]] else {
                    continue
                }
                resolved = Array(Set(rows.compactMap { row in
                    if let id = row["id"] as? String, !id.isEmpty { return id }
                    if let name = row["name"] as? String, !name.isEmpty { return name }
                    return nil
                }.filter { !$0.lowercased().contains("nanollava") })).sorted()
                if !resolved.isEmpty {
                    preferredMlxModelsEndpoint = endpoint
                    success = true
                    break
                }
            } catch {
                continue
            }
        }

        if success {
            mlxFailureCount = 0
            mlxNextInterval = Self.probeBaseInterval
            // Pin filter: when the user has selected a specific MLX model via
            // `llm.mlx.model` in settings.json and it's present in the catalog,
            // broadcast only that one. Otherwise, when the catalog advertises
            // multiple models, auto-pick the first — matches the APME judge's
            // "first non-nanollava" auto-detect and prevents dashboard from
            // exposing every downloaded model on disk as if they were all live.
            let pin = ApmeSettings.loadMlxConfig().model
            if let pin = pin, resolved.contains(pin) {
                cachedMlxModels = [pin]
            } else if resolved.count > 1, let first = resolved.first {
                cachedMlxModels = [first]
            } else {
                cachedMlxModels = resolved
            }
        } else {
            mlxFailureCount += 1
            mlxNextInterval = min(mlxNextInterval * 2, Self.probeMaxInterval)
            // Keep last-known model list until we've seen N consecutive
            // failures; then clear so the UI reflects unavailability.
            if mlxFailureCount >= Self.probeStaleThreshold {
                cachedMlxModels = []
            }
        }

        if previous != cachedMlxModels {
            broadcastStateUpdate()
            broadcastUsage()
        }
    }

    // MARK: - Command Forwarding

    private func forwardCommandToSession(_ cmd: [String: Any]) {
        guard let session = cachedSessions.first(where: { $0.agentType == "claude-code" }) else { return }
        Task {
            let url = URL(string: "http://127.0.0.1:\(session.port)/command")!
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: cmd)
            request.timeoutInterval = 2
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    // MARK: - Shutdown

    func shutdown() async {
        DaemonLogger.shared.info("Daemon shutting down...")
        networkMonitor?.cancel()
        networkMonitor = nil
        networkDebounceTask?.cancel()
        sessionPollTask?.cancel(); usagePollTask?.cancel()
        ollamaPollTask?.cancel(); mlxPollTask?.cancel(); gatewayPollTask?.cancel()
        gatewayHealthTask?.cancel(); usageTickTask?.cancel()
        antigravityPollTask?.cancel()
        initialUsageTask?.cancel()

        voiceAssistant.stop()
        await focusRelay.stop()
        await timelineRelay.stop()
        await logStream.stop()
        await gatewayProbe.stop()
        await displayMonitor.stop()
        await moduleManager.stopAll()
        if let gw = gatewayAdapter { await gw.stop() }

        registry.deregister(sessionId)
        registry.removeDaemonInfo()

        await wsServer.stop()
        await httpServer.stop()

        DaemonLogger.shared.info("Daemon stopped")
    }

    // MARK: - Helpers

    private func sessionToDict(_ s: DaemonSessionEntry) -> [String: Any] {
        var d: [String: Any] = ["id": s.id, "port": s.port, "alive": true, "projectName": s.projectName]
        if let a = s.agentType { d["agentType"] = a }
        if let st = s.state { d["state"] = st }
        if let mn = s.modelName { d["modelName"] = mn }
        if let tool = s.currentTool { d["currentTool"] = tool }
        if let options = s.options {
            d["options"] = options.map { option in
                option.mapValues { $0.value }
            }
        }
        if let navigable = s.navigable, navigable { d["navigable"] = true }
        if let sa = s.startedAt { d["startedAt"] = sa }
        return d
    }

    // MARK: - APME eval result handling

    /// Called on the main actor when ApmeRunner finishes an eval job.
    /// Mirrors bridge/src/daemon-server.ts lines 902-974 — persists turn-level
    /// outcome/composite, broadcasts an `apme_eval` WS event, and appends a
    /// `★ eval_result` timeline entry so every viewer target surfaces the score.
    @MainActor
    private func handleApmeResult(_ result: ApmeEvalJobResult) {
        guard let store = apmeStore else { return }

        // Turn-level branch
        if let turnId = result.turnId {
            guard let run = store.getRun(id: result.runId) else { return }
            let turnEvals = store.listEvalsForTurn(turnId)
            guard let overall = turnEvals.first(where: { $0.metric == "overall" }) else { return }

            // Persist turn outcome + composite so category scorecards aggregate.
            store.updateTurn(id: turnId, fields: [
                "outcome": "committed",
                "compositeScore": overall.score,
            ])

            let pct = Int((overall.score * 100).rounded())
            let category = run.taskCategory ?? "?"

            // WS broadcast — turn eval
            broadcastApmeEval(
                run: run,
                evals: turnEvals,
                overallScore: overall.score,
                outcome: "committed",
                compositeScore: overall.score
            )

            // Timeline entry (★ eval_result) — rendered by every viewer target
            appendEvalResultTimeline(
                raw: "★ turn \(pct)% [\(category)]",
                detail: "Turn eval · \((run.taskPrompt ?? "").prefix(80))",
                agentType: run.agentType
            )
            return
        }

        // Run-level branch
        guard let run = store.getRun(id: result.runId) else { return }
        let evals = store.listEvalsForRun(result.runId)
        let overall = evals.first(where: { $0.layer == "llm_judge" && $0.metric == "overall" })?.score
            ?? result.overall

        broadcastApmeEval(
            run: run,
            evals: evals,
            overallScore: overall,
            outcome: run.outcome,
            compositeScore: run.compositeScore
        )

        let pctValue = overall ?? run.compositeScore ?? 0
        let pct = Int((pctValue * 100).rounded())
        let category = run.taskCategory ?? "?"
        let outcome = run.outcome ?? "pending"
        appendEvalResultTimeline(
            raw: "★ [\(category)] \(pct)% · \(outcome)",
            detail: "\(run.projectName ?? "") · \((run.taskPrompt ?? "").prefix(100))",
            agentType: run.agentType
        )
    }

    /// Build + broadcast an `apme_eval` WebSocket event. Matches the JSON
    /// shape of `ADApmeRunSummary` (codegen'd from shared protocol.ts) so
    /// every viewer target — Android, Stream Deck+, ESP32, iOS, TUI — decodes
    /// it with the same struct.
    @MainActor
    private func broadcastApmeEval(
        run: ApmeRun,
        evals: [ApmeEval],
        overallScore: Double?,
        outcome: String?,
        compositeScore: Double?
    ) {
        var runDict: [String: Any] = [
            "runId": run.id,
            "sessionId": run.sessionId,
            "agentType": run.agentType,
            "startedAt": run.startedAt,
            "evals": evals.map { e -> [String: Any] in
                var d: [String: Any] = [
                    "layer": e.layer,
                    "metric": e.metric,
                    "score": e.score,
                    "createdAt": e.createdAt,
                ]
                if let jm = e.judgeModel { d["judgeModel"] = jm }
                return d
            },
        ]
        if let v = run.modelId { runDict["modelId"] = v }
        if let v = run.projectName { runDict["projectName"] = v }
        if let v = run.taskPrompt { runDict["taskPrompt"] = v }
        if let v = run.taskCategory { runDict["taskCategory"] = v }
        if let v = outcome { runDict["outcome"] = v }
        if let v = compositeScore { runDict["compositeScore"] = v }
        if let v = overallScore { runDict["overallScore"] = v }
        if let v = run.endedAt { runDict["endedAt"] = v }
        if let v = run.inputTokens { runDict["inputTokens"] = v }
        if let v = run.outputTokens { runDict["outputTokens"] = v }
        if let v = run.costUsd { runDict["costUsd"] = v }
        if let v = run.exitCode { runDict["exitCode"] = v }

        let event: [String: Any] = [
            "type": "apme_eval",
            "run": runDict,
        ]
        broadcastRaw(event)
    }

    /// Append an `eval_result` entry to the daemon timeline. Uses the
    /// existing TimelineStore so downstream viewers pick it up through the
    /// same channel that renders every other timeline entry.
    @MainActor
    private func appendEvalResultTimeline(raw: String, detail: String, agentType: String) {
        let entry = DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: "eval_result",
            raw: raw,
            detail: detail,
            approvalId: nil,
            status: nil,
            agentType: agentType,
            repeatCount: nil,
            automated: nil
        )
        Task { await timelineStore.add(entry) }
    }

    @MainActor
    private func appendGatewayTimelineEntry(_ rawEntry: [String: Any]) {
        let entry = DaemonTimelineEntry(
            ts: (rawEntry["ts"] as? NSNumber)?.doubleValue ?? rawEntry["ts"] as? Double ?? Date().timeIntervalSince1970 * 1000,
            type: rawEntry["type"] as? String ?? "event",
            raw: rawEntry["raw"] as? String ?? "",
            detail: rawEntry["detail"] as? String,
            approvalId: rawEntry["approvalId"] as? String,
            status: rawEntry["status"] as? String,
            agentType: rawEntry["agentType"] as? String ?? "openclaw",
            repeatCount: rawEntry["repeatCount"] as? Int,
            automated: rawEntry["automated"] as? Bool
        )
        Task { await timelineStore.add(entry) }
        broadcastRaw(["type": "timeline_event", "entry": rawEntry] as [String: Any])
    }

    // MARK: - APME eval tick (30s loop)

    /// Runs once every 30s. Mirrors bridge/src/daemon-server.ts:951-990.
    @MainActor
    private func apmeEvalTick() async {
        guard let store = apmeStore, let runner = apmeRunner else { return }

        // 1. Enqueue unevaluated runs (run-level layer-2 judge).
        let pending = store.listUnevaluatedRuns(limit: 5)
        for p in pending {
            runner.enqueue(runId: p.id)
        }

        // 2. Outcome detection on closed runs that don't have an outcome yet.
        //    Wait at least 10s after close so A/B + iteration windows resolve.
        let closedRuns = store.listRuns(limit: 20)
        let now = Int(Date().timeIntervalSince1970 * 1000)
        for r in closedRuns {
            guard let ended = r.endedAt, r.outcome == nil else { continue }
            if now - ended > 10_000 {
                ApmeOutcomeEngine.evaluateOutcome(store: store, runId: r.id)
            }
        }

        // 3. Re-classify runs the session bridge didn't finish classifying.
        //    Phase 2: uses classifyRunSmart — rules first, LLM fallback when
        //    rules return .unknown. Default backend is on-device Foundation
        //    Models so the LLM path is free and cost-safe.
        let unclassified = store.listUnclassifiedRuns(limit: 5)
        for r in unclassified {
            let result = await ApmeClassifier.classifyRunSmart(store: store, runId: r.id)
            if result.category != .unknown {
                if let data = try? JSONEncoder().encode(result.signals),
                   let json = String(data: data, encoding: .utf8) {
                    store.updateRun(id: r.id, fields: [
                        "taskSignals": json,
                        "taskCategory": result.category.rawValue,
                        "taskCategorySource": result.source,
                    ])
                }
            }
        }

        // 4. Backfill turn outcome for code-category turns that never went
        //    through turn_judge. Keeps v_category_scorecard populated even
        //    when no judge ran on the turn.
        let needOutcome = store.listTurnsNeedingOutcome(limit: 20)
        for t in needOutcome {
            let evs = store.listEvalsForTurn(t.id)
            let overall = evs.first(where: { $0.layer == "turn_judge" && $0.metric == "overall" })
            var fields: [String: Any?] = ["outcome": "committed"]
            if let o = overall { fields["compositeScore"] = o.score }
            store.updateTurn(id: t.id, fields: fields)
        }

        // 5. Clean up orphaned runs — started long ago, never closed.
        let orphans = store.listOrphanedRuns(staleSec: 1800)
        for id in orphans {
            store.updateRun(id: id, fields: [
                "endedAt": now,
                "taskCategory": "_empty",
            ])
        }

        // 6. Rubric auto-tuning (Phase 2). Gated by `shouldRetune` which
        //    only fires when there are ≥10 disagreement samples and the
        //    current rubric correlates poorly (<0.4) with user vibe. That
        //    means we tune roughly once per week in normal use — cheap
        //    enough even on paid backends, free on FM/MLX.
        if ApmeTuner.shouldRetune(store: store) {
            let outcome = await ApmeTuner.tune(store: store)
            DaemonLogger.shared.debug(
                "APME",
                "tuner: accepted=\(outcome.accepted) reason=\(outcome.reason) new_version=\(outcome.newVersion.map { String($0) } ?? "n/a")"
            )
        }
    }
}

// MARK: - Errors

enum DaemonError: Error {
    case alreadyRunning(port: Int)
    case noPortAvailable
}

struct SendableDict: @unchecked Sendable {
    let value: [String: Any]
    init(_ value: [String: Any]) { self.value = value }
}

extension [String: Any] {
    var jsonData: Data? {
        try? JSONSerialization.data(withJSONObject: self)
    }
}

// MARK: - PNG helpers

private extension Data {
    mutating func appendBE32(_ value: UInt32) {
        append(UInt8((value >> 24) & 0xFF))
        append(UInt8((value >> 16) & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8(value & 0xFF))
    }

    mutating func appendPNGChunk(type: [UInt8], data: Data) {
        appendBE32(UInt32(data.count))
        append(contentsOf: type)
        append(data)
        // CRC32 over type + data
        var crcData = Data(type)
        crcData.append(data)
        appendBE32(crc32(crcData))
    }
}

private func crc32(_ data: Data) -> UInt32 {
    var crc: UInt32 = 0xFFFFFFFF
    data.withUnsafeBytes { buffer in
        guard let bytes = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
        for i in 0..<data.count {
            let idx = Int((crc ^ UInt32(bytes[i])) & 0xFF)
            crc = crc32Table[idx] ^ (crc >> 8)
        }
    }
    return crc ^ 0xFFFFFFFF
}

private let crc32Table: [UInt32] = {
    var table = [UInt32](repeating: 0, count: 256)
    for i in 0..<256 {
        var c = UInt32(i)
        for _ in 0..<8 {
            if c & 1 != 0 {
                c = 0xEDB88320 ^ (c >> 1)
            } else {
                c = c >> 1
            }
        }
        table[i] = c
    }
    return table
}()
#endif
