package dev.agentdeck.ui.monitor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.BridgeDiscovery
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.ui.common.ConnectionPanel
import dev.agentdeck.ui.screen.AboutFooter
import dev.agentdeck.ui.screen.DisplaySettingsCard

@Composable
fun TabletSettingsDialog(
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    onDismiss: () -> Unit,
) {
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    val lastError by connection.lastError.collectAsState()
    val keepAwake by displayPrefs.keepAwakeFlow.collectAsState(initial = true)
    val displaySyncEnabled by displayPrefs.displaySyncEnabledFlow.collectAsState(initial = true)
    val idleTimeoutMinutes by displayPrefs.idleTimeoutMinutesFlow.collectAsState(initial = 5)
    val coroutineScope = rememberCoroutineScope()

    var discoveredBridges by remember { mutableStateOf(emptyList<DiscoveredBridge>()) }

    val context = LocalContext.current
    val discovery = remember { BridgeDiscovery(context) }
    LaunchedEffect(connectionStatus) {
        if (connectionStatus == ConnectionStatus.DISCONNECTED) {
            discovery.discover().collect { bridges ->
                discoveredBridges = bridges
            }
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.85f),
            color = Color(0xE61E293B),
            shape = RoundedCornerShape(16.dp),
        ) {
            Column(
                modifier = Modifier
                    .padding(24.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = "Settings",
                    style = MaterialTheme.typography.headlineSmall,
                    color = Color.White,
                )

                // Connection section
                Card(
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF334155)),
                ) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text(
                            text = "Connection",
                            style = MaterialTheme.typography.titleMedium,
                            color = Color(0xFF94A3B8),
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        ConnectionPanel(
                            connectionStatus = connectionStatus,
                            currentUrl = currentUrl,
                            lastError = lastError,
                            discoveredBridges = discoveredBridges,
                            onConnectToBridge = { bridge -> connection.connect(bridge.wsUrl()) },
                            onConnectLocalhost = { connection.connect(BridgeConstants.LOCALHOST_WS_URL) },
                            onConnectManualUrl = { url -> connection.connect(url) },
                            onDisconnect = { connection.disconnect() },
                        )
                    }
                }

                // Display section
                DisplaySettingsCard(
                    keepAwake = keepAwake,
                    displaySyncEnabled = displaySyncEnabled,
                    idleTimeoutMinutes = idleTimeoutMinutes,
                    coroutineScope = coroutineScope,
                    displayPrefs = displayPrefs,
                )

                // About
                AboutFooter()

                // Close button
                Button(
                    onClick = onDismiss,
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF475569)),
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Text("Close", color = Color.White)
                }
            }
        }
    }
}
