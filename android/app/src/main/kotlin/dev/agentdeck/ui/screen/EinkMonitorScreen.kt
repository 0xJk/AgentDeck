package dev.agentdeck.ui.screen

import android.content.res.Configuration
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ScreenRotation
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.BridgeDiscovery
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.net.UsageUpdate
import dev.agentdeck.state.AgentStateHolder
import dev.agentdeck.state.TimelineStore
import dev.agentdeck.ui.eink.EinkAgentPanel
import dev.agentdeck.ui.eink.EinkAttentionPanel
import dev.agentdeck.ui.eink.EinkAquariumFrame
import dev.agentdeck.ui.eink.EinkSettingsOverlay
import dev.agentdeck.ui.eink.EinkTimelinePanel
import dev.agentdeck.ui.eink.buildEinkAttentionFeatured
import dev.agentdeck.terrarium.renderer.einkColorEnabled
import dev.agentdeck.terrarium.toTerrariumState
import dev.agentdeck.ui.eink.EinkAnimatedRefreshZone
import dev.agentdeck.ui.eink.EinkRefreshZone
import dev.agentdeck.ui.eink.Zone
import dev.agentdeck.data.DashboardOrientation
import android.util.Log
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

private const val TAG = "EinkMonitor"

private fun shouldPersistBridgeUrl(url: String?): Boolean {
    return url != null && !url.contains("127.0.0.1") && !url.contains("localhost")
}

