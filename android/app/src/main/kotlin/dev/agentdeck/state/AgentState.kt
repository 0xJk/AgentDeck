package dev.agentdeck.state

import dev.agentdeck.net.AgentCapabilities
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeEvent
import dev.agentdeck.net.ModelCatalogEntry
import dev.agentdeck.net.OcSessionStatus
import dev.agentdeck.net.OllamaStatus
import dev.agentdeck.net.PermissionMode
import dev.agentdeck.net.PromptOption
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.net.SubscriptionInfo
import dev.agentdeck.net.AntigravityStatusInfo
import dev.agentdeck.net.StateUpdate
import dev.agentdeck.net.UsageUpdate
import dev.agentdeck.net.VoiceState
import dev.agentdeck.net.toTimelineEntry
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

private const val TAG = "Terrarium"
private val AGGREGATE_AGENT_TYPES = setOf("daemon", "openclaw")

data class DashboardState(
    val agentState: AgentState = AgentState.DISCONNECTED,
    val permissionMode: PermissionMode = PermissionMode.DEFAULT,
    val agentType: String? = null,
    val currentTool: String? = null,
    val toolInput: String? = null,
    val toolProgress: String? = null,
    val projectName: String? = null,
    val modelName: String? = null,
    val effortLevel: String? = null,
    val billingType: String? = null,
    val options: List<PromptOption> = emptyList(),
    val promptType: String? = null,
    val question: String? = null,
    val suggestedPrompt: String? = null,
    val remoteUrl: String? = null,
    val usage: UsageUpdate = UsageUpdate(),
    val voice: VoiceState = VoiceState(),
    val sessionId: String? = null,
    val bridgeConnected: Boolean = false,
    val agentCapabilities: AgentCapabilities? = null,
    val modelCatalog: List<ModelCatalogEntry>? = null,
    val sessionStatus: OcSessionStatus? = null,
    val pairingUrl: String? = null,
    val navigable: Boolean? = null,
    val cursorIndex: Int? = null,
    val hostDisplayOn: Boolean = true,
    val siblingSessions: List<SessionInfo> = emptyList(),
    val workerSessionCount: Int? = null,
    val oauthConnected: Boolean? = null,
    val ollamaStatus: OllamaStatus? = null,
    val gatewayAvailable: Boolean? = null,
    val gatewayConnected: Boolean? = null,
    val gatewayHasError: Boolean? = null,
    val voiceAssistantState: String? = null,
    val voiceAssistantText: String? = null,
    val voiceAssistantResponseText: String? = null,
    val mlxModels: List<String> = emptyList(),
    val subscriptions: List<SubscriptionInfo> = emptyList(),
    val antigravityStatus: AntigravityStatusInfo? = null,
)

class AgentStateHolder private constructor() {

    companion object {
        val instance: AgentStateHolder by lazy { AgentStateHolder() }
    }

    private val _state = MutableStateFlow(DashboardState())
    val state: StateFlow<DashboardState> = _state.asStateFlow()

    /** Last known state for offline cache display */
    private var lastKnownState: DashboardState? = null

    init {
        BridgeConnection.instance.onEvent = ::handleEvent
    }

    fun getLastKnownState(): DashboardState? = lastKnownState

