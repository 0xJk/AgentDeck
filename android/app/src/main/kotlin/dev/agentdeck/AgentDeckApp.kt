package dev.agentdeck

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

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
