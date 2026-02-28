package dev.agentdeck.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
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
    val uptime: Int? = null,
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
)

@Serializable
data class VoiceState(
    val state: String = "idle",
    val text: String? = null,
    val error: String? = null,
)

sealed class BridgeEvent {
    data class State(val data: StateUpdate) : BridgeEvent()
    data class Usage(val data: UsageUpdate) : BridgeEvent()
    data class Voice(val data: VoiceState) : BridgeEvent()
    data class Connected(val sessionId: String?) : BridgeEvent()
    data object Disconnected : BridgeEvent()
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
            else -> null
        }
    } catch (_: Exception) {
        null
    }
}
