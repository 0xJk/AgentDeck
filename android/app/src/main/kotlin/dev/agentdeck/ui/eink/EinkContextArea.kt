package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.AgentState
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.TimelineEntry
import kotlinx.coroutines.delay

/**
 * Context/permission area for e-ink center column (upper section).
 * Shows current agent activity based on state.
 */
@Composable
fun EinkContextArea(
    state: DashboardState,
    timelineEntries: List<TimelineEntry> = emptyList(),
    onSelectOption: (Int) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        when (state.agentState) {
            AgentState.PROCESSING -> {
                var tickCount by remember { mutableIntStateOf(0) }
                LaunchedEffect(state.currentTool) {
                    tickCount = 0
                    while (true) {
                        delay(1000)
                        tickCount++
                    }
                }
                val tickDots = ".".repeat((tickCount % 3) + 1)

                val recentTools = timelineEntries
                    .filter { it.type == "tool_request" }
                    .takeLast(3)

                if (recentTools.isEmpty() && state.currentTool != null) {
                    Text(
                        text = "> ${state.currentTool} $tickDots",
                        style = MaterialTheme.typography.bodyMedium.copy(
                            fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.Bold,
                        ),
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                } else {
                    recentTools.forEachIndexed { index, entry ->
                        val toolName = entry.summary.removePrefix("Tool: ")
                        val suffix = if (index == recentTools.lastIndex) " $tickDots" else ""
                        Text(
                            text = "> $toolName$suffix",
                            style = MaterialTheme.typography.bodyMedium.copy(
                                fontFamily = FontFamily.Monospace,
                                fontWeight = FontWeight.Bold,
                            ),
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }

                if (state.toolInput != null) {
                    Text(
                        text = "  \"${state.toolInput}\"",
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                    )
                }

                if (state.toolProgress != null) {
                    Text(
                        text = "  (${state.toolProgress})",
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            AgentState.AWAITING_PERMISSION,
            AgentState.AWAITING_OPTION,
            AgentState.AWAITING_DIFF -> {
                EinkPermissionPanel(
                    question = state.question,
                    options = state.options,
                    onSelectOption = onSelectOption,
                )
            }

            AgentState.IDLE -> {
                // Empty — IDLE context is hidden in landscape layout
            }

            AgentState.DISCONNECTED -> {
                Text(
                    text = "No connection",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }
    }
}
