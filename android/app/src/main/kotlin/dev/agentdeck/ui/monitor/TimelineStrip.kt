package dev.agentdeck.ui.monitor

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
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
 * Bottom HUD strip — two-pane "Logbook" layout.
 * Left (65%): compact log scroll. Right (35%): detail panel for focused entry.
 */
@Composable
fun TimelineStrip(
    entries: List<TimelineEntry>,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val displayEntries = remember(entries) {
        entries
            .filterNot { it.type == "chat_end" && it.agentType == "claude-code" }
            .takeLast(50)
    }
    val grouped = remember(displayEntries) { groupConsecutive(displayEntries) }

    // Focus tracking: -1 = auto-follow latest
    var focusedIndex by remember { mutableIntStateOf(-1) }

    // Resolve which entry to show in detail pane
    val focusedGroup: GroupedEntry? = when {
        grouped.isEmpty() -> null
        focusedIndex < 0 || focusedIndex >= grouped.size -> grouped.lastOrNull()
        else -> grouped[focusedIndex]
    }

    // Auto-scroll to bottom on new entries when in auto-follow mode
    LaunchedEffect(grouped.size) {
        if (grouped.isNotEmpty() && focusedIndex < 0) {
            listState.animateScrollToItem(grouped.lastIndex)
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth(),
    ) {
        // Main content: two-pane row
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        ) {
            // Left pane: compact log scroll (65%)
            Column(
                modifier = Modifier
                    .weight(0.65f)
                    .fillMaxHeight()
                    .padding(start = 8.dp, top = 4.dp, bottom = 4.dp),
            ) {
                Text(
                    text = "TIMELINE",
                    color = TerrariumColors.HUDSubtext,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(bottom = 2.dp),
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
                        verticalArrangement = Arrangement.spacedBy(0.dp),
                        modifier = Modifier.weight(1f, fill = false),
                    ) {
                        itemsIndexed(grouped) { index, group ->
                            val isSelected = index == focusedIndex ||
                                (focusedIndex < 0 && index == grouped.lastIndex)
                            CompactLogRow(
                                group = group,
                                isSelected = isSelected,
                                onClick = { focusedIndex = index },
                            )
                        }
                    }
                }
            }

            // Vertical divider
            Box(
                modifier = Modifier
                    .fillMaxHeight()
                    .width(1.dp)
                    .padding(vertical = 8.dp)
                    .background(TerrariumColors.HUDSubtext.copy(alpha = 0.3f)),
            )

            // Right pane: detail panel (35%)
            DetailPane(
                focusedGroup = focusedGroup,
                modifier = Modifier
                    .weight(0.35f)
                    .fillMaxHeight()
                    .padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
            )
        }

    }
}

/**
 * Compact single-line log row: `HH:mm icon summary [×N]`
 */
@Composable
private fun CompactLogRow(
    group: GroupedEntry,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    val entry = group.entry
    val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
    val timeStr = timeFormat.format(Date(entry.timestamp))
    val icon = typeIcon(entry.type, entry.status)
    val iconColor = typeColor(entry.type)
    val countSuffix = if (group.count > 1) " ×${group.count}" else ""
    val isChatEnd = entry.type == "chat_end"
    val sessionLabel = rowPrefixLabel(entry)
    val tight = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false))

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .background(
                if (isSelected) Color(0x20FFFFFF) else Color.Transparent,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Selected indicator bar
        if (isSelected) {
            Box(
                modifier = Modifier
                    .width(2.dp)
                    .height(14.dp)
                    .background(iconColor),
            )
        }

        Text(
            text = timeStr,
            color = TerrariumColors.HUDSubtext.copy(alpha = if (isChatEnd) 0.4f else 0.5f),
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            style = tight,
        )
        Text(
            text = icon,
            color = iconColor.copy(alpha = if (isChatEnd) 0.6f else 1f),
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            style = tight,
        )
        if (sessionLabel.isNotEmpty()) {
            Text(
                text = sessionLabel,
                color = TerrariumColors.HUDSubtext.copy(alpha = if (isChatEnd) 0.55f else 0.75f),
                fontSize = 10.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 96.dp),
                style = tight,
            )
        }
        Text(
            text = entry.summary + countSuffix,
            color = if (isChatEnd) TerrariumColors.HUDText.copy(alpha = 0.6f) else TerrariumColors.HUDText,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
            style = tight,
        )
    }
}

