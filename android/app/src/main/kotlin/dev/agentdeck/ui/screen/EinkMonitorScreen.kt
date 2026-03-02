package dev.agentdeck.ui.screen

import android.content.res.Configuration
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.agentdeck.data.DisplayPreferences
import dev.agentdeck.net.AgentState
import dev.agentdeck.net.BridgeConnection
import dev.agentdeck.net.BridgeDiscovery
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.state.SessionMetrics
import dev.agentdeck.state.TimelineStore
import dev.agentdeck.ui.eink.EinkAgentPanel
import dev.agentdeck.ui.eink.EinkContextArea
import dev.agentdeck.ui.eink.EinkEventLog
import dev.agentdeck.ui.eink.EinkFooterBar
import dev.agentdeck.ui.eink.EinkAquariumFrame
import dev.agentdeck.ui.eink.EinkSettingsOverlay
import dev.agentdeck.ui.eink.EinkStatusCompact
import dev.agentdeck.ui.eink.EinkTimelinePanel
import dev.agentdeck.ui.eink.EinkUsageCompact
import dev.agentdeck.ui.eink.compactStateMarker
import dev.agentdeck.terrarium.renderer.EinkTerrariumView
import dev.agentdeck.terrarium.toTerrariumState
import dev.agentdeck.ui.eink.EinkRefreshZone
import dev.agentdeck.ui.eink.RefreshMode
import android.util.Log
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first

private const val TAG = "EinkMonitor"

private const val SAVED_URL_TIMEOUT_MS = 8_000L

