package dev.agentdeck.ui.screen

import android.content.res.Configuration
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentdeck.R
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
import dev.agentdeck.ui.eink.EinkAquariumFrame
import dev.agentdeck.ui.eink.EinkSettingsOverlay
import dev.agentdeck.ui.eink.EinkStatusCompact
import dev.agentdeck.ui.eink.agentIcon
import dev.agentdeck.ui.eink.compactStateMarker
import dev.agentdeck.ui.eink.mapSessionState
import dev.agentdeck.terrarium.toTerrariumState
import dev.agentdeck.ui.eink.EinkAnimatedRefreshZone
import dev.agentdeck.ui.eink.EinkRefreshZone
import dev.agentdeck.ui.eink.RefreshMode
import android.util.Log
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

private const val TAG = "EinkMonitor"

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
    // Run mDNS discovery whenever not connected (including while reconnecting)
    LaunchedEffect(connectionStatus, currentUrl) {
        when {
            connectionStatus == ConnectionStatus.CONNECTED -> {
                discoveredBridges = emptyList()
                // Persist URL on successful connection
                currentUrl?.let { displayPrefs.setLastBridgeUrl(it) }
            }
            else -> {
                // DISCONNECTED or CONNECTING — run mDNS to show alternatives
                discovery.discover().collect { bridges ->
                    discoveredBridges = bridges
                }
            }
        }
    }

    // Auto-connect: saved URL first, then mDNS fallback
    LaunchedEffect(Unit) {
        val savedUrl = displayPrefs.lastBridgeUrlFlow.first()
        Log.i(TAG, "Auto-connect: savedUrl=$savedUrl")
        if (savedUrl != null) {
            connection.autoConnect(savedUrl)
            // Wait for connection or timeout
            delay(5000)
        }
        // If still disconnected, try mDNS discovery with daemon grace period
        if (connection.status.value != ConnectionStatus.CONNECTED) {
            Log.i(TAG, "Saved URL failed, trying mDNS discovery...")
            var bestBridges = emptyList<DiscoveredBridge>()
            val foundDaemon = withTimeoutOrNull(4000) {
                discovery.discover().collect { bridges ->
                    bestBridges = bridges
                    if (bridges.isNotEmpty() && connection.status.value != ConnectionStatus.CONNECTED) {
                        val daemon = bridges.firstOrNull { it.agentType == "daemon" }
                        if (daemon != null) {
                            Log.i(TAG, "mDNS daemon found: ${daemon.name} at ${daemon.wsUrl()}")
                            connection.connect(daemon.wsUrl())
                            return@collect
                        }
                    }
                }
            }
            // Grace period expired without daemon — fall back to any bridge
            if (foundDaemon == null && bestBridges.isNotEmpty() &&
                connection.status.value != ConnectionStatus.CONNECTED) {
                val bridge = bestBridges.first()
                Log.i(TAG, "mDNS daemon not found, fallback: ${bridge.name} (agent=${bridge.agentType}) at ${bridge.wsUrl()}")
                connection.connect(bridge.wsUrl())
            }
        }
    }

    // mDNS-discovered bridges are also shown in the UI for manual selection
    // in the not-connected screen or use Settings for manual URL entry.

    val lastError by connection.lastError.collectAsState()
    val isReconnecting by connection.isReconnecting.collectAsState()
    val reconnectAttempt by connection.reconnectAttempt.collectAsState()

    // Show not-connected screen only when truly disconnected (not reconnecting)
    val showNotConnected = connectionStatus != ConnectionStatus.CONNECTED &&
        state.agentState == AgentState.DISCONNECTED &&
        !isReconnecting

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
        } else if (isReconnecting && state.agentState == AgentState.DISCONNECTED) {
            EinkReconnectingScreen(
                url = currentUrl,
                attempt = reconnectAttempt,
                lastError = lastError,
                discoveredBridges = discoveredBridges,
                onConnectToBridge = { bridge ->
                    connection.connect(bridge.wsUrl())
                },
                onStopReconnecting = { connection.disconnect() },
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
                // Fixed aquarium weight prevents layout jump on state change
                Column(modifier = Modifier.weight(0.78f).fillMaxHeight()) {
                    // Aquarium frame — animated EPD refresh via callback
                    EinkAnimatedRefreshZone(
                        stateKey = Pair(state.agentState, sessionsKey),
                        modifier = Modifier.weight(0.50f).fillMaxWidth(),
                    ) { onFrameRendered ->
                        EinkAquariumFrame(
                            state = terrariumState,
                            onFrameRendered = onFrameRendered,
                        )
                    }

                    HorizontalDivider(thickness = 1.dp, color = Color.Black)

                    // Context + Status row
                    // Show split layout only when there's context to display
                    val hasContext = isActive && (
                        state.currentTool != null ||
                        state.options.isNotEmpty() ||
                        timelineEntries.any { it.type == "tool_request" }
                    )
                    if (hasContext) {
                        EinkRefreshZone(
                            mode = RefreshMode.A2,
                            debounceMs = 200,
                            triggerKey = Triple(state.agentState, state.currentTool,
                                listOf(state.usage, state.oauthConnected, state.ollamaStatus)),
                            modifier = Modifier.weight(0.12f).fillMaxWidth(),
                        ) {
                            Row(modifier = Modifier.fillMaxSize()) {
                                // Context area (50%)
                                EinkContextArea(
                                    state = state,
                                    timelineEntries = timelineEntries,
                                    onSelectOption = { index -> connection.sendSelectOption(index) },
                                    modifier = Modifier.weight(0.50f).fillMaxHeight(),
                                )
                                VerticalDivider(thickness = 1.dp, color = Color.Black)
                                // Compact status (50%)
                                EinkStatusCompact(
                                    state = state,
                                    modifier = Modifier.weight(0.50f).fillMaxHeight(),
                                )
                            }
                        }
                    } else {
                        // No context or IDLE: status full-width (13%)
                        EinkRefreshZone(
                            mode = if (isActive) RefreshMode.A2 else RefreshMode.DU,
                            debounceMs = if (isActive) 200 else 2000,
                            triggerKey = listOf(state.usage, state.oauthConnected, state.ollamaStatus, state.modelCatalog?.size),
                            modifier = Modifier.weight(0.13f).fillMaxWidth(),
                        ) {
                            EinkStatusCompact(state = state)
                        }
                    }

                    HorizontalDivider(thickness = 1.dp, color = Color.Black)

                    // Timeline
                    EinkRefreshZone(
                        mode = RefreshMode.A2,
                        debounceMs = 300,
                        triggerKey = timelineEntries.size,
                        modifier = Modifier.weight(0.37f).fillMaxWidth(),
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
                connection = connection,
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
    // Grayscale filter for e-ink
    val grayscaleFilter = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) })

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Image(
            painter = painterResource(R.drawable.agentdeck_icon),
            contentDescription = "AgentDeck",
            modifier = Modifier.size(48.dp),
            contentScale = ContentScale.Fit,
            colorFilter = grayscaleFilter,
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "AgentDeck",
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold),
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(modifier = Modifier.height(4.dp))

        Text(
            text = when (connectionStatus) {
                ConnectionStatus.DISCONNECTED -> "Searching for bridges..."
                ConnectionStatus.CONNECTING -> "Connecting..."
                ConnectionStatus.CONNECTED -> "Connected"
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Error message from last connection attempt
        if (lastError != null && connectionStatus == ConnectionStatus.DISCONNECTED) {
            Text(
                text = lastError,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(modifier = Modifier.height(16.dp))
        }

        if (connectionStatus == ConnectionStatus.CONNECTING) {
            Text(
                text = "Connecting...",
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
                shape = RoundedCornerShape(8.dp),
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
                        shape = RoundedCornerShape(8.dp),
                        border = BorderStroke(1.dp, Color.Black),
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
private fun EinkReconnectingScreen(
    url: String?,
    attempt: Int,
    lastError: String?,
    discoveredBridges: List<DiscoveredBridge>,
    onConnectToBridge: (DiscoveredBridge) -> Unit,
    onStopReconnecting: () -> Unit,
    onSettingsClick: () -> Unit,
) {
    // Grayscale filter for e-ink
    val grayscaleFilter = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) })

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Image(
            painter = painterResource(R.drawable.agentdeck_icon),
            contentDescription = "AgentDeck",
            modifier = Modifier.size(48.dp),
            contentScale = ContentScale.Fit,
            colorFilter = grayscaleFilter,
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "AgentDeck",
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold),
            color = MaterialTheme.colorScheme.onSurface,
        )

        Spacer(modifier = Modifier.height(4.dp))

        Text(
            text = "Reconnecting...",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(modifier = Modifier.height(8.dp))

        if (url != null) {
            Text(
                text = url,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Text(
            text = "Attempt $attempt",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Stop reconnecting button
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.6f)
                .clickable(onClick = onStopReconnecting),
            shape = RoundedCornerShape(8.dp),
            border = BorderStroke(2.dp, Color.Black),
            color = MaterialTheme.colorScheme.background,
        ) {
            Text(
                text = "Stop Reconnecting",
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(8.dp),
            )
        }

        // Error message
        if (lastError != null) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = lastError,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
            )
        }

        // Show discovered bridges as alternatives
        if (discoveredBridges.isNotEmpty()) {
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = "Or connect via WiFi:",
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
    connection: BridgeConnection,
    onSettingsClick: () -> Unit,
) {
    val terrariumState by remember { derivedStateOf { state.toTerrariumState() } }
    val isActive = state.agentState == AgentState.PROCESSING ||
        state.agentState == AgentState.AWAITING_PERMISSION ||
        state.agentState == AgentState.AWAITING_OPTION ||
        state.agentState == AgentState.AWAITING_DIFF
    val sessionsKey = state.siblingSessions.joinToString(",") { "${it.id}:${it.state}" }

    Column(modifier = Modifier.fillMaxSize()) {
        // Header: logo + primary agent + state + settings gear
        EinkPortraitHeader(state = state, onSettingsClick = onSettingsClick)

        HorizontalDivider(thickness = 2.dp, color = Color.Black)

        // Aquarium (35%) — landscape is 50% of 78% column ≈ 39% of total
        EinkAnimatedRefreshZone(
            stateKey = Pair(state.agentState, sessionsKey),
            modifier = Modifier.weight(0.35f).fillMaxWidth(),
        ) { onFrameRendered ->
            EinkAquariumFrame(
                state = terrariumState,
                onFrameRendered = onFrameRendered,
            )
        }

        HorizontalDivider(thickness = 1.dp, color = Color.Black)

        // Status (10%) — compact: arc gauges + models fit in ~80dp
        if (isActive) {
            EinkRefreshZone(
                mode = RefreshMode.A2,
                debounceMs = 200,
                triggerKey = Triple(state.agentState, state.currentTool,
                    listOf(state.usage, state.oauthConnected, state.ollamaStatus)),
                modifier = Modifier.weight(0.10f).fillMaxWidth(),
            ) {
                EinkStatusCompact(state = state)
            }
        } else {
            EinkRefreshZone(
                mode = RefreshMode.DU,
                debounceMs = 2000,
                triggerKey = listOf(state.usage, state.oauthConnected, state.ollamaStatus, state.modelCatalog?.size),
                modifier = Modifier.weight(0.10f).fillMaxWidth(),
            ) {
                EinkStatusCompact(state = state)
            }
        }

        HorizontalDivider(thickness = 1.dp, color = Color.Black)

        // Context area (15%) — only when active
        if (isActive) {
            EinkRefreshZone(
                mode = RefreshMode.A2,
                debounceMs = 200,
                triggerKey = Pair(state.agentState, state.currentTool),
                modifier = Modifier.weight(0.15f).fillMaxWidth(),
            ) {
                EinkContextArea(
                    state = state,
                    timelineEntries = timelineEntries,
                    onSelectOption = { index -> connection.sendSelectOption(index) },
                )
            }

            HorizontalDivider(thickness = 1.dp, color = Color.Black)
        }

        // Timeline (remaining: 0.40 idle / 0.25 active)
        EinkRefreshZone(
            mode = RefreshMode.A2,
            debounceMs = 300,
            triggerKey = timelineEntries.size,
            modifier = Modifier.weight(if (isActive) 0.25f else 0.40f).fillMaxWidth(),
        ) {
            EinkEventLog(entries = timelineEntries)
        }

    }
}

/**
 * Portrait header — mirrors landscape EinkAgentPanel info in compact horizontal form.
 * Row 1: "AgentDeck" brand + ⚙ settings
 * Row 2+: All agents (primary + siblings) as FlowRow chips — handles any count.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EinkPortraitHeader(
    state: dev.agentdeck.state.DashboardState,
    onSettingsClick: () -> Unit,
) {
    // Build agent list — same logic as EinkAgentPanel
    data class AgentEntry(
        val projectName: String,
        val agentType: String?,
        val modelName: String?,
        val effortLevel: String?,
        val agentState: AgentState,
    )

    val entries = mutableListOf<AgentEntry>()
    if (state.agentType != "daemon") {
        entries += AgentEntry(
            projectName = state.projectName ?: "Agent",
            agentType = state.agentType,
            modelName = state.modelName,
            effortLevel = state.effortLevel,
            agentState = state.agentState,
        )
    }
    state.siblingSessions.forEach { session ->
        if (session.id == state.sessionId) return@forEach
        if (session.agentType == "daemon") return@forEach
        if (session.agentType == state.agentType && entries.any { it.agentType == session.agentType }) return@forEach
        entries += AgentEntry(
            projectName = session.projectName ?: "Agent",
            agentType = session.agentType,
            modelName = null,
            effortLevel = null,
            agentState = mapSessionState(session),
        )
    }

    // Dedup numbering per (name, type) — same as EinkAgentPanel
    data class NameKey(val projectName: String, val agentType: String?)
    val nameCounts = entries.groupBy { NameKey(it.projectName, it.agentType) }
        .mapValues { it.value.size }
    val nameCounters = mutableMapOf<NameKey, Int>()

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        // Brand + gear
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "AgentDeck",
                style = MaterialTheme.typography.bodyLarge.copy(
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                ),
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(modifier = Modifier.weight(1f))
            state.workerSessionCount?.takeIf { it > 0 }?.let {
                Text(
                    text = "W:$it",
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.padding(horizontal = 4.dp))
            }
            Text(
                text = "\u2699 Settings",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.clickable(onClick = onSettingsClick),
            )
        }

        // Agent list — adaptive font: ≤4 normal, 5-8 smaller, 9+ compact
        // Max 2 lines (≈80dp) to protect aquarium space
        val fontSize = when {
            entries.size <= 4 -> 13.sp
            entries.size <= 8 -> 11.sp
            else -> 9.sp
        }
        val gap = if (entries.size <= 4) 10.dp else 6.dp

        FlowRow(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 80.dp),
            horizontalArrangement = Arrangement.spacedBy(gap),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            entries.forEach { entry ->
                val icon = agentIcon(entry.agentType)
                val key = NameKey(entry.projectName, entry.agentType)
                val needsSuffix = (nameCounts[key] ?: 1) > 1
                val suffix = if (needsSuffix) {
                    val idx = (nameCounters[key] ?: 0) + 1
                    nameCounters[key] = idx
                    "#$idx"
                } else ""

                val stateMarker = compactStateMarker(entry.agentState)
                // Truncate project name for many agents
                val name = if (entries.size > 8) {
                    entry.projectName.take(6)
                } else {
                    entry.projectName
                }
                val modelPart = when {
                    entry.modelName != null && entry.effortLevel != null && entry.effortLevel != "medium" ->
                        "${entry.modelName}\u00B7${entry.effortLevel}"
                    entry.modelName != null -> entry.modelName
                    else -> null
                }
                val label = buildString {
                    append("$icon $name$suffix ")
                    if (modelPart != null) append("$modelPart ")
                    append(stateMarker)
                }

                Text(
                    text = label,
                    fontSize = fontSize,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                )
            }
        }
    }
}
