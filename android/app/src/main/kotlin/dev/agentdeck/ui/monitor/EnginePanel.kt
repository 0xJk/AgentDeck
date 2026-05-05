package dev.agentdeck.ui.monitor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign

import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.ModelCatalogEntry
import dev.agentdeck.net.OllamaStatus
import dev.agentdeck.net.SubscriptionInfo
import dev.agentdeck.net.AntigravityStatusInfo
import dev.agentdeck.net.UsageUpdate
import dev.agentdeck.state.DashboardState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.util.formatBytes
import dev.agentdeck.util.formatResetTime
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeParseException

/**
 * Right HUD panel — "TANK STATUS" aquarium-themed engine dashboard.
 * Water-level gauges for rate limits, model info, ollama models, connection LED dots.
 */
@Composable
fun TankStatusPanel(
    state: DashboardState,
    modifier: Modifier = Modifier,
) {
    val usage = state.usage
    val staleSuffix = if (usage.usageStale == true) " !" else ""
    val ollamaStatus = state.ollamaStatus
    val modelCatalog = state.modelCatalog ?: emptyList()
    val openClawLines = if (state.gatewayConnected == true && state.agentType == "openclaw") {
        openClawDisplayLines(modelCatalog)
    } else {
        emptyList()
    }
    Column(
        modifier = modifier
            .background(TerrariumColors.HUDBg, RoundedCornerShape(8.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // Header
        Text(
            text = "\u223F TANK STATUS",
            color = TerrariumColors.HUDSubtext,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )

        // Water gauges: 5h + 7d side by side (subscription billing)
        if (usage.fiveHourPercent != null || usage.sevenDayPercent != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                if (usage.fiveHourPercent != null) {
                    WaterGauge(
                        label = "5h$staleSuffix",
                        percent = usage.fiveHourPercent,
                        resetTime = usage.fiveHourResetsAt?.let { formatResetTime(it) },
                    )
                }
                if (usage.sevenDayPercent != null) {
                    WaterGauge(
                        label = "7d$staleSuffix",
                        percent = usage.sevenDayPercent,
                        resetTime = usage.sevenDayResetsAt?.let { formatResetTime(it) },
                    )
                }
            }
        }

        // API billing: session cost gauge
        if (state.billingType == "api" && usage.costSpent != null) {
            ApiCostSection(
                costSpent = usage.costSpent,
                costLimit = usage.costLimit,
                resetTime = usage.resetTime?.let { formatResetTime(it) },
                stale = staleSuffix,
            )
        }

        EngineSection(
            title = "OpenClaw",
            lines = openClawLines,
            highlightedLine = openClawLines.firstOrNull(),
        )

        EngineSection(
            title = "MLX",
            lines = state.mlxModels,
        )

        EngineSection(
            title = "OLLAMA",
            lines = ollamaDisplayLines(ollamaStatus),
        )

        EngineSection(
            title = "Antigravity",
            lines = antigravityDisplayLines(state.antigravityStatus),
        )

        EngineSection(
            title = "Subscriptions",
            lines = subscriptionDisplayLines(state.subscriptions),
        )
    }
}

/**
 * Vertical water-level gauge — fills from bottom up.
 * Color transitions: green (<70%) → amber (70-90%) → red (≥90%).
 */
@Composable
private fun WaterGauge(
    label: String,
    percent: Double,
    resetTime: String?,
) {
    val pct = percent.coerceIn(0.0, 100.0)
    val fillFraction = (pct / 100.0).toFloat()
    val fillColor = when {
        pct >= 90 -> TerrariumColors.LEDRed
        pct >= 70 -> TerrariumColors.LEDAmber
        else -> TerrariumColors.LEDGreen
    }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        // Gauge label
        Text(
            text = label,
            color = TerrariumColors.HUDSubtext,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )

        // Gauge body — glass container with water fill
        Box(
            modifier = Modifier
                .size(width = 76.dp, height = 76.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(Color(0x20FFFFFF)),
            contentAlignment = Alignment.Center,
        ) {
            // Water fill from bottom
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight(fillFraction)
                    .align(Alignment.BottomCenter)
                    .background(fillColor.copy(alpha = 0.5f)),
            )

            // Percent overlay
            Text(
                text = "${pct.toInt()}%",
                color = TerrariumColors.HUDText,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                textAlign = TextAlign.Center,
            )
        }

        // Reset time
        if (resetTime != null) {
            Text(
                text = "\u27F2 $resetTime",
                color = TerrariumColors.HUDSubtext.copy(alpha = 0.7f),
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

/**
 * API billing cost display — horizontal bar gauge for cost/limit.
 */
@Composable
private fun ApiCostSection(
    costSpent: Double,
    costLimit: Double?,
    resetTime: String?,
    stale: String,
) {
    val tightStyle = PlatformTextStyle(includeFontPadding = false)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text = "API COST$stale",
            color = TerrariumColors.HUDSubtext,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            style = TextStyle(platformStyle = tightStyle),
        )

        if (costLimit != null && costLimit > 0) {
            val pct = (costSpent / costLimit * 100.0).coerceIn(0.0, 100.0)
            val fillFraction = (pct / 100.0).toFloat()
            val fillColor = when {
                pct >= 90 -> TerrariumColors.LEDRed
                pct >= 70 -> TerrariumColors.LEDAmber
                else -> TerrariumColors.LEDGreen
            }

            // Horizontal bar gauge
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(18.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(Color(0x20FFFFFF)),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth(fillFraction)
                        .fillMaxHeight()
                        .background(fillColor.copy(alpha = 0.5f)),
                )
                Text(
                    text = "${"%.2f".format(costSpent)} / ${"%.0f".format(costLimit)}",
                    color = TerrariumColors.HUDText,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.align(Alignment.Center),
                    style = TextStyle(platformStyle = tightStyle),
                )
            }
        } else {
            Text(
                text = "$${"%.2f".format(costSpent)}",
                color = TerrariumColors.HUDText,
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
                style = TextStyle(platformStyle = tightStyle),
            )
        }

        if (resetTime != null) {
            Text(
                text = "\u27F2 $resetTime",
                color = TerrariumColors.HUDSubtext.copy(alpha = 0.7f),
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                style = TextStyle(platformStyle = tightStyle),
            )
        }
    }
}

@Composable
private fun EngineSection(
    title: String,
    lines: List<String>,
    highlightedLine: String? = null,
) {
    if (lines.isEmpty()) return

    val tightStyle = PlatformTextStyle(includeFontPadding = false)
    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(
            text = title,
            color = TerrariumColors.HUDSubtext,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            style = TextStyle(platformStyle = tightStyle),
        )

        lines.forEach { line ->
            Text(
                text = line,
                color = if (line == highlightedLine) TerrariumColors.LEDAmber else TerrariumColors.HUDText,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                style = TextStyle(platformStyle = tightStyle),
                maxLines = 2,
            )
        }
    }
}

