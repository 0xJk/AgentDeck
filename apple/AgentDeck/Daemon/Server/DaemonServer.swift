#if os(macOS)
// DaemonServer.swift — Main daemon orchestrator
// Ported from bridge/src/daemon-server.ts — FULL wiring of all modules

import Foundation
import Network

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
    private var cachedGatewayAvailable = false
    private var cachedPairingUrl: String?
    private var lastStateEvent: [String: Any]?
    private var cachedApiUsage: ApiUsageData?
    private var lastApiFetchTime: Date = .distantPast
    private var apiUsageStale = false
    private var oauthConnected = false

    // Polling tasks
    private var sessionPollTask: Task<Void, Never>?
    private var usagePollTask: Task<Void, Never>?
    private var ollamaPollTask: Task<Void, Never>?
    private var gatewayPollTask: Task<Void, Never>?
    private var gatewayHealthTask: Task<Void, Never>?
    private var usageTickTask: Task<Void, Never>?
    private var initialUsageTask: Task<Void, Never>?

    // MARK: - Init

    init(port: Int?, debug: Bool) async throws {
        self.timelineRelay = TimelineRelay(selfPort: port ?? SessionRegistry.defaultPort)
        self.focusRelay = SessionFocusRelay()

        let requestedPort = port ?? SessionRegistry.defaultPort
        var resolvedPort = UInt16(requestedPort)

        // Singleton guard — only when using default port
        if port == nil {
            if let existing = registry.readDaemonInfo() {
                DaemonLogger.shared.info("Daemon already running on port \(existing.port) (PID \(existing.pid))")
                throw DaemonError.alreadyRunning
            }
            if let existing = registry.findExistingDaemon() {
                DaemonLogger.shared.info("Daemon already running on port \(existing.port)")
                throw DaemonError.alreadyRunning
            }
            if let health = await registry.probeDaemonHealth(port: requestedPort) {
                if health["mode"] as? String == "daemon" {
                    throw DaemonError.alreadyRunning
                }
                if let alt = await registry.findAvailablePort() {
                    resolvedPort = UInt16(alt)
                } else {
                    throw DaemonError.noPortAvailable
                }
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
            self.broadcastRaw([
                "type": "voice_assistant_state",
                "state": state.rawValue,
                "deviceId": "mac-builtin",
                "text": text as Any,
                "responseText": responseText as Any,
            ])
        }
        _ = voiceAssistant.start()

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
        // nonisolated(unsafe) on ESP32Serial side allows MainActor closures to cross actor boundary
        serial.serial.setStateProviderFn { [weak self] in
            MainActor.assumeIsolated { self?.lastStateEvent }
        }
        serial.serial.setUsageProviderFn { [weak self] in
            MainActor.assumeIsolated { self?.buildUsageEvent() }
        }
        serial.serial.setInitialStateProviderFn { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return [] }
                var events: [[String: Any]] = []
                if let state = self.lastStateEvent { events.append(state) }
                if let usage = self.buildUsageEvent() { events.append(usage) }
                return events
            }
        }

        // Pixoo
        let pixoo = PixooModule()
        self.pixooModule = pixoo
        moduleManager.register(pixoo)

        // Start all
        await moduleManager.startAll()

        // Wire serial broadcast hook
        let serialRef = serial
        let pixooRef = pixoo
        let d200hRef = d200h
        await wsServer.onBroadcast { data in
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
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
            let state = await MainActor.run { self?.stateMachine.state.rawValue ?? "disconnected" }
            return .json([
                "status": "ok", "mode": "daemon", "port": daemonPort,
                "pid": ProcessInfo.processInfo.processIdentifier,
                "uptime": ProcessInfo.processInfo.systemUptime,
                "state": state,
                "pairingToken": AuthManager.shared.token,
            ] as [String: Any])
        }

        await httpServer.get("/status") { _ in
            let sessions = SessionRegistry.shared.listActive()
            let list = sessions.map { ["id": $0.id, "port": $0.port, "projectName": $0.projectName, "agentType": $0.agentType as Any] as [String: Any] }
            return .json(["sessions": list, "daemon": ["port": daemonPort]] as [String: Any])
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
        await httpServer.get("/pixoo/frame") { _ in
            // Return last rendered frame as BMP (stub — returns empty)
            .text("No frame available", status: 204)
        }

        await httpServer.get("/pixoo/stream") { _ in
            // SSE frame stream (stub — requires full renderer)
            .text("event: frame\ndata: \n\n")
        }

        await httpServer.get("/pixoo") { _ in
            let html = """
            <html><body style="background:#000;display:flex;justify-content:center;align-items:center;height:100vh">
            <div><h2 style="color:#fff">Pixoo Preview</h2>
            <img id="f" width="256" height="256" style="image-rendering:pixelated">
            <script>const es=new EventSource('/pixoo/stream');
            es.addEventListener('frame',e=>{document.getElementById('f').src='data:image/bmp;base64,'+e.data});</script>
            </div></body></html>
            """
            return HTTPServer.HTTPResponse(status: 200, headers: ["Content-Type": "text/html"], body: Data(html.utf8))
        }
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
            if type != "switch_agent" && type != "query_usage" && type != "focus_session" { return }
        }

        switch type {
        case "focus_session":
            if let sessionId = cmd["sessionId"] as? String {
                Task { await focusRelay.focus(sessionId: sessionId) }
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
            Task { await fetchUsageRelayed() }
        case "switch_agent":
            Task { await focusRelay.unfocus() }
            handleSwitchAgent(cmd["agent"] as? String ?? "")
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
        let gwAlive = gatewayAdapter != nil
        let event = buildFullStateEvent(agentType: gwAlive ? "openclaw" : "daemon")
        lastStateEvent = event
        broadcastRaw(event)
        broadcastSessionsList()
        broadcastUsage()
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
                        self?.broadcastSessionsList()
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
    }

    @MainActor
    private func handleGatewayEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "gateway_chat":
            _ = stateMachine.transition(trigger: "spinner_start", source: .pty)
            broadcastStateUpdate()
        case "gateway_approval":
            _ = stateMachine.transition(trigger: "permission_prompt", source: .pty)
            if let payload = event["payload"] as? [String: Any] {
                stateMachine.question = payload["message"] as? String
            }
            broadcastStateUpdate()
        case "gateway_presence":
            break // Heartbeat
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
        let existingNames = Set(cachedModelCatalog.compactMap { $0["name"] as? String })
        for m in models {
            if let name = m["name"] as? String, !existingNames.contains(name) {
                cachedModelCatalog.append(m)
            }
        }
    }

    // MARK: - Polling

    private func startAllPolling() {
        // Sessions — 10s
        sessionPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard let self else { break }
                await self.refreshSessions()
            }
        }

        // Usage — 60s
        usagePollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard let self, await self.wsServer.clientCount > 0 else { continue }
                await self.fetchUsageRelayed()
            }
        }

        // Ollama — 5s
        ollamaPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, await self.wsServer.clientCount > 0 else { continue }
                await self.probeOllama()
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

        // Usage tick — 5s (for session duration display)
        usageTickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, await self.wsServer.clientCount > 0 else { continue }
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

        // Tier 1: HTTP relay from sibling
        for sibling in sessions {
            if let usage = await fetchUsageViaHTTP(port: sibling.port) {
                cachedApiUsage = nil // raw dict cached separately
                broadcastRaw(usage)
                lastApiFetchTime = Date()
                apiUsageStale = false
                return
            }
        }

        // Tier 2: WS relay from sibling
        // (simplified — uses HTTP since WS relay adds complexity)

        // Tier 3: Direct API (only if no siblings)
        if sessions.isEmpty {
            if let usage = await usageAPI.fetchUsage() {
                cachedApiUsage = usage
                lastApiFetchTime = Date()
                apiUsageStale = false
                oauthConnected = true
                broadcastUsage()
            } else {
                oauthConnected = usageAPI.hasOAuthToken()
                if cachedApiUsage != nil { apiUsageStale = true }
            }
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
            usage["type"] = "usage_update"
            return usage
        } catch { return nil }
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
        if !cachedModelCatalog.isEmpty { e["modelCatalog"] = cachedModelCatalog }
        if let o = cachedOllamaStatus { e["ollamaStatus"] = o }
        if cachedGatewayAvailable { e["gatewayAvailable"] = true }
        if cachedGatewayHasError { e["gatewayHasError"] = true }
        if let url = cachedPairingUrl { e["pairingUrl"] = url }
        if let r = stateMachine.remoteUrl { e["remoteUrl"] = r }
        if oauthConnected { e["oauthConnected"] = true }
        return e
    }

    private func buildUsageEvent() -> [String: Any]? {
        guard let u = cachedApiUsage else { return nil }
        var e: [String: Any] = ["type": "usage_update"]
        if let v = u.fiveHourPercent { e["fiveHourPercent"] = v }
        if let v = u.fiveHourResetsAt { e["fiveHourResetsAt"] = v }
        if let v = u.sevenDayPercent { e["sevenDayPercent"] = v }
        if let v = u.sevenDayResetsAt { e["sevenDayResetsAt"] = v }
        e["extraUsageEnabled"] = u.extraUsageEnabled
        if let v = u.extraUsageMonthlyLimit { e["extraUsageMonthlyLimit"] = v }
        if let v = u.extraUsageUsedCredits { e["extraUsageUsedCredits"] = v }
        if let v = u.extraUsageUtilization { e["extraUsageUtilization"] = v }
        if oauthConnected { e["oauthConnected"] = true }
        if apiUsageStale { e["usageStale"] = true }
        return e
    }

    // MARK: - Ollama

    @MainActor
    private func probeOllama() async {
        let url = URL(string: "http://127.0.0.1:11434/api/tags")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let models = json["models"] as? [[String: Any]] {
                cachedOllamaStatus = [
                    "available": true,
                    "models": models.map { ["name": $0["name"] ?? "", "size": $0["size"] ?? 0, "sizeVram": 0] }
                ]
            }
        } catch {
            cachedOllamaStatus = ["available": false, "models": [] as [Any]]
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
        sessionPollTask?.cancel(); usagePollTask?.cancel()
        ollamaPollTask?.cancel(); gatewayPollTask?.cancel()
        gatewayHealthTask?.cancel(); usageTickTask?.cancel()
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
        return d
    }
}

// MARK: - Errors

enum DaemonError: Error {
    case alreadyRunning
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
