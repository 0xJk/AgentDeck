package dev.agentdeck

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.lifecycleScope
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.ui.monitor.MonitorScreen
import dev.agentdeck.ui.screen.EinkMonitorScreen
import dev.agentdeck.ui.theme.AgentDeckTheme
import dev.agentdeck.util.EinkDetector
import android.content.Intent
import android.content.pm.ActivityInfo
import android.provider.Settings
import android.util.Log
import android.view.Surface
import android.view.WindowManager
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import dev.agentdeck.net.BridgeDiscovery
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.service.MonitorService
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private var isEinkDevice = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        isEinkDevice = EinkDetector.isEinkDevice()

        // E-ink: set landscape IMMEDIATELY — before any async/layout.
        // Pantone 6 (RK3566) ignores late requestedOrientation changes,
        // so this must happen before the first frame renders.
        if (isEinkDevice) {
            applyOrientationPreference(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE)

            @Suppress("DEPRECATION")
            window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)
            hideSystemBars()
        }

        val stateHolder = AgentStateHolder.instance
        val connection = BridgeConnection.instance
        val displayPrefs = DisplayPreferences(this, isEink = isEinkDevice)

        // Apply saved orientation preference (async — for user changes via Settings)
        lifecycleScope.launch {
            displayPrefs.orientationFlow.collect { orientation ->
                applyOrientationPreference(orientation)
            }
        }

        // Keep screen on while dashboard is active
        lifecycleScope.launch {
            displayPrefs.keepAwakeFlow.collect { keepAwake ->
                if (keepAwake) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        // Start/stop MonitorService based on keepAwake preference
        lifecycleScope.launch {
            displayPrefs.keepAwakeFlow.collect { keepAwake ->
                val serviceIntent = Intent(this@MainActivity, MonitorService::class.java)
                if (keepAwake) {
                    ContextCompat.startForegroundService(this@MainActivity, serviceIntent)
                } else {
                    stopService(serviceIntent)
                }
            }
        }

        setContent {
            AgentDeckTheme(isEink = isEinkDevice) {
                if (isEinkDevice) {
                    EinkMonitorScreen(stateHolder, connection, displayPrefs)
                } else {
                    TabletDashboard(stateHolder, connection, displayPrefs)
                }
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Re-hide system bars after Dialog dismissal (Dialog creates a new window
        // which resets immersive mode flags on the main window)
        if (hasFocus && isEinkDevice) {
            hideSystemBars()
        }
    }

    /**
     * Apply system-level rotation for RK3566 devices that ignore requestedOrientation.
     * Auto-requests WRITE_SETTINGS permission if not granted (lost on APK reinstall).
     */
    private fun applyOrientationPreference(orientation: Int) {
        requestedOrientation = orientation

        if (!isEinkDevice) return

        when (orientation) {
            ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE -> applySystemFixedRotation(Surface.ROTATION_90)
            ActivityInfo.SCREEN_ORIENTATION_PORTRAIT -> applySystemFixedRotation(Surface.ROTATION_0)
            ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED -> applySystemAutoRotation()
            else -> Log.w(TAG, "Unsupported orientation preference: $orientation")
        }
    }

    private fun applySystemFixedRotation(rotation: Int) {
        if (Settings.System.canWrite(this)) {
            try {
                Settings.System.putInt(contentResolver, Settings.System.ACCELEROMETER_ROTATION, 0)
                Settings.System.putInt(contentResolver, Settings.System.USER_ROTATION, rotation)
            } catch (e: Exception) {
                Log.w(TAG, "System rotation fallback failed: ${e.message}")
            }
        } else {
            // WRITE_SETTINGS lost (APK reinstall) — auto-request via system UI
            Log.w(TAG, "WRITE_SETTINGS not granted — requesting permission")
            try {
                startActivity(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS).apply {
                    data = android.net.Uri.parse("package:$packageName")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
            } catch (e: Exception) {
                Log.e(TAG, "Cannot open WRITE_SETTINGS screen: ${e.message}")
            }
        }
    }

    private fun applySystemAutoRotation() {
        if (Settings.System.canWrite(this)) {
            try {
                Settings.System.putInt(contentResolver, Settings.System.ACCELEROMETER_ROTATION, 1)
            } catch (e: Exception) {
                Log.w(TAG, "System auto-rotation fallback failed: ${e.message}")
            }
        } else {
            Log.w(TAG, "WRITE_SETTINGS not granted — auto-rotation fallback unavailable")
        }
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).let { controller ->
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }
}

private const val TAG = "MainActivity"

private fun shouldPersistBridgeUrl(url: String?): Boolean {
    return url != null && !url.contains("127.0.0.1") && !url.contains("localhost")
}

@Composable
fun TabletDashboard(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
) {
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    val context = LocalContext.current

    // Auto-connect: localhost (USB) → saved URL → mDNS (WiFi)
    LaunchedEffect(Unit) {
        val rawSavedUrl = displayPrefs.lastBridgeUrlFlow.first()
        val savedUrl = rawSavedUrl?.takeUnless { !shouldPersistBridgeUrl(it) }
        if (rawSavedUrl != null && savedUrl == null) {
            displayPrefs.setLastBridgeUrl(null)
        }
        Log.i(TAG, "Auto-connect: savedUrl=$savedUrl")
        // Try localhost (adb reverse USB connection) before mDNS
        if (connection.status.value != ConnectionStatus.CONNECTED) {
            Log.i(TAG, "Trying localhost:${BridgeConstants.WS_PORT} (USB)...")
            connection.connect(BridgeConstants.LOCALHOST_WS_URL)
            delay(3000)
        }
        if (savedUrl != null && connection.status.value != ConnectionStatus.CONNECTED) {
            connection.autoConnect(savedUrl)
            delay(5000)
        }
        // If still disconnected, try mDNS discovery
        if (connection.status.value != ConnectionStatus.CONNECTED) {
            Log.i(TAG, "Saved URL failed, trying mDNS discovery...")
            val discovery = BridgeDiscovery(context)
            // Phase 1: collect bridges, connect immediately if daemon found
            var bestBridges = emptyList<DiscoveredBridge>()
            val foundDaemon = withTimeoutOrNull(4000) {
                discovery.discover().collect { bridges ->
                    bestBridges = bridges
                    val daemon = bridges.firstOrNull { it.agentType == "daemon" }
                    if (daemon != null) {
                        Log.i(TAG, "mDNS auto-connect (daemon): ${daemon.name} at ${daemon.wsUrl()}")
                        connection.connect(daemon.wsUrl())
                        return@collect
                    }
                }
                true
            }
            // No non-daemon fallback — session bridges don't serve external clients.
            // If daemon not found, stay disconnected and let user connect manually.
        }
    }

    // Persist URL on successful connection
    LaunchedEffect(connectionStatus) {
        if (connectionStatus == ConnectionStatus.CONNECTED) {
            val url = currentUrl
            if (shouldPersistBridgeUrl(url)) displayPrefs.setLastBridgeUrl(url)
        }
    }

    // Re-discover when auth rejected (4001) or localhost gave up — URL cleared, disconnected
    LaunchedEffect(connectionStatus, currentUrl) {
        if (connectionStatus == ConnectionStatus.DISCONNECTED && currentUrl == null) {
            delay(1000) // brief pause before re-discovery
            Log.i(TAG, "Disconnected with no URL — re-discovering via mDNS")
            val discovery = BridgeDiscovery(context)
            var bestBridges = emptyList<DiscoveredBridge>()
            val foundDaemon = withTimeoutOrNull(4000) {
                discovery.discover().collect { bridges ->
                    bestBridges = bridges
                    val daemon = bridges.firstOrNull { it.agentType == "daemon" }
                    if (daemon != null) {
                        Log.i(TAG, "Re-discover (daemon): ${daemon.name} at ${daemon.wsUrl()}")
                        connection.connect(daemon.wsUrl())
                        return@collect
                    }
                }
                true
            }
            // No non-daemon fallback — daemon only
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        MonitorScreen(
            stateHolder = stateHolder,
            connection = connection,
            displayPrefs = displayPrefs,
        )
    }
}
