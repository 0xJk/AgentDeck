// AgentStateHolder.swift — Main @Observable state store
// Ported from android AgentState.kt (AgentStateHolder)

import Foundation

@Observable
final class AgentStateHolder: @unchecked Sendable {
    // MARK: - State

    private(set) var state = DashboardState()
    private var lastKnownState: DashboardState?

    // MARK: - Dependencies

    let connection = BridgeConnection()
    let discovery = BridgeDiscovery()
    let timelineStore = TimelineStore()
    let displaySync = DisplaySyncService()
    private(set) var timelineGenerator: StateTimelineGenerator!

    /// Bump to trigger SwiftUI re-render for nested timelineStore changes
    private(set) var timelineVersion: Int = 0

    #if os(macOS)
    let localDiscovery = LocalSessionDiscovery()
    #endif

    // MARK: - URL Persistence

    private static let lastBridgeUrlKey = "lastBridgeUrl"

    private var savedUrl: String? {
        get { UserDefaults.standard.string(forKey: Self.lastBridgeUrlKey) }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue, forKey: Self.lastBridgeUrlKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.lastBridgeUrlKey)
            }
        }
    }

    // MARK: - Lifecycle

    private var backgroundEnteredAt: Date?

    // MARK: - Connection Waterfall State

    private(set) var isAutoConnecting = false
    private var waterfallStage: WaterfallStage = .idle

    /// Bridges that failed to connect — skip them until browseResults refresh
    private var failedBridgeIds: Set<String> = []
    /// Track last browseResults count to detect mDNS refresh and clear blacklist
    private var lastBrowseCount: Int = 0

    private enum WaterfallStage {
        case idle
        case localSession    // macOS: reading sessions.json
        case savedUrl        // trying last known URL
        case mdns            // mDNS discovery
    }

    // MARK: - Init

    init() {
        timelineGenerator = StateTimelineGenerator(store: timelineStore)
        connection.onEvent = { [weak self] event in
            self?.handleEvent(event)
        }
        connection.onDisconnect = { [weak self] in
            guard let self else { return }
            if self.state.bridgeConnected {
                self.resetToDisconnected()
            }
            // Start mDNS discovery during reconnect so we can find new bridges
            self.discovery.startSearching()
        }
        connection.onReconnectExhausted = { [weak self] in
            guard let self else { return }
            // Blacklist the failed bridge so we skip it in auto-connect
            if let url = self.connection.url,
               let bridge = self.discovery.bridges.first(where: { $0.wsUrl == url }) {
                self.failedBridgeIds.insert(bridge.id)
                print("[Waterfall] blacklisted bridge \(bridge.id) after reconnect exhausted")
            }
            self.savedUrl = nil
            self.waterfallStage = .idle
            self.startConnectionWaterfall()
        }

        // On each reconnect attempt, check for available bridges.
        // If found, abort stale-URL reconnect and connect to the new bridge.
        connection.onReconnectAttempt = { [weak self] in
            guard let self else { return false }

            #if os(macOS)
            // macOS: prefer local sessions.json first
            let localBridges = self.localDiscovery.readSessionsNow()
            if let bridge = localBridges.first {
                DispatchQueue.main.async {
                    self.savedUrl = nil
                    self.waterfallStage = .idle
                    self.connectTo(bridge)
                }
                return true  // abort reconnect
            }
            #endif

            // All platforms: check mDNS discovered bridges (skip blacklisted)
            let candidates = self.discovery.bridges.filter { !self.failedBridgeIds.contains($0.id) }
            let bridge = candidates.first(where: { $0.agentType == "daemon" })
                ?? candidates.first
            if let bridge, bridge.wsUrl != self.connection.url {
                DispatchQueue.main.async {
                    self.savedUrl = nil
                    self.waterfallStage = .idle
                    self.connectTo(bridge)
                }
                return true  // abort reconnect
            }

            return false
        }
    }

    // MARK: - Lifecycle Handlers

    func handleBackgroundEntry() {
        backgroundEnteredAt = Date()
        connection.stopPingTimer()
        print("[Lifecycle] entered background")
    }

    func handleForegroundReturn() {
        let suspendDuration: TimeInterval
        if let enteredAt = backgroundEnteredAt {
            suspendDuration = Date().timeIntervalSince(enteredAt)
        } else {
            suspendDuration = 0
        }
        backgroundEnteredAt = nil
        print("[Lifecycle] foreground return, suspend=\(String(format: "%.1f", suspendDuration))s, connected=\(state.bridgeConnected)")

        // Sync display brightness on foreground return
        #if os(iOS)
        displaySync.handleForegroundReturn(hostDisplayOn: state.hostDisplayOn)
        #endif

        if !state.bridgeConnected {
            // Not connected — restart discovery
            restartWaterfall()
        } else if suspendDuration > 20 {
            // Long suspend — socket is certainly dead (server terminates after ~30s)
            print("[Lifecycle] long suspend (\(Int(suspendDuration))s) — force reconnect")
            connection.forceDisconnectAndRestart()
            restartWaterfall()
        } else if suspendDuration > 5 {
            // Medium suspend — check if socket is still alive
            print("[Lifecycle] medium suspend (\(Int(suspendDuration))s) — health check")
            connection.forceHealthCheck { [weak self] alive in
                guard let self else { return }
                if !alive {
                    print("[Lifecycle] health check failed — reconnecting")
                    self.connection.forceDisconnectAndRestart()
                    self.restartWaterfall()
                } else {
                    print("[Lifecycle] health check passed")
                    self.connection.startPingTimer()
                }
            }
            return  // Don't restart ping timer yet — health check callback will
        } else {
            // Short suspend — just restart ping timer
            connection.startPingTimer()
        }
    }

    private func restartWaterfall() {
        // Force reset waterfall stage so startConnectionWaterfall() can enter
        waterfallStage = .idle
        connection.resetReconnectCount()
        startConnectionWaterfall()
    }

    // MARK: - Connection Waterfall

    func startConnectionWaterfall() {
        guard waterfallStage == .idle else {
            print("[Waterfall] already in stage \(waterfallStage), skipping")
            return
        }
        isAutoConnecting = true
        print("[Waterfall] starting waterfall")

        #if os(macOS)
        // Stage 1: Check sessions.json (macOS only)
        waterfallStage = .localSession
        localDiscovery.startPolling()

        // Give local discovery a moment to scan
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, self.waterfallStage == .localSession else { return }

            if let bridge = self.localDiscovery.sessions.first {
                self.connectTo(bridge)
                return
            }

            // Stage 2: Try saved URL
            self.trySavedUrl()
        }
        #else
        // iOS: skip local session, go to saved URL
        trySavedUrl()
        #endif
    }

    private func trySavedUrl() {
        if let url = savedUrl {
            print("[Waterfall] trying saved URL: \(url)")
            waterfallStage = .savedUrl
            connectTo(url: url)

            // Timeout: if not connected within 3 seconds, fall through to mDNS
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, self.waterfallStage == .savedUrl else { return }
                if !self.state.bridgeConnected {
                    print("[Waterfall] saved URL timeout, falling through to mDNS")
                    self.connection.disconnect(reconnect: false)
                    self.startMdnsDiscovery()
                }
            }
        } else {
            print("[Waterfall] no saved URL, going to mDNS")
            startMdnsDiscovery()
        }
    }

    private func startMdnsDiscovery() {
        print("[Waterfall] starting mDNS discovery")
        waterfallStage = .mdns
        discovery.startSearching()

        #if os(macOS)
        // Keep local discovery running alongside mDNS on macOS
        localDiscovery.startPolling()
        #endif

        // Poll for discovered bridges and auto-connect to the first one
        startAutoConnectPolling()
    }

    private var autoConnectTimer: Timer?
    private var autoConnectPollCount = 0

    private func startAutoConnectPolling() {
        autoConnectPollCount = 0
        autoConnectTimer?.invalidate()
        autoConnectTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            guard self.waterfallStage == .mdns else {
                print("[AutoConnect] timer stopped: stage=\(self.waterfallStage)")
                timer.invalidate()
                self.autoConnectTimer = nil
                return
            }
            guard !self.state.bridgeConnected else {
                print("[AutoConnect] timer stopped: already connected")
                timer.invalidate()
                self.autoConnectTimer = nil
                return
            }

            // Skip if already trying to connect
            if self.connection.status != .disconnected {
                print("[AutoConnect] skipping: connection status=\(self.connection.status)")
                return
            }

            // Clear blacklist when browseResults change (stale mDNS entries removed)
            let currentBrowseCount = self.discovery.bridges.count
            if currentBrowseCount != self.lastBrowseCount {
                if !self.failedBridgeIds.isEmpty {
                    print("[AutoConnect] browseResults changed (\(self.lastBrowseCount)→\(currentBrowseCount)), clearing \(self.failedBridgeIds.count) failed bridges")
                    self.failedBridgeIds.removeAll()
                }
                self.lastBrowseCount = currentBrowseCount
            }

            print("[AutoConnect] poll: bridges=\(self.discovery.bridges.count), failed=\(self.failedBridgeIds.count), searching=\(self.discovery.isSearching)")

            #if os(macOS)
            // Prefer local sessions on macOS
            if let local = self.localDiscovery.sessions.first {
                print("[AutoConnect] connecting to local session: \(local.wsUrl)")
                timer.invalidate()
                self.autoConnectTimer = nil
                self.connectTo(local)
                return
            }
            #endif

            // Filter out bridges that previously failed to connect (ghost mDNS entries)
            let candidates = self.discovery.bridges.filter { !self.failedBridgeIds.contains($0.id) }

            // Prefer daemon bridge for consistent state (daemon aggregates all sessions)
            let bridge = candidates.first(where: { $0.agentType == "daemon" })
                ?? candidates.first
            if let bridge {
                print("[AutoConnect] connecting to bridge: \(bridge.wsUrl) (agent=\(bridge.agentType ?? "?"))")
                timer.invalidate()
                self.autoConnectTimer = nil
                self.connectTo(bridge)
            }

            // After 10 seconds with no mDNS results, stop polling
            // (user can still manually enter URL via ConnectionOverlay)
            self.autoConnectPollCount += 1
            if self.autoConnectPollCount >= 20 {  // 20 × 0.5s = 10s
                print("[AutoConnect] giving up after 10s with no bridges found")
                timer.invalidate()
                self.autoConnectTimer = nil
                self.isAutoConnecting = false
            }
        }
    }

    // MARK: - Event Handler

    func handleEvent(_ event: BridgeEvent) {
        switch event {
        case .stateUpdate(let e):
            handleStateUpdate(e)
        case .usageUpdate(let e):
            handleUsageUpdate(e)
        case .connection(let e):
            handleConnection(e)
        case .voiceState(let e):
            state.voiceState = e.state
            state.voiceText = e.text
            state.voiceError = e.error
        case .displayState(let e):
            state.hostDisplayOn = e.displayOn
            displaySync.handleDisplayState(displayOn: e.displayOn, isAppActive: true)
        case .sessionsList(let e):
            state.siblingSessions = e.sessions
        case .promptOptions(let e):
            state.options = e.options
            state.promptType = PromptType(rawValue: e.promptType)
            state.question = e.question
        case .buttonState:
            break  // Deck UI removed
        case .encoderState:
            break  // Deck UI removed
        case .deckSlotMap:
            break  // Deck UI removed
        case .userPrompt:
            break  // handled by voice/deck UI
        case .timelineEvent(let e):
            timelineGenerator.receivingBridgeTimeline = true
            timelineStore.addEntry(e.entry, upsert: e.upsert ?? false)
            timelineVersion += 1
        case .timelineHistory(let e):
            timelineGenerator.receivingBridgeTimeline = true
            timelineStore.mergeHistory(e.entries)
            timelineVersion += 1
        }

        // Cache state for offline display
        if case .stateUpdate = event { lastKnownState = state }
        if case .usageUpdate = event { lastKnownState = state }
    }

    // MARK: - State Update

    private func handleStateUpdate(_ e: StateUpdateEvent) {
        // Null-coalescing: only update fields that are present
        state.state = AgentConnectionState(rawValue: e.state) ?? state.state
        if let pm = e.permissionMode { state.permissionMode = PermissionMode(rawValue: pm) ?? state.permissionMode }
        state.agentType = e.agentType ?? state.agentType
        state.agentCapabilities = e.agentCapabilities ?? state.agentCapabilities
        state.currentTool = e.currentTool ?? state.currentTool
        state.toolInput = e.toolInput ?? state.toolInput
        state.toolProgress = e.toolProgress ?? state.toolProgress
        state.projectName = e.projectName ?? state.projectName
        state.modelName = e.modelName ?? state.modelName
        state.effortLevel = e.effortLevel ?? state.effortLevel
        if let bt = e.billingType { state.billingType = BillingType(rawValue: bt) ?? state.billingType }
        if let opts = e.options { state.options = opts }
        if let pt = e.promptType { state.promptType = PromptType(rawValue: pt) }
        state.question = e.question ?? state.question
        state.navigable = e.navigable ?? state.navigable
        state.cursorIndex = e.cursorIndex ?? state.cursorIndex
        state.suggestedPrompt = e.suggestedPrompt ?? state.suggestedPrompt
        if let mc = e.modelCatalog { state.modelCatalog = mc }
        state.sessionStatus = e.sessionStatus ?? state.sessionStatus
        state.remoteUrl = e.remoteUrl ?? state.remoteUrl
        state.pairingUrl = e.pairingUrl ?? state.pairingUrl
        state.workerSessionCount = e.workerSessionCount ?? state.workerSessionCount
        if let os = e.ollamaStatus { state.ollamaStatus = os }
        state.gatewayAvailable = e.gatewayAvailable ?? state.gatewayAvailable
        state.gatewayHasError = e.gatewayHasError ?? state.gatewayHasError

        // Local timeline generation (when bridge doesn't provide rich timeline)
        timelineGenerator.onStateUpdate(
            newState: state.state,
            agentType: e.agentType,
            currentTool: e.currentTool,
            toolInput: e.toolInput,
            question: e.question
        )
        timelineVersion += 1

        // Clear tool info on idle
        if state.state == .idle {
            state.currentTool = nil
            state.toolInput = nil
            state.toolProgress = nil
        }

        // Clear options when not awaiting
        if !state.state.isAwaiting {
            state.options = []
            state.question = nil
            state.promptType = nil
        }
    }

    // MARK: - Usage Update

    private func handleUsageUpdate(_ e: UsageEvent) {
        state.sessionDurationSec = e.sessionDurationSec ?? state.sessionDurationSec
        state.inputTokens = e.inputTokens ?? state.inputTokens
        state.outputTokens = e.outputTokens ?? state.outputTokens
        state.toolCalls = e.toolCalls ?? state.toolCalls
        state.estimatedCostUsd = e.estimatedCostUsd ?? state.estimatedCostUsd
        state.sessionPercent = e.sessionPercent ?? state.sessionPercent
        state.costSpent = e.costSpent ?? state.costSpent
        state.costLimit = e.costLimit ?? state.costLimit
        state.resetTime = e.resetTime ?? state.resetTime
        state.resetDate = e.resetDate ?? state.resetDate
        state.fiveHourPercent = e.fiveHourPercent ?? state.fiveHourPercent
        state.fiveHourResetsAt = e.fiveHourResetsAt ?? state.fiveHourResetsAt
        state.sevenDayPercent = e.sevenDayPercent ?? state.sevenDayPercent
        state.sevenDayResetsAt = e.sevenDayResetsAt ?? state.sevenDayResetsAt
        state.extraUsageEnabled = e.extraUsageEnabled ?? state.extraUsageEnabled
        state.extraUsageMonthlyLimit = e.extraUsageMonthlyLimit ?? state.extraUsageMonthlyLimit
        state.extraUsageUsedCredits = e.extraUsageUsedCredits ?? state.extraUsageUsedCredits
        state.extraUsageUtilization = e.extraUsageUtilization ?? state.extraUsageUtilization
        state.oauthConnected = e.oauthConnected ?? state.oauthConnected
        if let os = e.ollamaStatus { state.ollamaStatus = os }
        state.usageStale = e.usageStale ?? state.usageStale
    }

    // MARK: - Connection

    private func handleConnection(_ e: ConnectionEvent) {
        switch e.status {
        case "connected":
            state.bridgeConnected = true
            state.sessionId = e.sessionId
            isAutoConnecting = false
            waterfallStage = .idle

            // Save successful URL for next launch
            if let url = connection.url {
                savedUrl = url
            }
        case "disconnected":
            resetToDisconnected()
        default:
            break
        }
    }

    private func resetToDisconnected() {
        timelineGenerator.onDisconnected()
        timelineVersion += 1
        // Preserve lastKnownState for offline display
        state.bridgeConnected = false
        state.state = .disconnected
        state.sessionId = nil
        state.hostDisplayOn = true
        #if os(iOS)
        displaySync.restoreOnDisconnect()
        #endif
        state.currentTool = nil
        state.toolInput = nil
        state.toolProgress = nil
        state.options = []
        state.question = nil
    }

    // MARK: - Commands

    func sendCommand(_ command: PluginCommand) {
        connection.send(command)
    }

    // MARK: - Connection Management

    func connectTo(_ bridge: DiscoveredBridge) {
        connection.connect(to: bridge.wsUrl)
    }

    func connectTo(url: String) {
        connection.connect(to: url)
    }

    func disconnectBridge() {
        connection.disconnect()
        resetToDisconnected()
        savedUrl = nil  // Clear saved URL on explicit disconnect
        waterfallStage = .idle
    }
}