    private fun handleEvent(event: BridgeEvent) {
        when (event) {
            is BridgeEvent.State -> {
                Log.d(TAG, "StateEvent: state=${event.data.state}, agentType=${event.data.agentType}, tool=${event.data.currentTool}")
                _state.update { current ->
                    val keepAggregateIdentity =
                        current.agentType in AGGREGATE_AGENT_TYPES &&
                            event.data.agentType != null &&
                            event.data.agentType !in AGGREGATE_AGENT_TYPES &&
                            current.siblingSessions.isNotEmpty()
                    val resolvedAgentType = when {
                        keepAggregateIdentity -> current.agentType
                        else -> event.data.agentType ?: current.agentType
                    }
                    Log.d(TAG, "AgentType resolve: event=${event.data.agentType}, current=${current.agentType}, resolved=$resolvedAgentType")
                    current.copy(
                        agentState = event.data.state,
                        permissionMode = event.data.permissionMode,
                        agentType = resolvedAgentType,
                        currentTool = event.data.currentTool,
                        toolInput = event.data.toolInput,
                        toolProgress = event.data.toolProgress,
                        projectName = if (keepAggregateIdentity) current.projectName else event.data.projectName ?: current.projectName,
                        modelName = if (keepAggregateIdentity) current.modelName else event.data.modelName ?: current.modelName,
                        effortLevel = if (keepAggregateIdentity) current.effortLevel else event.data.effortLevel ?: current.effortLevel,
                        billingType = event.data.billingType ?: current.billingType,
                        options = event.data.options ?: emptyList(),
                        promptType = event.data.promptType,
                        question = event.data.question,
                        suggestedPrompt = event.data.suggestedPrompt,
                        remoteUrl = event.data.remoteUrl ?: current.remoteUrl,
                        agentCapabilities = event.data.agentCapabilities ?: current.agentCapabilities,
                        modelCatalog = event.data.modelCatalog ?: current.modelCatalog,
                        sessionStatus = event.data.sessionStatus ?: current.sessionStatus,
                        pairingUrl = event.data.pairingUrl ?: current.pairingUrl,
                        navigable = event.data.navigable,
                        cursorIndex = event.data.cursorIndex,
                        workerSessionCount = event.data.workerSessionCount ?: current.workerSessionCount,
                        ollamaStatus = event.data.ollamaStatus ?: current.ollamaStatus,
                        mlxModels = event.data.mlxModels ?: current.mlxModels,
                        subscriptions = event.data.subscriptions ?: current.subscriptions,
                        antigravityStatus = event.data.antigravityStatus ?: current.antigravityStatus,
                        gatewayAvailable = event.data.gatewayAvailable ?: current.gatewayAvailable,
                        gatewayConnected = event.data.gatewayConnected ?: current.gatewayConnected,
                        gatewayHasError = event.data.gatewayHasError ?: current.gatewayHasError,
                        voiceAssistantState = event.data.voiceAssistantState ?: current.voiceAssistantState,
                        voiceAssistantText = event.data.voiceAssistantText,
                        voiceAssistantResponseText = event.data.voiceAssistantResponseText,
                    )
                }
                lastKnownState = _state.value
                StateTimelineGenerator.instance.onStateUpdate(event.data)
                SessionMetrics.instance.onMessageReceived()
            }

            is BridgeEvent.UserPrompt -> {
                StateTimelineGenerator.instance.setLastUserPrompt(event.text)
            }

            is BridgeEvent.Usage -> {
                _state.update { it.copy(
                    usage = event.data,
                    oauthConnected = event.data.oauthConnected ?: it.oauthConnected,
                    ollamaStatus = event.data.ollamaStatus ?: it.ollamaStatus,
                    modelCatalog = event.data.modelCatalog ?: it.modelCatalog,
                    mlxModels = event.data.mlxModels ?: it.mlxModels,
                    subscriptions = event.data.subscriptions ?: it.subscriptions,
                    antigravityStatus = event.data.antigravityStatus ?: it.antigravityStatus,
                ) }
                lastKnownState = _state.value
                SessionMetrics.instance.onMessageReceived()
            }

            is BridgeEvent.Voice -> {
                _state.update { it.copy(voice = event.data) }
            }

            is BridgeEvent.Connected -> {
                _state.update {
                    it.copy(
                        bridgeConnected = true,
                        sessionId = event.sessionId,
                    )
                }
                SessionMetrics.instance.onConnected()
            }

            is BridgeEvent.DisplaySleep -> {
                _state.update { it.copy(hostDisplayOn = event.displayOn) }
            }

            is BridgeEvent.SessionsList -> {
                _state.update { it.copy(siblingSessions = event.sessions) }
            }

            is BridgeEvent.EncoderState -> { /* Deck tab removed — ignore */ }

            is BridgeEvent.ButtonState -> { /* Deck tab removed — ignore */ }

            is BridgeEvent.SlotMap -> { /* Deck tab removed — ignore */ }

            is BridgeEvent.Timeline -> {
                if (event.upsert) {
                    TimelineStore.instance.upsertEntry(event.entry.toTimelineEntry())
                } else {
                    TimelineStore.instance.addEntry(event.entry.toTimelineEntry())
                }
                StateTimelineGenerator.instance.setReceivingBridgeTimeline(true)
            }

            is BridgeEvent.TimelineHistory -> {
                TimelineStore.instance.addEntries(event.entries.map { it.toTimelineEntry() })
                StateTimelineGenerator.instance.setReceivingBridgeTimeline(true)
            }

            is BridgeEvent.Disconnected -> {
                _state.update {
                    it.copy(
                        bridgeConnected = false,
                        agentState = AgentState.DISCONNECTED,
                        hostDisplayOn = true,
                    )
                }
                SessionMetrics.instance.onDisconnected()
                StateTimelineGenerator.instance.onDisconnected()
            }
        }
    }
}
