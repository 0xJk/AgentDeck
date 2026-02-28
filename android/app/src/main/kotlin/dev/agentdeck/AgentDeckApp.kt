package dev.agentdeck

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ComponentName
import android.content.pm.PackageManager
import dev.agentdeck.util.EinkDetector

class AgentDeckApp : Application() {

    companion object {
        const val CHANNEL_ID = "agentdeck_monitor"
        lateinit var instance: AgentDeckApp
            private set
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        toggleHomeLauncher()
    }

    private fun toggleHomeLauncher() {
        if (EinkDetector.isEinkDevice()) return  // manifest default: enabled
        val component = ComponentName(this, "dev.agentdeck.MainActivityHome")
        val current = packageManager.getComponentEnabledSetting(component)
        if (current != PackageManager.COMPONENT_ENABLED_STATE_DISABLED) {
            packageManager.setComponentEnabledSetting(
                component,
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP
            )
        }
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Agent Monitor",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Persistent notification for agent monitoring"
            setShowBadge(false)
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }
}