@Composable
fun EinkMonitorScreen(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
) {
    val state by stateHolder.state.collectAsState()
    val connectionStatus by connection.status.collectAsState()
    val timelineEntries by TimelineStore.instance.entries.collectAsState()
    val metrics by SessionMetrics.instance.metrics.collectAsState()
    var showSettings by remember { mutableStateOf(false) }

    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val isLandscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    val currentUrl by connection.url.collectAsState()

    // mDNS discovery — active while disconnected (url cleared)
    val discovery = remember { BridgeDiscovery(context) }
    var discoveredBridges by remember { mutableStateOf<List<DiscoveredBridge>>(emptyList()) }

    // Discovery + URL save — keyed on both status AND url
    // (disconnect() may clear url without changing status when already DISCONNECTED)
    LaunchedEffect(connectionStatus, currentUrl) {
        when {
            connectionStatus == ConnectionStatus.DISCONNECTED && currentUrl == null -> {
                // No active connection — run mDNS discovery
                discovery.discover().collect { bridges ->
                    discoveredBridges = bridges
                }
            }
            connectionStatus == ConnectionStatus.CONNECTED -> {
                discoveredBridges = emptyList()
                // Persist URL on successful connection
                currentUrl?.let { displayPrefs.setLastBridgeUrl(it) }
            }
            else -> {
                // CONNECTING or DISCONNECTED with url set (reconnecting)
                discoveredBridges = emptyList()
            }
        }
    }

    // Auto-connect: try saved URL on first launch with timeout fallback
    LaunchedEffect(Unit) {
        val savedUrl = displayPrefs.lastBridgeUrlFlow.first()
        Log.i(TAG, "Auto-connect: savedUrl=$savedUrl")
        if (savedUrl != null) {
            connection.autoConnect(savedUrl)
            // Give saved URL time to connect; if it fails, give up and let mDNS take over
            delay(SAVED_URL_TIMEOUT_MS)
            if (connection.status.value != ConnectionStatus.CONNECTED) {
                Log.w(TAG, "Auto-connect timeout — disconnecting saved URL")
                connection.disconnect() // clears url, stops reconnect loop
                displayPrefs.setLastBridgeUrl(null)
            } else {
                Log.i(TAG, "Auto-connect succeeded to $savedUrl")
            }
        }
    }

    // NOTE: mDNS-discovered bridges are shown in the UI only (not auto-connected)
    // because LAN connections require an auth token. User can tap a bridge
    // in the not-connected screen or use Settings for manual URL entry.

    val lastError by connection.lastError.collectAsState()

    // Show not-connected screen when disconnected AND not actively reconnecting
    val showNotConnected = connectionStatus != ConnectionStatus.CONNECTED &&
        state.agentState == AgentState.DISCONNECTED

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        if (showNotConnected) {
            EinkNotConnectedScreen(
                connectionStatus = connectionStatus,
                discoveredBridges = discoveredBridges,
                lastError = lastError,
                onConnectToBridge = { bridge ->
                    connection.connect(bridge.wsUrl())
                },
                onConnectLocalhost = {
                    connection.connect("ws://127.0.0.1:9120")
                },
                onSettingsClick = { showSettings = true },
            )
        } else if (isLandscape) {
            // Aquarium-centered layout: agent panel | aquarium + content + timeline
            val terrariumState by remember { derivedStateOf { state.toTerrariumState() } }
            val isActive = state.agentState == AgentState.PROCESSING ||
                state.agentState == AgentState.AWAITING_PERMISSION ||
                state.agentState == AgentState.AWAITING_OPTION ||
                state.agentState == AgentState.AWAITING_DIFF

            // Stable key that captures session count + individual states (for refresh triggers)
            val sessionsKey = state.siblingSessions.joinToString(",") { "${it.id}:${it.state}" }

            Row(modifier = Modifier.fillMaxSize()) {
                // Left (22%): Agent panel — refresh on state, session list, or worker count changes
                EinkRefreshZone(
                    mode = RefreshMode.A2,
                    debounceMs = 200,
                    triggerKey = Triple(state.agentState, sessionsKey, state.workerSessionCount),
                    modifier = Modifier.weight(0.22f).fillMaxHeight(),
                ) {
                    EinkAgentPanel(
                        state = state,
                        onSettingsClick = { showSettings = true },
                        modifier = Modifier.fillMaxSize(),
                    )
                }

                VerticalDivider(thickness = 2.dp, color = Color.Black)

                // Right (78%): Aquarium + Content + Timeline
                Column(modifier = Modifier.weight(0.78f).fillMaxHeight()) {
                    // Aquarium frame — large tank (bigger when IDLE)
                    // Trigger includes agentState + sessions (affects crayfish + multi-octopus positions)
                    EinkRefreshZone(
                        mode = RefreshMode.FULL,
                        debounceMs = 500,
                        triggerKey = Pair(state.agentState, sessionsKey),
                        modifier = Modifier
                            .weight(if (isActive) 0.40f else 0.47f)
                            .fillMaxWidth(),
                    ) {
                        EinkAquariumFrame(state = terrariumState)
                    }

                    HorizontalDivider(thickness = 1.dp, color = Color.Black)

                    // Context + Status row (only when active)
                    if (isActive) {
                        EinkRefreshZone(
                            mode = RefreshMode.A2,
                            debounceMs = 200,
                            triggerKey = Pair(state.agentState, state.currentTool),
                            modifier = Modifier.weight(0.25f).fillMaxWidth(),
                        ) {
                            Row(modifier = Modifier.fillMaxSize()) {
                                // Context area (55%)
                                EinkContextArea(
                                    state = state,
                                    timelineEntries = timelineEntries,
                                    onSelectOption = { index -> connection.sendSelectOption(index) },
                                    modifier = Modifier.weight(0.55f).fillMaxHeight(),
                                )
                                VerticalDivider(thickness = 1.dp, color = Color.Black)
                                // Compact status (45%)
                                EinkStatusCompact(
                                    state = state,
                                    modifier = Modifier.weight(0.45f).fillMaxHeight(),
                                )
                            }
                        }
                    } else {
                        // IDLE: thin status row only
                        EinkRefreshZone(
                            mode = RefreshMode.DU,
                            debounceMs = 2000,
                            triggerKey = state.usage,
                            modifier = Modifier.weight(0.15f).fillMaxWidth(),
                        ) {
                            EinkStatusCompact(state = state)
                        }
                    }

                    HorizontalDivider(thickness = 1.dp, color = Color.Black)

                    // Timeline — expanded
                    EinkRefreshZone(
                        mode = RefreshMode.A2,
                        debounceMs = 300,
                        triggerKey = timelineEntries.size,
                        modifier = Modifier
                            .weight(if (isActive) 0.35f else 0.38f)
                            .fillMaxWidth(),
                    ) {
                        EinkEventLog(entries = timelineEntries)
                    }
                }
            }
        } else {
            EinkPortraitLayout(
                state = state,
                timelineEntries = timelineEntries,
                metrics = metrics,
                onSettingsClick = { showSettings = true },
            )
        }

        if (showSettings) {
            EinkSettingsOverlay(
                connection = connection,
                displayPrefs = displayPrefs,
                discoveredBridges = discoveredBridges,
                onDismiss = { showSettings = false },
            )
        }
    }
}

