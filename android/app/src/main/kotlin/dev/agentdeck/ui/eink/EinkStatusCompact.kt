package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.state.DashboardState
import dev.agentdeck.util.formatBytes
import dev.agentdeck.util.formatResetTime

/**
 * E-ink status — 2-column layout: LIMITS (left) | MODELS (right).
 * Unicode block gauge (█░) for compact inline rate limit display.
 */
@Composable
fun EinkStatusCompact(
    state: DashboardState,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxSize()
            .height(IntrinsicSize.Min)
            .padding(horizontal = 6.dp, vertical = 0.dp),
    ) {
        // Left: LIMITS (30%)
        Column(
            modifier = Modifier.weight(0.30f).fillMaxHeight().padding(end = 4.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            LimitsColumn(state)
        }

        VerticalDivider(thickness = 1.dp, color = Color.LightGray)

        // Right: MODELS (70%)
        Column(
            modifier = Modifier.weight(0.70f).fillMaxHeight().padding(start = 6.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            ModelsColumn(state)
        }
    }
}

// -- LIMITS column: Unicode block gauges --

private const val GAUGE_LEN = 6

/** Build a text gauge: █████░░░░░ */
private fun blockGauge(percent: Double): String {
    val filled = ((percent / 100.0).coerceIn(0.0, 1.0) * GAUGE_LEN).toInt()
    return "█".repeat(filled) + "░".repeat(GAUGE_LEN - filled)
}

@Composable
private fun LimitsColumn(state: DashboardState) {
    val usage = state.usage
    val has5h = usage.fiveHourPercent != null
    val has7d = usage.sevenDayPercent != null
    val hasLimits = state.billingType != "api" && (has5h || has7d)
    val stale = if (usage.usageStale == true) "!" else ""

    SectionLabel("LIMITS")

    if (hasLimits) {
        if (has5h) {
            val pct = usage.fiveHourPercent!!
            val reset = usage.fiveHourResetsAt?.let { formatResetTime(it) } ?: ""
            GaugeText("5h", pct, reset, stale)
        }
        if (has7d) {
            val pct = usage.sevenDayPercent!!
            val reset = usage.sevenDayResetsAt?.let { formatResetTime(it) } ?: ""
            GaugeText("7d", pct, reset, stale)
        }
        val extraPct = usage.extraUsageUtilization
        if (extraPct != null && usage.extraUsageEnabled == true) {
            GaugeText("Ex", extraPct * 100, "", stale)
        }
    } else if (state.billingType == "api") {
        DataLine("API Key")
    } else {
        DataLine("—")
    }
}

@Composable
private fun GaugeText(label: String, percent: Double, resetTime: String, stale: String) {
    val gauge = blockGauge(percent)
    val resetSuffix = if (resetTime.isNotEmpty()) " $resetTime" else ""
    Text(
        text = "$label $gauge ${percent.toInt()}%$resetSuffix$stale",
        fontSize = 11.sp,
        lineHeight = 14.sp,
        fontFamily = FontFamily.Monospace,
        color = Color.Black,
        maxLines = 1,
    )
}

// -- MODELS column --

@Composable
private fun ModelsColumn(state: DashboardState) {
    SectionLabel("MODELS")

    val catalog = state.modelCatalog
    if (state.oauthConnected == true) {
        val modelText = if (catalog != null && catalog.isNotEmpty()) {
            val names = catalog.filter { it.available }.map { abbreviateModel(it.name) }
            names.joinToString(", ")
        } else {
            "connected"
        }
        DataLine("OAuth: $modelText", maxLines = 2)
    } else if (state.oauthConnected == false) {
        DataLine("OAuth: disconnected")
    }

    val ollama = state.ollamaStatus
    if (ollama != null && ollama.available && ollama.models.isNotEmpty()) {
        val models = ollama.models.map { m ->
            val sizeStr = if (m.sizeVram > 0) " ${formatBytes(m.sizeVram)}"
                else if (m.size > 0) " ${formatBytes(m.size)}"
                else ""
            "${m.name}$sizeStr"
        }
        DataLine("Ollama: ${models.joinToString(", ")}")
    }
}

/** Abbreviate long model names for e-ink display */
private fun abbreviateModel(name: String): String {
    return name
        .replace("DeepSeek: DeepSeek ", "DS:")
        .replace("DeepSeek ", "DS:")
}

// -- Shared --

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        fontSize = 11.sp,
        lineHeight = 12.sp,
        fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace,
        letterSpacing = 1.sp,
        color = Color.DarkGray,
        modifier = Modifier.padding(bottom = 3.dp),
    )
}

@Composable
private fun DataLine(text: String, maxLines: Int = 1) {
    Text(
        text = text,
        fontSize = 11.sp,
        lineHeight = 13.sp,
        fontFamily = FontFamily.Monospace,
        color = Color.Black,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth(),
    )
}
