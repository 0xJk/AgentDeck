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
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.ui.monitor.MonitorScreen
import dev.agentdeck.ui.screen.EinkMonitorScreen
import dev.agentdeck.ui.theme.AgentDeckTheme
import dev.agentdeck.util.EinkDetector
import android.content.Intent
import android.util.Log
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

        // E-ink: immersive fullscreen — hide status bar and navigation bar
        if (isEinkDevice) {
            @Suppress("DEPRECATION")
            window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)
            hideSystemBars()
        }

        val stateHolder = AgentStateHolder.instance
        val connection = BridgeConnection.instance
        val displayPrefs = DisplayPreferences(this, isEink = isEinkDevice)

        // Apply saved orientation preference
        lifecycleScope.launch {
            displayPrefs.orientationFlow.collect { orientation ->
                requestedOrientation = orientation
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

@Composable
fun TabletDashboard(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
) {
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    val context = LocalContext.current

    // Auto-connect: saved URL → localhost (USB) → mDNS (WiFi)
    LaunchedEffect(Unit) {
        val savedUrl = displayPrefs.lastBridgeUrlFlow.first()
        Log.i(TAG, "Auto-connect: savedUrl=$savedUrl")
        if (savedUrl != null) {
            connection.autoConnect(savedUrl)
            delay(5000)
        }
        // Try localhost (adb reverse USB connection) before mDNS
        if (connection.status.value != ConnectionStatus.CONNECTED) {
            Log.i(TAG, "Trying localhost:9120 (USB)...")
            connection.connect("ws://127.0.0.1:9120")
            delay(3000)
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
            if (url != null) displayPrefs.setLastBridgeUrl(url)
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
