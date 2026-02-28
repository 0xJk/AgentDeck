package dev.agentdeck.ui.component

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.AgentState
import dev.agentdeck.ui.theme.AgentDeckColors

data class QuickAction(
    val label: String,
    val value: String,
    val isPrimary: Boolean = false,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun QuickActions(
    agentState: AgentState,
    onAction: (String) -> Unit,
    onInterrupt: () -> Unit,
    onEscape: () -> Unit,
    onSendPrompt: ((String) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val actions = when (agentState) {
        AgentState.IDLE -> listOf(
            QuickAction("GO ON", "go_on", isPrimary = true),
            QuickAction("REVIEW", "review"),
            QuickAction("COMMIT", "commit"),
            QuickAction("CLEAR", "clear"),
        )
        AgentState.PROCESSING -> listOf(
            QuickAction("STOP", "stop", isPrimary = true),
        )
        else -> emptyList()
    }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (agentState == AgentState.PROCESSING) {
            Button(
                onClick = onInterrupt,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = AgentDeckColors.Red),
            ) {
                Text("STOP", style = MaterialTheme.typography.titleMedium)
            }
        } else if (actions.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                actions.forEach { action ->
                    if (action.isPrimary) {
                        Button(
                            onClick = { onAction(action.value) },
                            modifier = Modifier.height(48.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = AgentDeckColors.Green,
                            ),
                        ) {
                            Text(action.label, style = MaterialTheme.typography.titleMedium)
                        }
                    } else {
                        OutlinedButton(
                            onClick = { onAction(action.value) },
                            modifier = Modifier.height(48.dp),
                        ) {
                            Text(action.label, style = MaterialTheme.typography.titleMedium)
                        }
                    }
                }
                // ESC button inline
                OutlinedButton(
                    onClick = onEscape,
                    modifier = Modifier.height(48.dp),
                ) {
                    Text("ESC", style = MaterialTheme.typography.bodyMedium)
                }
            }
        }

        // Custom prompt input (IDLE only)
        if (agentState == AgentState.IDLE && onSendPrompt != null) {
            var promptText by remember { mutableStateOf("") }
            OutlinedTextField(
                value = promptText,
                onValueChange = { promptText = it },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("Type a prompt...") },
                singleLine = true,
                trailingIcon = {
                    IconButton(
                        onClick = {
                            if (promptText.isNotBlank()) {
                                onSendPrompt(promptText.trim())
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
    }
}
