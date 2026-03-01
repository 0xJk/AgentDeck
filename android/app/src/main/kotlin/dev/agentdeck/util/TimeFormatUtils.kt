package dev.agentdeck.util

import java.time.Instant
import java.time.Duration

/**
 * Format ISO 8601 timestamp to relative time string.
 * Mirrors bridge/src/usage-api.ts formatResetTime().
 */
fun formatResetTime(isoString: String): String {
    return try {
        val resetAt = Instant.parse(isoString)
        val now = Instant.now()
        val diffMs = Duration.between(now, resetAt).toMillis()
        if (diffMs <= 0) return "now"
        val diffMin = (diffMs / 60_000).toInt()
        if (diffMin < 60) return "${diffMin}m"
        val h = diffMin / 60
        val m = diffMin % 60
        if (h < 24) return if (m > 0) "${h}h ${m}m" else "${h}h"
        val d = h / 24
        "${d}d ${h % 24}h"
    } catch (_: Exception) {
        isoString
    }
}

/** Format large numbers compactly: 1000→"1.0K", 1500000→"1.5M" */
fun formatCount(n: Long): String {
    return when {
        n < 1_000 -> n.toString()
        n < 1_000_000 -> "%.1fK".format(n / 1_000.0)
        else -> "%.1fM".format(n / 1_000_000.0)
    }
}

/** Overload for Int */
fun formatCount(n: Int): String = formatCount(n.toLong())

/** Generate ASCII gauge bar: "████░░" */
fun gaugeBar(percent: Double, width: Int = 6): String {
    val filled = ((percent / 100.0) * width).toInt().coerceIn(0, width)
    val empty = width - filled
    return "█".repeat(filled) + "░".repeat(empty)
}

/** Format duration from epoch millis to "H:MM" or "D:HH:MM" */
fun formatUptime(connectedSinceMs: Long): String {
    if (connectedSinceMs <= 0) return "0:00"
    val elapsed = System.currentTimeMillis() - connectedSinceMs
    if (elapsed < 0) return "0:00"
    val totalMin = (elapsed / 60_000).toInt()
    val h = totalMin / 60
    val m = totalMin % 60
    return if (h < 24) "%d:%02d".format(h, m) else {
        val d = h / 24
        "%d:%02d:%02d".format(d, h % 24, m)
    }
}
