// Protocol.swift — Bridge ↔ Client communication types
// Ported from shared/src/protocol.ts

import Foundation

// MARK: - Constants

enum BridgeConstants {
    static let wsPort = 9120
    static let httpPort = 9120
    static let reconnectIntervalMs = 3000
    static let stuckTimeoutMs = 5 * 60 * 1000
    static let wsPingIntervalMs = 15000
    static let wsActivityTimeoutMs = 30000
}

// MARK: - Enums

enum BillingType: String, Codable, Sendable {
    case subscription
    case api
    case unknown
}

// MARK: - Model / Session

struct ModelCatalogEntry: Codable, Sendable {
    let key: String
    let name: String
    let role: String  // "default" | "fallback-{n}" | "configured"
    let available: Bool

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decodeIfPresent(String.self, forKey: .key) ?? ""
        name = try container.decode(String.self, forKey: .name)
        role = try container.decode(String.self, forKey: .role)
        available = try container.decode(Bool.self, forKey: .available)
    }
}

struct OcSessionStatus: Codable, Sendable {
    var model: String?
    var contextTokens: Int?
    var messageCount: Int?
    var uptime: String?
    var sessionId: String?
}

// MARK: - Ollama

struct OllamaModel: Codable, Sendable {
    let name: String
    let size: Int
    let sizeVram: Int
}

struct OllamaStatus: Codable, Sendable {
    let available: Bool
    let models: [OllamaModel]
}

struct SubscriptionInfo: Codable, Sendable {
    let name: String
    var until: String?
}

struct AntigravityStatusInfo: Codable, Sendable {
    var planName: String?
    var availableCredits: Int?
    var minimumCreditAmountForUsage: Int?
}

// MARK: - Button / Encoder State (Bridge → Client)

struct ButtonSlotState: Codable, Sendable {
    let slot: Int
    let title: String
    var subtitle: String?
    let bgColor: String
    let textColor: String
    let enabled: Bool
    var icon: String?
    var badge: String?
    var action: String?
    var dim: Bool?
}

struct EncoderSlotState: Codable, Sendable {
    let slot: Int
    let encoderType: String  // utility | action | terminal | voice
    let header: String
    var value: String?
    var icon: String?
    let accentColor: String
    var progress: Double?
    var counter: String?
    var detail: String?
    var voiceState: String?  // idle | recording | transcribing | error | review
    var recordingMs: Int?
    var transcription: String?
}

struct DeckSlotConfig: Codable, Sendable {
    let slot: Int
    let actionType: String
    var settings: [String: AnyCodable]?
}

// MARK: - Session Info

struct SessionInfo: Codable, Sendable, Identifiable {
    let id: String
    let port: Int
    let projectName: String?
    var agentType: String?
    var alive: Bool = true
    var state: String?
    var modelName: String?
    var startedAt: String?
}

// MARK: - Bridge Events (Bridge → Client)

struct StateUpdateEvent: Codable, Sendable {
    let type: String  // "state_update"
    let state: String
    var permissionMode: String?
    var agentType: String?
    var agentCapabilities: AgentCapabilities?
    var currentTool: String?
    var toolInput: String?
    var toolProgress: String?
    var projectName: String?
    var modelName: String?
    var effortLevel: String?
    var billingType: String?
    var options: [PromptOption]?
    var promptType: String?
    var question: String?
    var navigable: Bool?
    var cursorIndex: Int?
    var suggestedPrompt: String?
    var modelCatalog: [ModelCatalogEntry]?
    var sessionStatus: OcSessionStatus?
    var remoteUrl: String?
    var pairingUrl: String?
    var workerSessionCount: Int?
    var ollamaStatus: OllamaStatus?
    var mlxModels: [String]?
    var subscriptions: [SubscriptionInfo]?
    var antigravityStatus: AntigravityStatusInfo?
    var gatewayAvailable: Bool?
    var gatewayHasError: Bool?
    var voiceAssistantState: String?  // idle | listening | processing | speaking | disabled
    var voiceAssistantText: String?
    var voiceAssistantResponseText: String?
}

struct UsageEvent: Codable, Sendable {
    let type: String  // "usage_update"
    var sessionDurationSec: Int?
    var inputTokens: Int?
    var outputTokens: Int?
    var toolCalls: Int?
    var estimatedCostUsd: Double?
    var sessionPercent: Double?
    var costSpent: Double?
    var costLimit: Double?
    var resetTime: String?
    var resetDate: String?
    var fiveHourPercent: Double?
    var fiveHourResetsAt: String?
    var sevenDayPercent: Double?
    var sevenDayResetsAt: String?
    var extraUsageEnabled: Bool?
    var extraUsageMonthlyLimit: Double?
    var extraUsageUsedCredits: Double?
    var extraUsageUtilization: Double?
    var oauthConnected: Bool?
    var ollamaStatus: OllamaStatus?
    var usageStale: Bool?
    var tokenStatus: String?  // "valid" | "expired" | "missing" | "unknown"
    var codexAuthMode: String?
    var codexWebAuthConnected: Bool?
    var codexPlanType: String?
    var codexAccountId: String?
    var codexSubscriptionActiveUntil: String?
    var codexLastRefreshAt: String?
    var modelCatalog: [ModelCatalogEntry]?
    var mlxModels: [String]?
    var subscriptions: [SubscriptionInfo]?
    var antigravityStatus: AntigravityStatusInfo?
}

struct ConnectionEvent: Codable, Sendable {
    let type: String  // "connection"
    let status: String  // connected | reconnecting | disconnected
    var sessionId: String?
}

