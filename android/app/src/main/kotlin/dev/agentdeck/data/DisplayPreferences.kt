package dev.agentdeck.data

import android.content.Context
import android.content.pm.ActivityInfo
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore("display_prefs")

class DisplayPreferences(private val context: Context) {

    companion object {
        private val ORIENTATION_KEY = intPreferencesKey("orientation")
        private val KEEP_AWAKE_KEY = booleanPreferencesKey("keep_awake")
    }

    val orientationFlow: Flow<Int> = context.dataStore.data.map { prefs ->
        prefs[ORIENTATION_KEY] ?: ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
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
}
