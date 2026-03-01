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
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.AgentState
import dev.agentdeck.state.DashboardState

/**
 * LEFT zone (22%) — Agent panel for e-ink 3-zone layout.
 * AgentDeck logo + agent list (type/model/state) + worker count + settings.
 *
 * Also exported as [EinkAgentColumn] for backward compatibility with portrait layout.
 */
@Composable
fun EinkAgentPanel(
    state: DashboardState,
    onSettingsClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val monoStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // AgentDeck logo
        Text(
            text = "AgentDeck",
            style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold),
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Primary agent block
        EinkAgentBlock(
            agentType = state.agentType,
            modelName = state.modelName,
            agentState = state.agentState,
        )

        // Sibling agents
        state.siblingSessions.forEach { session ->
            // Skip self (primary agent already shown above)
            if (session.id == state.sessionId) return@forEach
            EinkAgentBlock(
                agentType = session.agentType,
                modelName = null,
                agentState = mapSessionState(session),
            )
        }

        // Worker count
        state.workerSessionCount?.takeIf { it > 0 }?.let {
            Text(text = "Workers: $it", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)
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
 * Compact agent identity block: type, model, state marker.
 */
@Composable
internal fun EinkAgentBlock(
    agentType: String?,
    modelName: String?,
    agentState: AgentState,
) {
    val monoStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)

    Column {
        Text(
            text = "[${agentType ?: "agent"}]",
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
            color = MaterialTheme.colorScheme.onSurface,
        )
        modelName?.let {
            Text(text = "  $it", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)
        }
        Text(
            text = "  ${compactStateMarker(agentState)}",
            style = monoStyle,
            color = MaterialTheme.colorScheme.onSurface,
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

private fun mapSessionState(session: dev.agentdeck.net.SessionInfo): AgentState {
    if (!session.alive) return AgentState.DISCONNECTED
    return when (session.state) {
        "processing" -> AgentState.PROCESSING
        "idle" -> AgentState.IDLE
        "awaiting_permission", "awaiting_option", "awaiting_diff" -> AgentState.AWAITING_PERMISSION
        else -> AgentState.IDLE
    }
}
