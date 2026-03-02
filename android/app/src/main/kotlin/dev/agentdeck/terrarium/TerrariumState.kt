package dev.agentdeck.terrarium

import dev.agentdeck.net.AgentState
import dev.agentdeck.state.DashboardState
import dev.agentdeck.terrarium.creature.AgentMark

/** Visual states for each creature and the environment. */

enum class OctopusVisualState {
    SLEEPING,    // Curled up at bottom, dim, eyes closed
    FLOATING,    // Gentle sine bob, tentacles wave
    WORKING,     // Starburst animation — processing (tool use or thinking)
    ASKING,      // Speech bubble + "?" — awaiting user input
}

enum class CrayfishVisualState {
    DORMANT,    // Partially hidden behind rocks
    SITTING,    // Idle on rock, claws at rest
    OBSERVING,  // Watching activity — gentle claw fidget, eyes tracking
    ROUTING,    // Claws clap, eyes flash, signal lines emit (OpenClaw orchestrating)
    WAITING,    // Claws raised
}

enum class TetraVisualState {
    ABSENT,     // Not visible (disconnected)
    CIRCLING,   // Boids algorithm, orbiting attractor
    STREAMING,  // Line up, streak horizontally, code trail particles
    HOVERING,   // Formation near options area
}

enum class EnvironmentVisualState {
    DARK,    // Disconnected — dim/off
    CALM,    // Idle — gentle caustics, slow bubbles
    ACTIVE,  // Processing — bright caustics, more bubbles
    ALERT,   // Awaiting input — pulsing highlights
}

/** Per-agent creature state for multi-session rendering. */
data class AgentCreatureState(
    val sessionId: String,
    val agentType: String?,
    val mark: AgentMark?,
    val visualState: OctopusVisualState,
    val isPrimary: Boolean,
    val layoutSlot: Int,
    val displayName: String? = null,
)

/** Combined visual state for the entire terrarium scene. */
data class TerrariumState(
    val octopus: OctopusVisualState,
    val crayfish: CrayfishVisualState,
    val tetra: TetraVisualState,
    val environment: EnvironmentVisualState,
    val currentTool: String? = null,
    val toolProgress: String? = null,
    val projectName: String? = null,
    val modelName: String? = null,
    val agentType: String? = null,
    val hasError: Boolean = false,
    /** Multi-session: all coding agent creatures (octopuses). */
    val agents: List<AgentCreatureState> = emptyList(),
    /** OpenClaw backend worker count. */
    val workerCrayfishCount: Int = 0,
)

