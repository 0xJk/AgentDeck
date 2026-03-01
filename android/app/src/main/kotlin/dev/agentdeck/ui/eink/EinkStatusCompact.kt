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
import dev.agentdeck.util.formatCount
import dev.agentdeck.util.formatResetTime
import dev.agentdeck.util.formatUptime
import dev.agentdeck.util.gaugeBar

/**
 * Compact horizontal status display for e-ink landscape layout.
 * Condenses OAuth, rate limits, ollama, tokens, cost into minimal rows.
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
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        // OAuth + Connection (one line)
        val oauthIcon = if (state.oauthConnected == true) "\u2713" else "\u2717"
        val connIcon = if (state.bridgeConnected) "\u25CF" else "\u25CB"
        Text(
            text = "OAuth$oauthIcon  $connIcon Bridge",
            style = monoStyle,
            color = MaterialTheme.colorScheme.onSurface,
        )

        // 5h gauge
        usage.fiveHourPercent?.let { pct ->
            val bar = gaugeBar(pct, width = 4)
            val reset = usage.fiveHourResetsAt?.let { formatResetTime(it) } ?: ""
            Text(
                text = "5h $bar ${pct.toInt()}% $reset",
                style = monoStyle,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }

        // 7d gauge
        usage.sevenDayPercent?.let { pct ->
            val bar = gaugeBar(pct, width = 4)
            val reset = usage.sevenDayResetsAt?.let { formatResetTime(it) } ?: ""
            Text(
                text = "7d $bar ${pct.toInt()}% $reset",
                style = monoStyle,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }

        // Ollama + Tokens + Cost (one line)
        val ollamaLabel = state.ollamaStatus?.let { if (it.available) "Olla\u2713" else "" } ?: ""
        val tok = formatCount(usage.inputTokens.toLong() + usage.outputTokens.toLong())
        val cost = usage.estimatedCostUsd?.let { "$${"%.2f".format(it)}" } ?: ""
        Text(
            text = "$ollamaLabel Tok:$tok $cost",
            style = monoStyle,
            color = MaterialTheme.colorScheme.onSurface,
        )

        // Uptime
        val uptime = formatUptime(metricsSnapshot.connectedSince ?: 0L)
        Text(
            text = "UP: $uptime",
            style = monoStyle,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
