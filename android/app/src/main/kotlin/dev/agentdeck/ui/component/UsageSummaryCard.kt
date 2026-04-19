package dev.agentdeck.ui.component

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.UsageUpdate
import dev.agentdeck.state.MetricsSnapshot
import dev.agentdeck.ui.eink.formatCount
import dev.agentdeck.ui.eink.formatDuration
import dev.agentdeck.ui.eink.formatDurationLong
import dev.agentdeck.ui.theme.AgentDeckColors

/**
 * Compact usage summary card for DashboardScreen.
 * Rate limit bars with reset times + extra usage + token/cost/uptime stats.
 */
@Composable
fun UsageSummaryCard(
    usage: UsageUpdate,
    metrics: MetricsSnapshot,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Row 1: Rate limit bars with reset times
            // Treat stale upstream data as "no data" — a frozen "12%" from an
            // old CLI session reads as current. Every other AgentDeck surface
            // (macOS dashboard, Pixoo, D200H, plugin) collapses its usage
            // region on the same criteria.
            val usageLive = usage.usageStale != true
            if (usageLive && (usage.fiveHourPercent != null || usage.sevenDayPercent != null)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    if (usage.fiveHourPercent != null) {
                        CompactGauge(
                            label = "5h",
                            percent = usage.fiveHourPercent,
                            resetAt = usage.fiveHourResetsAt,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    if (usage.sevenDayPercent != null) {
                        CompactGauge(
                            label = "7d",
                            percent = usage.sevenDayPercent,
                            resetAt = usage.sevenDayResetsAt,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }

            // Extra usage bar
            if (usageLive && usage.extraUsageEnabled == true && usage.extraUsageUtilization != null) {
                CompactGauge(
                    label = "Extra",
                    percent = usage.extraUsageUtilization,
                    suffix = if (usage.extraUsageUsedCredits != null && usage.extraUsageMonthlyLimit != null) {
                        "$${String.format("%.2f", usage.extraUsageUsedCredits)}/$${String.format("%.0f", usage.extraUsageMonthlyLimit)}"
                    } else null,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            // Row 2: Quick stats
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                StatChip(
                    label = "Tok",
                    value = formatCount(usage.inputTokens + usage.outputTokens),
                )
                StatChip(label = "Tool", value = "${usage.toolCalls}")
                if (usage.estimatedCostUsd != null) {
                    StatChip(
                        label = "$",
                        value = String.format("%.2f", usage.estimatedCostUsd),
                    )
                }
                val uptimeText = if (metrics.connectedSince != null) {
                    val elapsed = System.currentTimeMillis() - metrics.connectedSince
                    formatDurationLong(elapsed)
                } else {
                    formatDuration(usage.sessionDurationSec)
                }
                StatChip(label = "UP", value = uptimeText)
            }
        }
    }
}

@Composable
private fun CompactGauge(
    label: String,
    percent: Double,
    modifier: Modifier = Modifier,
    resetAt: String? = null,
    suffix: String? = null,
) {
    val fraction = (percent / 100.0).coerceIn(0.0, 1.0).toFloat()
    val color = when {
        percent >= 90 -> AgentDeckColors.Red
        percent >= 70 -> AgentDeckColors.Amber
        else -> AgentDeckColors.Green
    }

    Column(modifier = modifier) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "$label:",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            LinearProgressIndicator(
                progress = { fraction },
                modifier = Modifier
                    .weight(1f)
                    .height(6.dp)
                    .clip(RoundedCornerShape(3.dp)),
                color = color,
                trackColor = MaterialTheme.colorScheme.surfaceVariant,
            )
            Text(
                text = suffix ?: "${percent.toInt()}%",
                style = MaterialTheme.typography.bodySmall,
                color = color,
            )
        }
        if (resetAt != null) {
            Text(
                text = "Resets ${formatResetTime(resetAt)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun formatResetTime(isoString: String): String {
    return try {
        val odt = java.time.OffsetDateTime.parse(isoString)
        val local = odt.atZoneSameInstant(java.time.ZoneId.systemDefault()).toLocalDateTime()
        String.format("%02d:%02d", local.hour, local.minute)
    } catch (_: Exception) {
        isoString
    }
}

@Composable
private fun StatChip(
    label: String,
    value: String,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = value,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
