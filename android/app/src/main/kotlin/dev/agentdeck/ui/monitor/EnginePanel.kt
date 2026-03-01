package dev.agentdeck.ui.monitor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.OllamaStatus
import dev.agentdeck.net.UsageUpdate
import dev.agentdeck.state.MetricsSnapshot
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.ui.eink.formatCount
import dev.agentdeck.ui.eink.formatDurationLong
import dev.agentdeck.util.formatResetTime

/**
 * Right HUD panel — "ENGINE"
 * Rate limit gauges, tokens, cost, message count, uptime.
 */
@Composable
fun EnginePanel(
    usage: UsageUpdate,
    metrics: MetricsSnapshot,
    oauthConnected: Boolean? = null,
    ollamaStatus: OllamaStatus? = null,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .background(TerrariumColors.HUDBg, RoundedCornerShape(8.dp))
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(
            text = "ENGINE",
            color = TerrariumColors.HUDSubtext,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )

        // OAuth status
        val oauthLabel = when (oauthConnected) {
            true -> "OAuth \u2713"
            false -> "OAuth \u2717"
            null -> null
        }
        if (oauthLabel != null) {
            Text(
                text = oauthLabel,
                color = if (oauthConnected == true) TerrariumColors.LEDGreen else TerrariumColors.HUDSubtext,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
        }

        // Rate limit gauges with reset times
        if (usage.fiveHourPercent != null) {
            HudGauge(label = "5h", percent = usage.fiveHourPercent)
            usage.fiveHourResetsAt?.let { resetAt ->
                Text(
                    text = "  resets ${formatResetTime(resetAt)}",
                    color = TerrariumColors.HUDSubtext.copy(alpha = 0.6f),
                    fontSize = 9.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
        if (usage.sevenDayPercent != null) {
            HudGauge(label = "7d", percent = usage.sevenDayPercent)
            usage.sevenDayResetsAt?.let { resetAt ->
                Text(
                    text = "  resets ${formatResetTime(resetAt)}",
                    color = TerrariumColors.HUDSubtext.copy(alpha = 0.6f),
                    fontSize = 9.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }

        Spacer(modifier = Modifier.height(2.dp))

        // Ollama status
        ollamaStatus?.let { olla ->
            val ollaLabel = if (olla.available) "Ollama (${olla.models.size})" else "Ollama \u2717"
            val ollaColor = if (olla.available) TerrariumColors.LEDGreen else TerrariumColors.HUDSubtext.copy(alpha = 0.5f)
            HudInfoRow("LLM", ollaLabel)
        }

        // Token count
        val totalTok = usage.inputTokens + usage.outputTokens
        HudInfoRow("Tok", formatCount(totalTok))

        // Cost
        if (usage.estimatedCostUsd != null) {
            HudInfoRow("Cost", "$${String.format("%.2f", usage.estimatedCostUsd)}")
        }

        // Message count
        HudInfoRow("Msg", "${metrics.messageCount}")

        // Uptime
        val uptimeText = if (metrics.connectedSince != null) {
            formatDurationLong(System.currentTimeMillis() - metrics.connectedSince)
        } else {
            "--:--"
        }
        HudInfoRow("UP", uptimeText)
    }
}

@Composable
private fun HudGauge(label: String, percent: Double) {
    val pct = percent.coerceIn(0.0, 100.0).toInt()
    val filled = (pct * 6 / 100).coerceAtMost(6)
    val empty = 6 - filled
    val bar = "\u2588".repeat(filled) + "\u2591".repeat(empty)
    val color = when {
        percent >= 90 -> TerrariumColors.LEDRed
        percent >= 70 -> TerrariumColors.LEDAmber
        else -> TerrariumColors.LEDGreen
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = "$label",
            color = TerrariumColors.HUDSubtext,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            text = "[$bar]",
            color = color,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            text = "$pct%",
            color = color,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
        )
    }
}

@Composable
private fun HudInfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = "$label:",
            color = TerrariumColors.HUDSubtext,
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            text = value,
            color = TerrariumColors.HUDText,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )
    }
}
