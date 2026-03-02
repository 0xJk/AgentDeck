package dev.agentdeck.ui.screen

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.PromptOption
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.state.DashboardState
import dev.agentdeck.ui.deck.DeckAction
import dev.agentdeck.ui.deck.DeckButton
import dev.agentdeck.ui.deck.DeckButtonConfig
import dev.agentdeck.ui.deck.EncoderStrip
import dev.agentdeck.ui.deck.colorForOption
import dev.agentdeck.ui.deck.computeDeckLayout
import dev.agentdeck.ui.theme.AgentDeckColors
import dev.agentdeck.voice.VoiceRecorder
import kotlinx.coroutines.launch

@Composable
fun DeckScreen(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
) {
    val state by stateHolder.state.collectAsState()
    val buttons = computeDeckLayout(state)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val voiceRecorder = remember { VoiceRecorder(context) }

    val agentState = state.agentState

    val isAwaiting = agentState == AgentState.AWAITING_OPTION ||
            agentState == AgentState.AWAITING_PERMISSION ||
            agentState == AgentState.AWAITING_DIFF

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // Compact status bar
        CompactStatusBar(state = state)

        // Encoder strip (mirrors SD+ LCD row)
        EncoderStrip(
            encoderStates = state.encoderStates,
            takeoverActive = state.encoderTakeoverActive,
            onRotate = { slot, ticks ->
                val encoderType = state.encoderStates.find { it.slot == slot }?.encoderType
                when (encoderType) {
                    "utility" -> connection.sendUtility("adjust_volume", ticks * 5)
                    "action" -> {
                        if (isAwaiting) {
                            val dir = if (ticks > 0) "down" else "up"
                            connection.sendNavigateOption(dir)
                        }
                    }
                    else -> {}
                }
            },
            onPush = { slot ->
                val encoderType = state.encoderStates.find { it.slot == slot }?.encoderType
                when (encoderType) {
                    "utility" -> connection.sendUtility("toggle_mute")
                    "action" -> {
                        if (isAwaiting) {
                            val idx = state.cursorIndex ?: 0
                            connection.sendSelectOption(idx)
                        }
                    }
                    "voice" -> {
                        if (voiceRecorder.recording) {
                            voiceRecorder.cancel()
                        }
                    }
                    else -> {}
                }
            },
            onLongPress = { slot ->
                val encoderType = state.encoderStates.find { it.slot == slot }?.encoderType
                if (encoderType == "voice") {
                    voiceRecorder.start()
                }
            },
            onRelease = { slot ->
                val encoderType = state.encoderStates.find { it.slot == slot }?.encoderType
                if (encoderType == "voice" && voiceRecorder.recording) {
                    scope.launch {
                        val text = voiceRecorder.stopAndTranscribe(connection)
                        if (text != null && agentState == AgentState.IDLE) {
                            connection.sendPrompt(text)
                        }
                    }
                }
            },
        )

        // 2x4 button grid (compact — fixed height, no aspect ratio)
        DeckButtonGrid(
            buttons = buttons,
            onAction = { action, actionString ->
                if (actionString != null) {
                    executeActionString(actionString, connection)
                } else {
                    executeDeckAction(action, connection)
                }
            },
        )

        // Context area (fills remaining space)
        DeckContextArea(
            state = state,
            connection = connection,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        )
    }
}

// --- Compact Status Bar ---