@Composable
fun EinkMonitorScreen(
    stateHolder: AgentStateHolder,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
) {
    val state by stateHolder.state.collectAsState()
    val connectionStatus by connection.status.collectAsState()
    val timelineEntries by TimelineStore.instance.entries.collectAsState()
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
                // Keep the last network URL stable; localhost is always known implicitly.
                if (shouldPersistBridgeUrl(currentUrl)) {
                    displayPrefs.setLastBridgeUrl(currentUrl)
                }
            }
            else -> {
                // DISCONNECTED or CONNECTING — run mDNS to show alternatives
                discovery.discover().collect { bridges ->
                    discoveredBridges = bridges
                }
            }
        }
    }

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
            // No non-daemon fallback — session bridges don't serve external clients.
            if (false && foundDaemon == null && bestBridges.isNotEmpty() &&
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
    val showSessionList by displayPrefs.showSessionListFlow.collectAsState(initial = true)
    val showTimeline by displayPrefs.showTimelineFlow.collectAsState(initial = true)
    val showSettingsButton by displayPrefs.showSettingsButtonFlow.collectAsState(initial = true)
    val featuredAttention = remember(state) { buildEinkAttentionFeatured(state) }

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
                    connection.connect(BridgeConstants.LOCALHOST_WS_URL)
                },
                onSettingsClick = { showSettings = true },
                showSettingsButton = showSettingsButton,
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
                showSettingsButton = showSettingsButton,
            )
        } else if (isLandscape) {
            // App Store-ready E-ink projection:
            //   chrome + optional attention strip
            //   top row: Sessions | Terrarium
            //   bottom row: text timeline
            // Models/devices/large limits are intentionally absent; limits
            // appear only as a small corner card when fresh usage data exists.
            // Use state as key so toTerrariumState() recomputes when siblingSessions etc. change.
            // derivedStateOf + remember would capture the initial state parameter (plain value,
            // not a Compose State) and never re-evaluate — causing stale creature counts.
            val terrariumState = remember(state) { state.toTerrariumState() }

            // Stable key that captures session count + individual states (for refresh triggers)
            val sessionsKey = state.siblingSessions.joinToString(",") { "${it.id}:${it.state}" }

            Column(modifier = Modifier.fillMaxSize()) {
                EinkRefreshZone(
                    mode = Zone.CHROME.mode,
                    debounceMs = Zone.CHROME.debounceMs,
                    triggerKey = Triple(state.agentState, sessionsKey, state.workerSessionCount),
                    modifier = Modifier.height(44.dp).fillMaxWidth(),
                ) {
                    EinkDashboardChromeBar(
                        state = state,
                        displayPrefs = displayPrefs,
                        showSettingsButton = showSettingsButton,
                        onSettingsClick = { showSettings = true },
                        modifier = Modifier.fillMaxSize(),
                    )
                }

                if (featuredAttention != null) {
                    HorizontalDivider(thickness = 1.dp, color = Color.Black)
                    val attentionIdentity = listOf(
                        featuredAttention.sessionId,
                        featuredAttention.question,
                        featuredAttention.promptType,
                        featuredAttention.options.map { it.label },
                    )
                    EinkRefreshZone(
                        mode = Zone.ATTENTION.mode,
                        debounceMs = Zone.ATTENTION.debounceMs,
                        triggerKey = attentionIdentity,
                        softTriggerKey = featuredAttention.cursorIndex,
                        modifier = Modifier.height(112.dp).fillMaxWidth(),
                    ) {
                        EinkAttentionPanel(
                            featured = featuredAttention,
                            onFocusSession = { connection.sendFocusSession(it) },
                            onSelectOption = { connection.sendSelectOption(it) },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }

                Column(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    Row(
                        modifier = Modifier
                            .weight(if (showTimeline) 0.64f else 1f)
                            .fillMaxWidth(),
                    ) {
                        if (showSessionList) {
                            EinkRefreshZone(
                                mode = Zone.CHROME.mode,
                                debounceMs = Zone.CHROME.debounceMs,
                                triggerKey = Triple(state.agentState, sessionsKey, state.workerSessionCount),
                                modifier = Modifier.weight(0.36f).fillMaxHeight(),
                            ) {
                                EinkAgentPanel(
                                    state = state,
                                    onSettingsClick = { showSettings = true },
                                    onFocusSession = { connection.sendFocusSession(it) },
                                    showSettingsButton = showSettingsButton,
                                    displayPrefs = displayPrefs,
                                    showBrandHeader = false,
                                    showFooterControls = false,
                                    modifier = Modifier.fillMaxSize(),
                                )
                            }

                            VerticalDivider(thickness = 2.dp, color = Color.Black)
                        }

                        Box(modifier = Modifier.weight(if (showSessionList) 0.64f else 1f).fillMaxHeight()) {
                            EinkAnimatedRefreshZone(
                                stateKey = Pair(state.agentState, sessionsKey),
                                modifier = Modifier.fillMaxSize(),
                            ) { onFrameRendered ->
                                EinkAquariumFrame(
                                    state = terrariumState,
                                    onFrameRendered = onFrameRendered,
                                )
                            }
                            if (hasEinkLimitData(state.usage)) {
                                EinkLimitsCornerCard(
                                    usage = state.usage,
                                    modifier = Modifier
                                        .align(Alignment.BottomEnd)
                                        .padding(10.dp),
                                )
                            }
                        }
                    }

                    if (showTimeline) {
                        HorizontalDivider(thickness = 2.dp, color = Color.Black)
                        EinkRefreshZone(
                            mode = Zone.TIMELINE.mode,
                            debounceMs = Zone.TIMELINE.debounceMs,
                            triggerKey = timelineEntries.size,
                            modifier = Modifier.weight(0.36f).fillMaxWidth(),
                        ) {
                            EinkTimelinePanel(entries = timelineEntries, modifier = Modifier.fillMaxSize())
                        }
                    }
                }
            }
        } else {
            EinkPortraitLayout(
                state = state,
                timelineEntries = timelineEntries,
                connection = connection,
                displayPrefs = displayPrefs,
                showSessionList = showSessionList,
                showTimeline = showTimeline,
                showSettingsButton = showSettingsButton,
                onSettingsClick = { showSettings = true },
            )
        }

        if (showSettings) {
            EinkSettingsOverlay(
                connection = connection,
                displayPrefs = displayPrefs,
                dashState = state,
                discoveredBridges = discoveredBridges,
                onDismiss = { showSettings = false },
            )
        }
    }
}

