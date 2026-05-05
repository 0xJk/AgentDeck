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
    @Volatile private var receivingBridgeTimeline = false
    @Volatile private var lastUserPrompt: String? = null
    @Volatile private var lastChatPrompt: String? = null

    /** When Bridge provides rich timeline, suppress local generation to avoid duplicates. */
    fun setReceivingBridgeTimeline(receiving: Boolean) {
        receivingBridgeTimeline = receiving
    }

    /** Set the latest user prompt text from bridge user_prompt event. */
    fun setLastUserPrompt(text: String) {
        lastUserPrompt = text
        lastChatPrompt = text
        // Retroactively update the most recent chat_start if it was "Prompt sent"
        // (user_prompt WS event often arrives after the state_update that triggered chat_start)
        if (!receivingBridgeTimeline) {
            val snippet = if (text.length > 500) text.take(497) + "..." else text
            val detail = if (text.length > 100) {
                if (text.length > 1000) text.take(1000) + "..." else text
            } else null
            TimelineStore.instance.updateLastOfType("chat_start") { entry ->
                if (entry.summary == "Prompt sent") {
                    entry.copy(summary = snippet, detail = detail)
                } else entry
            }
        }
    }

    fun onStateUpdate(update: StateUpdate) {
        if (receivingBridgeTimeline) return  // Bridge provides rich timeline
        val now = System.currentTimeMillis()
        val newState = update.state
        val store = TimelineStore.instance

        // Track agent type
        if (update.agentType != null) {
            lastAgentType = update.agentType
        }
        val agent = lastAgentType
        val project = update.projectName

        // State transitions
        when {
            // IDLE -> PROCESSING: chat started
            previousState == AgentState.IDLE && newState == AgentState.PROCESSING -> {
                chatStartTime = now
                val prompt = lastUserPrompt
                lastUserPrompt = null
                lastChatPrompt = prompt
                val raw = if (!prompt.isNullOrEmpty()) {
                    if (prompt.length > 500) prompt.take(497) + "..." else prompt
                } else "Prompt sent"
                val detail = if (!prompt.isNullOrEmpty() && prompt.length > 100) {
                    if (prompt.length > 1000) prompt.take(1000) + "..." else prompt
                } else null
                store.addEntry(TimelineEntry(now, "chat_start", raw, detail = detail, agentType = agent, projectName = project))
            }

            // -> AWAITING_PERMISSION: permission requested
            newState == AgentState.AWAITING_PERMISSION && previousState != AgentState.AWAITING_PERMISSION -> {
                val question = update.question ?: "Permission requested"
                store.addEntry(TimelineEntry(now, "tool_request", question, agentType = agent, projectName = project))
            }

            // AWAITING -> PROCESSING: resumed
            previousState in AWAITING_STATES && newState == AgentState.PROCESSING -> {
                store.addEntry(TimelineEntry(now, "chat_start", "Resumed", agentType = agent, projectName = project))
            }

            // PROCESSING -> IDLE: chat completed
            previousState == AgentState.PROCESSING && newState == AgentState.IDLE -> {
                val duration = chatStartTime?.let { formatDurationCompact(now - it) }
                val prompt = lastChatPrompt
                lastChatPrompt = null
                // Extract topic hint: first line of prompt, max 80 chars
                val topicHint = prompt?.let {
                    val firstLine = it.lines().firstOrNull()?.trim() ?: return@let null
                    if (firstLine.length < 5) return@let null
                    if (firstLine.length > 80) firstLine.take(77) + "..." else firstLine
                }
                val label = topicHint ?: "Completed"
                val summary = if (duration != null) "$label · $duration" else label
                val detail = prompt?.let {
                    "Prompt: ${if (it.length > 200) it.take(200) + "..." else it}"
                }
                chatStartTime = null
                store.addEntry(TimelineEntry(now, "chat_end", summary, detail = detail, agentType = agent, projectName = project))
            }

            // DISCONNECTED -> else: connected
            previousState == AgentState.DISCONNECTED && newState != AgentState.DISCONNECTED -> {
                store.addEntry(TimelineEntry(now, "chat_start", "Connected", agentType = agent, projectName = project))
            }
        }

        // Tool tracking during PROCESSING (2s dedup)
        if (newState == AgentState.PROCESSING && update.currentTool != null) {
            val tool = update.currentTool
            if (tool != lastToolName || (now - lastToolTime) > TOOL_DEDUP_MS) {
                val summary = formatToolSummary(tool, update.toolInput)
                store.addEntry(TimelineEntry(now, "tool_request", summary, agentType = agent, projectName = project))
                lastToolName = tool
                lastToolTime = now
            }
        }

        previousState = newState
    }

    fun onDisconnected() {
        receivingBridgeTimeline = false  // Reset on disconnect → local fallback
        val now = System.currentTimeMillis()
        if (previousState != AgentState.DISCONNECTED) {
            TimelineStore.instance.addEntry(
                TimelineEntry(now, "error", "Disconnected", agentType = lastAgentType)
            )
        }
        previousState = AgentState.DISCONNECTED
        lastToolName = null
        chatStartTime = null
        lastUserPrompt = null
        lastChatPrompt = null
    }

    /** Format tool summary from toolInput (already extracted & truncated by bridge's formatToolInput). */
    private fun formatToolSummary(toolName: String, toolInput: String?): String {
        if (toolInput == null) return toolName
        // Only abbreviate if it looks like a pure file path (contains / and no spaces)
        val display = if (toolInput.contains('/') && !toolInput.contains(' ')) {
            abbreviatePath(toolInput.trim())
        } else {
            toolInput.trim().lines().first().take(100)
        }
        return if (display.isNotEmpty()) "$toolName $display" else toolName
    }

    /** Abbreviate file paths to last 2 segments: "foo/bar/baz.kt" → "bar/baz.kt" */
    private fun abbreviatePath(input: String): String {
        val arg = input.lineSequence().firstOrNull()?.trim()?.take(80) ?: return ""
        val parts = arg.split("/")
        return if (parts.size > 2) parts.takeLast(2).joinToString("/") else arg
    }
}
