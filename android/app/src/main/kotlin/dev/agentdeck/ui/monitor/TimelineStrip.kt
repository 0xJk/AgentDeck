package dev.agentdeck.ui.monitor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.state.TimelineEntry
import dev.agentdeck.terrarium.TerrariumColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Bottom HUD strip — "TIMELINE"
 * Shows recent events with auto-scroll, type-based color prefix.
 */
@Composable
fun TimelineStrip(
    entries: List<TimelineEntry>,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val recentEntries = entries.takeLast(20)

    // Auto-scroll to bottom on new entries
    LaunchedEffect(recentEntries.size) {
        if (recentEntries.isNotEmpty()) {
            listState.animateScrollToItem(recentEntries.lastIndex)
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(TerrariumColors.HUDBg, RoundedCornerShape(8.dp))
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

        if (recentEntries.isEmpty()) {
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
                items(recentEntries) { entry ->
                    TimelineRow(entry)
                }
            }
        }
    }
}

@Composable
private fun TimelineRow(entry: TimelineEntry) {
    val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
    val timeStr = timeFormat.format(Date(entry.timestamp))
    val prefix = typePrefix(entry.type)
    val prefixColor = typeColor(entry.type)

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = timeStr,
            color = TerrariumColors.HUDSubtext.copy(alpha = 0.6f),
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            text = "[$prefix]",
            color = prefixColor,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            text = entry.summary,
            color = TerrariumColors.HUDText,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

private fun typePrefix(type: String): String = when (type) {
    "tool_request" -> "T"
    "tool_resolved" -> "T"
    "model_call" -> "M"
    "model_response" -> "M"
    "memory_recall" -> "R"
    "tool_exec" -> "X"
    "chat_start" -> "C"
    "chat_end" -> "C"
    "error" -> "E"
    "state_change" -> "S"
    else -> "?"
}

private fun typeColor(type: String) = when (type) {
    "tool_request", "tool_resolved", "tool_exec" -> TerrariumColors.LEDGreen
    "model_call", "model_response" -> TerrariumColors.TetraNeon
    "memory_recall" -> TerrariumColors.ClaudeBody
    "chat_start", "chat_end" -> TerrariumColors.HUDText
    "error" -> TerrariumColors.LEDRed
    "state_change" -> TerrariumColors.LEDAmber
    else -> TerrariumColors.HUDSubtext
}