@Composable
private fun EinkDashboardChromeBar(
    state: dev.agentdeck.state.DashboardState,
    displayPrefs: DisplayPreferences,
    showSettingsButton: Boolean,
    onSettingsClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val isCurrentlyLandscape =
        LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val currentOrientation by displayPrefs.orientationFlow.collectAsState(
        initial = DashboardOrientation.defaultFor(isEink = true),
    )
    val grayscaleFilter = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) })
    Row(
        modifier = modifier.padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Image(
            painter = painterResource(R.drawable.agentdeck_icon),
            contentDescription = "AgentDeck",
            modifier = Modifier.size(30.dp),
            contentScale = ContentScale.Fit,
            colorFilter = if (einkColorEnabled) null else grayscaleFilter,
        )
        // Wordmark uses default sans (IBM Plex Sans where bundled, system sans
        // otherwise). DESIGN.md §10-3 reserves Monospace for diagnostic/data
        // glyphs — the brand line itself stays sans for identity.
        Text(
            text = "AgentDeck",
            fontSize = 18.sp,
            lineHeight = 21.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text = "· :9120",
            fontSize = 12.sp,
            lineHeight = 15.sp,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.weight(1f))
        state.workerSessionCount?.takeIf { state.gatewayConnected == true && it > 0 }?.let {
            Text(
                text = "W:$it",
                fontSize = 12.sp,
                lineHeight = 15.sp,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            text = "S:${einkSessionCount(state)}",
            fontSize = 12.sp,
            lineHeight = 15.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurface,
        )
        EinkChromeIconButton(
            onClick = {
                scope.launch {
                    val newOrientation = DashboardOrientation.nextManualOrientation(
                        currentOrientation,
                        isCurrentlyLandscape,
                    )
                    displayPrefs.setOrientation(newOrientation)
                }
            },
        ) {
            Icon(
                imageVector = Icons.Default.ScreenRotation,
                contentDescription = "Rotate screen",
                tint = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(19.dp),
            )
        }
        if (showSettingsButton) {
            EinkChromeIconButton(
                onClick = onSettingsClick,
            ) {
                Icon(
                    imageVector = Icons.Default.Settings,
                    contentDescription = "Settings",
                    tint = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun EinkChromeIconButton(
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = Modifier
            .size(32.dp)
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(3.dp),
        border = BorderStroke(1.dp, Color.Black),
        color = MaterialTheme.colorScheme.background,
    ) {
        Box(contentAlignment = Alignment.Center) {
            content()
        }
    }
}

private fun einkSessionCount(state: dev.agentdeck.state.DashboardState): Int {
    val primaryIsAggregate = state.agentType == "daemon" ||
        state.agentType == "openclaw" ||
        state.siblingSessions.any { it.agentType == state.agentType }
    val primaryCount = if (!primaryIsAggregate && state.agentType != null) 1 else 0
    return primaryCount + state.siblingSessions.count { it.agentType != "daemon" }
}

private fun hasEinkLimitData(usage: UsageUpdate): Boolean {
    return usage.usageStale != true &&
        (usage.fiveHourPercent != null || usage.sevenDayPercent != null)
}

@Composable
private fun EinkLimitsCornerCard(
    usage: UsageUpdate,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val width = if (compact) 148.dp else 176.dp
    Surface(
        modifier = modifier
            .width(width)
            .height(if (compact) 68.dp else 78.dp),
        shape = RoundedCornerShape(4.dp),
        border = BorderStroke(2.dp, Color.Black),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 7.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "LIMITS",
                    fontSize = 10.sp,
                    lineHeight = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = "node",
                    fontSize = 9.sp,
                    lineHeight = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            usage.fiveHourPercent?.let { pct ->
                EinkLimitRow(label = "5h", percent = pct)
            }
            usage.sevenDayPercent?.let { pct ->
                EinkLimitRow(label = "7d", percent = pct)
            }
        }
    }
}

@Composable
private fun EinkLimitRow(label: String, percent: Double) {
    val pct = percent.coerceIn(0.0, 100.0).toInt()
    Text(
        text = "$label ${einkBlockGauge(pct)} $pct%",
        fontSize = 11.sp,
        lineHeight = 13.sp,
        fontFamily = FontFamily.Monospace,
        color = MaterialTheme.colorScheme.onSurface,
        maxLines = 1,
    )
}

private fun einkBlockGauge(percent: Int): String {
    val cells = 8
    val filled = ((percent.coerceIn(0, 100) / 100.0) * cells).toInt()
    return "\u2588".repeat(filled) + "\u2591".repeat(cells - filled)
}

@Composable
private fun EinkNotConnectedScreen(
    connectionStatus: ConnectionStatus,
    discoveredBridges: List<DiscoveredBridge>,
    lastError: String?,
    onConnectToBridge: (DiscoveredBridge) -> Unit,
    onConnectLocalhost: () -> Unit,
    onSettingsClick: () -> Unit,
    showSettingsButton: Boolean,
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
                        text = BridgeConstants.LOCALHOST_DISPLAY,
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

        if (showSettingsButton) {
            Text(
                text = "\u2699 Settings",
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.clickable(onClick = onSettingsClick),
            )
        }
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
    showSettingsButton: Boolean,
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

        // Error block — above the action button so it's always visible.
        // Use a bordered Surface to clearly separate diagnostic info from status text.
        if (lastError != null) {
            Spacer(modifier = Modifier.height(12.dp))
            Surface(
                modifier = Modifier.fillMaxWidth(0.8f),
                shape = RoundedCornerShape(4.dp),
                border = BorderStroke(1.dp, Color.Black),
                color = MaterialTheme.colorScheme.background,
            ) {
                Column(modifier = Modifier.padding(10.dp)) {
                    Text(
                        text = "Connection error",
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Bold),
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = lastError,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

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

        if (showSettingsButton) {
            Text(
                text = "\u2699 Settings",
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.clickable(onClick = onSettingsClick),
            )
        }
    }
}

@Composable
private fun EinkPortraitLayout(
    state: dev.agentdeck.state.DashboardState,
    timelineEntries: List<dev.agentdeck.state.TimelineEntry>,
    connection: BridgeConnection,
    displayPrefs: DisplayPreferences,
    showSessionList: Boolean,
    showTimeline: Boolean,
    showSettingsButton: Boolean,
    onSettingsClick: () -> Unit,
) {
    val terrariumState = remember(state) { state.toTerrariumState() }
    val featuredAttention = remember(state) { buildEinkAttentionFeatured(state) }
    val sessionsKey = state.siblingSessions.joinToString(",") { "${it.id}:${it.state}" }

    Column(modifier = Modifier.fillMaxSize()) {
        EinkRefreshZone(
            mode = Zone.CHROME.mode,
            debounceMs = Zone.CHROME.debounceMs,
            triggerKey = Triple(state.agentState, sessionsKey, state.workerSessionCount),
            modifier = Modifier.height(44.dp).fillMaxWidth(),
        ) {
            EinkDashboardChromeBar(
                state = state,
                displayPrefs = displayPrefs,
                showSettingsButton = showSettingsButton,
                onSettingsClick = onSettingsClick,
                modifier = Modifier.fillMaxSize(),
            )
        }

        if (featuredAttention != null) {
            HorizontalDivider(thickness = 1.dp, color = Color.Black)
            val attentionIdentity = listOf(
                featuredAttention.sessionId,
                featuredAttention.question,
                featuredAttention.promptType,
                featuredAttention.options.map { it.label },
            )
            EinkRefreshZone(
                mode = Zone.ATTENTION.mode,
                debounceMs = Zone.ATTENTION.debounceMs,
                triggerKey = attentionIdentity,
                softTriggerKey = featuredAttention.cursorIndex,
                modifier = Modifier.height(136.dp).fillMaxWidth(),
            ) {
                EinkAttentionPanel(
                    featured = featuredAttention,
                    onFocusSession = { connection.sendFocusSession(it) },
                    onSelectOption = { connection.sendSelectOption(it) },
                )
            }
        }

        if (showSessionList) {
            EinkRefreshZone(
                mode = Zone.CHROME.mode,
                debounceMs = Zone.CHROME.debounceMs,
                triggerKey = Triple(state.agentState, sessionsKey, state.workerSessionCount),
                modifier = Modifier.weight(if (showTimeline) 0.26f else 0.34f).fillMaxWidth(),
            ) {
                EinkAgentPanel(
                    state = state,
                    onSettingsClick = onSettingsClick,
                    onFocusSession = { connection.sendFocusSession(it) },
                    showSettingsButton = showSettingsButton,
                    displayPrefs = displayPrefs,
                    showBrandHeader = false,
                    showFooterControls = false,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            HorizontalDivider(thickness = 2.dp, color = Color.Black)
        }

        Box(modifier = Modifier.weight(if (showTimeline) 0.32f else 0.66f).fillMaxWidth()) {
            EinkAnimatedRefreshZone(
                stateKey = Pair(state.agentState, sessionsKey),
                modifier = Modifier.fillMaxSize(),
            ) { onFrameRendered ->
                EinkAquariumFrame(
                    state = terrariumState,
                    onFrameRendered = onFrameRendered,
                )
            }
            if (hasEinkLimitData(state.usage)) {
                EinkLimitsCornerCard(
                    usage = state.usage,
                    compact = true,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(8.dp),
                )
            }
        }

        if (showTimeline) {
            HorizontalDivider(thickness = 2.dp, color = Color.Black)
            EinkRefreshZone(
                mode = Zone.TIMELINE.mode,
                debounceMs = Zone.TIMELINE.debounceMs,
                triggerKey = timelineEntries.size,
                modifier = Modifier.weight(0.42f).fillMaxWidth(),
            ) {
                EinkTimelinePanel(entries = timelineEntries, modifier = Modifier.fillMaxSize())
            }
        }
    }
}
