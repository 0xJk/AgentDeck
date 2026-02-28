package dev.agentdeck.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.ModelCatalogEntry
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.state.SessionMetrics
import dev.agentdeck.state.TimelineStore
import dev.agentdeck.ui.component.StatusCard
import dev.agentdeck.ui.component.SyncIndicator
import dev.agentdeck.ui.component.TimelineList
import dev.agentdeck.ui.component.UsageSummaryCard
import dev.agentdeck.ui.component.stateColor
import dev.agentdeck.ui.component.stateLabel
import dev.agentdeck.ui.theme.AgentDeckColors

@Suppress("UNUSED_PARAMETER")
@Composable
fun DashboardScreen(
    stateHolder: AgentStateHolder,
    isEink: Boolean,
) {
    val state by stateHolder.state.collectAsState()
    val timelineEntries by TimelineStore.instance.entries.collectAsState()
    val metrics by SessionMetrics.instance.metrics.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // Session Overview card
        SessionOverviewCard(
            agentState = state.agentState,
            projectName = state.projectName,
            modelName = state.modelName,
            currentTool = state.currentTool,
        )

        // Usage summary card
        UsageSummaryCard(
            usage = state.usage,
            metrics = metrics,
        )

        // Model catalog (OpenClaw)
        val catalog = state.modelCatalog
        if (!catalog.isNullOrEmpty()) {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = "Models",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    catalog.forEach { entry ->
                        ModelRow(entry)
                    }
                }
            }
        }

        // Timeline header with sync indicator
        if (timelineEntries.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Timeline",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                SyncIndicator(metrics = metrics)
            }
            TimelineList(
                entries = timelineEntries,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            )
        } else if (state.agentState == AgentState.DISCONNECTED) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "Not connected to bridge",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SessionOverviewCard(
    agentState: AgentState,
    projectName: String?,
    modelName: String?,
    currentTool: String?,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = "Sessions",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Row(
                modifier = Modifier.padding(top = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                // Status dot
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(stateColor(agentState))
                )

                // Project name
                Text(
                    text = projectName ?: "—",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                )

                // State label
                Text(
                    text = stateLabel(agentState),
                    style = MaterialTheme.typography.bodyMedium,
                    color = stateColor(agentState),
                )

                // Model name
                if (modelName != null) {
                    Text(
                        text = modelName,
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // Current tool (if processing)
            if (currentTool != null && agentState == AgentState.PROCESSING) {
                Text(
                    text = "Tool: $currentTool",
                    style = MaterialTheme.typography.bodySmall,
                    color = AgentDeckColors.Blue,
                    modifier = Modifier.padding(top = 4.dp, start = 20.dp),
                )
            }
        }
    }
}

@Composable
private fun ModelRow(entry: ModelCatalogEntry) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = entry.name,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (entry.role != null) {
                Text(
                    text = entry.role,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Text(
            text = if (entry.available) "\u2713" else "\u2717",
            style = MaterialTheme.typography.bodyMedium,
            color = if (entry.available) AgentDeckColors.Green else AgentDeckColors.SlateText,
        )
    }
}
