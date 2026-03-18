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
    SICK,       // Gateway has errors — desaturated, tilted, labored breathing
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
    /** Pop burst positions (normalized) — set for 1 frame when ASKING exits. */
    val popBurstPositions: List<Pair<Float, Float>> = emptyList(),
)

/** Derive the most active AgentState from sibling sessions (for daemon mode). */
private fun mostActiveSessionState(siblings: List<dev.agentdeck.net.SessionInfo>): AgentState? {
    // Priority: PROCESSING > AWAITING_* > IDLE > null
    var best: AgentState? = null
    for (s in siblings) {
        if (s.agentType == "daemon") continue
        val mapped = when (s.state) {
            "processing" -> AgentState.PROCESSING
            "awaiting_permission" -> AgentState.AWAITING_PERMISSION
            "awaiting_option" -> AgentState.AWAITING_OPTION
            "awaiting_diff" -> AgentState.AWAITING_DIFF
            "idle" -> AgentState.IDLE
            else -> null
        } ?: continue
        if (best == null || mapped.ordinal > best.ordinal) {
            best = mapped
        }
    }
    return best
}

/** Map DashboardState to visual TerrariumState. */
fun DashboardState.toTerrariumState(): TerrariumState {
    val isOpenClaw = agentType == "openclaw"
    val hasTool = currentTool != null

    // In daemon mode, the daemon's own agentState is DISCONNECTED (no PTY).
    // Derive effective state from the most active sibling session so that
    // tetra/environment/bubbles reflect actual activity.
    val isDaemonLike = agentType == "daemon" ||
        (agentType != null && siblingSessions.any { it.agentType == agentType })
    val effectiveAgentState = if (isDaemonLike && agentState == AgentState.DISCONNECTED) {
        mostActiveSessionState(siblingSessions) ?: AgentState.IDLE
    } else {
        agentState
    }

    val octopus = when (effectiveAgentState) {
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
        isOpenClaw -> when (effectiveAgentState) {
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
        // Nothing — derive from effective agent state
        else -> when (effectiveAgentState) {
            AgentState.DISCONNECTED -> CrayfishVisualState.DORMANT
            AgentState.PROCESSING -> CrayfishVisualState.OBSERVING
            else -> CrayfishVisualState.SITTING
        }
    }

    // Override to SICK if gateway has errors (but not when DORMANT — gateway unreachable)
    val effectiveCrayfish = if (gatewayHasError == true && crayfish != CrayfishVisualState.DORMANT) {
        CrayfishVisualState.SICK
    } else {
        crayfish
    }

    val crayfishRouting = effectiveCrayfish == CrayfishVisualState.ROUTING
    val tetra = when (effectiveAgentState) {
        AgentState.DISCONNECTED -> TetraVisualState.ABSENT
        AgentState.IDLE -> if (crayfishRouting) TetraVisualState.STREAMING else TetraVisualState.CIRCLING
        AgentState.PROCESSING -> if (hasTool || isOpenClaw || crayfishRouting) TetraVisualState.STREAMING else TetraVisualState.CIRCLING
        AgentState.AWAITING_PERMISSION,
        AgentState.AWAITING_OPTION,
        AgentState.AWAITING_DIFF -> TetraVisualState.HOVERING
    }

    val environment = when (effectiveAgentState) {
        AgentState.DISCONNECTED -> EnvironmentVisualState.DARK
        AgentState.IDLE -> EnvironmentVisualState.CALM
        AgentState.PROCESSING -> EnvironmentVisualState.ACTIVE
        AgentState.AWAITING_PERMISSION,
        AgentState.AWAITING_OPTION,
        AgentState.AWAITING_DIFF -> EnvironmentVisualState.ALERT
    }

    // Build multi-agent creature list from sibling sessions
    val agents = mutableListOf<AgentCreatureState>()

    // Primary agent — skip if disconnected (no session), daemon-like, or openclaw proxy
    if (agentState != AgentState.DISCONNECTED && !isDaemonLike && agentType != "openclaw") {
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
        crayfish = effectiveCrayfish,
        tetra = tetra,
        environment = environment,
        currentTool = currentTool,
        toolProgress = toolProgress,
        projectName = projectName,
        modelName = modelName,
        agentType = agentType,
        hasError = gatewayHasError == true,
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
