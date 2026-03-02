package dev.agentdeck.ui.eink

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.state.DashboardState
import dev.agentdeck.util.formatBytes
import dev.agentdeck.util.formatResetTime

/**
 * Redesigned e-ink status display with 2 sections: Rate Limits + Models.
 * Adapts between wide (2-column) and narrow (2-column) layouts via BoxWithConstraints.
 */
@Composable
fun EinkStatusCompact(
    state: DashboardState,
    modifier: Modifier = Modifier,
) {
    val usage = state.usage

    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        if (maxWidth > 700.dp) {
            // Wide layout: 3-column horizontal
            WideStatusLayout(state = state, usage = usage)
        } else {
            // Narrow layout: vertical stack
            NarrowStatusLayout(state = state, usage = usage)
        }
    }
}

// ── Wide layout (IDLE: full width, 2 columns) ──────────────────────────────

@Composable
private fun WideStatusLayout(
    state: DashboardState,
    usage: dev.agentdeck.net.UsageUpdate,
) {
    Row(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Left (50%): Rate Limits
        Column(
            modifier = Modifier.weight(1f).fillMaxHeight(),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            SectionHeader("RATE LIMITS")
            if (state.billingType == "api") {
                DataText("API Key")
            } else {
                RateLimitRow(label = "5h", percent = usage.fiveHourPercent, resetAt = usage.fiveHourResetsAt)
                RateLimitRow(label = "7d", percent = usage.sevenDayPercent, resetAt = usage.sevenDayResetsAt)
                ExtraUsageRow(usage)
            }
        }

        // Right (50%): Models
        Column(
            modifier = Modifier.weight(1f).fillMaxHeight(),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            SectionHeader("MODELS")
            ModelsSection(state)
        }
    }
}

// ── Narrow layout (ACTIVE: vertical stack) ──────────────────────────────────

@Composable
private fun NarrowStatusLayout(
    state: DashboardState,
    usage: dev.agentdeck.net.UsageUpdate,
) {
    Row(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Left (50%): Rate Limits
        Column(
            modifier = Modifier.weight(1f).fillMaxHeight(),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (state.billingType == "api") {
                SectionHeader("API Key")
            } else {
                SectionHeader("RATE LIMITS")
                RateLimitRow(label = "5h", percent = usage.fiveHourPercent, resetAt = usage.fiveHourResetsAt)
                RateLimitRow(label = "7d", percent = usage.sevenDayPercent, resetAt = usage.sevenDayResetsAt)
                ExtraUsageRow(usage)
            }
        }

        // Right (50%): Models
        Column(
            modifier = Modifier.weight(1f).fillMaxHeight(),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            SectionHeader("MODELS")
            ModelsSection(state)
        }
    }
}

// ── Shared components ───────────────────────────────────────────────────────

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall.copy(
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
        ),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun DataText(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
        color = MaterialTheme.colorScheme.onSurface,
    )
}

@Composable
private fun SmallDataText(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall.copy(
            fontFamily = FontFamily.Monospace,
            fontSize = 9.sp,
            lineHeight = 12.sp,
        ),
        color = MaterialTheme.colorScheme.onSurface,
    )
}

@Composable
private fun RateLimitRow(label: String, percent: Double?, resetAt: String?) {
    if (percent == null) return
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        DataText(label)
        EinkGaugeBar(
            percent = percent,
            modifier = Modifier.weight(1f),
        )
        DataText("${percent.toInt()}%")
        resetAt?.let { DataText(formatResetTime(it)) }
    }
}

@Composable
private fun ExtraUsageRow(usage: dev.agentdeck.net.UsageUpdate) {
    val extraPct = usage.extraUsageUtilization ?: return
    if (usage.extraUsageEnabled != true) return
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        DataText("Ex")
        EinkGaugeBar(
            percent = extraPct * 100.0,
            modifier = Modifier.weight(1f),
        )
        DataText("${(extraPct * 100).toInt()}%")
    }
}

@Composable
private fun ModelsSection(state: DashboardState) {
    // OAuth / model catalog
    val catalog = state.modelCatalog
    if (state.oauthConnected == true) {
        if (catalog != null && catalog.isNotEmpty()) {
            val names = catalog.filter { it.available }.map { it.name }
            SmallDataText("OAuth: ${names.joinToString(", ")}")
        } else {
            SmallDataText("OAuth: connected")
        }
    } else if (state.oauthConnected == false) {
        SmallDataText("OAuth: disconnected")
    }

    // Ollama — show disk size, VRAM when loaded
    val ollama = state.ollamaStatus
    if (ollama != null && ollama.available && ollama.models.isNotEmpty()) {
        val models = ollama.models.map { m ->
            val sizeStr = when {
                m.sizeVram > 0 -> " ${formatBytes(m.sizeVram)}"
                m.size > 0 -> " ${formatBytes(m.size)}"
                else -> ""
            }
            "${m.name}$sizeStr"
        }
        SmallDataText("Ollama: ${models.joinToString(", ")}")
    }
}

/**
 * Compose Box-based gauge bar for e-ink: black fill + white empty + black border.
 * Maximum contrast without dithering artifacts.
 */
@Composable
private fun EinkGaugeBar(
    percent: Double,
    modifier: Modifier = Modifier,
    height: Dp = 10.dp,
) {
    val fillFraction = (percent / 100.0).coerceIn(0.0, 1.0).toFloat()
    Box(
        modifier = modifier
            .height(height)
            .border(1.dp, Color.Black, RoundedCornerShape(2.dp))
            .clip(RoundedCornerShape(2.dp))
            .background(Color.White),
    ) {
        Box(
            modifier = Modifier
                .fillMaxHeight()
                .fillMaxWidth(fillFraction)
                .background(Color.Black),
        )
    }
}
