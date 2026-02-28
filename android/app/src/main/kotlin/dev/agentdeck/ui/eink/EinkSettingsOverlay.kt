package dev.agentdeck.ui.eink

import android.content.pm.ActivityInfo
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.ConnectionStatus
import kotlinx.coroutines.launch

@Composable
fun EinkSettingsOverlay(
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    onDismiss: () -> Unit,
) {
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    val currentOrientation by displayPrefs.orientationFlow.collectAsState(
        initial = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    )
    val keepAwake by displayPrefs.keepAwakeFlow.collectAsState(initial = true)
    val scope = rememberCoroutineScope()

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(4.dp),
            color = MaterialTheme.colorScheme.background,
            modifier = Modifier.border(2.dp, Color.Black, RoundedCornerShape(4.dp)),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    text = "Settings",
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                // Connection status
                Text(
                    text = "Connection",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = when (connectionStatus) {
                        ConnectionStatus.CONNECTED -> "\u25CF Connected"
                        ConnectionStatus.CONNECTING -> "\u25CB Connecting..."
                        ConnectionStatus.DISCONNECTED -> "\u25CB Disconnected"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                if (currentUrl != null) {
                    Text(
                        text = currentUrl!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                // Display settings
                Text(
                    text = "Display",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = "Keep Awake",
                        style = MaterialTheme.typography.bodyLarge,
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
                    text = "Prevents sleep while dashboard is active",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                HorizontalDivider(thickness = 1.dp, color = Color.Black)

                // Orientation selection
                Text(
                    text = "Orientation",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )

                OrientationOption(
                    label = "Portrait",
                    selected = currentOrientation == ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
                    onClick = {
                        scope.launch { displayPrefs.setOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT) }
                    },
                )
                OrientationOption(
                    label = "Landscape",
                    selected = currentOrientation == ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
                    onClick = {
                        scope.launch { displayPrefs.setOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE) }
                    },
                )
                OrientationOption(
                    label = "Auto",
                    selected = currentOrientation == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
                    onClick = {
                        scope.launch { displayPrefs.setOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED) }
                    },
                )

                Spacer(modifier = Modifier.height(8.dp))

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
private fun OrientationOption(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        RadioButton(
            selected = selected,
            onClick = onClick,
            colors = RadioButtonDefaults.colors(
                selectedColor = Color.Black,
                unselectedColor = Color.DarkGray,
            ),
        )
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