@Composable
private fun CompactStatusBar(state: DashboardState) {
    val agentState = state.agentState

    val stateLabel = when (agentState) {
        AgentState.DISCONNECTED -> "OFFLINE"
        AgentState.IDLE -> "IDLE"
        AgentState.PROCESSING -> "PROCESSING"
        AgentState.AWAITING_PERMISSION -> "PERMIT?"
        AgentState.AWAITING_OPTION -> "SELECT"
        AgentState.AWAITING_DIFF -> "DIFF"
    }

    val stateColor = when (agentState) {
        AgentState.DISCONNECTED -> AgentDeckColors.SlateText
        AgentState.IDLE -> AgentDeckColors.Green
        AgentState.PROCESSING -> AgentDeckColors.Blue
        AgentState.AWAITING_PERMISSION, AgentState.AWAITING_DIFF -> AgentDeckColors.Amber
        AgentState.AWAITING_OPTION -> AgentDeckColors.Cyan
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(36.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(AgentDeckColors.Surface)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Project name
        Text(
            text = state.projectName ?: "AgentDeck",
            style = MaterialTheme.typography.titleMedium.copy(
                fontWeight = FontWeight.Bold,
                fontSize = 14.sp,
            ),
            color = AgentDeckColors.WhiteText,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )

        // State indicator chip
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 8.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(stateColor),
            )
            Spacer(modifier = Modifier.width(4.dp))
            Text(
                text = stateLabel,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                color = stateColor,
            )
        }

        // Model name
        if (state.modelName != null) {
            Text(
                text = state.modelName ?: "",
                fontSize = 11.sp,
                color = AgentDeckColors.SlateText,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 4.dp),
            )
        }

        // Usage badge
        val pct = state.usage.fiveHourPercent
        if (pct != null) {
            val usageText = "${(pct * 100).toInt()}%"
            val pillColor = when {
                pct >= 0.9 -> AgentDeckColors.Red
                pct >= 0.7 -> AgentDeckColors.Amber
                else -> AgentDeckColors.Green
            }
            Box(
                modifier = Modifier
                    .padding(start = 8.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(pillColor.copy(alpha = 0.25f))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                Text(
                    text = usageText,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    color = pillColor,
                )
            }
        }
    }
}

// --- Button Grid ---

@Composable
private fun DeckButtonGrid(
    buttons: List<DeckButtonConfig>,
    onAction: (DeckAction, String?) -> Unit,
) {
    // Row 1: slots 0-3
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (i in 0..3) {
            val btn = buttons.getOrElse(i) { DeckButtonConfig("", bgColor = AgentDeckColors.Surface) }
            DeckButton(
                config = btn,
                onClick = { onAction(btn.action, btn.actionString) },
                modifier = Modifier
                    .weight(1f)
                    .height(80.dp),
            )
        }
    }
    // Row 2: slots 4-7
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (i in 4..7) {
            val btn = buttons.getOrElse(i) { DeckButtonConfig("", bgColor = AgentDeckColors.Surface) }
            DeckButton(
                config = btn,
                onClick = { onAction(btn.action, btn.actionString) },
                modifier = Modifier
                    .weight(1f)
                    .height(80.dp),
            )
        }
    }
}

// --- Context Area ---