private fun ollamaDisplayLines(ollamaStatus: OllamaStatus?): List<String> {
    if (ollamaStatus == null || !ollamaStatus.available || ollamaStatus.models.isEmpty()) return emptyList()
    val running = ollamaStatus.models.filter { it.sizeVram > 0 }
    val source = if (running.isNotEmpty()) running else ollamaStatus.models
    val items = source.map { model ->
        val vramText = when {
            model.sizeVram > 0 -> " ${formatBytes(model.sizeVram)}"
            model.size > 0 -> " ${formatBytes(model.size)}"
            else -> ""
        }
        "${model.name}$vramText"
    }
    return if (items.isEmpty()) emptyList() else listOf(items.distinct().joinToString(", "))
}

private fun openClawDisplayLines(modelCatalog: List<ModelCatalogEntry>): List<String> {
    val available = modelCatalog.filter { it.available }
    if (available.isEmpty()) return emptyList()

    val ordered = available.sortedWith(
        compareByDescending<ModelCatalogEntry> { it.role == "default" }
            .thenBy { normalizeOpenClawName(it.name) }
    )

    val primary = normalizeOpenClawName(ordered.first().name)
    val remainder = ordered.drop(1).map { normalizeOpenClawName(it.name) }
    if (remainder.isEmpty()) return listOf(primary)

    val grouped = linkedMapOf<String, MutableList<String>>()
    remainder.forEach { normalized ->
        val family = openClawFamilyKey(normalized)
        grouped.getOrPut(family) { mutableListOf() }.add(normalized)
    }

    return listOf(primary) + grouped.values.map { compactOpenClawFamily(it) }.filter { it.isNotBlank() }
}

