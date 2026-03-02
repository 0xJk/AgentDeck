package dev.agentdeck.util

import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime

/**
 * Format ISO 8601 timestamp to relative time string.
 * Mirrors bridge/src/usage-api.ts formatResetTime().
 * Handles both "Z" and "+00:00" timezone offset formats.
 */
fun formatResetTime(isoString: String): String {
    return try {
        // OffsetDateTime handles both "Z" and "+00:00" / "+09:00" etc.
        val resetAt = OffsetDateTime.parse(isoString).toInstant()
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

/** Format byte sizes compactly: 1073741824 → "1.0G", 536870912 → "512M" */
fun formatBytes(bytes: Long): String = when {
    bytes >= 1_073_741_824 -> "%.1fG".format(bytes / 1_073_741_824.0)
    bytes >= 1_048_576 -> "%dM".format(bytes / 1_048_576)
    bytes >= 1_024 -> "%dK".format(bytes / 1_024)
    else -> "${bytes}B"
}

/** Format millisecond duration compactly: 45000 → "45s", 125000 → "2m 5s" */
fun formatDurationCompact(ms: Long): String {
    if (ms < 1000) return "<1s"
    val totalSec = (ms / 1000).toInt()
    val m = totalSec / 60
    val s = totalSec % 60
    return when {
        m == 0 -> "${s}s"
        s == 0 -> "${m}m"
        else -> "${m}m ${s}s"
    }
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
