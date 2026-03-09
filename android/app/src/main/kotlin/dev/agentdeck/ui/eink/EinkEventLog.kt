package dev.agentdeck.ui.eink

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.state.GroupedEntry
import dev.agentdeck.state.TimelineEntry
import dev.agentdeck.state.groupConsecutive
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Compact event log for e-ink center column.
 * Shows recent 14 events with type icons and grouping, "HH:MM ▶ summary" monospace format.
 */
@Composable
fun EinkEventLog(
    entries: List<TimelineEntry>,
    modifier: Modifier = Modifier,
) {
    val scrollState = rememberScrollState()
    val recent = entries.takeLast(20)
    val grouped = remember(recent) { groupConsecutive(recent).takeLast(14) }

    // Auto-scroll to bottom when new entries arrive
    LaunchedEffect(entries.size) {
        scrollState.animateScrollTo(scrollState.maxValue)
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(8.dp)
            .verticalScroll(scrollState),
    ) {
        if (grouped.isEmpty()) {
            Text(
                text = "No events yet",
                style = MaterialTheme.typography.bodySmall.copy(
                    fontFamily = FontFamily.Monospace,
                ),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            grouped.forEach { group ->
                val entry = group.entry
                val time = formatTimeHHMM(entry.timestamp)
                val agentTag = agentTag(entry.agentType)
                val icon = typeIcon(entry.type, entry.status)
                val countSuffix = if (group.count > 1) " (×${group.count})" else ""
                val line = "$time $agentTag$icon ${entry.summary}$countSuffix"
                val hasDetail = !entry.detail.isNullOrEmpty() && entry.detail != entry.summary
                Text(
                    text = line,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp,
                        lineHeight = 17.sp,
                        fontWeight = if (entry.type == "chat_start") FontWeight.Bold else FontWeight.Normal,
                    ),
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = if (hasDetail) 2 else 1,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (hasDetail) {
                    Text(
                        text = "  ${entry.detail}",
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            lineHeight = 14.sp,
                        ),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = 4.dp),
                    )
                }
            }
        }
    }
}

private val timeFormat = SimpleDateFormat("HH:mm", Locale.US)

private fun formatTimeHHMM(timestamp: Long): String {
    return timeFormat.format(Date(timestamp))
}

private fun typeIcon(type: String, status: String? = null): String = when (type) {
    "tool_request" -> when (status) {
        "approved" -> "✓"
        "denied" -> "✗"
        else -> "⚠"
    }
    "tool_resolved" -> "✓"
    "tool_exec" -> "▸"
    "model_call" -> "◆"
    "model_response" -> "◇"
    "chat_start" -> "▶"
    "chat_end" -> "■"
    "chat_response" -> "◇"
    "memory_recall" -> "⦻"
    "error" -> "✗"
    "scheduled" -> "⏰"
    "user_action" -> "☞"
    "state_change" -> "△"
    else -> "·"
}

private fun agentTag(agentType: String?): String = when (agentType) {
    "claude-code" -> "Claude "
    "openclaw" -> "OpenClaw "
    null -> ""
    else -> "Agent "
}
