package dev.agentdeck

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.lifecycleScope
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.ui.screen.DashboardScreen
import dev.agentdeck.ui.screen.EinkMonitorScreen
import dev.agentdeck.ui.screen.SettingsScreen
import dev.agentdeck.ui.theme.AgentDeckTheme
import dev.agentdeck.util.EinkDetector
import android.util.Log
import android.view.WindowManager
import androidx.compose.runtime.LaunchedEffect
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

sealed class Screen(val route: String, val label: String, val icon: ImageVector) {
    data object Dashboard : Screen("dashboard", "Dashboard", Icons.Default.Dashboard)
    data object Settings : Screen("settings", "Settings", Icons.Default.Settings)
}

private val bottomNavScreens = listOf(Screen.Dashboard, Screen.Settings)

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val isEink = EinkDetector.isEinkDevice()

        // E-ink: immersive fullscreen — hide status bar and navigation bar
        if (isEink) {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            WindowInsetsControllerCompat(window, window.decorView).let { controller ->
                controller.hide(WindowInsetsCompat.Type.systemBars())
                controller.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }

        val stateHolder = AgentStateHolder.instance
        val connection = BridgeConnection.instance
        val displayPrefs = DisplayPreferences(this, isEink = isEink)

        // Apply saved orientation preference
        lifecycleScope.launch {
            displayPrefs.orientationFlow.collect { orientation ->
                requestedOrientation = orientation
            }
        }

        // Keep screen on for e-ink monitoring dashboard
        if (isEink) {
            lifecycleScope.launch {
                displayPrefs.keepAwakeFlow.collect { keepAwake ->
                    if (keepAwake) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                }
            }
        }

        setContent {
            AgentDeckTheme(isEink = isEink) {
                if (isEink) {
                    EinkMonitorScreen(stateHolder, connection, displayPrefs)
                } else {
                    MainNavigation(stateHolder, connection, displayPrefs, isEink)
                }
            }
        }
    }
}

private const val TAG = "MainActivity"
private const val SAVED_URL_TIMEOUT_MS = 8_000L

@Composable
fun MainNavigation(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    isEink: Boolean,
) {
    val navController = rememberNavController()
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = navBackStackEntry?.destination

    // Auto-connect to saved bridge URL on launch
    LaunchedEffect(Unit) {
        val savedUrl = displayPrefs.lastBridgeUrlFlow.first()
        Log.i(TAG, "Auto-connect: savedUrl=$savedUrl")
        if (savedUrl != null) {
            connection.autoConnect(savedUrl)
            delay(SAVED_URL_TIMEOUT_MS)
            if (connection.status.value != ConnectionStatus.CONNECTED) {
                Log.w(TAG, "Auto-connect timeout — disconnecting saved URL")
                connection.disconnect()
                displayPrefs.setLastBridgeUrl(null)
            } else {
                Log.i(TAG, "Auto-connect succeeded to $savedUrl")
            }
        }
    }

    // Persist URL on successful connection
    val connectionStatus by connection.status.collectAsState()
    val currentUrl by connection.url.collectAsState()
    LaunchedEffect(connectionStatus) {
        if (connectionStatus == ConnectionStatus.CONNECTED) {
            val url = currentUrl
            if (url != null) displayPrefs.setLastBridgeUrl(url)
        }
    }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        bottomBar = {
            NavigationBar {
                    bottomNavScreens.forEach { screen ->
                        NavigationBarItem(
                            icon = { Icon(screen.icon, contentDescription = screen.label) },
                            label = { Text(screen.label) },
                            selected = currentDestination?.hierarchy?.any { it.route == screen.route } == true,
                            onClick = {
                                navController.navigate(screen.route) {
                                    popUpTo(navController.graph.findStartDestination().id) {
                                        saveState = true
                                    }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            }
                        )
                    }
            }
        }
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = Screen.Dashboard.route,
            modifier = Modifier.padding(innerPadding)
        ) {
            composable(Screen.Dashboard.route) {
                DashboardScreen(
                    stateHolder = stateHolder,
                    connection = connection,
                    isEink = isEink,
                )
            }
            composable(Screen.Settings.route) {
                SettingsScreen(
                    connection = connection,
                    displayPrefs = displayPrefs,
                    isEink = isEink,
                )
            }
        }
    }
}
