package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.SessionMetrics
import dev.agentdeck.util.formatBytes
import dev.agentdeck.util.formatResetTime
import dev.agentdeck.util.formatUptime
import dev.agentdeck.util.gaugeBar

/**
 * Compact horizontal status display for e-ink landscape layout.
 * Condenses OAuth, rate limits, ollama, tokens, cost into 3 rows to fit IDLE 12% height.
 */
@Composable
fun EinkStatusCompact(
    state: DashboardState,
    modifier: Modifier = Modifier,
) {
    val monoStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    val usage = state.usage
    val metricsSnapshot by SessionMetrics.instance.metrics.collectAsState()

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalArrangement = Arrangement.spacedBy(1.dp),
    ) {
        // Row 1: OAuth + Bridge + Uptime
        val oauthIcon = if (state.oauthConnected == true) "\u2713" else "\u2717"
        val connIcon = if (state.bridgeConnected) "\u25CF" else "\u25CB"
        val uptime = formatUptime(metricsSnapshot.connectedSince ?: 0L)
        Text(
            text = "OAuth$oauthIcon $connIcon Bridge  UP:$uptime",
            style = monoStyle,
            color = MaterialTheme.colorScheme.onSurface,
        )

        // Row 2: 5h + 7d gauges combined in single line
        val parts = mutableListOf<String>()
        usage.fiveHourPercent?.let { pct ->
            val bar = gaugeBar(pct, width = 3)
            val reset = usage.fiveHourResetsAt?.let { formatResetTime(it) } ?: ""
            parts += "5h $bar ${pct.toInt()}% $reset"
        }
        usage.sevenDayPercent?.let { pct ->
            val bar = gaugeBar(pct, width = 3)
            val reset = usage.sevenDayResetsAt?.let { formatResetTime(it) } ?: ""
            parts += "7d $bar ${pct.toInt()}% $reset"
        }
        if (parts.isNotEmpty()) {
            Text(
                text = parts.joinToString("  "),
                style = monoStyle,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
            )
        }

        // Row 3: Ollama status + running model names with VRAM
        val ollamaLabel = state.ollamaStatus?.let { if (it.available) "Olla\u2713" else "" } ?: ""
        val modelParts = state.ollamaStatus?.models?.map { model ->
            val vram = if (model.sizeVram > 0) " ${formatBytes(model.sizeVram)}" else ""
            "${model.name}$vram"
        } ?: emptyList()
        val row3 = if (modelParts.isNotEmpty()) {
            "$ollamaLabel ${modelParts.joinToString(" \u00B7 ")}".trim()
        } else {
            ollamaLabel
        }
        if (row3.isNotEmpty()) {
            Text(
                text = row3,
                style = monoStyle,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}
