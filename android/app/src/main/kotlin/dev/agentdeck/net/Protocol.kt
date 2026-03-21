package dev.agentdeck.net

import android.util.Log
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive

@Serializable
enum class AgentState {
    @SerialName("disconnected") DISCONNECTED,
    @SerialName("idle") IDLE,
    @SerialName("processing") PROCESSING,
    @SerialName("awaiting_permission") AWAITING_PERMISSION,
    @SerialName("awaiting_option") AWAITING_OPTION,
    @SerialName("awaiting_diff") AWAITING_DIFF,
}

@Serializable
enum class PermissionMode {
    @SerialName("default") DEFAULT,
    @SerialName("plan") PLAN,
    @SerialName("acceptEdits") ACCEPT_EDITS,
    @SerialName("dontAsk") DONT_ASK,
    @SerialName("bypassPermissions") BYPASS_PERMISSIONS,
}

@Serializable
data class AgentCapabilities(
    val type: String? = null,
    val displayName: String? = null,
    val hasTerminal: Boolean = false,
    val hasModeSwitching: Boolean = false,
    val hasDiffReview: Boolean = false,
    val hasOptionLists: Boolean = false,
    val hasNavigablePrompts: Boolean = false,
    val hasSuggestedPrompts: Boolean = false,
    val hasApiUsage: Boolean = false,
    val hasModelCatalog: Boolean = false,
)

@Serializable
data class ModelCatalogEntry(
    val name: String,
    val role: String? = null,
    val available: Boolean = true,
)

@Serializable
data class OcSessionStatus(
    val model: String? = null,
    val contextTokens: Int? = null,
    val messageCount: Int? = null,
    val uptime: String? = null,
    val sessionId: String? = null,
)

@Serializable
data class PromptOption(
    val label: String,
    val value: String? = null,
    val description: String? = null,
    val index: Int? = null,
    val shortcut: String? = null,
    val recommended: Boolean? = null,
    val selected: Boolean? = null,
)

@Serializable
data class StateUpdate(
    val state: AgentState = AgentState.DISCONNECTED,
    val permissionMode: PermissionMode = PermissionMode.DEFAULT,
    val agentType: String? = null,
    val currentTool: String? = null,
    val toolInput: String? = null,
    val toolProgress: String? = null,
    val projectName: String? = null,
    val modelName: String? = null,
    val effortLevel: String? = null,
    val billingType: String? = null,
    val options: List<PromptOption>? = null,
    val promptType: String? = null,
    val question: String? = null,
    val suggestedPrompt: String? = null,
    val remoteUrl: String? = null,
    val navigable: Boolean? = null,
    val cursorIndex: Int? = null,
    val agentCapabilities: AgentCapabilities? = null,
    val modelCatalog: List<ModelCatalogEntry>? = null,
    val sessionStatus: OcSessionStatus? = null,
    val pairingUrl: String? = null,
    val workerSessionCount: Int? = null,
    val ollamaStatus: OllamaStatus? = null,
    val gatewayAvailable: Boolean? = null,
    val gatewayHasError: Boolean? = null,
    val voiceAssistantState: String? = null,
    val voiceAssistantText: String? = null,
    val voiceAssistantResponseText: String? = null,
)

@Serializable
data class UsageUpdate(
    val sessionDurationSec: Int = 0,
    val inputTokens: Int = 0,
    val outputTokens: Int = 0,
    val toolCalls: Int = 0,
    val estimatedCostUsd: Double? = null,
    val fiveHourPercent: Double? = null,
    val sevenDayPercent: Double? = null,
    val fiveHourResetsAt: String? = null,
    val sevenDayResetsAt: String? = null,
    val extraUsageEnabled: Boolean? = null,
    val extraUsageMonthlyLimit: Double? = null,
    val extraUsageUsedCredits: Double? = null,
    val extraUsageUtilization: Double? = null,
    val sessionPercent: Double? = null,
    val costSpent: Double? = null,
    val costLimit: Double? = null,
    val resetTime: String? = null,
    val resetDate: String? = null,
    val oauthConnected: Boolean? = null,
    val ollamaStatus: OllamaStatus? = null,
    val usageStale: Boolean? = null,
    val tokenStatus: String? = null,  // "valid" | "expired" | "missing" | "unknown"
)