private fun normalizeOpenClawName(name: String): String =
    name
        .replace("DeepSeek: DeepSeek ", "DeepSeek ")
        .replace("DeepSeek:", "DeepSeek")
        .replace("GPT: GPT ", "GPT ")
        .replace("GLM: GLM ", "GLM ")
        .trim()

private fun openClawFamilyKey(name: String): String {
    val lower = name.lowercase()
    return when {
        lower.startsWith("glm") -> "glm"
        lower.startsWith("gpt") -> "gpt"
        lower.startsWith("deepseek") -> "deepseek"
        lower.startsWith("claude") -> "claude"
        lower.startsWith("gemini") -> "gemini"
        lower.startsWith("qwen") -> "qwen"
        lower.startsWith("llama") -> "llama"
        else -> name
    }
}

private fun compactOpenClawFamily(names: List<String>): String {
    val deduped = names.distinct()
    val first = deduped.firstOrNull() ?: return ""
    if (deduped.size == 1) return first

    val prefix = familyDisplayPrefix(first)
    if (prefix.isEmpty()) return deduped.joinToString(", ")

    return deduped.mapIndexed { index, name ->
        if (index > 0 && name.startsWith(prefix)) {
            name.removePrefix(prefix).trim()
        } else {
            name
        }
    }.joinToString(", ")
}

private fun familyDisplayPrefix(name: String): String {
    val lower = name.lowercase()
    return when {
        lower.startsWith("glm-") -> "GLM-"
        lower.startsWith("gpt-") -> "GPT-"
        lower.startsWith("deepseek ") -> "DeepSeek "
        lower.startsWith("claude ") -> "Claude "
        lower.startsWith("gemini ") -> "Gemini "
        lower.startsWith("qwen ") -> "Qwen "
        lower.startsWith("llama ") -> "Llama "
        else -> ""
    }
}

private fun subscriptionDisplayLines(subscriptions: List<SubscriptionInfo>): List<String> {
    val now = Instant.now()
    return subscriptions.map { formatSubscriptionLine(it, now) }
}

/**
 * Render one subscription row. Drops the `until` suffix when the parsed
 * timestamp is missing, malformed, or already in the past — otherwise the
 * dashboard surfaces a stale "ChatGPT Plus · 2025-03-04" once the underlying
 * Codex JWT falls behind the user's actual subscription state. Caller passes
 * `now` so unit tests can pin time without touching the system clock.
 */
internal fun formatSubscriptionLine(sub: SubscriptionInfo, now: Instant): String {
    val raw = sub.until
    val parsed = raw?.let { parseUntilInstant(it) }
    return if (raw != null && parsed != null && parsed.isAfter(now)) {
        "${sub.name} · ${raw.take(10)}"
    } else {
        sub.name
    }
}

/**
 * Parse `SubscriptionInfo.until` to an `Instant`. Accepts ISO 8601 with
 * offset (`2026-05-15T00:00:00Z`), with fractional seconds, and bare date
 * (`2026-05-15`, treated as UTC midnight). Returns `null` for blank or
 * unparseable input.
 */
internal fun parseUntilInstant(input: String): Instant? {
    val trimmed = input.trim()
    if (trimmed.isEmpty()) return null
    return try {
        OffsetDateTime.parse(trimmed).toInstant()
    } catch (_: DateTimeParseException) {
        try {
            Instant.parse(trimmed)
        } catch (_: DateTimeParseException) {
            try {
                LocalDate.parse(trimmed).atStartOfDay().toInstant(ZoneOffset.UTC)
            } catch (_: DateTimeParseException) {
                null
            }
        }
    }
}

private fun antigravityDisplayLines(status: AntigravityStatusInfo?): List<String> {
    val planName = status?.planName?.takeIf { it.isNotBlank() } ?: return emptyList()
    return listOf(planName)
}
