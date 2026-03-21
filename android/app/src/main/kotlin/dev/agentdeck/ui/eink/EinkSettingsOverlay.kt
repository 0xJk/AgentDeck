package dev.agentdeck.ui.eink

import android.content.pm.ActivityInfo
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.ui.common.ConnectionPanel
import kotlinx.coroutines.launch

@Composable
fun EinkSettingsOverlay(
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    discoveredBridges: List<DiscoveredBridge> = emptyList(),
    onDismiss: () -> Unit,
) {
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    val lastError by connection.lastError.collectAsState()
    val currentOrientation by displayPrefs.orientationFlow.collectAsState(
        initial = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    )
    val keepAwake by displayPrefs.keepAwakeFlow.collectAsState(initial = true)
    val scope = rememberCoroutineScope()

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            shape = RoundedCornerShape(4.dp),
            color = MaterialTheme.colorScheme.background,
            modifier = Modifier
                .fillMaxWidth(0.85f)
                .fillMaxHeight(0.9f)
                .border(2.dp, Color.Black, RoundedCornerShape(4.dp)),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text = "Settings",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                )

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                // Connection section
                Text(
                    text = "Connection",
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                ConnectionPanel(
                    connectionStatus = connectionStatus,
                    currentUrl = currentUrl,
                    lastError = lastError,
                    discoveredBridges = discoveredBridges,
                    onConnectToBridge = { bridge ->
                        connection.connect(bridge.wsUrl())
                    },
                    onConnectLocalhost = {
                        connection.connect(BridgeConstants.LOCALHOST_WS_URL)
                    },
                    onConnectManualUrl = { url -> connection.connect(url) },
                    onDisconnect = {
                        connection.disconnect()
                        scope.launch { displayPrefs.setLastBridgeUrl(null) }
                    },
                )

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                // Display settings
                Text(
                    text = "Display",
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = "Keep Awake",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Switch(
                        checked = keepAwake,
                        onCheckedChange = { scope.launch { displayPrefs.setKeepAwake(it) } },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = Color.White,
                            checkedTrackColor = Color.Black,
                            uncheckedThumbColor = Color.DarkGray,
                            uncheckedTrackColor = Color.LightGray,
                        ),
                    )
                }
                Text(
                    text = "Keeps CPU active and refreshes display on state changes",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                // Orientation selection
                Text(
                    text = "Orientation",
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    SegmentOption(
                        label = "Portrait",
                        selected = currentOrientation == ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
                        onClick = {
                            scope.launch { displayPrefs.setOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT) }
                        },
                        modifier = Modifier.weight(1f),
                    )
                    SegmentOption(
                        label = "Landscape",
                        selected = currentOrientation == ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
                        onClick = {
                            scope.launch { displayPrefs.setOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE) }
                        },
                        modifier = Modifier.weight(1f),
                    )
                    SegmentOption(
                        label = "Auto",
                        selected = currentOrientation == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
                        onClick = {
                            scope.launch { displayPrefs.setOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED) }
                        },
                        modifier = Modifier.weight(1f),
                    )
                }

                Spacer(modifier = Modifier.height(2.dp))

                // Close button
                Button(
                    onClick = onDismiss,
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color.Black,
                        contentColor = Color.White,
                    ),
                    shape = RoundedCornerShape(4.dp),
                ) {
                    Text("Close")
                }
            }
        }
    }
}

@Composable
private fun SegmentOption(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.clickable(onClick = onClick),
        shape = RoundedCornerShape(4.dp),
        color = if (selected) Color.Black else MaterialTheme.colorScheme.background,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) Color.Black else Color.DarkGray,
        ),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = if (selected) Color.White else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
        )
    }
}