@Serializable
data class OllamaModel(
    val name: String,
    val size: Long = 0,
    val sizeVram: Long = 0,
)

@Serializable
data class OllamaStatus(
    val available: Boolean = false,
    val models: List<OllamaModel> = emptyList(),
)

@Serializable
data class VoiceState(
    val state: String = "idle",
    val text: String? = null,
    val error: String? = null,
)

// --- Button state (Bridge → Android) ---

@Serializable
data class ButtonSlotState(
    val slot: Int,
    val title: String,
    val subtitle: String? = null,
    val bgColor: String,
    val textColor: String,
    val enabled: Boolean = true,
    val icon: String? = null,
    val badge: String? = null,
    val action: String? = null,
    val dim: Boolean = false,
)

// --- Encoder LCD state (Bridge → Android) ---

@Serializable
data class EncoderSlotState(
    val slot: Int,
    val encoderType: String,
    val header: String,
    val value: String? = null,
    val icon: String? = null,
    val accentColor: String = "#94A3B8",
    val progress: Float? = null,
    val counter: String? = null,
    val detail: String? = null,
    val voiceState: String? = null,
    val recordingMs: Long? = null,
    val transcription: String? = null,
)

@Serializable
data class DeckSlotConfig(
    val slot: Int,
    val actionType: String,
    val settings: Map<String, JsonElement>? = null,
)

// --- Multi-session discovery ---

@Serializable
data class SessionInfo(
    val id: String,
    val port: Int,
    val projectName: String? = null,
    val agentType: String? = null,
    val alive: Boolean = true,
    val state: String? = null,
)

// --- Bridge timeline entry (rich OpenClaw events) ---

@Serializable
data class BridgeTimelineEntry(
    val ts: Long,
    val type: String,
    val raw: String,
    val detail: String? = null,
    val approvalId: String? = null,
    val status: String? = null,
    val agentType: String? = null,
)

fun BridgeTimelineEntry.toTimelineEntry() = dev.agentdeck.state.TimelineEntry(
    timestamp = ts,
    type = type,
    summary = raw,
    detail = detail,
    agentType = agentType,
    status = status,
)

sealed class BridgeEvent {
    data class State(val data: StateUpdate) : BridgeEvent()
    data class Usage(val data: UsageUpdate) : BridgeEvent()
    data class Voice(val data: VoiceState) : BridgeEvent()
    data class Connected(val sessionId: String?) : BridgeEvent()
    data object Disconnected : BridgeEvent()
    data class DisplaySleep(val displayOn: Boolean) : BridgeEvent()
    data class SessionsList(val sessions: List<SessionInfo>) : BridgeEvent()
    data class EncoderState(val encoders: List<EncoderSlotState>, val takeoverActive: Boolean) : BridgeEvent()
    data class ButtonState(val buttons: List<ButtonSlotState>) : BridgeEvent()
    data class SlotMap(val buttons: List<DeckSlotConfig>, val encoders: List<DeckSlotConfig>) : BridgeEvent()
    data class Timeline(val entry: BridgeTimelineEntry, val upsert: Boolean = false) : BridgeEvent()
    data class TimelineHistory(val entries: List<BridgeTimelineEntry>) : BridgeEvent()
    data class UserPrompt(val text: String) : BridgeEvent()
}

// --- App -> Bridge commands ---

object PluginCommands {
    fun respond(value: String): String =
        """{"type":"respond","value":${Json.encodeToString(kotlinx.serialization.serializer<String>(), value)}}"""

    fun selectOption(index: Int): String =
        """{"type":"select_option","index":$index}"""

    fun sendPrompt(text: String): String =
        """{"type":"send_prompt","text":${Json.encodeToString(kotlinx.serialization.serializer<String>(), text)}}"""

    fun interrupt(): String = """{"type":"interrupt"}"""

    fun escape(): String = """{"type":"escape"}"""

    fun queryUsage(): String = """{"type":"query_usage"}"""

