package dev.agentdeck.service

import android.content.ContentResolver
import android.content.Context
import android.os.PowerManager
import android.provider.Settings
import android.util.Log

/**
 * Controls display brightness/timeout in response to host display sleep events.
 *
 * LCD tablets: brightness→0, SCREEN_OFF_TIMEOUT→2s → screen turns off.
 * On wake: restores timeout, wakes screen, restores brightness + mode.
 *
 * E-ink devices: sysfs /sys/class/backlight/{device}/brightness → 0.
 * Works on Crema S (warm/white). Pantone 6 sysfs is SELinux-protected — dim skipped.
 * Saved frontlight values are persisted to disk for crash recovery.
 */
class BrightnessController(
    private val context: Context,
    private val contentResolver: ContentResolver,
    private val powerManager: PowerManager,
    private val isEink: Boolean,
) {
    companion object {
        private const val TAG = "BrightnessController"
        private const val LCD_OFF_TIMEOUT_MS = 2_000
        private const val PREFS_NAME = "brightness_controller"
        private const val PREF_DIMMED = "is_dimmed"
        private const val PREF_FRONTLIGHT_PREFIX = "frontlight_"
        private const val BACKLIGHT_BASE = "/sys/class/backlight"

        /** Known sysfs frontlight device names across e-ink vendors. */
        private val KNOWN_BACKLIGHT_DEVICES = listOf(
            "warm", "white",                       // Crema S (RK3566 B&W)
            "aw99703", "aw99703_sec",              // MOAAN Pantone 6 sysfs (not app-writable)
            "rk_backlight",                        // Generic Rockchip
            "backlight", "lcd-backlight",           // Common Android
        )

        /** Derive a stable SharedPreferences key from path (parent dir name). */
        private fun prefKeyForPath(path: String): String =
            java.io.File(path).parentFile?.name ?: path.substringAfterLast('/')
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val frontlightPaths: List<String> = discoverFrontlightPaths()
    private var isDimmed = false
    private var savedBrightness: Int? = null
    private var savedBrightnessMode: Int? = null
    private var savedScreenOffTimeout: Int? = null
    private var savedFrontlight: Map<String, Int>? = null

    init {
        // Recover from crash/restart while dimmed — restore frontlight from disk
        if (isEink && prefs.getBoolean(PREF_DIMMED, false)) {
            val saved = mutableMapOf<String, Int>()
            for (path in frontlightPaths) {
                val key = PREF_FRONTLIGHT_PREFIX + prefKeyForPath(path)
                val value = prefs.getInt(key, -1)
                if (value >= 0) saved[path] = value
            }
            if (saved.isNotEmpty()) {
                Log.i(TAG, "Recovering frontlight from previous crash: $saved")
                saved.forEach { (path, value) ->
                    try { java.io.File(path).writeText(value.toString()) }
                    catch (e: Exception) { Log.w(TAG, "Cannot recover $path: ${e.message}") }
                }
            }
            prefs.edit().putBoolean(PREF_DIMMED, false).apply()
        }
    }

    fun canWriteSettings(): Boolean = isEink || Settings.System.canWrite(context)

    fun dim() {
        if (isDimmed) return

        if (!isEink && !Settings.System.canWrite(context)) {
            Log.w(TAG, "Cannot dim LCD — WRITE_SETTINGS not granted. " +
                "Grant via: adb shell appops set ${context.packageName} WRITE_SETTINGS allow")
            return
        }

        isDimmed = true

        if (isEink) {
            dimEink()
        } else {
            dimLcd()
        }
    }

    fun restore() {
        if (!isDimmed) return
        isDimmed = false

        if (isEink) {
            restoreEink()
        } else {
            restoreLcd()
        }
    }

    fun isDimmed(): Boolean = isDimmed

    // ── LCD ─────────────────────────────────────────────────────────────

    private fun dimLcd() {
        try {
            savedBrightnessMode = Settings.System.getInt(
                contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
            )
            Settings.System.putInt(
                contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
            )
            savedBrightness = Settings.System.getInt(
                contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128
            )
            Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, 0)
            savedScreenOffTimeout = Settings.System.getInt(
                contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, 60_000
            )
            Settings.System.putInt(
                contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, LCD_OFF_TIMEOUT_MS
            )
            Log.i(TAG, "LCD dim: brightness ${savedBrightness}→0, timeout ${savedScreenOffTimeout}→${LCD_OFF_TIMEOUT_MS}ms")
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot dim LCD (no WRITE_SETTINGS): ${e.message}")
            savedBrightness = null
            savedBrightnessMode = null
            savedScreenOffTimeout = null
        }
    }

    private fun restoreLcd() {
        try {
            savedScreenOffTimeout?.let { timeout ->
                Settings.System.putInt(contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, timeout)
            }
            wakeScreen()
            val brightness = savedBrightness ?: 128
            Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, brightness)
            savedBrightnessMode?.let { mode ->
                Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE, mode)
            }
            Log.i(TAG, "LCD restored: brightness=$brightness, mode=${savedBrightnessMode}, timeout=${savedScreenOffTimeout}")
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot restore LCD: ${e.message}")
        }
        savedBrightness = null
        savedBrightnessMode = null
        savedScreenOffTimeout = null
    }

    // ── E-ink ───────────────────────────────────────────────────────────

    private fun dimEink() {
        val saved = mutableMapOf<String, Int>()
        var sysfsWorked = false
        for (path in frontlightPaths) {
            try {
                val current = java.io.File(path).readText().trim().toIntOrNull() ?: continue
                if (current == 0) continue
                saved[path] = current
                java.io.File(path).writeText("0")
                sysfsWorked = true
            } catch (_: Exception) {}
        }

        savedFrontlight = saved.ifEmpty { null }

        // Persist to disk for crash recovery
        prefs.edit().apply {
            putBoolean(PREF_DIMMED, true)
            saved.forEach { (path, value) ->
                putInt(PREF_FRONTLIGHT_PREFIX + prefKeyForPath(path), value)
            }
        }.apply()

        if (sysfsWorked) {
            Log.i(TAG, "E-ink dim: sysfs OK, saved=${saved.size} values")
        } else {
            // Pantone 6: frontlight not app-controllable without root
            Log.w(TAG, "E-ink dim: sysfs not writable — skipping (no app-level frontlight control)")
        }
    }

    private fun restoreEink() {
        val toRestore = savedFrontlight ?: run {
            val fromDisk = mutableMapOf<String, Int>()
            for (path in frontlightPaths) {
                val key = PREF_FRONTLIGHT_PREFIX + prefKeyForPath(path)
                val value = prefs.getInt(key, -1)
                if (value > 0) fromDisk[path] = value
            }
            fromDisk.ifEmpty { null }
        }
        toRestore?.forEach { (path, value) ->
            try { java.io.File(path).writeText(value.toString()) }
            catch (e: Exception) { Log.w(TAG, "Cannot restore $path: ${e.message}") }
        }
        // Clear disk state
        prefs.edit().apply {
            putBoolean(PREF_DIMMED, false)
            frontlightPaths.forEach { path ->
                remove(PREF_FRONTLIGHT_PREFIX + prefKeyForPath(path))
            }
        }.apply()
        Log.i(TAG, "E-ink restored: ${toRestore?.entries?.joinToString { "${prefKeyForPath(it.key)}=${it.value}" } ?: "nothing"}")
        savedFrontlight = null
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /** Probe known sysfs backlight device paths. */
    private fun discoverFrontlightPaths(): List<String> {
        val found = KNOWN_BACKLIGHT_DEVICES
            .map { "$BACKLIGHT_BASE/$it/brightness" }
            .filter { path -> try { java.io.File(path).exists() } catch (_: Exception) { false } }
        Log.i(TAG, "Discovered frontlight paths: $found")
        return found
    }

    private fun wakeScreen() {
        if (!powerManager.isInteractive) {
            @Suppress("DEPRECATION")
            try {
                powerManager.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                    "AgentDeck:ScreenWake"
                ).acquire(3_000L)
                Log.d(TAG, "Acquired SCREEN_BRIGHT wake lock to wake screen")
            } catch (e: Exception) {
                Log.w(TAG, "Wake lock failed, trying KEYCODE_WAKEUP: ${e.message}")
                try { Runtime.getRuntime().exec(arrayOf("input", "keyevent", "KEYCODE_WAKEUP")) }
                catch (e2: Exception) { Log.w(TAG, "KEYCODE_WAKEUP also failed: ${e2.message}") }
            }
        }
    }
}
