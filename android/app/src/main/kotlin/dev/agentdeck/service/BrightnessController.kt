package dev.agentdeck.service

import android.content.ContentResolver
import android.os.PowerManager
import android.provider.Settings
import android.util.Log

/**
 * Controls display brightness/timeout in response to host display sleep events.
 *
 * LCD tablets: Forces manual brightness mode, sets brightness to 0, then
 * SCREEN_OFF_TIMEOUT to 2s so the backlight turns off completely.
 * On wake: restores timeout first, sends WAKEUP, then restores brightness + mode.
 *
 * E-ink devices: Turns off frontlight via sysfs (/sys/class/backlight/{warm,white}).
 * Screen content remains visible in ambient light; system stays awake.
 */
class BrightnessController(
    private val contentResolver: ContentResolver,
    private val powerManager: PowerManager,
    private val isEink: Boolean,
) {
    companion object {
        private const val TAG = "BrightnessController"
        private const val LCD_OFF_TIMEOUT_MS = 2_000
        private val FRONTLIGHT_PATHS = listOf(
            "/sys/class/backlight/warm/brightness",
            "/sys/class/backlight/white/brightness",
        )
    }

    private var isDimmed = false
    private var savedBrightness: Int? = null
    private var savedBrightnessMode: Int? = null
    private var savedScreenOffTimeout: Int? = null
    private var savedFrontlight: Map<String, Int>? = null

    fun dim() {
        if (isDimmed) return
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

    private fun dimLcd() {
        try {
            // Save current brightness mode (auto/manual)
            savedBrightnessMode = Settings.System.getInt(
                contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
            )
            // Force manual mode so brightness=0 is respected
            Settings.System.putInt(
                contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
            )

            // Save and set brightness to minimum
            savedBrightness = Settings.System.getInt(
                contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128
            )
            Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, 0)

            // Save screen-off timeout and set to 2s for full backlight off
            savedScreenOffTimeout = Settings.System.getInt(
                contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, 60_000
            )
            Settings.System.putInt(
                contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, LCD_OFF_TIMEOUT_MS
            )

            Log.i(TAG, "LCD dim: brightness ${savedBrightness}→0, mode ${savedBrightnessMode}→MANUAL, timeout ${savedScreenOffTimeout}→${LCD_OFF_TIMEOUT_MS}ms")
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot dim LCD (no WRITE_SETTINGS): ${e.message}")
            savedBrightness = null
            savedBrightnessMode = null
            savedScreenOffTimeout = null
        }
    }

    private fun restoreLcd() {
        try {
            // Restore timeout first — prevents re-sleep after wake
            savedScreenOffTimeout?.let { timeout ->
                Settings.System.putInt(
                    contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, timeout
                )
            }

            // Wake the screen (it may be off from the 2s timeout or deep Doze)
            if (!powerManager.isInteractive) {
                // Use PowerManager wake lock — more reliable than exec in Doze
                @Suppress("DEPRECATION")
                try {
                    powerManager.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                        "AgentDeck:ScreenWake"
                    ).acquire(3_000L)
                    Log.d(TAG, "Acquired SCREEN_BRIGHT wake lock to wake LCD")
                } catch (e: Exception) {
                    Log.w(TAG, "Wake lock failed, trying keyevent fallback: ${e.message}")
                    try {
                        Runtime.getRuntime().exec(arrayOf("input", "keyevent", "KEYCODE_WAKEUP"))
                    } catch (e2: Exception) {
                        Log.w(TAG, "KEYCODE_WAKEUP also failed: ${e2.message}")
                    }
                }
            }

            // Restore brightness
            val brightness = savedBrightness ?: 128
            Settings.System.putInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, brightness)

            // Restore brightness mode (auto/manual)
            savedBrightnessMode?.let { mode ->
                Settings.System.putInt(
                    contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE, mode
                )
            }

            Log.i(TAG, "LCD restored: brightness=$brightness, mode=${savedBrightnessMode}, timeout=${savedScreenOffTimeout}")
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot restore LCD: ${e.message}")
        }
        savedBrightness = null
        savedBrightnessMode = null
        savedScreenOffTimeout = null
    }

    private fun dimEink() {
        // Save current frontlight values and turn off
        val saved = mutableMapOf<String, Int>()
        for (path in FRONTLIGHT_PATHS) {
            try {
                val current = java.io.File(path).readText().trim().toIntOrNull() ?: continue
                saved[path] = current
                java.io.File(path).writeText("0")
            } catch (e: Exception) {
                Log.w(TAG, "Cannot write $path: ${e.message}")
            }
        }
        savedFrontlight = saved.ifEmpty { null }
        Log.i(TAG, "E-ink dim: frontlight ${saved.entries.joinToString { "${it.key.substringAfterLast('/')}=${it.value}→0" }}")
    }

    private fun restoreEink() {
        savedFrontlight?.forEach { (path, value) ->
            try {
                java.io.File(path).writeText(value.toString())
            } catch (e: Exception) {
                Log.w(TAG, "Cannot restore $path: ${e.message}")
            }
        }
        Log.i(TAG, "E-ink restored: frontlight ${savedFrontlight?.entries?.joinToString { "${it.key.substringAfterLast('/')}=${it.value}" } ?: "none"}")
        savedFrontlight = null
    }
}
