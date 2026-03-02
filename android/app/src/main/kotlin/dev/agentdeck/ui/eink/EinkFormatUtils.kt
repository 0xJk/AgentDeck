package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.AgentState

fun formatCount(n: Int): String = when {
    n >= 1_000_000 -> "%.1fM".format(n / 1_000_000.0)
    n >= 1_000 -> "%.1fK".format(n / 1_000.0)
    else -> n.toString()
}

fun formatDuration(seconds: Int): String {
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

fun formatDurationLong(millis: Long): String {
    val totalSec = (millis / 1000).toInt()
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    val s = totalSec % 60
    return "%d:%02d:%02d".format(h, m, s)
}

fun stateMarker(state: AgentState): String = when (state) {
    AgentState.IDLE -> "\u25CF IDLE"                          // ●
    AgentState.PROCESSING -> "\u25C9 PROCESSING"              // ◉
    AgentState.AWAITING_PERMISSION -> "\u26A0 PERMISSION"     // ⚠
    AgentState.AWAITING_OPTION -> "\u25C7 SELECT"             // ◇
    AgentState.AWAITING_DIFF -> "\u25A1 DIFF REVIEW"          // □
    AgentState.DISCONNECTED -> "\u25CB DISCONNECTED"          // ○
}

fun compactStateMarker(state: AgentState): String = when (state) {
    AgentState.IDLE -> "\u25CF IDLE"
    AgentState.PROCESSING -> "\u25C9 PROC"
    AgentState.AWAITING_PERMISSION -> "\u26A0 PERM"
    AgentState.AWAITING_OPTION -> "\u25C7 SEL"
    AgentState.AWAITING_DIFF -> "\u25A1 DIFF"
    AgentState.DISCONNECTED -> "\u25CB OFF"
}

fun agentIcon(agentType: String?): String = when (agentType) {
    "claude-code" -> "\uD83D\uDC19"  // octopus
    "openclaw" -> "\uD83E\uDD9E"     // lobster (closest to crayfish)
    else -> "\u25CF"                   // bullet
}

fun mapSessionState(session: dev.agentdeck.net.SessionInfo): AgentState {
    if (!session.alive) return AgentState.DISCONNECTED
    return when (session.state) {
        "processing" -> AgentState.PROCESSING
        "idle" -> AgentState.IDLE
        "awaiting_permission", "awaiting_option", "awaiting_diff" -> AgentState.AWAITING_PERMISSION
        else -> AgentState.IDLE
    }
}

@Composable
fun EinkTextGauge(
    label: String,
    percent: Double,
    barLength: Int = 20,
) {
    val pct = percent.coerceIn(0.0, 100.0).toInt()
    val filled = (pct * barLength / 100).coerceAtMost(barLength)
    val empty = barLength - filled
    val bar = "\u2588".repeat(filled) + "\u2591".repeat(empty)  // █ and ░

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = "$label:",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = "[$bar] $pct%",
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
