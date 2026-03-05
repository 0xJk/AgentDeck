package dev.agentdeck.ui.eink

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.AgentState
import dev.agentdeck.state.DashboardState

/**
 * LEFT zone (22%) — Agent panel for e-ink 3-zone layout.
 * Icon + display name (with #N suffix for duplicates) + model + state.
 *
 * Also exported as [EinkAgentColumn] for backward compatibility with portrait layout.
 */
@Composable
fun EinkAgentPanel(
    state: DashboardState,
    onSettingsClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Build display list: primary + siblings (excluding self)
    data class AgentEntry(
        val projectName: String,
        val agentType: String?,
        val modelName: String?,
        val effortLevel: String?,
        val agentState: AgentState,
    )

    val entries = mutableListOf<AgentEntry>()

    // Primary agent — skip if daemon (not a coding agent; openclaw shows as 🦞)
    if (state.agentType != "daemon") {
        entries += AgentEntry(
            projectName = state.projectName ?: "Agent",
            agentType = state.agentType,
            modelName = state.modelName,
            effortLevel = state.effortLevel,
            agentState = state.agentState,
        )
    }

    // Siblings (skip self and daemon)
    state.siblingSessions.forEach { session ->
        if (session.id == state.sessionId) return@forEach
        if (session.agentType == "daemon") return@forEach
        entries += AgentEntry(
            projectName = session.projectName ?: "Agent",
            agentType = session.agentType,
            modelName = null,
            effortLevel = null,
            agentState = mapSessionState(session),
        )
    }

    // Count occurrences per (projectName, agentType) for #N suffix —
    // different agent types (🦞 vs 🐙) with the same project name don't need numbering
    data class NameKey(val projectName: String, val agentType: String?)
    val nameCounts = entries.groupBy { NameKey(it.projectName, it.agentType) }
        .mapValues { it.value.size }
    val nameCounters = mutableMapOf<NameKey, Int>()

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 8.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        // Brand logo — largest text at top
        Text(
            text = "AgentDeck",
            style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold),
            color = MaterialTheme.colorScheme.onSurface,
        )
        Spacer(modifier = Modifier.height(4.dp))

        entries.forEach { entry ->
            val icon = agentIcon(entry.agentType)
            val key = NameKey(entry.projectName, entry.agentType)
            val needsSuffix = (nameCounts[key] ?: 1) > 1
            val suffix = if (needsSuffix) {
                val idx = (nameCounters[key] ?: 0) + 1
                nameCounters[key] = idx
                " #$idx"
            } else {
                ""
            }
            val displayName = "$icon ${entry.projectName}$suffix"

            EinkAgentBlock(
                displayName = displayName,
                modelName = entry.modelName,
                effortLevel = entry.effortLevel,
                agentState = entry.agentState,
            )
        }

        // Worker count
        state.workerSessionCount?.takeIf { it > 0 }?.let {
            Text(
                text = "Workers: $it",
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }

        Spacer(modifier = Modifier.weight(1f))

        // Settings gear
        Text(
            text = "\u2699 Settings",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clickable(onClick = onSettingsClick),
        )
    }
}

/**
 * Compact agent identity block: display name (up to 2 lines) + model·state on one line.
 */
@Composable
internal fun EinkAgentBlock(
    displayName: String,
    modelName: String?,
    effortLevel: String? = null,
    agentState: AgentState,
) {
    // Model + effort + state merged into one line: "  opus-4 · high · ◉ PROC" or "  ◉ PROC"
    val stateMarker = compactStateMarker(agentState)
    val modelEffort = when {
        modelName != null && effortLevel != null && effortLevel != "medium" -> "$modelName \u00B7 $effortLevel"
        modelName != null -> modelName
        else -> null
    }
    val subLine = if (modelEffort != null) {
        "  $modelEffort \u00B7 $stateMarker"
    } else {
        "  $stateMarker"
    }

    Column {
        Text(
            text = displayName,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = subLine,
            fontSize = 13.sp,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Backward-compatible alias for [EinkAgentPanel].
 * Used by portrait layout and other screens that reference the old name.
 */
@Composable
fun EinkAgentColumn(
    state: DashboardState,
    onSettingsClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    EinkAgentPanel(state = state, onSettingsClick = onSettingsClick, modifier = modifier)
}