@Composable
private fun DeckContextArea(
    state: DashboardState,
    connection: BridgeConnection,
    modifier: Modifier = Modifier,
) {
    val agentState = state.agentState

    when {
        agentState == AgentState.DISCONNECTED -> {
            Box(modifier = modifier, contentAlignment = Alignment.Center) {
                Text(
                    text = "Not connected",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // AWAITING states: always show full option list
        (agentState == AgentState.AWAITING_PERMISSION ||
                agentState == AgentState.AWAITING_DIFF ||
                agentState == AgentState.AWAITING_OPTION) -> {
            Column(modifier = modifier) {
                // Question text
                if (state.question != null) {
                    Card(
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surface,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = state.question ?: "",
                            style = MaterialTheme.typography.bodyMedium,
                            color = AgentDeckColors.Amber,
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                    Spacer(modifier = Modifier.height(6.dp))
                }

                // Always show full option list (scrollable)
                if (state.options.isNotEmpty()) {
                    ExpandedOptionList(
                        options = state.options,
                        navigable = state.navigable,
                        cursorIndex = state.cursorIndex,
                        connection = connection,
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f),
                    )
                }
            }
        }

        // PROCESSING: tool info + progress indicator
        agentState == AgentState.PROCESSING -> {
            Column(modifier = modifier) {
                // Indeterminate progress bar
                LinearProgressIndicator(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(2.dp)
                        .clip(RoundedCornerShape(1.dp)),
                    color = AgentDeckColors.Blue,
                    trackColor = AgentDeckColors.Surface,
                )

                Spacer(modifier = Modifier.height(8.dp))

                if (state.currentTool != null) {
                    Card(
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surface,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text(
                                text = state.currentTool ?: "",
                                style = MaterialTheme.typography.titleMedium,
                                color = AgentDeckColors.Blue,
                            )
                            if (state.toolProgress != null) {
                                Text(
                                    text = state.toolProgress ?: "",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(top = 4.dp),
                                )
                            }
                        }
                    }
                } else {
                    // Animated dots when no tool info
                    ProcessingDots()
                }
            }
        }

        // IDLE: suggested prompt chip + prompt input
        agentState == AgentState.IDLE -> {
            Column(modifier = modifier) {
                // Suggested prompt chip
                if (state.suggestedPrompt != null) {
                    AssistChip(
                        onClick = { connection.sendPrompt(state.suggestedPrompt ?: "") },
                        label = {
                            Text(
                                text = state.suggestedPrompt ?: "",
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                        colors = AssistChipDefaults.assistChipColors(
                            containerColor = AgentDeckColors.Surface,
                            labelColor = AgentDeckColors.Green,
                        ),
                        modifier = Modifier.padding(bottom = 6.dp),
                    )
                }

                PromptInput(
                    onSend = { text -> connection.sendPrompt(text) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun ProcessingDots() {
    val transition = rememberInfiniteTransition(label = "dots")
    val dotPhase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 3f,
        animationSpec = infiniteRepeatable(
            animation = tween(1200, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "dot_phase",
    )
    val dots = ".".repeat(dotPhase.toInt().coerceIn(1, 3))
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(12.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text = "Processing$dots",
            style = MaterialTheme.typography.bodyMedium,
            color = AgentDeckColors.Blue,
        )
    }
}

@Composable
private fun PromptInput(
    onSend: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var promptText by remember { mutableStateOf("") }

    OutlinedTextField(
        value = promptText,
        onValueChange = { promptText = it },
        modifier = modifier,
        placeholder = { Text("Type a prompt...") },
        singleLine = true,
        trailingIcon = {
            IconButton(
                onClick = {
                    if (promptText.isNotBlank()) {
                        onSend(promptText.trim())
                        promptText = ""
                    }
                },
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.Send,
                    contentDescription = "Send",
                )
            }
        },
    )
}

@Composable
private fun ExpandedOptionList(
    options: List<PromptOption>,
    navigable: Boolean?,
    cursorIndex: Int?,
    connection: BridgeConnection,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        itemsIndexed(options) { index, option ->
            val colors = colorForOption(option)
            val isHighlighted = cursorIndex == index

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Left accent bar for highlighted item
                Box(
                    modifier = Modifier
                        .width(4.dp)
                        .height(48.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(if (isHighlighted) colors.text else Color.Transparent),
                )

                OutlinedButton(
                    onClick = {
                        if (navigable == true) {
                            connection.sendSelectOption(index)
                        } else {
                            val key = option.shortcut ?: option.label.firstOrNull()?.lowercase() ?: "y"
                            connection.sendRespond(key)
                        }
                    },
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = 4.dp),
                    shape = RoundedCornerShape(10.dp),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // Shortcut badge
                        if (option.shortcut != null) {
                            Box(
                                modifier = Modifier
                                    .size(24.dp)
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(colors.bg.copy(alpha = 0.5f)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = option.shortcut?.uppercase() ?: "",
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = colors.text,
                                )
                            }
                            Spacer(modifier = Modifier.width(8.dp))
                        }

                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = option.label,
                                style = MaterialTheme.typography.titleMedium.copy(
                                    fontSize = 14.sp,
                                ),
                                color = colors.text,
                            )
                            if (option.description != null) {
                                Text(
                                    text = option.description ?: "",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

// --- Action Dispatch ---

private fun executeDeckAction(action: DeckAction, connection: BridgeConnection) {
    when (action) {
        is DeckAction.SwitchMode -> connection.sendSwitchMode()
        is DeckAction.Command -> connection.sendPrompt(action.text)
        is DeckAction.SelectOption -> connection.sendSelectOption(action.index)
        is DeckAction.Respond -> connection.sendRespond(action.value)
        is DeckAction.Interrupt -> connection.sendInterrupt()
        is DeckAction.Escape -> connection.sendEscape()
        is DeckAction.ShowMoreOptions -> { /* no longer used — full list always shown in context area */ }
        is DeckAction.Noop -> { /* no-op */ }
    }
}

private fun executeActionString(action: String, connection: BridgeConnection) {
    when {
        action == "switch_mode" -> connection.sendSwitchMode()
        action == "interrupt" -> connection.sendInterrupt()
        action == "escape" -> connection.sendEscape()
        action.startsWith("command:") -> connection.sendPrompt(action.removePrefix("command:"))
        action.startsWith("respond:") -> connection.sendRespond(action.removePrefix("respond:"))
        action.startsWith("select_option:") ->
            action.removePrefix("select_option:").toIntOrNull()?.let { connection.sendSelectOption(it) }
    }
}
