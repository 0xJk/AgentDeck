package dev.agentdeck.ui.monitor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.state.GroupedEntry
import dev.agentdeck.state.TimelineEntry
import dev.agentdeck.state.groupConsecutive
import dev.agentdeck.terrarium.TerrariumColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Bottom HUD strip — "TIMELINE"
 * Shows recent events with auto-scroll, type icons, grouping, status indicators.
 */
@Composable
fun TimelineStrip(
    entries: List<TimelineEntry>,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val recentEntries = entries.takeLast(30)
    val grouped = remember(recentEntries) { groupConsecutive(recentEntries) }

    // Auto-scroll to bottom on new entries
    LaunchedEffect(grouped.size) {
        if (grouped.isNotEmpty()) {
            listState.animateScrollToItem(grouped.lastIndex)
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(8.dp),
    ) {
        Text(
            text = "TIMELINE",
            color = TerrariumColors.HUDSubtext,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.padding(bottom = 4.dp),
        )

        if (grouped.isEmpty()) {
            Text(
                text = "No events yet",
                color = TerrariumColors.HUDSubtext,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
        } else {
            LazyColumn(
                state = listState,
                verticalArrangement = Arrangement.spacedBy(2.dp),
                modifier = Modifier.weight(1f, fill = false),
            ) {
                items(grouped) { group ->
                    TimelineRow(group)
                }
            }
        }
    }
}

@Composable
private fun TimelineRow(group: GroupedEntry) {
    val entry = group.entry
    val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
    val timeStr = timeFormat.format(Date(entry.timestamp))
    val agentTag = agentTag(entry.agentType)
    val icon = typeIcon(entry.type, entry.status)
    val iconColor = typeColor(entry.type)
    val isChatStart = entry.type == "chat_start"
    val isChatEnd = entry.type == "chat_end"
    val countSuffix = if (group.count > 1) " (×${group.count})" else ""

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = timeStr,
                color = TerrariumColors.HUDSubtext.copy(alpha = if (isChatEnd) 0.5f else 0.6f),
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = if (agentTag.isNotEmpty()) "$agentTag $icon" else icon,
                color = iconColor.copy(alpha = if (isChatEnd) 0.7f else 1f),
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = entry.summary + countSuffix,
                color = if (isChatEnd) TerrariumColors.HUDText.copy(alpha = 0.7f) else TerrariumColors.HUDText,
                fontSize = if (isChatStart) 11.sp else 10.sp,
                fontWeight = if (isChatStart) FontWeight.Bold else FontWeight.Normal,
                fontFamily = FontFamily.Monospace,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        if (!entry.detail.isNullOrEmpty() && entry.detail != entry.summary) {
            Text(
                text = entry.detail,
                color = TerrariumColors.HUDSubtext.copy(alpha = 0.7f),
                fontSize = 9.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 68.dp),
            )
        }
    }
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

private fun typeColor(type: String) = when (type) {
    "tool_request", "tool_resolved", "tool_exec" -> TerrariumColors.LEDGreen
    "model_call", "model_response" -> TerrariumColors.TetraNeon
    "chat_response" -> TerrariumColors.TetraNeon
    "memory_recall" -> TerrariumColors.ClaudeBody
    "chat_start", "chat_end" -> TerrariumColors.HUDText
    "error" -> TerrariumColors.LEDRed
    "state_change" -> TerrariumColors.LEDAmber
    else -> TerrariumColors.HUDSubtext
}

private fun agentTag(agentType: String?): String = when (agentType) {
    "claude-code" -> "Claude"
    "openclaw" -> "OpenClaw"
    null -> ""
    else -> "Agent"
}