/** Map DashboardState to visual TerrariumState. */
fun DashboardState.toTerrariumState(): TerrariumState {
    val isOpenClaw = agentType == "openclaw"
    val hasTool = currentTool != null
    val octopus = when (agentState) {
        AgentState.DISCONNECTED -> OctopusVisualState.SLEEPING
        AgentState.IDLE -> OctopusVisualState.FLOATING
        AgentState.PROCESSING -> OctopusVisualState.WORKING
        AgentState.AWAITING_PERMISSION,
        AgentState.AWAITING_OPTION,
        AgentState.AWAITING_DIFF -> OctopusVisualState.ASKING
    }

    // OpenClaw sibling state determines crayfish independently
    val ocSibling = siblingSessions.firstOrNull { it.agentType == "openclaw" }
    val crayfish = when {
        // Primary is OpenClaw — use primary state
        isOpenClaw -> when (agentState) {
            AgentState.PROCESSING -> CrayfishVisualState.ROUTING
            AgentState.IDLE -> CrayfishVisualState.SITTING
            AgentState.DISCONNECTED -> CrayfishVisualState.DORMANT
            else -> CrayfishVisualState.WAITING
        }
        // Sibling OpenClaw exists — use its state
        ocSibling != null -> when (ocSibling.state) {
            "processing" -> CrayfishVisualState.ROUTING
            "idle" -> CrayfishVisualState.SITTING
            "awaiting_permission", "awaiting_option", "awaiting_diff" -> CrayfishVisualState.WAITING
            else -> if (ocSibling.alive) CrayfishVisualState.SITTING else CrayfishVisualState.DORMANT
        }
        // Gateway detected but no bridge
        gatewayAvailable == true -> CrayfishVisualState.SITTING
        // Nothing — derive from primary agent state
        else -> when (agentState) {
            AgentState.DISCONNECTED -> CrayfishVisualState.DORMANT
            AgentState.PROCESSING -> CrayfishVisualState.OBSERVING
            else -> CrayfishVisualState.SITTING
        }
    }

    val crayfishRouting = crayfish == CrayfishVisualState.ROUTING
    val tetra = when (agentState) {
        AgentState.DISCONNECTED -> TetraVisualState.ABSENT
        AgentState.IDLE -> if (crayfishRouting) TetraVisualState.STREAMING else TetraVisualState.CIRCLING
        AgentState.PROCESSING -> if (hasTool || isOpenClaw || crayfishRouting) TetraVisualState.STREAMING else TetraVisualState.CIRCLING
        AgentState.AWAITING_PERMISSION,
        AgentState.AWAITING_OPTION,
        AgentState.AWAITING_DIFF -> TetraVisualState.HOVERING
    }

    val environment = when (agentState) {
        AgentState.DISCONNECTED -> EnvironmentVisualState.DARK
        AgentState.IDLE -> EnvironmentVisualState.CALM
        AgentState.PROCESSING -> EnvironmentVisualState.ACTIVE
        AgentState.AWAITING_PERMISSION,
        AgentState.AWAITING_OPTION,
        AgentState.AWAITING_DIFF -> EnvironmentVisualState.ALERT
    }

    // Build multi-agent creature list from sibling sessions
    val agents = mutableListOf<AgentCreatureState>()

    // Primary agent — skip if disconnected (no session), daemon, or openclaw proxy
    if (agentState != AgentState.DISCONNECTED && agentType != "daemon" && agentType != "openclaw") {
        agents.add(
            AgentCreatureState(
                sessionId = sessionId ?: "primary",
                agentType = agentType,
                mark = AgentMark.fromAgentType(agentType),
                visualState = octopus,
                isPrimary = true,
                layoutSlot = 0,
                displayName = projectName,
            )
        )
    }

    // Sibling sessions (coding agents only — not the current session)
    var slot = agents.size
    for (sibling in siblingSessions) {
        if (sessionId != null && sibling.id == sessionId) continue // skip self (null guard)
        val siblingType = sibling.agentType
        if (siblingType == "openclaw" || siblingType == "daemon") continue // not octopus
        agents.add(
            AgentCreatureState(
                sessionId = sibling.id,
                agentType = siblingType,
                mark = AgentMark.fromAgentType(siblingType),
                visualState = mapSessionOctopusState(sibling.state),
                isPrimary = false,
                layoutSlot = slot++,
                displayName = sibling.projectName,
            )
        )
    }

    // Number duplicate display names: "AgentDeck", "AgentDeck" → "AgentDeck #1", "AgentDeck #2"
    val nameCounts = agents.groupingBy { it.displayName }.eachCount()
    val nameCounters = mutableMapOf<String?, Int>()
    for (i in agents.indices) {
        val name = agents[i].displayName
        if (name != null && (nameCounts[name] ?: 0) >= 2) {
            val seq = (nameCounters[name] ?: 0) + 1
            nameCounters[name] = seq
            agents[i] = agents[i].copy(displayName = "$name #$seq")
        }
    }

    return TerrariumState(
        octopus = octopus,
        crayfish = crayfish,
        tetra = tetra,
        environment = environment,
        currentTool = currentTool,
        toolProgress = toolProgress,
        projectName = projectName,
        modelName = modelName,
        agentType = agentType,
        agents = agents,
        workerCrayfishCount = workerSessionCount ?: 0,
    )
}

private fun mapSessionOctopusState(state: String?): OctopusVisualState = when (state) {
    "processing" -> OctopusVisualState.WORKING
    "awaiting_permission", "awaiting_option", "awaiting_diff" -> OctopusVisualState.ASKING
    "idle" -> OctopusVisualState.FLOATING
    else -> OctopusVisualState.FLOATING
}
