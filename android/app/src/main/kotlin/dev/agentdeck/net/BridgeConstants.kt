package dev.agentdeck.net

/**
 * Bridge connection constants — synced with shared/src/protocol.ts.
 * Update these when the TypeScript canonical values change.
 */
object BridgeConstants {
    /** Default daemon WebSocket port (fallback to 9121+ if occupied) */
    const val WS_PORT = 9120

    /** Default daemon HTTP port (same as WS) */
    const val HTTP_PORT = 9120

    /** OpenClaw Gateway default port */
    const val GATEWAY_PORT = 18789

    /** Reconnect interval after disconnect */
    const val RECONNECT_INTERVAL_MS = 3_000L

    /** Stuck state timeout (5 minutes) */
    const val STUCK_TIMEOUT_MS = 5 * 60 * 1_000L

    /** WebSocket ping interval */
    const val WS_PING_INTERVAL_MS = 15_000L

    /** WebSocket activity timeout */
    const val WS_ACTIVITY_TIMEOUT_MS = 30_000L

    /** Localhost WebSocket URL for USB connection */
    const val LOCALHOST_WS_URL = "ws://127.0.0.1:$WS_PORT"

    /** Display string for localhost address */
    const val LOCALHOST_DISPLAY = "127.0.0.1:$WS_PORT"
}