@Composable
private fun EinkNotConnectedScreen(
    connectionStatus: ConnectionStatus,
    discoveredBridges: List<DiscoveredBridge>,
    lastError: String?,
    onConnectToBridge: (DiscoveredBridge) -> Unit,
    onConnectLocalhost: () -> Unit,
    onSettingsClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = when (connectionStatus) {
                ConnectionStatus.DISCONNECTED -> "\u25CB  Not Connected"
                ConnectionStatus.CONNECTING -> "\u25CC  Connecting..."
                ConnectionStatus.CONNECTED -> "\u25CF  Connected"
            },
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold),
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Error message from last connection attempt
        if (lastError != null && connectionStatus == ConnectionStatus.DISCONNECTED) {
            Text(
                text = lastError,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(16.dp))
        }

        if (connectionStatus == ConnectionStatus.CONNECTING) {
            Text(
                text = "Trying to reach bridge...",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (connectionStatus == ConnectionStatus.DISCONNECTED) {
            // USB (adb reverse) quick connect
            Surface(
                modifier = Modifier
                    .fillMaxWidth(0.6f)
                    .clickable(onClick = onConnectLocalhost),
                shape = RoundedCornerShape(4.dp),
                border = BorderStroke(2.dp, Color.Black),
                color = MaterialTheme.colorScheme.background,
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        text = "USB (adb reverse)",
                        style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        text = "127.0.0.1:9120",
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // mDNS discovered bridges
            if (discoveredBridges.isNotEmpty()) {
                Text(
                    text = "Discovered",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.height(4.dp))
                discoveredBridges.forEach { bridge ->
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth(0.6f)
                            .clickable { onConnectToBridge(bridge) },
                        shape = RoundedCornerShape(4.dp),
                        border = BorderStroke(1.dp, Color.Gray),
                        color = MaterialTheme.colorScheme.background,
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text(
                                text = "\u25CF ${bridge.name}",
                                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                text = "${bridge.host}:${bridge.port}",
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                }
            } else {
                Text(
                    text = "Searching for bridges...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "\u2699 Settings",
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.clickable(onClick = onSettingsClick),
        )
    }
}

@Composable
private fun EinkPortraitLayout(
    state: dev.agentdeck.state.DashboardState,
    timelineEntries: List<dev.agentdeck.state.TimelineEntry>,
    metrics: dev.agentdeck.state.MetricsSnapshot,
    onSettingsClick: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        // Compact header: ~15% of screen
        EinkCompactHeader(
            agentState = state.agentState,
            projectName = state.projectName,
            modelName = state.modelName,
            currentTool = state.currentTool,
            toolProgress = state.toolProgress,
            usage = state.usage,
            onSettingsClick = onSettingsClick,
        )

        HorizontalDivider(thickness = 2.dp, color = Color.Black)

        // Terrarium band (~15%)
        val terrariumState by remember { derivedStateOf { state.toTerrariumState() } }
        EinkTerrariumView(
            state = terrariumState,
            modifier = Modifier
                .fillMaxWidth()
                .weight(0.15f),
        )
        HorizontalDivider(thickness = 1.dp, color = Color.Black)

        // Timeline: ~65% of screen
        EinkTimelinePanel(
            entries = timelineEntries,
            modifier = Modifier.weight(0.65f),
        )

        // Compact footer
        HorizontalDivider(thickness = 1.dp, color = Color.Black)
        EinkFooterBar(
            metrics = metrics,
            usage = state.usage,
            isEink = true,
        )
    }
}

@Composable
private fun EinkCompactHeader(
    agentState: AgentState,
    projectName: String?,
    modelName: String?,
    currentTool: String?,
    toolProgress: String?,
    usage: dev.agentdeck.net.UsageUpdate,
    onSettingsClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // Row 1: state marker + project + model + gear
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = compactStateMarker(agentState),
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (projectName != null) {
                Text(
                    text = projectName,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                )
            } else {
                Spacer(modifier = Modifier.weight(1f))
            }
            if (modelName != null) {
                Text(
                    text = modelName,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                text = "\u2699",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.clickable(onClick = onSettingsClick),
            )
        }

        // Tool info if processing
        if (currentTool != null && agentState == AgentState.PROCESSING) {
            Text(
                text = "> $currentTool" + (toolProgress?.let { " ($it)" } ?: ""),
                style = MaterialTheme.typography.bodySmall.copy(
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                ),
                color = MaterialTheme.colorScheme.onSurface,
            )
        }

        // Row 2: compact usage
        EinkUsageCompact(usage = usage)
    }
}
