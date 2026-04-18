package dev.agentdeck.ui.component

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.terrarium.TerrariumColors

/**
 * AgentDeck brand logo — bold monospace text + accent underline bar.
 * Two variants: e-ink (black on white, solid bar) and tablet (HUD text, neon cyan glow bar).
 */
@Composable
fun AgentDeckLogo(isEink: Boolean, modifier: Modifier = Modifier) {
    if (isEink) {
        EinkLogo(modifier)
    } else {
        TabletLogo(modifier)
    }
}

@Composable
private fun EinkLogo(modifier: Modifier) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "AgentDeck",
            style = MaterialTheme.typography.headlineSmall.copy(
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            ),
            color = MaterialTheme.colorScheme.onSurface,
        )
        Spacer(modifier = Modifier.height(3.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth(0.8f)
                .height(2.dp)
                .background(
                    MaterialTheme.colorScheme.onSurface,
                    RoundedCornerShape(1.dp),
                ),
        )
    }
}

@Composable
private fun TabletLogo(modifier: Modifier) {
    val accentColor = Color(0xFF00E5FF) // Neon cyan

    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Stacked-deck mark + wordmark, matching the menubar/iOS brand. The
        // deck glyph on the left gives users a recognizable AgentDeck shape
        // independent of the wordmark.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            AgentDeckMark(size = 20.dp, color = accentColor)
            Text(
                text = "AgentDeck",
                color = TerrariumColors.HUDText,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
        Spacer(modifier = Modifier.height(3.dp))
        // Glow layer (3dp, 30% opacity) + crisp bar (2dp)
        Box(
            modifier = Modifier
                .fillMaxWidth(0.8f)
                .height(5.dp)
                .drawBehind {
                    // Glow layer
                    drawRoundRect(
                        color = accentColor.copy(alpha = 0.30f),
                        topLeft = Offset.Zero,
                        size = Size(size.width, 3.dp.toPx()),
                        cornerRadius = CornerRadius(1.5.dp.toPx()),
                    )
                    // Crisp bar
                    drawRoundRect(
                        color = accentColor,
                        topLeft = Offset(0f, 3.dp.toPx()),
                        size = Size(size.width, 2.dp.toPx()),
                        cornerRadius = CornerRadius(1.dp.toPx()),
                    )
                },
        )
    }
}

/**
 * Icon-only AgentDeck mark — three offset stacked cards with a single pip
 * on the top card. Metaphor: a deck of agents. Geometry mirrors the Swift
 * `AgentDeckLogo` (which ports from `explore/logos.jsx::LogoDeck`), so all
 * surfaces — menubar popup, iOS/macOS dashboard, Android tablet HUD — show
 * the same brand glyph. Only the tint varies per context.
 *
 * Usage:
 *   AgentDeckMark(size = 18.dp, color = TerrariumColors.TetraNeon)
 */
@Composable
fun AgentDeckMark(size: Dp = 20.dp, color: Color = TerrariumColors.HUDText) {
    Canvas(modifier = Modifier.size(size)) {
        val s = this.size.minDimension / 24f  // unit-space 0..24
        val stroke = (1.6f * s).coerceAtLeast(1.0f)
        // Three offset cards, back → front, increasing opacity. Offsets
        // match the JS prototype's `LogoDeck` rect positions.
        val cards = listOf(
            Triple(4f, 8f, 0.35f),
            Triple(6f, 5f, 0.60f),
            Triple(8f, 2f, 1.00f),
        )
        for ((x, y, alpha) in cards) {
            drawRoundRect(
                color = color.copy(alpha = alpha),
                topLeft = Offset(x * s, y * s),
                size = Size(12f * s, 14f * s),
                cornerRadius = CornerRadius(1.5f * s, 1.5f * s),
                style = Stroke(width = stroke),
            )
        }
        // Pip on the front card.
        val pipRadius = 1.6f * s
        drawCircle(
            color = color,
            radius = pipRadius,
            center = Offset(14f * s, 9f * s),
        )
    }
}
