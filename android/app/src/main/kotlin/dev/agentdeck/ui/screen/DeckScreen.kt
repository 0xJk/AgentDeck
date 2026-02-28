package dev.agentdeck.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.PromptOption
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.ui.deck.DeckAction
import dev.agentdeck.ui.deck.DeckButton
import dev.agentdeck.ui.deck.DeckButtonConfig
import dev.agentdeck.ui.deck.colorForOption
import dev.agentdeck.ui.deck.computeDeckLayout
import dev.agentdeck.ui.theme.AgentDeckColors

@Composable
fun DeckScreen(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
) {
    val state by stateHolder.state.collectAsState()
    val buttons = computeDeckLayout(state)

    // Track whether "MORE" was tapped to expand option list
    var showMoreOptions by remember { mutableStateOf(false) }

    // Reset showMore when state changes away from AWAITING
    val agentState = state.agentState
    if (agentState != AgentState.AWAITING_OPTION &&
        agentState != AgentState.AWAITING_PERMISSION &&
        agentState != AgentState.AWAITING_DIFF
    ) {
        showMoreOptions = false
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // 2×4 button grid
        DeckButtonGrid(
            buttons = buttons,
            onAction = { action ->
                when (action) {
                    is DeckAction.ShowMoreOptions -> showMoreOptions = true
                    else -> executeDeckAction(action, connection)
                }
            },
        )

        Spacer(modifier = Modifier.height(4.dp))

        // Context area
        DeckContextArea(
            state = state,
            connection = connection,
            showMoreOptions = showMoreOptions,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        )
    }
}

@Composable
private fun DeckButtonGrid(
    buttons: List<DeckButtonConfig>,
    onAction: (DeckAction) -> Unit,
) {
    // Row 1: slots 0-3
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (i in 0..3) {
            val btn = buttons.getOrElse(i) { DeckButtonConfig("", bgColor = AgentDeckColors.Surface) }
            DeckButton(
                config = btn,
                onClick = { onAction(btn.action) },
                modifier = Modifier
                    .weight(1f)
                    .aspectRatio(1f),
            )
        }
    }
    // Row 2: slots 4-7
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (i in 4..7) {
            val btn = buttons.getOrElse(i) { DeckButtonConfig("", bgColor = AgentDeckColors.Surface) }
            DeckButton(
                config = btn,
                onClick = { onAction(btn.action) },
                modifier = Modifier
                    .weight(1f)
                    .aspectRatio(1f),
            )
        }
    }
}

@Composable
private fun DeckContextArea(
    state: dev.agentdeck.state.DashboardState,
    connection: BridgeConnection,
    showMoreOptions: Boolean,
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

        // AWAITING states: question text + expanded option list
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
                    Spacer(modifier = Modifier.height(8.dp))
                }

                // Expanded option list (when MORE tapped or 5+ options)
                if (showMoreOptions && state.options.size > 3) {
                    ExpandedOptionList(
                        options = state.options,
                        navigable = state.navigable,
                        connection = connection,
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f),
                    )
                }
            }
        }

        // PROCESSING: tool info
        agentState == AgentState.PROCESSING -> {
            Box(modifier = modifier, contentAlignment = Alignment.TopStart) {
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
                }
            }
        }

        // IDLE: custom prompt input
        agentState == AgentState.IDLE -> {
            Column(modifier = modifier) {
                PromptInput(
                    onSend = { text -> connection.sendPrompt(text) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
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
    connection: BridgeConnection,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        itemsIndexed(options) { index, option ->
            val colors = colorForOption(option)
            OutlinedButton(
                onClick = {
                    if (navigable == true) {
                        connection.sendSelectOption(index)
                    } else {
                        val key = option.shortcut ?: option.label.firstOrNull()?.lowercase() ?: "y"
                        connection.sendRespond(key)
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(10.dp),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                ) {
                    Text(
                        text = option.label,
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.text,
                    )
                    if (option.description != null) {
                        Text(
                            text = option.description ?: "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

private fun executeDeckAction(action: DeckAction, connection: BridgeConnection) {
    when (action) {
        is DeckAction.SwitchMode -> connection.sendSwitchMode()
        is DeckAction.Command -> connection.sendPrompt(action.text)
        is DeckAction.SelectOption -> connection.sendSelectOption(action.index)
        is DeckAction.Respond -> connection.sendRespond(action.value)
        is DeckAction.Interrupt -> connection.sendInterrupt()
        is DeckAction.Escape -> connection.sendEscape()
        is DeckAction.ShowMoreOptions -> { /* handled in caller */ }
        is DeckAction.Noop -> { /* no-op */ }
    }
}
