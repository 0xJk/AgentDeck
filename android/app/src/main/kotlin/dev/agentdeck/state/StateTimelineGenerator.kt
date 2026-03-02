package dev.agentdeck.state

import dev.agentdeck.net.AgentState
import dev.agentdeck.net.StateUpdate
import dev.agentdeck.util.formatDurationCompact

class StateTimelineGenerator private constructor() {

    companion object {
        val instance: StateTimelineGenerator by lazy { StateTimelineGenerator() }
        private const val TOOL_DEDUP_MS = 2000L
        private val AWAITING_STATES = setOf(
            AgentState.AWAITING_PERMISSION,
            AgentState.AWAITING_OPTION,
            AgentState.AWAITING_DIFF,
        )
    }

    @Volatile private var previousState: AgentState = AgentState.DISCONNECTED
    @Volatile private var lastToolName: String? = null
    @Volatile private var lastToolTime: Long = 0
    @Volatile private var lastAgentType: String? = null
    @Volatile private var chatStartTime: Long? = null

    fun onStateUpdate(update: StateUpdate) {
        val now = System.currentTimeMillis()
        val newState = update.state
        val store = TimelineStore.instance

        // Track agent type
        if (update.agentType != null) {
            lastAgentType = update.agentType
        }
        val agent = lastAgentType

        // State transitions
        when {
            // IDLE -> PROCESSING: chat started
            previousState == AgentState.IDLE && newState == AgentState.PROCESSING -> {
                chatStartTime = now
                store.addEntry(TimelineEntry(now, "chat_start", "Prompt sent", agentType = agent))
            }

            // -> AWAITING_PERMISSION: permission requested
            newState == AgentState.AWAITING_PERMISSION && previousState != AgentState.AWAITING_PERMISSION -> {
                val question = update.question ?: "Permission requested"
                store.addEntry(TimelineEntry(now, "permission", question, agentType = agent))
            }

            // AWAITING -> PROCESSING: resumed
            previousState in AWAITING_STATES && newState == AgentState.PROCESSING -> {
                store.addEntry(TimelineEntry(now, "chat_start", "Resumed", agentType = agent))
            }

            // PROCESSING -> IDLE: chat completed
            previousState == AgentState.PROCESSING && newState == AgentState.IDLE -> {
                val duration = chatStartTime?.let { formatDurationCompact(now - it) }
                val summary = if (duration != null) "Response received ($duration)" else "Chat completed"
                chatStartTime = null
                store.addEntry(TimelineEntry(now, "chat_end", summary, agentType = agent))
            }

            // DISCONNECTED -> else: connected
            previousState == AgentState.DISCONNECTED && newState != AgentState.DISCONNECTED -> {
                store.addEntry(TimelineEntry(now, "chat_start", "Connected", agentType = agent))
            }
        }

        // Tool tracking during PROCESSING (2s dedup)
        if (newState == AgentState.PROCESSING && update.currentTool != null) {
            val tool = update.currentTool
            if (tool != lastToolName || (now - lastToolTime) > TOOL_DEDUP_MS) {
                val summary = formatToolSummary(tool, update.toolInput)
                store.addEntry(TimelineEntry(now, "tool_request", summary, agentType = agent))
                lastToolName = tool
                lastToolTime = now
            }
        }

        previousState = newState
    }

    fun onDisconnected() {
        val now = System.currentTimeMillis()
        if (previousState != AgentState.DISCONNECTED) {
            TimelineStore.instance.addEntry(
                TimelineEntry(now, "error", "Disconnected", agentType = lastAgentType)
            )
        }
        previousState = AgentState.DISCONNECTED
        lastToolName = null
        chatStartTime = null
    }

    /** Format tool summary with abbreviated path from toolInput. */
    private fun formatToolSummary(toolName: String, toolInput: String?): String {
        if (toolInput == null) return toolName
        val arg = abbreviatePath(toolInput.trim())
        return if (arg.isNotEmpty()) "$toolName $arg" else toolName
    }

    /** Abbreviate file paths to last 2 segments: "foo/bar/baz.kt" → "bar/baz.kt" */
    private fun abbreviatePath(input: String): String {
        // Extract first meaningful argument (file path or short text)
        val arg = input.lineSequence().firstOrNull()?.trim()?.take(80) ?: return ""
        val parts = arg.split("/")
        return if (parts.size > 2) parts.takeLast(2).joinToString("/") else arg
    }
}
