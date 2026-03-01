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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.state.TimelineEntry
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Compact event log for e-ink center column.
 * Shows recent 8 events in "HH:MM [T] summary" monospace format.
 */
@Composable
fun EinkEventLog(
    entries: List<TimelineEntry>,
    modifier: Modifier = Modifier,
) {
    val scrollState = rememberScrollState()
    val recent = entries.takeLast(8)

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
        if (recent.isEmpty()) {
            Text(
                text = "No events yet",
                style = MaterialTheme.typography.bodySmall.copy(
                    fontFamily = FontFamily.Monospace,
                ),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            recent.forEach { entry ->
                val time = formatTimeHHMM(entry.timestamp)
                val typeTag = typeTag(entry.type)
                val line = "$time $typeTag ${entry.summary}"
                Text(
                    text = line,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp,
                    ),
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

private val timeFormat = SimpleDateFormat("HH:mm", Locale.US)

private fun formatTimeHHMM(timestamp: Long): String {
    return timeFormat.format(Date(timestamp))
}

private fun typeTag(type: String): String = when (type) {
    "tool_request" -> "[T]"
    "tool_resolved" -> "[T]"
    "model_call" -> "[M]"
    "model_response" -> "[M]"
    "chat_start" -> "[C]"
    "chat_end" -> "[C]"
    "error" -> "[E]"
    "memory_recall" -> "[R]"
    "tool_exec" -> "[X]"
    else -> "[S]"  // state changes and others
}
