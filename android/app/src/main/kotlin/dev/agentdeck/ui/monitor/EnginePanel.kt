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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign

import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.ModelCatalogEntry
import dev.agentdeck.net.OllamaStatus
import dev.agentdeck.net.UsageUpdate
import dev.agentdeck.state.DashboardState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.util.formatBytes
import dev.agentdeck.util.formatResetTime

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
    val oauthConnected = state.oauthConnected
    val ollamaStatus = state.ollamaStatus
    val modelName = state.modelName
    val modelCatalog = state.modelCatalog ?: emptyList()
    Column(
        modifier = modifier
            .background(TerrariumColors.HUDBg, RoundedCornerShape(8.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // Header
        Text(
            text = "\u223F TANK STATUS",
            color = TerrariumColors.HUDSubtext,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )

        // Water gauges: 5h + 7d side by side
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

        // Model info section
        ModelInfoSection(
            modelName = modelName,
            modelCatalog = modelCatalog,
        )

        // Ollama info section
        OllamaInfoSection(ollamaStatus = ollamaStatus)

        // Connection dots
        ConnectionDots(
            oauthConnected = oauthConnected,
            ollamaStatus = ollamaStatus,
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
 * Current active model + available models from catalog.
 */
@Composable
private fun ModelInfoSection(
    modelName: String?,
    modelCatalog: List<ModelCatalogEntry>,
) {
    if (modelName == null && modelCatalog.isEmpty()) return

    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(
            text = "MODEL",
            color = TerrariumColors.HUDSubtext,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )

        // Current active model
        if (modelName != null) {
            Text(
                text = modelName,
                color = TerrariumColors.HUDText,
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
            )
        }

        // Other available models (excluding current)
        val otherModels = modelCatalog
            .filter { it.available && it.name != modelName }
            .map { it.name }
        if (otherModels.isNotEmpty()) {
            Text(
                text = otherModels.joinToString(" \u00B7 "),
                color = TerrariumColors.HUDSubtext,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

/**
 * Running ollama models with VRAM sizes.
 */
@Composable
private fun OllamaInfoSection(ollamaStatus: OllamaStatus?) {
    if (ollamaStatus == null || !ollamaStatus.available || ollamaStatus.models.isEmpty()) return

    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(
            text = "OLLAMA",
            color = TerrariumColors.HUDSubtext,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )

        ollamaStatus.models.forEach { model ->
            val vramText = when {
                model.sizeVram > 0 -> " ${formatBytes(model.sizeVram)}"
                model.size > 0 -> " ${formatBytes(model.size)}"
                else -> ""
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Spacer(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(TerrariumColors.LEDGreen),
                )
                Text(
                    text = "${model.name}$vramText",
                    color = TerrariumColors.HUDText,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

/**
 * Connection status LED dots — OAuth + Ollama.
 */
@Composable
private fun ConnectionDots(
    oauthConnected: Boolean?,
    ollamaStatus: OllamaStatus?,
) {
    val dots = mutableListOf<Pair<String, Color>>()

    when (oauthConnected) {
        true -> dots += "OAuth" to TerrariumColors.LEDGreen
        false -> dots += "OAuth" to TerrariumColors.LEDRed.copy(alpha = 0.6f)
        null -> {} // unknown — don't show
    }

    ollamaStatus?.let { olla ->
        if (olla.available) {
            dots += "Ollama" to TerrariumColors.LEDGreen
        } else {
            dots += "Ollama" to TerrariumColors.HUDSubtext.copy(alpha = 0.4f)
        }
    }

    if (dots.isNotEmpty()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            dots.forEach { (label, color) ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    // LED dot
                    Spacer(
                        modifier = Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(color),
                    )
                    Text(
                        text = label,
                        color = TerrariumColors.HUDSubtext,
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }
    }
}