struct VoiceStateEvent: Codable, Sendable {
    let type: String  // "voice_state"
    let state: String  // idle | recording | transcribing | error
    var text: String?
    var error: String?
}

struct DisplayStateEvent: Codable, Sendable {
    let type: String  // "display_state"
    let displayOn: Bool
}

struct SessionsListEvent: Codable, Sendable {
    let type: String  // "sessions_list"
    let sessions: [SessionInfo]
}

struct PromptOptionsEvent: Codable, Sendable {
    let type: String  // "prompt_options"
    let promptType: String
    var question: String?
    let options: [PromptOption]
}

struct ButtonStateEvent: Codable, Sendable {
    let type: String  // "button_state"
    let buttons: [ButtonSlotState]
}

struct EncoderStateEvent: Codable, Sendable {
    let type: String  // "encoder_state"
    let encoders: [EncoderSlotState]
    var takeoverActive: Bool?
}

struct DeckSlotMapEvent: Codable, Sendable {
    let type: String  // "deck_slot_map"
    var buttons: [DeckSlotConfig]?
    var encoders: [DeckSlotConfig]?
}

struct UserPromptEvent: Codable, Sendable {
    let type: String  // "user_prompt"
    let text: String
}

// MARK: - Timeline Events

struct TimelineEventMsg: Codable, Sendable {
    let type: String  // "timeline_event"
    let entry: TimelineEntry
    var upsert: Bool?
}

struct TimelineHistoryMsg: Codable, Sendable {
    let type: String  // "timeline_history"
    let entries: [TimelineEntry]
}

// MARK: - Bridge Event Union

enum BridgeEvent: Sendable {
    case stateUpdate(StateUpdateEvent)
    case usageUpdate(UsageEvent)
    case connection(ConnectionEvent)
    case voiceState(VoiceStateEvent)
    case displayState(DisplayStateEvent)
    case sessionsList(SessionsListEvent)
    case promptOptions(PromptOptionsEvent)
    case buttonState(ButtonStateEvent)
    case encoderState(EncoderStateEvent)
    case deckSlotMap(DeckSlotMapEvent)
    case userPrompt(UserPromptEvent)
    case timelineEvent(TimelineEventMsg)
    case timelineHistory(TimelineHistoryMsg)
}

// MARK: - Plugin Commands (Client → Bridge)

enum PluginCommand: Encodable, Sendable {
    case respond(value: String)
    case selectOption(index: Int)
    case navigateOption(direction: String)
    case sendPrompt(text: String)
    case switchMode(mode: String?)
    case interrupt
    case escape
    case voice(action: String)
    case queryUsage
    case diag(action: String)
    case utility(action: String, value: Int?)
    case focusSession(sessionId: String)

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicCodingKey.self)
        switch self {
        case .respond(let value):
            try container.encode("respond", forKey: .init("type"))
            try container.encode(value, forKey: .init("value"))
        case .selectOption(let index):
            try container.encode("select_option", forKey: .init("type"))
            try container.encode(index, forKey: .init("index"))
        case .navigateOption(let direction):
            try container.encode("navigate_option", forKey: .init("type"))
            try container.encode(direction, forKey: .init("direction"))
        case .sendPrompt(let text):
            try container.encode("send_prompt", forKey: .init("type"))
            try container.encode(text, forKey: .init("text"))
        case .switchMode(let mode):
            try container.encode("switch_mode", forKey: .init("type"))
            if let mode { try container.encode(mode, forKey: .init("mode")) }
        case .interrupt:
            try container.encode("interrupt", forKey: .init("type"))
        case .escape:
            try container.encode("escape", forKey: .init("type"))
        case .voice(let action):
            try container.encode("voice", forKey: .init("type"))
            try container.encode(action, forKey: .init("action"))
        case .queryUsage:
            try container.encode("query_usage", forKey: .init("type"))
        case .diag(let action):
            try container.encode("diag", forKey: .init("type"))
            try container.encode(action, forKey: .init("action"))
        case .utility(let action, let value):
            try container.encode("utility", forKey: .init("type"))
            try container.encode(action, forKey: .init("action"))
            if let value { try container.encode(value, forKey: .init("value")) }
        case .focusSession(let sessionId):
            try container.encode("focus_session", forKey: .init("type"))
            try container.encode(sessionId, forKey: .init("sessionId"))
        }
    }
}

// MARK: - Helpers

struct DynamicCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init(_ string: String) { self.stringValue = string; self.intValue = nil }
    init?(stringValue: String) { self.stringValue = stringValue; self.intValue = nil }
    init?(intValue: Int) { self.stringValue = "\(intValue)"; self.intValue = intValue }
}

/// Type-erased Codable wrapper for heterogeneous dictionaries
struct AnyCodable: Codable, @unchecked Sendable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let b = try? container.decode(Bool.self) { value = b }
        else if let i = try? container.decode(Int.self) { value = i }
        else if let d = try? container.decode(Double.self) { value = d }
        else if let s = try? container.decode(String.self) { value = s }
        else if let a = try? container.decode([AnyCodable].self) { value = a.map(\.value) }
        else if let o = try? container.decode([String: AnyCodable].self) { value = o.mapValues(\.value) }
        else { value = NSNull() }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let b as Bool: try container.encode(b)
        case let i as Int: try container.encode(i)
        case let d as Double: try container.encode(d)
        case let s as String: try container.encode(s)
        default: try container.encodeNil()
        }
    }
}