/**
 * Detail pane — shows full info for the focused entry.
 */
@Composable
private fun DetailPane(
    focusedGroup: GroupedEntry?,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(4.dp))
            .background(Color(0x30000000)),
    ) {
        if (focusedGroup == null) {
            Box(
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "No events",
                    color = TerrariumColors.HUDSubtext.copy(alpha = 0.5f),
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        } else {
            val entry = focusedGroup.entry
            val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
            val timeStr = timeFormat.format(Date(entry.timestamp))
            val icon = typeIcon(entry.type, entry.status)
            val iconColor = typeColor(entry.type)
            val sourceLabel = sourceLabel(entry)
            val countSuffix = if (focusedGroup.count > 1) " (×${focusedGroup.count})" else ""

            // Header: type badge + timestamp
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Type badge chip
                Text(
                    text = " $icon ${formatType(entry.type)} ",
                    color = Color.White,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .clip(RoundedCornerShape(3.dp))
                        .background(iconColor.copy(alpha = 0.7f))
                        .padding(horizontal = 4.dp, vertical = 1.dp),
                )
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    text = timeStr,
                    color = TerrariumColors.HUDSubtext,
                    fontSize = 9.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }

            // Source tag if present
            if (sourceLabel.isNotEmpty()) {
                Text(
                    text = sourceLabel + countSuffix,
                    color = TerrariumColors.HUDSubtext.copy(alpha = 0.7f),
                    fontSize = 9.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
            }

            Spacer(modifier = Modifier.height(4.dp))

            // Summary
            Text(
                text = entry.summary,
                color = TerrariumColors.HUDText,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(horizontal = 8.dp),
            )

            // Detail text (word-wrapped, scrollable area)
            if (!entry.detail.isNullOrEmpty() && entry.detail != entry.summary) {
                Spacer(modifier = Modifier.height(4.dp))
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f, fill = false)
                        .padding(horizontal = 8.dp),
                ) {
                    item {
                        Text(
                            text = entry.detail,
                            color = TerrariumColors.HUDSubtext.copy(alpha = 0.8f),
                            fontSize = 10.sp,
                            fontFamily = FontFamily.Monospace,
                            softWrap = true,
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.weight(1f))
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
    "eval_result" -> "★"
    else -> "·"
}

private fun typeColor(type: String) = when (type) {
    "tool_request", "tool_resolved", "tool_exec" -> TerrariumColors.LEDGreen
    "model_call", "model_response" -> TerrariumColors.TetraNeon
    "chat_response" -> TerrariumColors.TetraNeon
    "memory_recall" -> TerrariumColors.ClaudeBody
    "chat_start", "chat_end" -> TerrariumColors.HUDText
    "error" -> TerrariumColors.LEDRed
    "state_change", "eval_result" -> TerrariumColors.LEDAmber
    else -> TerrariumColors.HUDSubtext
}

private fun agentTag(agentType: String?): String = when (agentType) {
    "claude-code" -> "Claude"
    "openclaw" -> "OpenClaw"
    null -> ""
    else -> "Agent"
}

private fun rowPrefixLabel(entry: TimelineEntry): String {
    val project = entry.projectName?.takeIf { it.isNotBlank() }
    if (project != null) return "[$project]"
    val tag = agentTag(entry.agentType)
    return if (tag.isNotEmpty()) "[$tag]" else ""
}

private fun sourceLabel(entry: TimelineEntry): String {
    val project = entry.projectName?.takeIf { it.isNotBlank() }
    val tag = agentTag(entry.agentType)
    return when {
        project != null && tag.isNotEmpty() -> "$project · $tag"
        project != null -> project
        else -> tag
    }
}

private fun formatType(type: String): String = when (type) {
    "tool_request" -> "TOOL"
    "tool_resolved" -> "DONE"
    "tool_exec" -> "EXEC"
    "model_call" -> "MODEL"
    "model_response" -> "RESP"
    "chat_start" -> "CHAT"
    "chat_end" -> "END"
    "chat_response" -> "REPLY"
    "memory_recall" -> "MEM"
    "error" -> "ERR"
    "scheduled" -> "SCHED"
    "user_action" -> "USER"
    "state_change" -> "STATE"
    "eval_result" -> "EVAL"
    else -> type.uppercase().take(5)
}
