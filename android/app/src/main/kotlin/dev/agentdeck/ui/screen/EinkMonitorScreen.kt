package dev.agentdeck.ui.screen

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.state.TimelineStore
import dev.agentdeck.ui.eink.EinkSettingsOverlay
import dev.agentdeck.ui.eink.EinkStatusPanel
import dev.agentdeck.ui.eink.EinkTimelinePanel
import dev.agentdeck.ui.eink.EinkUsageCompact
import dev.agentdeck.ui.eink.EinkUsagePanel

@Composable
fun EinkMonitorScreen(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
) {
    val state by stateHolder.state.collectAsState()
    val timelineEntries by TimelineStore.instance.entries.collectAsState()
    var showSettings by remember { mutableStateOf(false) }

    val configuration = LocalConfiguration.current
    val isLandscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        if (isLandscape) {
            EinkLandscapeLayout(
                agentState = state.agentState,
                projectName = state.projectName,
                modelName = state.modelName,
                agentType = state.agentType,
                currentTool = state.currentTool,
                toolProgress = state.toolProgress,
                usage = state.usage,
                timelineEntries = timelineEntries,
                onSettingsClick = { showSettings = true },
            )
        } else {
            EinkPortraitLayout(
                agentState = state.agentState,
                projectName = state.projectName,
                modelName = state.modelName,
                currentTool = state.currentTool,
                toolProgress = state.toolProgress,
                usage = state.usage,
                timelineEntries = timelineEntries,
                onSettingsClick = { showSettings = true },
            )
        }

        if (showSettings) {
            EinkSettingsOverlay(
                connection = connection,
                displayPrefs = displayPrefs,
                onDismiss = { showSettings = false },
            )
        }
    }
}

@Composable
private fun EinkLandscapeLayout(
    agentState: AgentState,
    projectName: String?,
    modelName: String?,
    agentType: String?,
    currentTool: String?,
    toolProgress: String?,
    usage: dev.agentdeck.net.UsageUpdate,
    timelineEntries: List<dev.agentdeck.state.TimelineEntry>,
    onSettingsClick: () -> Unit,
) {
    Row(modifier = Modifier.fillMaxSize()) {
        // Left panel: status + usage + settings gear
        Column(
            modifier = Modifier
                .weight(0.35f)
                .fillMaxHeight(),
        ) {
            EinkStatusPanel(
                agentState = agentState,
                projectName = projectName,
                modelName = modelName,
                agentType = agentType,
                currentTool = currentTool,
                toolProgress = toolProgress,
            )

            HorizontalDivider(thickness = 1.dp, color = Color.Black)

            EinkUsagePanel(usage = usage)

            Spacer(modifier = Modifier.weight(1f))

            // Settings gear
            Text(
                text = "\u2699 Settings",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .clickable(onClick = onSettingsClick)
                    .padding(16.dp),
            )
        }

        // Vertical divider
        VerticalDivider(
            thickness = 2.dp,
            color = Color.Black,
            modifier = Modifier.fillMaxHeight(),
        )

        // Right panel: timeline
        Column(
            modifier = Modifier
                .weight(0.65f)
                .fillMaxHeight(),
        ) {
            Text(
                text = "Timeline",
                style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            )
            HorizontalDivider(thickness = 1.dp, color = Color.Black)
            EinkTimelinePanel(
                entries = timelineEntries,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun EinkPortraitLayout(
    agentState: AgentState,
    projectName: String?,
    modelName: String?,
    currentTool: String?,
    toolProgress: String?,
    usage: dev.agentdeck.net.UsageUpdate,
    timelineEntries: List<dev.agentdeck.state.TimelineEntry>,
    onSettingsClick: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        // Compact header: ~20% of screen
        EinkCompactHeader(
            agentState = agentState,
            projectName = projectName,
            modelName = modelName,
            currentTool = currentTool,
            toolProgress = toolProgress,
            usage = usage,
            onSettingsClick = onSettingsClick,
        )

        HorizontalDivider(thickness = 2.dp, color = Color.Black)

        // Timeline: ~80% of screen
        EinkTimelinePanel(
            entries = timelineEntries,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun EinkCompactHeader(
    agentState: AgentState,
    projectName: String?,
    modelName: String?,
    currentTool: String?,
    toolProgress: String?,
    usage: dev.agentdeck.net.UsageUpdate,
    onSettingsClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // Row 1: state marker + project + model + gear
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = compactStateMarker(agentState),
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (projectName != null) {
                Text(
                    text = projectName,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                )
            } else {
                Spacer(modifier = Modifier.weight(1f))
            }
            if (modelName != null) {
                Text(
                    text = modelName,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                text = "\u2699",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.clickable(onClick = onSettingsClick),
            )
        }

        // Tool info if processing
        if (currentTool != null && agentState == AgentState.PROCESSING) {
            Text(
                text = "> $currentTool" + (toolProgress?.let { " ($it)" } ?: ""),
                style = MaterialTheme.typography.bodySmall.copy(
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                ),
                color = MaterialTheme.colorScheme.onSurface,
            )
        }

        // Row 2: compact usage
        EinkUsageCompact(usage = usage)
    }
}

private fun compactStateMarker(state: AgentState): String = when (state) {
    AgentState.IDLE -> "\u25CF IDLE"
    AgentState.PROCESSING -> "\u25C9 PROC"
    AgentState.AWAITING_PERMISSION -> "\u26A0 PERM"
    AgentState.AWAITING_OPTION -> "\u25C7 SEL"
    AgentState.AWAITING_DIFF -> "\u25A1 DIFF"
    AgentState.DISCONNECTED -> "\u25CB OFF"
}
