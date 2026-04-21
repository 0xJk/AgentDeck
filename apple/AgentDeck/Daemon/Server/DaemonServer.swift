#if os(macOS)
// DaemonServer.swift — Main daemon orchestrator
// Ported from bridge/src/daemon-server.ts — FULL wiring of all modules
//
// Runs in two modes:
//   1. In-process (no CLI present) — owns port 9120, serves pairing/device
//      I/O to iPads, Pixoo, ESP32, D200H. Session count is effectively zero
//      because the Swift daemon does not spawn PTYs (see DaemonService.swift
//      header for the role split).
//   2. External-proxy (CLI is running) — the CLI binds 9120 first; this
//      DaemonServer never starts. DaemonService instead transitions to
//      `isUsingExternalDaemon = true` and the Swift app becomes a WS client
//      of the CLI daemon. Hardware rows are shown only from the external
//      daemon's `state_update.moduleHealth` payload.
//
// Gateway flags (`gatewayAvailable`, `gatewayConnected`, `gatewayHasError`)
// on broadcast events mean:
//   - gatewayAvailable: OpenClaw process reachable on localhost:18789.
//                       Drives topology row visibility.
//   - gatewayConnected: OpenClaw Gateway authenticated (shared token
//                       accepted). Drives crayfish creature rendering
//                       across Mac UI, Android, ESP32 firmware, Pixoo64.
//   - gatewayHasError:  Auth attempt failed or protocol error — surfaces
//                       SICK crayfish + error row in topology.

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
    private var apmeCollector: ApmeCollector?        // Claude Code hooks
    private var apmeCollectorGateway: ApmeCollector? // OpenClaw gateway (separate to avoid activeHookSession collision)
    private var apmeRunner: ApmeRunner?
    private var apmeEvalTimerTask: Task<Void, Never>?

    // Gateway
    private var gatewayAdapter: OpenClawAdapter?
    private var gatewayConnecting = false
    private var cachedGatewayHasError = false
    private var cachedGatewayConnected = false
    /// Consecutive probe failures before committing to "unavailable".
    /// Requires 2 consecutive misses (≈10s) before triggering disconnect
    /// so transient glitches don't flash "Not configured" in the UI.
    private var gatewayProbeFailCount = 0
    private static let gatewayProbeDisconnectThreshold = 2
    private var cachedGatewayAuthStatus: String = "gateway_not_found"
    private var cachedGatewayAuthRequestId: String?
    private var cachedGatewayAuthMessage: String?
    /// Locally-generated Gateway identity (Ed25519 public-key SHA-256 hex).
    /// Surfaced in state_update so dashboards can render "approve this
    /// deviceId in OpenClaw Web UI" when pairing is still pending.
    private var cachedGatewayDeviceId: String?

    // Gateway session state — updated ONLY from OpenClaw adapter events.
    // Never written by Claude Code hook events so the two don't cross-contaminate.
    // The shared `stateMachine` tracks Claude Code / hook-driven sessions only.
    private var gatewaySessionState: String = "idle"
    private var gatewayCurrentTool: String? = nil
    private var gatewayModelName: String? = nil

    // State caches
    private var cachedSessions: [DaemonSessionEntry] = []

    /// Sessions advertised over WS via `session_push_register` from CLI
    /// session bridges. Kept separate from `cachedSessions` so that
    /// `refreshSessions()` — which sources entries from the filesystem
    /// registry — can merge both without clobbering push-based registrations.
    ///
    /// Why this exists: the App Store Swift daemon and the Node CLI use
    /// different data dirs (group container vs `~/.agentdeck`) and the
    /// sandbox blocks Swift from reading `~/.agentdeck/sessions.json`. CLI
    /// session bridges therefore can't be discovered via filesystem — they
    /// register themselves over the daemon WS. Without this map the Swift
    /// daemon stays at 0 sessions even when `agentdeck claude` is running,
    /// which shows up as empty `sessions_list` broadcasts and blank
    /// terrariums on every surface.
    private var pushedSessionsById: [String: DaemonSessionEntry] = [:]

    /// Last hook-event wall-clock timestamp per pushed session, keyed on
    /// sessionId. Used to evict sessions whose Claude Code process died
    /// without delivering a `session_end` hook — Claude Code's Stop/End
    /// hooks are ~18% reliable, so without a TTL sweep the sessions list
    /// accumulates ghost entries whose creatures keep swimming (or
    /// "floating") indefinitely. A fresh hook from the same sessionId
    /// resurrects the entry; see `handleHookEvent` and `evictStaleHookSessions`.
    private var lastHookAtByPushedSession: [String: Date] = [:]

    /// TTL for hook-driven pushed sessions. 3 minutes balances tolerating
    /// long "user is thinking" pauses against clearing ghost entries within
    /// the same coffee break. When a hook arrives after this window, the
    /// `session_start` synthesis path will recreate the entry.
    private static let pushedSessionStaleTTL: TimeInterval = 180

    /// Session id of the most recent hook event that carried one. Used to
    /// stamp state_update broadcasts so dashboard clients can attribute
    /// timeline entries + primary-creature state to the right session
    /// when multiple claude sessions are running concurrently.
    private var currentHookSessionId: String?
    private var cachedModelCatalog: [[String: Any]] = []
    private var cachedOllamaStatus: [String: Any]?
    /// Cached serial module snapshot — `buildModuleHealthSync` can't
    /// `await` SerialModule.statusSnapshot() (the module is async because
    /// ESP32Serial is an actor), so we pre-fetch into this cache via a
    /// 5s poll. Without this, every state_update arrived with
    /// `serial: {available: true}` and no `connections` array, hiding
    /// every ESP32 board from the Dashboard USB serial section even
    /// though `/health` HTTP showed them correctly via the async path.
    private var cachedSerialStatus: [String: Any]?

    /// Stream Deck plugin self-registration. The Elgato plugin sends a
    /// `client_register` WS command right after connect with the physical
    /// devices it sees — we cache that here so the Dashboard's Downstream
    /// rail can render a Stream Deck row without having to duplicate
    /// Elgato's device enumeration. Stamped with `updatedAt` so a TTL
    /// sweep (`evictStaleHookSessions`) can expire the cache when the
    /// plugin quits without a clean disconnect.
    private struct StreamDeckRegistration {
        var devices: [[String: Any]]
        var updatedAt: Date
    }
    private var cachedStreamDeck: StreamDeckRegistration?
    private static let streamDeckStaleTTL: TimeInterval = 120
    private var cachedMlxModels: [String] = []
    private var cachedMlxModelCatalog: [String] = []
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

    // Anthropic Admin API (Console) usage — independent from subscription
    // OAuth path above. User pastes an admin API key in Settings and the
    // daemon polls `/v1/organizations/usage_report/messages` for today +
    // last 30 days. Cache 10 min TTL, identical stale semantics.
    private var cachedAdminApiUsage: AnthropicAdminUsage?
    private var lastAdminApiFetchTime: Date = .distantPast
    private var adminApiPollTask: Task<Void, Never>?
    private static let adminApiPollInterval: TimeInterval = 600  // 10 minutes
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
            let gatewayCollector = ApmeCollector(store: store)
            apmeCollectorGateway = gatewayCollector
            // Runner wraps the judge pipeline. In Phase 1 the only backend
            // is Apple Foundation Models (on-device, zero-config). If it's
            // unavailable (Intel Mac, Apple Intelligence off), turn_judge
            // evals silently skip — collector still records everything.
            let runner = ApmeRunner(store: store)
            apmeRunner = runner
            collector.runner = runner
            gatewayCollector.runner = runner

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
                        event["mlxModelCatalog"] = self.cachedMlxModelCatalog
                    } else {
                        event.removeValue(forKey: "mlxModels")
                        event.removeValue(forKey: "mlxModelCatalog")
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
            // PixooModule is an actor — hop onto its executor via a Task.
            // Box `json` through SendableDict so the Task closure doesn't
            // capture a non-Sendable `[String: Any]`. Broadcast ordering
            // matches Task launch order because the actor serializes
            // incoming calls.
            let pixooEventBox = SendableDict(json)
            Task { await pixooRef.handleEvent(pixooEventBox.value) }
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
                        Task {
                            let sent = await self.serialModule?.serial.sendWifiProvisionToAll(provisionMsg.value) ?? 0
                            if sent > 0 {
                                DaemonLogger.shared.info("WiFi provision sent to \(sent) ESP32 connection(s); trigger port \(portPath)")
                            }
                        }
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
            // Surface focused session's model + effort on /health so sibling
            // bridges and external dashboards can mirror them without a
            // separate state_update subscription.
            let focus: (model: String?, effort: String?) = await MainActor.run { [weak self] in
                (self?.stateMachine.modelName, self?.stateMachine.effortLevel)
            }
            var payload: [String: Any] = [
                "status": "ok", "mode": "daemon", "port": daemonPort,
                "pid": ProcessInfo.processInfo.processIdentifier,
                "uptime": ProcessInfo.processInfo.systemUptime,
                "state": state,
                "pairingToken": AuthManager.shared.token,
                "modules": health["modules"] as Any,
            ]
            if let m = focus.model { payload["modelName"] = m }
            if let e = focus.effort { payload["effortLevel"] = e }
            return .json(payload)
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

    // MARK: - Session push (from CLI session bridges via WS)

    /// Register a CLI session bridge's advertised identity. The session
    /// bridge lives outside the sandbox (Node process, `~/.agentdeck` world)
    /// and the sandbox blocks the Swift daemon from reading its sessions.json;
    /// this WS-pushed registration is the sole discovery path. Duplicate
    /// registrations for the same `sessionId` just update the existing entry
    /// (idempotent — session bridges re-register on WS reconnect).
    @MainActor
    private func handleSessionPushRegister(_ cmd: [String: Any]) {
        guard let sessionId = cmd["sessionId"] as? String,
              let port = cmd["port"] as? Int else {
            DaemonLogger.shared.debug("Daemon", "session_push_register missing sessionId or port: \(cmd)")
            return
        }
        let agentType = cmd["agentType"] as? String
        let projectName = cmd["projectName"] as? String ?? ""
        var entry = pushedSessionsById[sessionId] ?? DaemonSessionEntry(
            id: sessionId,
            port: port,
            pid: 0, // CLI does not send pid; liveness is inferred from /health probes
            projectName: projectName,
            agentType: agentType,
            tmuxSession: nil,
            tty: nil,
            parentTty: nil,
            startedAt: nil
        )
        // Update mutable fields on re-register (port drift, agent type change).
        if entry.port != port || entry.agentType != agentType || entry.projectName != projectName {
            entry = DaemonSessionEntry(
                id: sessionId,
                port: port,
                pid: 0,
                projectName: projectName,
                agentType: agentType,
                tmuxSession: entry.tmuxSession,
                tty: entry.tty,
                parentTty: entry.parentTty,
                startedAt: entry.startedAt
            )
        }
        pushedSessionsById[sessionId] = entry
        DaemonLogger.shared.debug("Daemon", "session_push_register: \(sessionId) port=\(port) agent=\(agentType ?? "?")")

        // Merge into cachedSessions immediately so the next sessions_list
        // broadcast reflects the new session without waiting for a probe tick.
        upsertIntoCachedSessions(entry)
        broadcastSessionsList()
    }

    /// Update state/modelName for a previously-registered push session.
    /// Silently ignored when the sessionId isn't known — session bridges
    /// race the initial register vs first state event and push_state may
    /// arrive before the first register.
    @MainActor
    private func handleSessionPushState(_ cmd: [String: Any]) {
        guard let sessionId = cmd["sessionId"] as? String else { return }
        guard var entry = pushedSessionsById[sessionId] else {
            DaemonLogger.shared.debug("Daemon", "session_push_state: unknown sessionId \(sessionId)")
            return
        }
        if let state = cmd["state"] as? String { entry.state = state }
        if let modelName = cmd["modelName"] as? String { entry.modelName = modelName }
        if let effortLevel = cmd["effortLevel"] as? String { entry.effortLevel = effortLevel }
        if let projectName = cmd["projectName"] as? String, !projectName.isEmpty {
            entry = DaemonSessionEntry(
                id: entry.id,
                port: entry.port,
                pid: entry.pid,
                projectName: projectName,
                agentType: entry.agentType,
                tmuxSession: entry.tmuxSession,
                tty: entry.tty,
                parentTty: entry.parentTty,
                startedAt: entry.startedAt
            )
        }
        pushedSessionsById[sessionId] = entry

        upsertIntoCachedSessions(entry)
        broadcastSessionsList()
    }

    /// Insert-or-update a session entry in `cachedSessions`, preserving sort
    /// order. Used by both `handleSessionPushRegister` and `handleSessionPushState`.
    @MainActor
    private func upsertIntoCachedSessions(_ entry: DaemonSessionEntry) {
        cachedSessions.removeAll { $0.id == entry.id }
        cachedSessions.append(entry)
        cachedSessions = DashboardDataRules.sortSessions(cachedSessions)
    }

    // MARK: - Commands

    @MainActor
    private func handleCommand(_ cmd: [String: Any]) {
        guard let type = cmd["type"] as? String else { return }
        DaemonLogger.shared.debug("Daemon", "cmd: \(type)")

        // Session bridge self-registration — must run BEFORE the gateway
        // adapter dispatch so that a gateway-driven mode doesn't swallow
        // the push. Mirrors the `onRawMessage` interception used by the
        // Node daemon in `bridge/src/daemon-server.ts`.
        if type == "session_push_register" {
            handleSessionPushRegister(cmd)
            return
        }
        if type == "session_push_state" {
            handleSessionPushState(cmd)
            return
        }
        if type == "client_register" {
            handleClientRegister(cmd)
            return
        }

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

        // Per-session id extraction. The global state_machine transitions
        // below remain for backwards compatibility with surfaces that read
        // the aggregate state (menubar badge, D200H). The authoritative
        // per-session state lives on `pushedSessionsById` entries so that
        // multi-session terrariums render each creature independently —
        // without this a Stop in one session drags the other session's
        // creature to idle too, because the terrarium falls back to global
        // state when session.state is nil.
        let sessionId = (json["session_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }

        // Resurrection: Claude Code only fires `session_start` once per
        // claude process lifetime. If the AgentDeck daemon restarts mid-
        // session, the next event from that ongoing process (tool_start,
        // user_prompt_submit, stop, notification) is the first hook we
        // see — without an entry, `updateSessionHookState` would no-op
        // and the sessions list would stay empty until the user killed
        // and restarted every claude. Synthesize a minimal entry on any
        // non-end event when the sessionId is unknown; the subsequent
        // per-event `updateSessionHookState` then sets the right state.
        if let sessionId, event != "session_end", event != "session_start", pushedSessionsById[sessionId] == nil {
            var entry = DaemonSessionEntry(
                id: sessionId,
                port: Int(port),
                pid: 0,
                projectName: projectNameFromHookPayload(json),
                agentType: "claude-code",
                tmuxSession: nil,
                tty: nil,
                parentTty: nil,
                startedAt: ISO8601DateFormatter().string(from: Date())
            )
            entry.state = "idle"
            pushedSessionsById[sessionId] = entry
            upsertIntoCachedSessions(entry)
            DaemonLogger.shared.debug("Hook", "Resurrected session entry for \(sessionId) on \(event)")
            // Intentionally no broadcast here — the event's own
            // updateSessionHookState (or session_start path) will broadcast.
        }

        switch event {
        case "session_start":
            _ = stateMachine.transition(trigger: "session_start", source: .hook)
            let projectName: String = {
                if let p = json["project_name"] as? String, !p.isEmpty { return p }
                if let cwd = json["cwd"] as? String, !cwd.isEmpty {
                    return URL(fileURLWithPath: cwd).lastPathComponent
                }
                return ""
            }()
            if !projectName.isEmpty { stateMachine.projectName = projectName }
            // App Store standalone: hook POST is the only Claude Code session
            // signal (sandbox blocks sessions.json; no WS push arrives without
            // the external Node bridge). Synthesize an entry keyed on Claude's
            // session_id so dashboards populate — a later session_push_register
            // with the same id merges cleanly via upsertIntoCachedSessions.
            //
            // agentType MUST be "claude-code" — it's the canonical value every
            // downstream creature renderer allowlists (Pixoo Swift/Node, plugin,
            // Android). Using bare "claude" here made hook-only sessions invisible
            // on every surface except the macOS Terrarium (which uses a denylist).
            if let sessionId {
                var entry = DaemonSessionEntry(
                    id: sessionId,
                    port: Int(port),
                    pid: 0,
                    projectName: projectName,
                    agentType: "claude-code",
                    tmuxSession: nil,
                    tty: nil,
                    parentTty: nil,
                    startedAt: ISO8601DateFormatter().string(from: Date())
                )
                entry.state = "idle"
                pushedSessionsById[sessionId] = entry
                upsertIntoCachedSessions(entry)
                broadcastSessionsList()
            }
        case "user_prompt_submit":
            _ = stateMachine.transition(trigger: "user_prompt_submit", source: .hook)
            updateSessionHookState(sessionId: sessionId, state: "processing")
            // Timeline: user's question opens a chat turn so the dashboard
            // renders Claude Code activity alongside OpenClaw/OpenCode. Before
            // this, only tool_start/tool_end entries appeared (via OpenClaw
            // path) and Claude Code conversations looked empty on the timeline.
            appendClaudeCodeChatStart(json: json, sessionId: sessionId)
        case "stop":
            _ = stateMachine.transition(trigger: "stop", source: .hook)
            updateSessionHookState(sessionId: sessionId, state: "idle", clearTool: true)
            // Timeline: close the turn. `last_assistant_message` is the hook
            // payload field Claude Code populates (~18% reliable per DEV log
            // note) — when present we emit a chat_response; otherwise just
            // chat_end. Tool-only turns fall through to empty chat_end.
            appendClaudeCodeChatEnd(json: json, sessionId: sessionId)
        case "session_end":
            _ = stateMachine.transition(trigger: "session_end", source: .hook)
            if let sessionId {
                pushedSessionsById.removeValue(forKey: sessionId)
                cachedSessions.removeAll { $0.id == sessionId }
                broadcastSessionsList()
            }
        case "tool_start":
            stateMachine.currentTool = json["tool_name"] as? String
            stateMachine.toolInput = json["tool_input"] as? String
            updateSessionHookState(
                sessionId: sessionId,
                state: "processing",
                currentTool: json["tool_name"] as? String
            )
        case "tool_end":
            stateMachine.currentTool = nil; stateMachine.toolInput = nil
            stateMachine.toolCalls += 1
            // Stay "processing" between tool boundaries — `stop` drops the
            // session back to idle when the turn finishes.
            updateSessionHookState(sessionId: sessionId, state: "processing", clearTool: true)
        default: break
        }

        // APME: route every hook event through the collector.
        // The collector manages its own session lifecycle (session_start opens
        // a run, session_end closes it, everything in between is a step).
        apmeCollector?.handleHook(event: event, data: json)

        // Attribute the next state_update + timeline entries to the session
        // that fired this hook: remember the sessionId, and mirror the
        // session's projectName onto the global StateMachine so downstream
        // timeline generators (client-side StateTimelineGenerator) label
        // events with the correct project. Without this the global
        // projectName stays stuck on whichever session most recently fired
        // `session_start`, so cross-session interleaving mislabels entries.
        if let sessionId {
            lastHookAtByPushedSession[sessionId] = Date()
            currentHookSessionId = sessionId
            if let proj = pushedSessionsById[sessionId]?.projectName, !proj.isEmpty {
                stateMachine.projectName = proj
            }
        }
        if event == "session_end", let sessionId {
            lastHookAtByPushedSession.removeValue(forKey: sessionId)
            if currentHookSessionId == sessionId { currentHookSessionId = nil }
        }

        broadcastStateUpdate()
    }

    /// Handle a `client_register` announcement from a rich UI surface
    /// (currently: Elgato Stream Deck plugin). Updates `cachedStreamDeck`
    /// with the device roster the plugin claims to drive so the Dashboard
    /// Downstream rail can render a Stream Deck row. Only `streamdeck-plugin`
    /// is recognized for now; future client types slot in here.
    @MainActor
    private func handleClientRegister(_ cmd: [String: Any]) {
        guard let clientType = cmd["clientType"] as? String else { return }
        switch clientType {
        case "streamdeck-plugin":
            let devices = (cmd["devices"] as? [[String: Any]]) ?? []
            cachedStreamDeck = StreamDeckRegistration(devices: devices, updatedAt: Date())
            DaemonLogger.shared.debug("Daemon", "client_register streamdeck-plugin devices=\(devices.count)")
            broadcastStateUpdate()
        default:
            DaemonLogger.shared.debug("Daemon", "client_register ignored clientType=\(clientType)")
        }
    }

    /// Expire the Stream Deck cache when the plugin has gone silent for
    /// `streamDeckStaleTTL`. The plugin's connection-manager reconnect
    /// loop keeps sending `client_register` every connect, so a live
    /// plugin naturally keeps the timestamp fresh; a killed/uninstalled
    /// plugin stops refreshing and the row disappears on its own.
    @MainActor
    private func evictStaleClientRegistrations() async {
        let cutoff = Date().addingTimeInterval(-Self.streamDeckStaleTTL)
        if let sd = cachedStreamDeck, sd.updatedAt < cutoff {
            DaemonLogger.shared.debug("Daemon", "Evicted stale streamdeck client registration")
            cachedStreamDeck = nil
            broadcastStateUpdate()
        }
    }

    /// Derive a project label from a Claude Code hook payload. Prefers an
    /// explicit `project_name` field, falls back to the last path component
    /// of `cwd`. Used by both the `session_start` synthesis path and the
    /// resurrection path for sessions whose `session_start` fired before
    /// this daemon process was running.
    private func projectNameFromHookPayload(_ json: [String: Any]) -> String {
        if let p = json["project_name"] as? String, !p.isEmpty { return p }
        if let cwd = json["cwd"] as? String, !cwd.isEmpty {
            return URL(fileURLWithPath: cwd).lastPathComponent
        }
        return ""
    }

    /// Evict hook-driven sessions whose last hook is older than
    /// `pushedSessionStaleTTL`. Claude Code's `session_end` hook is
    /// unreliable, so without this a `claude` process that crashed or was
    /// Ctrl-C'd leaves a ghost entry whose creature keeps swimming or
    /// floating forever. A fresh hook for the same sessionId re-creates
    /// the entry through the `session_start` synthesis path.
    @MainActor
    private func evictStaleHookSessions() async {
        let cutoff = Date().addingTimeInterval(-Self.pushedSessionStaleTTL)
        let expired = lastHookAtByPushedSession.compactMap { (sid, ts) -> String? in
            ts < cutoff ? sid : nil
        }
        guard !expired.isEmpty else { return }
        for sid in expired {
            pushedSessionsById.removeValue(forKey: sid)
            cachedSessions.removeAll { $0.id == sid }
            lastHookAtByPushedSession.removeValue(forKey: sid)
            if currentHookSessionId == sid { currentHookSessionId = nil }
            DaemonLogger.shared.debug("Hook", "Evicted stale session \(sid) (no hook in \(Int(Self.pushedSessionStaleTTL))s)")
        }
        broadcastSessionsList()
    }

    /// Apply a per-session state/tool update coming from a hook event and
    /// broadcast the refreshed sessions list. No-op when the sessionId is
    /// nil or refers to a session we never registered via `session_start`.
    @MainActor
    private func updateSessionHookState(
        sessionId: String?,
        state newState: String,
        currentTool: String? = nil,
        clearTool: Bool = false
    ) {
        guard let sessionId, var entry = pushedSessionsById[sessionId] else { return }
        entry.state = newState
        if clearTool {
            entry.currentTool = nil
        } else if let currentTool {
            entry.currentTool = currentTool
        }
        pushedSessionsById[sessionId] = entry
        upsertIntoCachedSessions(entry)
        broadcastSessionsList()
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
                        if self?.stateMachine.state == .disconnected {
                            _ = self?.stateMachine.transition(trigger: "session_start", source: .hook)
                        }
                        // APME: open a run for this Gateway connection
                        self?.apmeCollectorGateway?.handleHook(event: "session_start", data: [
                            "session_id": "openclaw-gateway",
                            "project_name": "OpenClaw",
                            "agent_type": "openclaw",
                        ])
                        self?.handleStateChanged()
                    } else {
                        self?.cachedGatewayConnected = false
                        if self?.cachedGatewayAvailable == true, self?.cachedGatewayAuthStatus == "connected" {
                            // WebSocket dropped but Gateway TCP port is still open —
                            // adapter will reconnect internally with backoff. Show
                            // "reconnecting" instead of "Approve in Web UI" or
                            // "Not configured" so the user doesn't act on a false state.
                            self?.cachedGatewayAuthStatus = "reconnecting"
                        }
                        DaemonLogger.shared.info("OpenClaw Gateway disconnected")
                        await self?.logStream.stop()
                        _ = self?.stateMachine.transition(trigger: "session_end", source: .hook)
                        self?.gatewaySessionState = "idle"
                        self?.gatewayCurrentTool = nil
                        // APME: close the gateway run on disconnect
                        self?.apmeCollectorGateway?.handleHook(event: "session_end", data: [
                            "session_id": "openclaw-gateway",
                        ])
                        self?.handleStateChanged()
                    }
                }
            }
            await adapter.start()
            // Cache the locally-generated deviceId so state_update can carry
            // it even before the first successful handshake (which is when
            // pairing UI most needs to show the id). `currentDeviceId()` is
            // populated by `loadDeviceIdentity()` inside `start()`.
            let deviceId = await adapter.currentDeviceId()
            await MainActor.run {
                self.cachedGatewayDeviceId = deviceId
            }
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
        gatewaySessionState = "idle"
        gatewayCurrentTool = nil
        // Note: gatewayModelName is intentionally preserved across brief disconnects
        // so the model row doesn't flash empty on reconnect.
        _ = stateMachine.transition(trigger: "session_end", source: .hook)
        apmeCollectorGateway?.handleHook(event: "session_end", data: [
            "session_id": "openclaw-gateway",
        ])
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
            case "final", "aborted":
                gatewaySessionState = "idle"
                gatewayCurrentTool = nil
                // APME: record response text → triggers inline classification + eval
                let response = chatPayload["response"] as? String ?? ""
                if !response.isEmpty {
                    apmeCollectorGateway?.setTurnResponse(response)
                }
            case "error":
                gatewaySessionState = "idle"
                gatewayCurrentTool = nil
            default:
                gatewaySessionState = "processing"
            }
            broadcastStateUpdate()
        case "gateway_approval":
            gatewaySessionState = "awaiting_permission"
            if let payload = event["payload"] as? [String: Any] {
                gatewayCurrentTool = payload["tool"] as? String
            }
            broadcastStateUpdate()
        case "gateway_approval_resolved":
            let resolvedPayload = event["payload"] as? [String: Any]
            let decision = resolvedPayload?["decision"] as? String
            // "deny" means tool execution was blocked — agent returns to idle.
            // "allow" (or any other value) means execution resumes → processing.
            gatewaySessionState = (decision == "deny") ? "idle" : "processing"
            gatewayCurrentTool = nil
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
                let entryType = entry["type"] as? String

                if entryType == "model_call" {
                    // session.message role=user → turn start: record prompt for APME
                    let prompt = (entry["detail"] as? String) ?? (entry["raw"] as? String) ?? ""
                    if !prompt.isEmpty {
                        apmeCollectorGateway?.handleHook(event: "user_prompt_submit", data: [
                            "session_id": "openclaw-gateway",
                            "prompt": prompt,
                        ])
                    }
                } else if entryType == "tool_exec" {
                    // session.tool entries arrive via sessions.messages.subscribe.
                    // Keep gatewayCurrentTool in sync AND wire tool events to APME.
                    let toolName = entry["raw"] as? String
                    let status = entry["status"] as? String
                    let hasOutput = entry["detail"] != nil
                    if status == "complete" || status == "error" || hasOutput {
                        if gatewayCurrentTool == toolName { gatewayCurrentTool = nil }
                        apmeCollectorGateway?.handleHook(event: "tool_end", data: [
                            "session_id": "openclaw-gateway",
                            "tool_name": toolName as Any,
                        ])
                    } else {
                        // pending / no status yet — tool is starting
                        gatewayCurrentTool = toolName
                        if gatewaySessionState == "idle" { gatewaySessionState = "processing" }
                        apmeCollectorGateway?.handleHook(event: "tool_start", data: [
                            "session_id": "openclaw-gateway",
                            "tool_name": toolName as Any,
                        ])
                    }
                    broadcastStateUpdate()
                }
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
                let defaultModel = event["defaultModel"] as? String
                if let defaultModel, !defaultModel.isEmpty {
                    gatewayModelName = defaultModel
                }
                let catalogChanged = updateModelCatalog(from: models, source: "gateway", replaceExisting: true)
                if catalogChanged || defaultModel != nil {
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
        // Stale hook-session eviction — 30s. See `lastHookAtByPushedSession`
        // and `pushedSessionStaleTTL` for rationale. Also doubles as the
        // cadence for expiring stale client_register cache entries
        // (Stream Deck plugin TTL) since both care about minute-scale
        // cleanup rather than immediate reaction.
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self else { break }
                await self.evictStaleHookSessions()
                await self.evictStaleClientRegistrations()
            }
        }

        // Serial status refresh — 5s. Pre-fetches the ESP32/Serial module's
        // async snapshot into `cachedSerialStatus` so the sync broadcast
        // path (`buildModuleHealthSync`) can emit full `connections`
        // payloads. Without this the Dashboard USB serial section stays
        // empty even with boards physically connected.
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self else { break }
                if let snap = await self.serialStatusSnapshot() {
                    await MainActor.run { self.cachedSerialStatus = snap }
                }
            }
        }

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

        // Anthropic Admin API — 10 min. Independent from the subscription
        // usage poll above. Skipped entirely when the user hasn't pasted
        // an admin API key (common case for subscription users).
        adminApiPollTask = Task { [weak self] in
            // Initial kick right after startup so Settings preview shows
            // something without waiting the full interval.
            if AnthropicAdminApiClient.shared.hasKey() {
                await self?.refreshAdminApiUsage()
            }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.adminApiPollInterval))
                guard let self else { break }
                guard AnthropicAdminApiClient.shared.hasKey() else { continue }
                guard await self.wsServer.hasClients() else { continue }
                await self.refreshAdminApiUsage()
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

        // Gateway probe — 5s with hysteresis
        // A single TCP miss does NOT trigger disconnect — transient network
        // glitches (< 10s) are invisible to the user. Only 2+ consecutive
        // failures (≈10s of confirmed unavailability) cause a state change.
        gatewayPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self else { break }
                let available = await self.gatewayProbe.isAvailable

                if available {
                    self.gatewayProbeFailCount = 0
                    let wasUnavailable = !self.cachedGatewayAvailable
                    self.cachedGatewayAvailable = true
                    if self.cachedGatewayAuthStatus == "gateway_not_found" {
                        self.cachedGatewayAuthStatus = "gateway_reachable"
                    }
                    if self.gatewayAdapter == nil {
                        self.connectGatewayAdapter()
                    }
                    if wasUnavailable { self.broadcastStateUpdate() }
                } else {
                    self.gatewayProbeFailCount += 1
                    if self.gatewayProbeFailCount >= Self.gatewayProbeDisconnectThreshold {
                        // Confirmed unavailable: flip state and disconnect
                        let wasAvailable = self.cachedGatewayAvailable
                        self.cachedGatewayAvailable = false
                        self.cachedGatewayAuthStatus = "gateway_not_found"
                        self.cachedGatewayAuthRequestId = nil
                        self.cachedGatewayAuthMessage = nil
                        if self.gatewayAdapter != nil { self.disconnectGatewayAdapter() }
                        if wasAvailable { self.broadcastStateUpdate() }
                    }
                    // First miss: silently wait. Adapter handles WebSocket reconnect internally.
                }
            }
        }
        Task { await gatewayProbe.start() }

        // Gateway health — 30s
        gatewayHealthTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self else { break }
                let adapterHealth = await self.gatewayAdapter?.fetchHealthHasError()
                let hasError: Bool
                if let adapterHealth {
                    hasError = adapterHealth
                } else {
                    hasError = await self.gatewayProbe.hasErrorSnapshot()
                }
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
        // Pull filesystem-registered sessions (our own group container) first.
        let registryEntries = await registry.listActiveAndReachable().filter { $0.id != sessionId }

        // Merge with push-registered sessions (CLI bridges over WS). Pushed
        // sessions are authoritative for App Store builds because Swift
        // can't read `~/.agentdeck/sessions.json`.
        var merged = registryEntries
        let knownIds = Set(merged.map { $0.id })
        for (_, pushed) in pushedSessionsById where !knownIds.contains(pushed.id) {
            merged.append(pushed)
        }

        let enriched = await enrichSessionsWithState(merged)

        // Prune pushed sessions whose /health probe failed repeatedly — the
        // bridge is gone. `enrichSessionsWithState` leaves `state = nil` when
        // the probe errors; we catch those and drop the local push entry.
        let livePushedIds = Set(enriched.filter { $0.state != nil }.map { $0.id })
        let stalePushed = pushedSessionsById.keys.filter { id in
            registryEntries.contains(where: { $0.id == id }) == false
                && livePushedIds.contains(id) == false
        }
        for id in stalePushed {
            DaemonLogger.shared.debug("Daemon", "Pruning stale pushed session \(id)")
            pushedSessionsById.removeValue(forKey: id)
        }

        cachedSessions = DashboardDataRules.sortSessions(enriched.filter { entry in
            // Keep filesystem entries unconditionally; drop pushed entries
            // whose probe failed (already pruned above, double-gate for safety).
            if registryEntries.contains(where: { $0.id == entry.id }) { return true }
            return livePushedIds.contains(entry.id)
        })
        broadcastSessionsList()
    }

    private func enrichSessionsWithState(_ sessions: [DaemonSessionEntry]) async -> [DaemonSessionEntry] {
        // Hook-synthesized sessions share this daemon's port, so probing
        // `/health` would loop back to us and every entry would end up
        // carrying our *global* stateMachine.state — which makes every
        // creature mirror the most recently active session and fire
        // "idle" on another session's Stop. Skip the self-probe; the
        // per-session state we set in handleHookEvent is already right.
        let selfPort = Int(self.port)
        return await withTaskGroup(of: DaemonSessionEntry.self) { group in
            for session in sessions {
                group.addTask {
                    var s = session
                    guard session.port != selfPort else { return s }
                    if let health = await SessionRegistry.shared.probeDaemonHealth(port: session.port) {
                        s.agentType = health["agentType"] as? String ?? s.agentType
                        s.state = health["state"] as? String
                        s.modelName = health["modelName"] as? String
                        s.effortLevel = health["effortLevel"] as? String
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
        if cachedGatewayConnected {
            if !sessions.contains(where: { ($0["id"] as? String) == "openclaw-gateway" || ($0["agentType"] as? String) == "openclaw" }) {
                // Only authenticated Gateway connections should materialize as
                // a virtual OpenClaw session. Reachability/auth failures stay
                // in the topology/status rows so the terrarium does not render
                // a crayfish that looks like an active integration.
                var gatewaySession: [String: Any] = [
                    "id": "openclaw-gateway", "port": 18789,
                    "projectName": "OpenClaw", "agentType": "openclaw",
                    "alive": true, "state": gatewaySessionState,
                    "startedAt": "1970-01-01T00:00:00.000Z",
                ]
                if let tool = gatewayCurrentTool { gatewaySession["currentTool"] = tool }
                if let modelName = gatewayModelName { gatewaySession["modelName"] = modelName }
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
                if let fetchedAt = cachedApiUsage?.fetchedAt {
                    lastApiFetchTime = Date(timeIntervalSince1970: fetchedAt)
                } else {
                    lastApiFetchTime = Date()
                }
                apiUsageStale = cachedApiUsage?.stale ?? false
                apiUsagePreAdjusted = false  // raw data from HTTP, needs adjustment
                oauthConnected = usage["oauthConnected"] as? Bool ?? true
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
            if let fetchedAt = usage.fetchedAt {
                lastApiFetchTime = Date(timeIntervalSince1970: fetchedAt)
            } else {
                lastApiFetchTime = Date()
            }
            apiUsageStale = usage.stale
            apiUsagePreAdjusted = false  // raw data from API, needs adjustment
            oauthConnected = usageAPI.tokenStatus == .valid
            if let inferred = usage.inferredBillingType {
                stateMachine.billingType = inferred
            }
            DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier3-ok", "Usage Tier 3 OK: 5h=\(usage.fiveHourPercent ?? -1)%", minInterval: 30)
            broadcastUsage()
        } else {
            DaemonLogger.shared.throttledDebug("Daemon", key: "usage-relay:tier3-failed:\(usageAPI.tokenStatus.rawValue)", "Usage Tier 3 failed (token: \(usageAPI.tokenStatus.rawValue))", minInterval: 30)
            oauthConnected = usageAPI.hasOAuthToken()
            // Don't mark stale here for transient failures — usageTick's
            // 10-min TTL handles temporary outages. BUT: if the token is
            // definitively missing or expired (App Store sandbox with no
            // ~/.claude OAuth access, or post-logout), no fresh fetch will
            // ever land through this daemon — flag stale immediately so
            // every downstream surface collapses its usage region instead
            // of showing cached numbers during the 10-min grace.
            switch usageAPI.tokenStatus {
            case .missing, .expired:
                if !apiUsageStale {
                    DaemonLogger.shared.debug("Daemon", "Token \(usageAPI.tokenStatus.rawValue) — marking cached usage stale so UI hides instead of showing frozen values")
                    apiUsageStale = true
                }
            default: break
            }
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
                usage["fetchedAt"] = Double(fetchedAt) / 1000.0
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
            inferredBillingType: dict["fiveHourPercent"] != nil ? "subscription" : "api",
            fetchedAt: dict["fetchedAt"] as? Double,
            stale: dict["usageStale"] as? Bool ?? false
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
        var gateway: [String: Any] = [
            "available": cachedGatewayAvailable,
            "connected": cachedGatewayConnected,
            "hasError": cachedGatewayHasError,
            "authStatus": cachedGatewayAuthStatus,
        ]
        if let requestId = cachedGatewayAuthRequestId { gateway["authRequestId"] = requestId }
        if let message = cachedGatewayAuthMessage { gateway["authMessage"] = message }
        var modules: [String: Any] = [
            "gateway": gateway
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
        if let sd = cachedStreamDeck {
            modules["streamDeck"] = [
                "available": true,
                "devices": sd.devices,
            ] as [String: Any]
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
        // Stamp the event with the session id that most recently produced a
        // hook so timeline / primary-creature attribution picks the right
        // session when several are running concurrently.
        if let sid = currentHookSessionId { e["sessionId"] = sid }
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
        if let id = cachedGatewayDeviceId { e["gatewayDeviceId"] = id }
        e["daemonPort"] = Int(port)
        if let requestId = cachedGatewayAuthRequestId { e["gatewayAuthRequestId"] = requestId }
        if let message = cachedGatewayAuthMessage { e["gatewayAuthMessage"] = message }
        if let url = cachedPairingUrl { e["pairingUrl"] = url }
        if let r = stateMachine.remoteUrl { e["remoteUrl"] = r }
        e["oauthConnected"] = oauthConnected
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

    /// Refresh cached Anthropic Console Admin API usage. No-op when
    /// no key is configured. On failure the previous cached value is
    /// flagged stale so the UI can show "last known" values.
    @MainActor
    private func refreshAdminApiUsage() async {
        guard AnthropicAdminApiClient.shared.hasKey() else { return }
        if let fresh = await AnthropicAdminApiClient.shared.fetchUsage() {
            cachedAdminApiUsage = fresh
            lastAdminApiFetchTime = Date()
        } else if var stale = cachedAdminApiUsage {
            stale.stale = true
            cachedAdminApiUsage = stale
        }
        broadcastUsage()
    }

    private func buildModuleHealthSync() -> [String: Any] {
        var modules: [String: Any] = [:]
        if let adb = adbModule { modules["adb"] = adb.statusSnapshot() }
        if let d200h = d200hModule { modules["d200h"] = d200h.statusSnapshot() }
        if let pixoo = pixooModule { modules["pixoo"] = pixoo.statusSnapshot() }
        // SerialModule.statusSnapshot() is async — read the 5s-polled
        // cache so Dashboard USB serial section sees connected boards
        // without us having to awaitly-pre-fetch on every broadcast.
        if let cachedSerial = cachedSerialStatus {
            modules["serial"] = cachedSerial
        } else if serialModule != nil {
            modules["serial"] = ["available": true, "connections": [] as [Any]] as [String: Any]
        }
        if let sd = cachedStreamDeck {
            modules["streamDeck"] = [
                "available": true,
                "devices": sd.devices,
            ] as [String: Any]
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

        // API usage data — skip adjustUsagePercent when values were synced from relay.
        // When the data is stale (no live fetch succeeded recently, e.g. App Store
        // sandbox with no relay path), emit neither percentages nor reset times so
        // every downstream surface — macOS dashboard, Stream Deck plugin, Android,
        // Pixoo, D200H — collapses its usage region instead of rendering a stale
        // number that looks authoritative. `usageStale` flag is still sent so
        // callers that want to distinguish "never fetched" from "had data, now
        // stale" can, but no numbers ride along with it.
        if let u = cachedApiUsage {
            let usageIsStale = apiUsageStale || u.stale
            if !usageIsStale {
                if apiUsagePreAdjusted {
                    e["fiveHourPercent"] = u.fiveHourPercent as Any
                    e["sevenDayPercent"] = u.sevenDayPercent as Any
                } else {
                    e["fiveHourPercent"] = adjustUsagePercent(u.fiveHourPercent, resetsAt: u.fiveHourResetsAt) as Any
                    e["sevenDayPercent"] = adjustUsagePercent(u.sevenDayPercent, resetsAt: u.sevenDayResetsAt) as Any
                }
                if let v = u.fiveHourResetsAt { e["fiveHourResetsAt"] = v }
                if let v = u.sevenDayResetsAt { e["sevenDayResetsAt"] = v }
            }
            e["extraUsageEnabled"] = u.extraUsageEnabled
            if let v = u.extraUsageMonthlyLimit { e["extraUsageMonthlyLimit"] = v }
            if let v = u.extraUsageUsedCredits { e["extraUsageUsedCredits"] = v }
            if let v = u.extraUsageUtilization { e["extraUsageUtilization"] = v }
        }

        e["oauthConnected"] = oauthConnected
        e["usageStale"] = apiUsageStale || cachedApiUsage?.stale == true
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

        e["adminApiKeyPresent"] = AnthropicAdminApiClient.shared.hasKey()
        if let admin = cachedAdminApiUsage {
            e["adminApiTodayInputTokens"] = admin.today.input
            e["adminApiTodayOutputTokens"] = admin.today.output
            e["adminApiTodayCacheReadTokens"] = admin.today.cacheRead
            e["adminApiTodayCacheCreationTokens"] = admin.today.cacheCreation
            e["adminApiMonthInputTokens"] = admin.month.input
            e["adminApiMonthOutputTokens"] = admin.month.output
            e["adminApiMonthCacheReadTokens"] = admin.month.cacheRead
            e["adminApiMonthCacheCreationTokens"] = admin.month.cacheCreation
            e["adminApiTopModels"] = admin.topModels.map {
                ["model": $0.model, "totalTokens": $0.totalTokens]
            }
            e["adminApiFetchedAt"] = admin.fetchedAt
            e["adminApiStale"] = admin.stale
        }

        return e
    }

    @MainActor
    private func mergeEngineSnapshot(into event: inout [String: Any]) {
        if !cachedModelCatalog.isEmpty { event["modelCatalog"] = cachedModelCatalog }
        if let ollama = cachedOllamaStatus { event["ollamaStatus"] = ollama }
        if !cachedMlxModels.isEmpty { event["mlxModels"] = cachedMlxModels }
        if !cachedMlxModelCatalog.isEmpty { event["mlxModelCatalog"] = cachedMlxModelCatalog }
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

        // `/api/tags` returns every installed model with details (family,
        // parameter_size); `/api/ps` returns only models currently resident
        // in VRAM. We need both: tags is the source of truth for "what's
        // available", ps overlays runtime VRAM usage. Embedding models
        // (bert family, bge-*/e5-*/gte-* names, etc.) never sit in VRAM
        // between requests — surfacing them as "not loaded" is misleading,
        // so we classify each row as "chat" vs "embed" so the UI can
        // group them without the loaded/not-loaded framing.
        async let tagsData = fetchOllamaData(path: "/api/tags")
        async let psData = fetchOllamaData(path: "/api/ps")
        let tags = (await tagsData).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let ps = (await psData).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }

        if let tags, let tagModels = tags["models"] as? [[String: Any]] {
            var vramByName: [String: Int] = [:]
            if let ps, let psModels = ps["models"] as? [[String: Any]] {
                for m in psModels {
                    guard let name = m["name"] as? String else { continue }
                    vramByName[name] = m["size_vram"] as? Int ?? m["sizeVram"] as? Int ?? 0
                }
            }
            cachedOllamaStatus = [
                "available": true,
                "models": tagModels.map { m -> [String: Any] in
                    let name = m["name"] as? String ?? ""
                    let family = (m["details"] as? [String: Any])?["family"] as? String
                    return [
                        "name": name,
                        "size": m["size"] ?? 0,
                        "sizeVram": vramByName[name] ?? 0,
                        "kind": Self.classifyOllamaKind(name: name, family: family),
                    ]
                }
            ]
            success = true
        } else if let ps, let psModels = ps["models"] as? [[String: Any]] {
            // /api/tags failed but /api/ps succeeded — still report Ollama
            // as available (we just won't know about unloaded installed
            // models this cycle).
            cachedOllamaStatus = [
                "available": true,
                "models": psModels.map { m -> [String: Any] in
                    let name = m["name"] as? String ?? ""
                    let family = (m["details"] as? [String: Any])?["family"] as? String
                    return [
                        "name": name,
                        "size": m["size"] ?? 0,
                        "sizeVram": m["size_vram"] ?? m["sizeVram"] ?? 0,
                        "kind": Self.classifyOllamaKind(name: name, family: family),
                    ]
                }
            ]
            success = true
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

    /// Fetch `http://127.0.0.1:11434<path>` as raw Data with a 2s timeout.
    /// Parsing is deferred to the caller so the return type stays Sendable
    /// across the `async let` parallelism boundary in `probeOllama`.
    /// Returns nil on any network error.
    private nonisolated func fetchOllamaData(path: String) async -> Data? {
        guard let url = URL(string: "http://127.0.0.1:11434\(path)") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        guard let (data, _) = try? await LocalProbeSession.shared.data(for: request) else {
            return nil
        }
        return data
    }

    /// Classify an Ollama model as "chat" (text generation) or "embed"
    /// (embedding-only). Uses `details.family` as the primary signal and
    /// falls back to well-known embed name patterns for older Ollama
    /// builds that don't surface family. Embedding families Ollama
    /// produces: `bert`, `nomic-bert`, `distilbert`, `roberta`.
    private static func classifyOllamaKind(name: String, family: String?) -> String {
        if let family = family?.lowercased(),
           ["bert", "nomic-bert", "distilbert", "roberta"].contains(family) {
            return "embed"
        }
        let lower = name.lowercased()
        let embedMarkers = [
            "bge-", "-embed", "embed-", "nomic-embed", "mxbai-embed",
            "snowflake-arctic-embed", "all-minilm", "gte-",
        ]
        if embedMarkers.contains(where: { lower.contains($0) }) { return "embed" }
        if lower.hasPrefix("e5-") || lower.hasPrefix("e5:") { return "embed" }
        return "chat"
    }

    @MainActor
    private func probeMLX() async {
        let previous = cachedMlxModels
        let previousCatalog = cachedMlxModelCatalog
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
            let pin = ApmeSettings.loadMlxConfig().model
            cachedMlxModelCatalog = resolved
            cachedMlxModels = Self.pickMlxModels(catalog: resolved, pin: pin)
        } else {
            mlxFailureCount += 1
            mlxNextInterval = min(mlxNextInterval * 2, Self.probeMaxInterval)
            // Keep last-known model list until we've seen N consecutive
            // failures; then clear so the UI reflects unavailability.
            if mlxFailureCount >= Self.probeStaleThreshold {
                cachedMlxModels = []
                cachedMlxModelCatalog = []
            }
        }

        if previous != cachedMlxModels || previousCatalog != cachedMlxModelCatalog {
            broadcastStateUpdate()
            broadcastUsage()
        }
    }

    private static func pickMlxModels(catalog: [String], pin: String?) -> [String] {
        if let pin, catalog.contains(pin) {
            return [pin]
        }
        let fallback = "mlx-community/Qwen3.6-35B-A3B-4bit"
        if catalog.contains(fallback) {
            return [fallback]
        }
        if let first = catalog.first {
            return [first]
        }
        return []
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
        sessionPollTask?.cancel(); usagePollTask?.cancel(); adminApiPollTask?.cancel()
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
        if let ef = s.effortLevel { d["effortLevel"] = ef }
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

    /// Append a `chat_start` timeline entry for a Claude Code UserPromptSubmit
    /// hook. Without this, Claude Code conversations appeared empty on the
    /// dashboard timeline while OpenClaw/OpenCode sessions showed full turns.
    @MainActor
    private func appendClaudeCodeChatStart(json: [String: Any], sessionId: String?) {
        let prompt = claudeCodePromptText(from: json)
        guard !prompt.isEmpty else { return }
        let snippet = String(prompt.prefix(200))
        let detail: String? = prompt.count > 100
            ? String(prompt.prefix(1000))
            : nil
        let ts = Date().timeIntervalSince1970 * 1000
        var entry = DaemonTimelineEntry(
            ts: ts,
            type: "chat_start",
            raw: snippet,
            detail: detail,
            approvalId: nil,
            status: nil,
            agentType: "claude-code",
            repeatCount: nil,
            automated: nil
        )
        entry.sessionId = sessionId
        entry.projectName = pushedSessionsById[sessionId ?? ""]?.projectName
        Task { await timelineStore.add(entry) }
        broadcastRaw([
            "type": "timeline_event",
            "entry": claudeCodeEntryDict(entry),
        ] as [String: Any])
    }

    /// Append a `chat_response` (when `last_assistant_message` arrived) + a
    /// terminating `chat_end` for a Claude Code Stop hook.
    @MainActor
    private func appendClaudeCodeChatEnd(json: [String: Any], sessionId: String?) {
        let assistantText = (json["last_assistant_message"] as? String) ?? ""
        let now = Date().timeIntervalSince1970 * 1000
        let projectName = pushedSessionsById[sessionId ?? ""]?.projectName
        if !assistantText.isEmpty {
            let snippet = String(assistantText.prefix(200))
            let detail: String? = assistantText.count > 100
                ? String(assistantText.prefix(1000))
                : nil
            var respEntry = DaemonTimelineEntry(
                ts: now - 1,
                type: "chat_response",
                raw: snippet,
                detail: detail,
                approvalId: nil,
                status: nil,
                agentType: "claude-code",
                repeatCount: nil,
                automated: nil
            )
            respEntry.sessionId = sessionId
            respEntry.projectName = projectName
            Task { await timelineStore.add(respEntry) }
            broadcastRaw([
                "type": "timeline_event",
                "entry": claudeCodeEntryDict(respEntry),
            ] as [String: Any])
        }
        var endEntry = DaemonTimelineEntry(
            ts: now,
            type: "chat_end",
            raw: assistantText.isEmpty ? "Completed" : String(assistantText.prefix(200)),
            detail: nil,
            approvalId: nil,
            status: nil,
            agentType: "claude-code",
            repeatCount: nil,
            automated: nil
        )
        endEntry.sessionId = sessionId
        endEntry.projectName = projectName
        Task { await timelineStore.add(endEntry) }
        broadcastRaw([
            "type": "timeline_event",
            "entry": claudeCodeEntryDict(endEntry),
        ] as [String: Any])
    }

    /// Pull the user's prompt from either Claude Code's legacy `prompt` field
    /// or the newer `message.content` shape. Mirrors the collector's parsing.
    private func claudeCodePromptText(from json: [String: Any]) -> String {
        if let s = json["prompt"] as? String, !s.isEmpty { return s }
        if let message = json["message"] as? [String: Any],
           let content = message["content"] as? String {
            return content
        }
        return ""
    }

    /// Encode a DaemonTimelineEntry into the dict shape broadcastRaw expects —
    /// matches the key set `appendGatewayTimelineEntry` uses for round-trip.
    private func claudeCodeEntryDict(_ e: DaemonTimelineEntry) -> [String: Any] {
        var dict: [String: Any] = [
            "ts": e.ts,
            "type": e.type,
            "raw": e.raw,
        ]
        if let v = e.detail { dict["detail"] = v }
        if let v = e.agentType { dict["agentType"] = v }
        if let v = e.sessionId { dict["sessionId"] = v }
        if let v = e.projectName { dict["projectName"] = v }
        return dict
    }

    @MainActor
    private func appendGatewayTimelineEntry(_ rawEntry: [String: Any]) {
        var entry = DaemonTimelineEntry(
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
        entry.runId = rawEntry["runId"] as? String
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
