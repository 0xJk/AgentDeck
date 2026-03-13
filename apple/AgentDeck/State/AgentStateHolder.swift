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

    // MARK: - Connection Waterfall State

    private(set) var isAutoConnecting = false
    private var waterfallStage: WaterfallStage = .idle

    private enum WaterfallStage {
        case idle
        case localSession    // macOS: reading sessions.json
        case savedUrl        // trying last known URL
        case mdns            // mDNS discovery
    }

    // MARK: - Init

    init() {
        connection.onEvent = { [weak self] event in
            self?.handleEvent(event)
        }
        connection.onReconnectExhausted = { [weak self] in
            guard let self else { return }
            self.savedUrl = nil
            self.waterfallStage = .idle
            self.startConnectionWaterfall()
        }

        #if os(macOS)
        // On each reconnect attempt, check sessions.json for a local bridge.
        // If found, abort stale-URL reconnect and connect locally instead.
        connection.onReconnectAttempt = { [weak self] in
            guard let self else { return false }
            let bridges = self.localDiscovery.readSessionsNow()
            if let bridge = bridges.first {
                DispatchQueue.main.async {
                    self.savedUrl = nil
                    self.waterfallStage = .idle
                    self.connectTo(bridge)
                }
                return true  // abort reconnect
            }
            return false
        }
        #endif
    }

    // MARK: - Connection Waterfall

    func startConnectionWaterfall() {
        guard waterfallStage == .idle else { return }
        isAutoConnecting = true

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
            waterfallStage = .savedUrl
            connectTo(url: url)

            // Timeout: if not connected within 3 seconds, fall through to mDNS
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, self.waterfallStage == .savedUrl else { return }
                if !self.state.bridgeConnected {
                    self.connection.disconnect(reconnect: false)
                    self.startMdnsDiscovery()
                }
            }
        } else {
            startMdnsDiscovery()
        }
    }

    private func startMdnsDiscovery() {
        waterfallStage = .mdns
        discovery.startSearching()

        #if os(macOS)
        // Keep local discovery running alongside mDNS on macOS
        localDiscovery.startPolling()
        #endif
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
        case .sessionsList(let e):
            state.siblingSessions = e.sessions
        case .promptOptions(let e):
            state.options = e.options
            state.promptType = PromptType(rawValue: e.promptType)
            state.question = e.question
        case .buttonState(let e):
            state.buttonStates = e.buttons
        case .encoderState(let e):
            state.encoderStates = e.encoders
            state.encoderTakeoverActive = e.takeoverActive ?? false
        case .deckSlotMap(let e):
            if let buttons = e.buttons { state.buttonSlotMap = buttons }
            if let encoders = e.encoders { state.encoderSlotMap = encoders }
        case .userPrompt:
            break  // handled by voice/deck UI
        case .timelineEvent(let e):
            timelineStore.addEntry(e.entry, upsert: e.upsert ?? false)
        case .timelineHistory(let e):
            timelineStore.mergeHistory(e.entries)
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
        // Preserve lastKnownState for offline display
        state.bridgeConnected = false
        state.state = .disconnected
        state.sessionId = nil
        state.hostDisplayOn = true
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
