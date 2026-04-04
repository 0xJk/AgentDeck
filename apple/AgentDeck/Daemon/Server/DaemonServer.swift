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

    // Gateway
    private var gatewayAdapter: OpenClawAdapter?
    private var gatewayConnecting = false
    private var cachedGatewayHasError = false

    // State caches
    private var cachedSessions: [DaemonSessionEntry] = []
    private var cachedModelCatalog: [[String: Any]] = []
    private var cachedOllamaStatus: [String: Any]?
    private var cachedMlxModels: [String] = []
    private var preferredMlxModelsEndpoint: String?
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
                DaemonLogger.shared.info("Port \(requestedPort) is occupied but health probe is not ready yet; treating as startup race")
                throw DaemonError.alreadyRunning(port: requestedPort)
            }
        }

        self.port = resolvedPort
        self.cachedPairingUrl = auth.getWsUrl(port: Int(resolvedPort))
    }

    // MARK: - Start (non-blocking)

    func startServices() async {
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

        do {
            try await wsServer.start(port: port)
        } catch {
            DaemonLogger.shared.error("Failed to start server: \(error)")
            return
        }

        // 2. Register session
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
                self?.cachedDisplayOn = displayOn
                self?.broadcastRaw(["type": "display_state", "displayOn": displayOn] as [String: Any])
            }
        }

        // 7. Start device modules
        await startDeviceModules()

        // 8. Start timeline relay (subscribes to sibling WS)
        await timelineRelay.setEventHandler { [weak self] event in
            let box = SendableDict(event)
            Task { @MainActor in
                self?.handleRelayedEvent(box.value)
            }
        }
        await timelineRelay.start()

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
                    if event["ollamaStatus"] == nil, let cached = self.cachedOllamaStatus {
                        event["ollamaStatus"] = cached
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

        // 9. Start polling
        startAllPolling()

        // 10. Initial delayed usage fetch
        initialUsageTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            await self?.fetchUsageRelayed()
        }

        // 11. Auto-install Claude Code hooks
        HookInstaller.installIfNeeded()

        // 12. Voice assistant
        voiceAssistant.sendPrompt = { [weak self] text in
            guard let self else { return }
            // Route to gateway or session bridge
            if let gw = self.gatewayAdapter {
                Task { await gw.sendRPC(method: "chat.send", params: ["message": text]) }
                _ = self.stateMachine.transition(trigger: "user_prompt_submit", source: .hook)
                self.broadcastStateUpdate()
            } else {
                self.forwardCommandToSession(["type": "send_prompt", "text": text])
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
                        } else {
                            DaemonLogger.shared.info("Network path update (IP unchanged: \(newIP ?? "none"))")
                        }
                        // Re-advertise Bonjour with current IP
                        await self.wsServer.republishBonjour()
                        // Wake device modules (reconnect ESP32, Pixoo, etc.)
                        await self.moduleManager.wakeAll()
                        // Re-sync timeline relay (drop dead subscriptions)
                        await self.timelineRelay.sync()
                        // Broadcast fresh state to all reconnected clients
                        self.broadcastStateUpdate()
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

        // Seed initial state so serial heartbeat has data from the start
        // (without this, lastStateEvent is nil until first WS client or hook event)
        let gwAlive = gatewayAdapter != nil
        lastStateEvent = buildFullStateEvent(agentType: gwAlive ? "openclaw" : "daemon")

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

        await httpServer.get("/sse") { _ in
            .text("event: connected\ndata: {}\n\n")
        }

        // Pixoo endpoints
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
    private func buildDiagPayload(tail: Int) async -> SendableDict {
        let modules = await buildModuleHealth().value["modules"] as? [String: Any] ?? [:]
        let recentLog = DaemonLogger.shared.recentLines(limit: tail)
        return SendableDict([
            "status": "ok",
            "state": stateMachine.state.rawValue,
            "sessionId": sessionId,
            "gatewayConnected": gatewayAdapter != nil,
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

        let gwAlive = gatewayAdapter != nil
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
            let modeCmd = SendableDict(["type": "switch_mode"])
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
        if target == "openclaw", gatewayAdapter != nil {
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
        broadcastStateUpdate()
    }

    // MARK: - State Changed (cascade)

    @MainActor
    private func handleStateChanged() {
        let currentState = stateMachine.state
        let gwAlive = gatewayAdapter != nil
        let event = buildFullStateEvent(agentType: gwAlive ? "openclaw" : "daemon")
        lastStateEvent = event
        broadcastRaw(event)
        broadcastSessionsList()
        broadcastUsage()

        // Voice assistant: reset timeout on any activity during processing
        if currentState == .processing && voiceAssistant.state == .processing {
            voiceAssistant.resetResponseTimeout()
        }

        // Voice assistant: PROCESSING→IDLE triggers TTS response
        let wasProcessing = previousDaemonState == .processing
        previousDaemonState = currentState
        if wasProcessing && currentState == .idle && voiceAssistant.state == .processing {
            Task {
                let lastEntry = await timelineStore.getLastEntry(type: "chat_end")
                let responseText = (lastEntry?.detail ?? lastEntry?.raw) ?? ""
                voiceAssistant.handleResponse(responseText.isEmpty ? "완료했습니다." : responseText)
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
                        DaemonLogger.shared.info("OpenClaw Gateway connected")
                        await self?.logStream.start()
                        if self?.stateMachine.state == .disconnected {
                            _ = self?.stateMachine.transition(trigger: "session_start", source: .hook)
                        }
                        self?.handleStateChanged()
                    } else {
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
        cachedModelCatalog = []
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
                cachedModelCatalog = models
                DaemonLogger.shared.debug("Daemon", "Model catalog from Gateway: \(models.count) models")
                if stateMachine.modelName == nil, let defaultModel = event["defaultModel"] as? String {
                    stateMachine.modelName = defaultModel
                }
                broadcastStateUpdate()
                broadcastUsage()
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
                mergeModelCatalog(catalog)
            }
        default:
            break
        }
    }

    private func mergeModelCatalog(_ models: [[String: Any]]) {
        let existingKeys = Set(cachedModelCatalog.compactMap { $0["key"] as? String })
        var merged = cachedModelCatalog
        for m in models {
            if let key = m["key"] as? String, !existingKeys.contains(key) {
                merged.append(m)
            }
        }
        if merged.count != cachedModelCatalog.count {
            cachedModelCatalog = merged
            DaemonLogger.shared.debug("Daemon", "Model catalog merged: \(merged.count) models total")
            broadcastStateUpdate()
            broadcastUsage()
        }
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

        // Ollama — 5s
        ollamaPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, await self.wsServer.hasClients() else { continue }
                await self.probeOllama()
            }
        }

        // MLX — 5s
        mlxPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
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
                let hasError = await self.gatewayProbe.hasError
                if hasError != self.cachedGatewayHasError {
                    self.cachedGatewayHasError = hasError
                    self.broadcastStateUpdate()
                }
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
        let sessions = registry.listActive().filter { $0.id != sessionId }
        cachedSessions = await enrichSessionsWithState(sessions)
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
            if !sessions.contains(where: { ($0["agentType"] as? String) == "openclaw" }) {
                sessions.append([
                    "id": "openclaw-gateway", "port": 18789,
                    "projectName": "OpenClaw", "agentType": "openclaw",
                    "alive": true, "state": gatewayAdapter != nil ? stateMachine.state.rawValue : "idle",
                ] as [String: Any])
            }
        }
        return ["type": "sessions_list", "sessions": sessions]
    }

    // MARK: - Usage (3-tier relay)

    @MainActor
    private func fetchUsageRelayed() async {
        let sessions = registry.listActive().filter { $0.agentType != "daemon" && $0.id != sessionId }
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
            if cachedApiUsage != nil { apiUsageStale = true }
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
            if cachedApiUsage != nil { apiUsageStale = true }
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
        let gwAlive = gatewayAdapter != nil
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

    @MainActor
    private func buildModuleHealth() async -> SendableDict {
        let gwConnected: Bool
        if let gw = gatewayAdapter {
            gwConnected = await gw.isConnectedSnapshot
        } else {
            gwConnected = false
        }
        var modules: [String: Any] = [
            "gateway": [
                "available": cachedGatewayAvailable,
                "connected": gwConnected,
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
        if cachedGatewayAvailable { e["gatewayAvailable"] = true }
        if cachedGatewayHasError { e["gatewayHasError"] = true }
        if let url = cachedPairingUrl { e["pairingUrl"] = url }
        if let r = stateMachine.remoteUrl { e["remoteUrl"] = r }
        if oauthConnected { e["oauthConnected"] = true }
        // Voice assistant state (piggyback on state_update for all clients)
        if cachedVoiceAssistantState != "disabled" {
            e["voiceAssistantState"] = cachedVoiceAssistantState
            e["voiceAssistantText"] = cachedVoiceAssistantText as Any
            e["voiceAssistantResponseText"] = cachedVoiceAssistantResponseText as Any
        }
        return e
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

        // If usage is very high (>90%), keep it 'sticky' for 5 minutes after reset
        // to account for server propagation delay/clock skew.
        if percent > 0.90 {
            if elapsed < 300 { // 5 minutes
                return percent
            }
        } else {
            // For lower usage, a 60s buffer is enough
            if elapsed < 60 {
                return percent
            }
        }

        // Only reset to 0 after safe buffer
        return 0
    }

    // MARK: - Ollama

    @MainActor
    private func probeOllama() async {
        let previous = cachedOllamaStatus as NSDictionary?
        do {
            guard let psUrl = URL(string: "http://127.0.0.1:11434/api/ps") else { return }
            var request = URLRequest(url: psUrl)
            request.timeoutInterval = 2
            let (data, _) = try await URLSession.shared.data(for: request)
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
            }
        } catch {
            cachedOllamaStatus = ["available": false, "models": [] as [Any]]
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
        let candidates = Array(Set(([preferredMlxModelsEndpoint].compactMap { $0 }) + fallbackCandidates))
        var resolved: [String] = []

        for endpoint in candidates {
            guard let url = URL(string: endpoint) else { continue }
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 2
                let (data, response) = try await URLSession.shared.data(for: request)
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
                    break
                }
            } catch {
                continue
            }
        }
        cachedMlxModels = resolved
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
        if let sa = s.startedAt { d["startedAt"] = sa }
        return d
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
#endif
