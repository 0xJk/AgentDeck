package dev.agentdeck.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeDiscovery
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.ui.theme.AgentDeckColors
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    isEink: Boolean,
) {
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    val lastError by connection.lastError.collectAsState()
    val keepAwake by displayPrefs.keepAwakeFlow.collectAsState(initial = true)
    val coroutineScope = rememberCoroutineScope()

    var manualUrl by remember { mutableStateOf("") }
    var discoveredBridges by remember { mutableStateOf(emptyList<DiscoveredBridge>()) }

    // mDNS discovery when disconnected
    val context = LocalContext.current
    val discovery = remember { BridgeDiscovery(context) }
    LaunchedEffect(connectionStatus) {
        if (connectionStatus == ConnectionStatus.DISCONNECTED) {
            discovery.discover().collect { bridges ->
                discoveredBridges = bridges
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = "Settings",
            style = MaterialTheme.typography.headlineMedium,
        )

        // Connection
        Card(
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "Connection",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.height(8.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Status",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        text = when (connectionStatus) {
                            ConnectionStatus.CONNECTED -> "Connected"
                            ConnectionStatus.CONNECTING -> "Connecting..."
                            ConnectionStatus.DISCONNECTED -> "Disconnected"
                        },
                        style = MaterialTheme.typography.labelLarge,
                        color = when (connectionStatus) {
                            ConnectionStatus.CONNECTED -> AgentDeckColors.Green
                            ConnectionStatus.CONNECTING -> AgentDeckColors.Amber
                            ConnectionStatus.DISCONNECTED -> AgentDeckColors.SlateText
                        },
                    )
                }

                if (currentUrl != null) {
                    Text(
                        text = currentUrl!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }

                // Error display
                if (lastError != null) {
                    Text(
                        text = lastError!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }

                Spacer(modifier = Modifier.height(12.dp))

                if (connectionStatus == ConnectionStatus.CONNECTED) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = {
                            connection.connect("ws://127.0.0.1:9120")
                        }) {
                            Text("USB Connect")
                        }
                        OutlinedButton(onClick = { connection.disconnect() }) {
                            Text("Disconnect")
                        }
                    }
                } else {
                    // USB quick-connect
                    Button(
                        onClick = { connection.connect("ws://127.0.0.1:9120") },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("USB Connect")
                    }

                    // mDNS discovered bridges
                    if (discoveredBridges.isNotEmpty()) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "Discovered Bridges",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        discoveredBridges.forEach { bridge ->
                            OutlinedButton(
                                onClick = {
                                    connection.connect("ws://${bridge.host}:${bridge.port}")
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Column {
                                    Text(bridge.name)
                                    Text(
                                        "${bridge.host}:${bridge.port}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }

                    // Manual URL entry
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedTextField(
                        value = manualUrl,
                        onValueChange = { manualUrl = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text("ws://192.168.1.x:9120?token=abc") },
                        singleLine = true,
                        label = { Text("Manual URL") },
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Button(
                        onClick = {
                            if (manualUrl.isNotBlank()) {
                                connection.connect(manualUrl.trim())
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = manualUrl.isNotBlank(),
                    ) {
                        Text("Connect")
                    }
                }
            }
        }

        // Background monitoring
        Card(
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "Background Monitoring",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Keep connection alive",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Switch(
                        checked = keepAwake,
                        onCheckedChange = {
                            coroutineScope.launch { displayPrefs.setKeepAwake(it) }
                        },
                    )
                }
                Text(
                    text = "Maintains WebSocket connection when app is backgrounded via foreground service",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // About
        Card(
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "About",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "AgentDeck Android",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    text = "v0.1.0",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = "Monitoring dashboard for AI coding agents",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}