    fun switchMode(): String = """{"type":"switch_mode"}"""

    fun utility(action: String, value: Int? = null): String {
        val valueStr = if (value != null) ""","value":$value""" else ""
        return """{"type":"utility","action":"$action"$valueStr}"""
    }

    fun navigateOption(direction: String): String =
        """{"type":"navigate_option","direction":"$direction"}"""
}

// --- JSON parsing ---

val protocolJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    coerceInputValues = true
}

fun parseBridgeMessage(text: String): BridgeEvent? {
    return try {
        val element = protocolJson.parseToJsonElement(text)
        val obj = element.jsonObject
        val type = obj["type"]?.jsonPrimitive?.content ?: return null

        when (type) {
            "state_update" -> {
                val data = protocolJson.decodeFromJsonElement<StateUpdate>(element)
                BridgeEvent.State(data)
            }
            "usage_update" -> {
                val data = protocolJson.decodeFromJsonElement<UsageUpdate>(element)
                BridgeEvent.Usage(data)
            }
            "voice_state" -> {
                val data = protocolJson.decodeFromJsonElement<VoiceState>(element)
                BridgeEvent.Voice(data)
            }
            "connection" -> {
                val status = obj["status"]?.jsonPrimitive?.content
                val sessionId = obj["sessionId"]?.jsonPrimitive?.content
                if (status == "connected") BridgeEvent.Connected(sessionId)
                else BridgeEvent.Disconnected
            }
            "display_state" -> {
                val displayOn = obj["displayOn"]?.jsonPrimitive?.boolean ?: true
                BridgeEvent.DisplaySleep(displayOn)
            }
            "sessions_list" -> {
                val sessionsArray = obj["sessions"]
                if (sessionsArray != null) {
                    val sessions = protocolJson.decodeFromJsonElement<List<SessionInfo>>(sessionsArray)
                    BridgeEvent.SessionsList(sessions)
                } else null
            }
            "encoder_state" -> {
                val encodersArray = obj["encoders"]
                val takeoverActive = obj["takeoverActive"]?.jsonPrimitive?.boolean ?: false
                if (encodersArray != null) {
                    val encoders = protocolJson.decodeFromJsonElement<List<EncoderSlotState>>(encodersArray)
                    BridgeEvent.EncoderState(encoders, takeoverActive)
                } else null
            }
            "button_state" -> {
                val buttonsArray = obj["buttons"]
                if (buttonsArray != null) {
                    val buttons = protocolJson.decodeFromJsonElement<List<ButtonSlotState>>(buttonsArray)
                    BridgeEvent.ButtonState(buttons)
                } else null
            }
            "deck_slot_map" -> {
                val buttonsArray = obj["buttons"]
                val encodersArray = obj["encoders"]
                if (buttonsArray != null && encodersArray != null) {
                    val buttons = protocolJson.decodeFromJsonElement<List<DeckSlotConfig>>(buttonsArray)
                    val encoders = protocolJson.decodeFromJsonElement<List<DeckSlotConfig>>(encodersArray)
                    BridgeEvent.SlotMap(buttons, encoders)
                } else null
            }
            "user_prompt" -> {
                val promptText = obj["text"]?.jsonPrimitive?.content
                if (promptText != null) BridgeEvent.UserPrompt(promptText) else null
            }
            "timeline_event" -> {
                val entryObj = obj["entry"]
                val isUpsert = obj["upsert"]?.jsonPrimitive?.boolean ?: false
                if (entryObj != null) {
                    val entry = protocolJson.decodeFromJsonElement<BridgeTimelineEntry>(entryObj)
                    BridgeEvent.Timeline(entry, isUpsert)
                } else null
            }
            "timeline_history" -> {
                val entriesArray = obj["entries"]
                if (entriesArray != null) {
                    val entries = protocolJson.decodeFromJsonElement<List<BridgeTimelineEntry>>(entriesArray)
                    BridgeEvent.TimelineHistory(entries)
                } else null
            }
            else -> null
        }
    } catch (e: Exception) {
        Log.e("Terrarium", "parseBridgeMessage failed: ${e.message}, raw=${text.take(300)}")
        null
    }
}
