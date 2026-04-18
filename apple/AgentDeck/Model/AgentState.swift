// AgentState.swift — State enums & prompt types
// Ported from shared/src/states.ts

import Foundation

// MARK: - State

enum AgentConnectionState: String, Codable, Sendable, CaseIterable {
    case disconnected
    case idle
    case processing
    case awaitingPermission = "awaiting_permission"
    case awaitingOption = "awaiting_option"
    case awaitingDiff = "awaiting_diff"

    var isAwaiting: Bool {
        switch self {
        case .awaitingPermission, .awaitingOption, .awaitingDiff: true
        default: false
        }
    }

    var isActive: Bool {
        self == .processing
    }

    var displayLabel: String {
        switch self {
        case .disconnected: "DISCONNECTED"
        case .idle: "IDLE"
        case .processing: "PROCESSING"
        case .awaitingPermission: "PERMISSION"
        case .awaitingOption: "SELECT"
        case .awaitingDiff: "DIFF REVIEW"
        }
    }
}

// MARK: - Permission Mode

enum PermissionMode: String, Codable, Sendable {
    case `default`
    case plan
    case acceptEdits
    case dontAsk
    case bypassPermissions
}

// MARK: - Prompt Option

struct PromptOption: Codable, Sendable, Identifiable {
    let index: Int
    let label: String
    var shortcut: String?
    var recommended: Bool?
    var selected: Bool?

    var id: Int { index }
}

// MARK: - Prompt Type

enum PromptType: String, Codable, Sendable {
    case yesNo = "yes_no"
    case yesNoAlways = "yes_no_always"
    case multiSelect = "multi_select"
    case diffReview = "diff_review"
}

// MARK: - Dashboard State (composite observable state)

struct DashboardState: Sendable {
    // Connection
    var bridgeConnected = false
    var sessionId: String?

    // Agent state
    var state: AgentConnectionState = .disconnected
    var permissionMode: PermissionMode = .default
    var agentType: String?  // "claude-code" | "openclaw"
    var agentCapabilities: AgentCapabilities?

    // Tool info
    var currentTool: String?
    var toolInput: String?
    var toolProgress: String?

    // Project / Model
    var projectName: String?
    var modelName: String?
    var effortLevel: String?
    var billingType: BillingType = .unknown

    // Prompt
    var options: [PromptOption] = []
    var promptType: PromptType?
    var question: String?
    var navigable = false
    var cursorIndex = 0
    var suggestedPrompt: String?

    // Model catalog
    var modelCatalog: [ModelCatalogEntry] = []
    var sessionStatus: OcSessionStatus?

    // Remote / Gateway
    var remoteUrl: String?
    var pairingUrl: String?
    var workerSessionCount: Int?
    var gatewayAvailable = false
    var gatewayConnected = false
    var gatewayHasError = false
    var gatewayAuthStatus: String?
    var gatewayAuthRequestId: String?
    var gatewayAuthMessage: String?

    // Usage
    var sessionDurationSec = 0
    var inputTokens = 0
    var outputTokens = 0
    var toolCalls = 0
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
    var previousFiveHourPercent: Double?
    var previousSevenDayPercent: Double?
    var extraUsageEnabled: Bool?
    var extraUsageMonthlyLimit: Double?
    var extraUsageUsedCredits: Double?
    var extraUsageUtilization: Double?
    var oauthConnected: Bool?
    var ollamaStatus: OllamaStatus?
    var usageStale: Bool?
    var codexAuthMode: String?
    var codexWebAuthConnected: Bool?
    var codexPlanType: String?
    var codexAccountId: String?
    var codexSubscriptionActiveUntil: String?
    var codexLastRefreshAt: String?
    var mlxModels: [String] = []
    var subscriptions: [SubscriptionInfo] = []
    var antigravityStatus: AntigravityStatusInfo?

    // Voice
    var voiceState: String?  // idle | recording | transcribing | error
    var voiceText: String?
    var voiceError: String?

    // Voice Assistant (wake word pipeline)
    var voiceAssistantState: String?  // idle | listening | processing | speaking | disabled
    var voiceAssistantText: String?
    var voiceAssistantResponseText: String?

    // Display
    var hostDisplayOn = true

    // Multi-session
    var siblingSessions: [SessionInfo] = []

    // Device module health (from daemon statusSnapshot aggregation)
    var moduleHealth: ModuleHealthState?

}

// MARK: - Module Health

struct ModuleHealthState: Sendable {
    var adb: AdbHealth?
    var d200h: D200hHealth?
    var pixoo: PixooHealth?
    var serial: SerialHealth?
}

struct AdbHealth: Sendable {
    var available: Bool = false
    var devices: [String] = []
    var reverseReadyCount: Int = 0
    var lastError: String?
}

struct D200hHealth: Sendable {
    var connected: Bool = false
    var managerOpened: Bool = false
    var sandboxEnabled: Bool = false
    var usbEntitlementPresent: Bool = false
    var buttonPressCount: Int = 0
    var hidReportCount: Int = 0
    var writeOK: Int = 0
    var writeFail: Int = 0
    var lastWriteError: String?
    var lastOpenError: String?
}

struct PixooHealth: Sendable {
    var configuredDeviceCount: Int = 0
    var deviceIps: [String] = []
    var hasFrame: Bool = false
    var displayDimmed: Bool = false
    var lastPushError: String?
    var devices: [PixooDeviceHealth] = []
}

struct PixooDeviceHealth: Sendable {
    var ip: String
    var online: Bool
    var failures: Int
    var backedOff: Bool
}

struct SerialHealth: Sendable {
    var connectedPorts: [String] = []
    var lastError: String?
}
