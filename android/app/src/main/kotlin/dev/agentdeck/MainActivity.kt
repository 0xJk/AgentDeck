package dev.agentdeck

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.DataUsage
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.TouchApp
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.ui.screen.ControlScreen
import dev.agentdeck.ui.screen.DashboardScreen
import dev.agentdeck.ui.screen.EinkMonitorScreen
import dev.agentdeck.ui.screen.PairingScreen
import dev.agentdeck.ui.screen.SettingsScreen
import dev.agentdeck.ui.screen.UsageScreen
import dev.agentdeck.ui.theme.AgentDeckTheme
import dev.agentdeck.util.EinkDetector
import android.view.WindowManager
import kotlinx.coroutines.launch

sealed class Screen(val route: String, val label: String, val icon: ImageVector) {
    data object Dashboard : Screen("dashboard", "Dashboard", Icons.Default.Dashboard)
    data object Usage : Screen("usage", "Usage", Icons.Default.DataUsage)
    data object Control : Screen("control", "Control", Icons.Default.TouchApp)
    data object Settings : Screen("settings", "Settings", Icons.Default.Settings)
    data object Pairing : Screen("pairing", "Pairing", Icons.Default.Settings)
}

private val bottomNavScreens = listOf(Screen.Dashboard, Screen.Usage, Screen.Control, Screen.Settings)

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val isEink = EinkDetector.isEinkDevice()
        val stateHolder = AgentStateHolder.instance
        val connection = BridgeConnection.instance
        val displayPrefs = DisplayPreferences(this)

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
                    MainNavigation(stateHolder, connection, isEink)
                }
            }
        }
    }
}

@Composable
fun MainNavigation(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
    isEink: Boolean,
) {
    val navController = rememberNavController()
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = navBackStackEntry?.destination

    val showBottomBar = currentDestination?.route != Screen.Pairing.route

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        bottomBar = {
            if (showBottomBar) {
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
        }
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = Screen.Dashboard.route,
            modifier = Modifier.padding(innerPadding)
        ) {
            composable(Screen.Dashboard.route) {
                DashboardScreen(stateHolder = stateHolder, isEink = isEink)
            }
            composable(Screen.Usage.route) {
                UsageScreen(stateHolder = stateHolder, isEink = isEink)
            }
            composable(Screen.Control.route) {
                ControlScreen(
                    stateHolder = stateHolder,
                    connection = connection,
                    isEink = isEink,
                )
            }
            composable(Screen.Settings.route) {
                SettingsScreen(
                    connection = connection,
                    isEink = isEink,
                    onNavigateToPairing = { navController.navigate(Screen.Pairing.route) },
                )
            }
            composable(Screen.Pairing.route) {
                PairingScreen(
                    connection = connection,
                    onPaired = { navController.popBackStack() },
                )
            }
        }
    }
}
