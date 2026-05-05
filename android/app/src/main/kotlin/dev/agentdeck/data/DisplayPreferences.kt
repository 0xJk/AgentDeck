package dev.agentdeck.data

import android.content.Context
import android.content.pm.ActivityInfo
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore("display_prefs")

class DisplayPreferences(
    private val context: Context,
    private val isEink: Boolean = false,
) {

    companion object {
        private val ORIENTATION_KEY = intPreferencesKey("orientation")
        private val KEEP_AWAKE_KEY = booleanPreferencesKey("keep_awake")
        private val LAST_BRIDGE_URL_KEY = stringPreferencesKey("last_bridge_url")
        private val DISPLAY_SYNC_ENABLED_KEY = booleanPreferencesKey("display_sync_enabled")
        private val IDLE_TIMEOUT_MINUTES_KEY = intPreferencesKey("idle_timeout_minutes")
        private val SHOW_SESSION_LIST_KEY = booleanPreferencesKey("show_session_list")
        private val SHOW_TANK_STATUS_KEY = booleanPreferencesKey("show_tank_status")
        private val SHOW_DEVICE_DIAGNOSTIC_KEY = booleanPreferencesKey("show_device_diagnostic")
        private val SHOW_TIMELINE_KEY = booleanPreferencesKey("show_timeline")
        private val SHOW_SETTINGS_BUTTON_KEY = booleanPreferencesKey("show_settings_button")
    }

    val orientationFlow: Flow<Int> = context.dataStore.data.map { prefs ->
        prefs[ORIENTATION_KEY]
            ?: if (isEink) ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
               else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }

    val keepAwakeFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[KEEP_AWAKE_KEY] ?: true
    }

    suspend fun setOrientation(orientation: Int) {
        context.dataStore.edit { prefs ->
            prefs[ORIENTATION_KEY] = orientation
        }
    }

    suspend fun setKeepAwake(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[KEEP_AWAKE_KEY] = enabled
        }
    }

    val lastBridgeUrlFlow: Flow<String?> = context.dataStore.data.map { prefs ->
        prefs[LAST_BRIDGE_URL_KEY]
    }

    suspend fun setLastBridgeUrl(url: String?) {
        context.dataStore.edit { prefs ->
            if (url != null) {
                prefs[LAST_BRIDGE_URL_KEY] = url
            } else {
                prefs.remove(LAST_BRIDGE_URL_KEY)
            }
        }
    }

    val displaySyncEnabledFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[DISPLAY_SYNC_ENABLED_KEY] ?: true
    }

    suspend fun setDisplaySyncEnabled(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[DISPLAY_SYNC_ENABLED_KEY] = enabled
        }
    }

    val idleTimeoutMinutesFlow: Flow<Int> = context.dataStore.data.map { prefs ->
        prefs[IDLE_TIMEOUT_MINUTES_KEY] ?: 5
    }

    suspend fun setIdleTimeoutMinutes(minutes: Int) {
        context.dataStore.edit { prefs ->
            prefs[IDLE_TIMEOUT_MINUTES_KEY] = minutes
        }
    }

    val showSessionListFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SHOW_SESSION_LIST_KEY] ?: true
    }

    suspend fun setShowSessionList(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[SHOW_SESSION_LIST_KEY] = enabled
        }
    }

    val showTankStatusFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SHOW_TANK_STATUS_KEY] ?: true
    }

    suspend fun setShowTankStatus(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[SHOW_TANK_STATUS_KEY] = enabled
        }
    }

    val showDeviceDiagnosticFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SHOW_DEVICE_DIAGNOSTIC_KEY] ?: true
    }

    suspend fun setShowDeviceDiagnostic(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[SHOW_DEVICE_DIAGNOSTIC_KEY] = enabled
        }
    }

    val showTimelineFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SHOW_TIMELINE_KEY] ?: true
    }

    suspend fun setShowTimeline(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[SHOW_TIMELINE_KEY] = enabled
        }
    }

    val showSettingsButtonFlow: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[SHOW_SETTINGS_BUTTON_KEY] ?: true
    }

    suspend fun setShowSettingsButton(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[SHOW_SETTINGS_BUTTON_KEY] = enabled
        }
    }
}
