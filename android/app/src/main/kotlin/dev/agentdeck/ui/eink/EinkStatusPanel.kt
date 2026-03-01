package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.agentdeck.state.DashboardState
import dev.agentdeck.state.SessionMetrics
import dev.agentdeck.util.formatCount
import dev.agentdeck.util.formatResetTime
import dev.agentdeck.util.formatUptime
import dev.agentdeck.util.gaugeBar

/**
 * RIGHT zone (32%) — Status panel for e-ink 3-zone layout.
 * OAuth, Connection, rate limits with reset times, Ollama, tokens, cost, uptime.
 */
@Composable
fun EinkStatusPanel(
    state: DashboardState,
    modifier: Modifier = Modifier,
) {
    val monoStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
    val usage = state.usage
    val metricsSnapshot by SessionMetrics.instance.metrics.collectAsState()

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // OAuth status
        val oauthLabel = when {
            state.oauthConnected == true -> "connected"
            state.billingType == "api" -> "API key"
            else -> "\u2014"
        }
        Text(text = "OAuth: $oauthLabel", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)

        // Connection
        val connIcon = if (state.bridgeConnected) "\u25CF" else "\u25CB"
        val connLabel = if (state.bridgeConnected) "CONNECTED" else "DISCONNECTED"
        Text(text = "Conn: $connIcon $connLabel", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)

        HorizontalDivider(thickness = 1.dp, color = Color.Black)

        // 5h rate limit + reset time
        usage.fiveHourPercent?.let { pct ->
            val bar = gaugeBar(pct)
            val reset = usage.fiveHourResetsAt?.let { formatResetTime(it) } ?: ""
            Text(text = "5h $bar ${pct.toInt()}%  $reset", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)
        }

        // 7d rate limit + reset time
        usage.sevenDayPercent?.let { pct ->
            val bar = gaugeBar(pct)
            val reset = usage.sevenDayResetsAt?.let { formatResetTime(it) } ?: ""
            Text(text = "7d $bar ${pct.toInt()}%  $reset", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)
        }

        HorizontalDivider(thickness = 1.dp, color = Color.Black)

        // Ollama
        state.ollamaStatus?.let { olla ->
            val label = if (olla.available) "running (${olla.models.size})" else "stopped"
            Text(text = "Ollama: $label", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)
        }

        HorizontalDivider(thickness = 1.dp, color = Color.Black)

        // Tokens
        val totalTok = usage.inputTokens.toLong() + usage.outputTokens.toLong()
        Text(text = "Tok: ${formatCount(totalTok)}", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)

        // Cost
        usage.estimatedCostUsd?.let {
            Text(text = "Cost: $${"%.2f".format(it)}", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)
        }

        // Messages + Uptime
        val msgCount = metricsSnapshot.messageCount
        val uptime = formatUptime(metricsSnapshot.connectedSince ?: 0L)
        Text(text = "Msg: $msgCount  UP: $uptime", style = monoStyle, color = MaterialTheme.colorScheme.onSurface)
    }
}
