package dev.agentdeck.ui.monitor

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.ui.component.BrandIcon

/**
 * Floating attention card surfaced over the terrarium when any session is
 * awaiting input (permission / option / diff). Ports the macOS Option D
 * "attention theater" pattern to the tablet HUD in terrarium palette — a
 * deep-water glass card with an amber bioluminescent signal glow.
 *
 * YES / NO / ALWAYS map to the canonical `select_option(0/1/2)` command
 * (same path as D200H hardware buttons and the Swift Cmd+Y/N/A shortcut).
 *
 * Non-interactive creature badge pulses with a subtle breathe animation;
 * the card's amber outer stroke pulses to 1.0s period so the user sees
 * the alert in peripheral vision without it feeling distracting.
 *
 * Rendered only when `featured` is non-null — the caller decides which
 * awaiting session to surface (typically the focused one, or the first in
 * sort order).
 */
@Composable
fun AttentionTheaterHUD(
    featured: AttentionFeatured,
    queuedCount: Int,
    onRespond: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val infinite = rememberInfiniteTransition(label = "attention")
    val breathe by infinite.animateFloat(
        initialValue = 1f,
        targetValue = 1.04f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 900, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "breathe",
    )
    val auraAlpha by infinite.animateFloat(
        initialValue = 0.12f,
        targetValue = 0.35f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1200, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "aura",
    )

    Column(
        modifier = modifier
            .widthIn(max = 460.dp)
            .background(
                color = Color.Black.copy(alpha = 0.65f),
                shape = RoundedCornerShape(12.dp),
            )
            .border(
                border = BorderStroke(1.dp, TerrariumColors.LEDAmber.copy(alpha = 0.45f)),
                shape = RoundedCornerShape(12.dp),
            )
            .clip(RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            // Breathing creature badge — dark glass tile + amber edge.
            Box(
                modifier = Modifier
                    .size(50.dp)
                    .scale(breathe)
                    .background(
                        color = Color.Black.copy(alpha = 0.45f),
                        shape = RoundedCornerShape(12.dp),
                    )
                    .border(
                        border = BorderStroke(1.dp, TerrariumColors.LEDAmber.copy(alpha = auraAlpha + 0.15f)),
                        shape = RoundedCornerShape(12.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                BrandIcon(agentType = featured.agentType, isEink = false, size = 34.dp)
            }

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "ATTENTION",
                        color = TerrariumColors.LEDAmber,
                        fontSize = 9.5.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                    )
                    if (queuedCount > 0) {
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = "+$queuedCount queued",
                            color = TerrariumColors.HUDSubtext,
                            fontSize = 9.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
                Text(
                    text = featured.projectName ?: "Session",
                    color = TerrariumColors.HUDText,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = featured.subtitle,
                    color = TerrariumColors.HUDSubtext,
                    fontSize = 10.5.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val question = featured.question
                if (!question.isNullOrEmpty()) {
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = question,
                        color = TerrariumColors.HUDText,
                        fontSize = 12.sp,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        // YES / NO / ALWAYS — `select_option(0/1/2)` matches the D200H
        // hardware mapping and the keyboard shortcuts we ship on desktop.
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TheaterButton(
                label = "Yes",
                fill = TerrariumColors.LEDGreen,
                modifier = Modifier.weight(1f),
                onClick = { onRespond(0) },
            )
            TheaterButton(
                label = "No",
                fill = TerrariumColors.LEDRed,
                modifier = Modifier.weight(1f),
                onClick = { onRespond(1) },
            )
            TheaterButton(
                label = "Always",
                fill = TerrariumColors.TetraNeon,
                modifier = Modifier.weight(1f),
                onClick = { onRespond(2) },
            )
        }
    }
}

/**
 * Small lookaside wrapper so `MonitorScreen` doesn't have to reach across
 * Android/iOS `SessionInfo` variants — we pull exactly what the theater
 * needs and format it upstream. `agentType`/`question`/etc. all carry the
 * same meaning as the Swift `AttentionTheaterHUD.session` fields.
 */
data class AttentionFeatured(
    val sessionId: String?,
    val projectName: String?,
    val agentType: String?,
    val modelName: String?,
    val question: String?,
    val subtitle: String,
)

@Composable
private fun TheaterButton(
    label: String,
    fill: Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier = modifier
            .height(40.dp)
            .background(color = fill, shape = RoundedCornerShape(8.dp))
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = Color.Black.copy(alpha = 0.85f),
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/**
 * Build the `AttentionFeatured` payload from a tablet SessionInfo +
 * optional live question (only the focused session has the question
 * streamed live; non-focused sessions still surface but with a generic
 * prompt).
 */
fun buildAttentionFeatured(
    session: SessionInfo,
    question: String?,
): AttentionFeatured {
    val agentLabel = when (session.agentType) {
        "claude-code" -> "Claude"
        "codex-cli"   -> "Codex"
        "openclaw"    -> "OpenClaw"
        "opencode"    -> "OpenCode"
        else          -> session.agentType?.replaceFirstChar { it.uppercaseChar() } ?: "Agent"
    }
    val parts = buildList {
        add(agentLabel)
        session.modelName?.let { add(shortenModel(it)) }
    }
    return AttentionFeatured(
        sessionId = session.id,
        projectName = session.projectName,
        agentType = session.agentType,
        modelName = session.modelName,
        question = question,
        subtitle = parts.joinToString(" · "),
    )
}

/** Check whether an agent state corresponds to "awaiting user input". */
fun AgentState.isAwaiting(): Boolean = when (this) {
    AgentState.AWAITING_PERMISSION,
    AgentState.AWAITING_OPTION,
    AgentState.AWAITING_DIFF -> true
    else -> false
}

private fun shortenModel(name: String): String {
    var s = name
    for (prefix in listOf("claude-", "gpt-", "o1-", "o3-")) {
        if (s.startsWith(prefix)) s = s.removePrefix(prefix)
    }
    return s.replace(Regex("-\\d{8}$"), "")
}
