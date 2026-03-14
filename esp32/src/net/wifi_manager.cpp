#include "wifi_manager.h"
#include <WiFi.h>
#include <WiFiManager.h>
#include "config.h"

static WiFiManager wm;
static char ipBuf[16] = {0};
static bool portalActive = false;
static bool wifiWasConnected = false;

namespace Net {

void wifiInit() {
    WiFi.mode(WIFI_STA);

    // Non-blocking portal mode: if no saved credentials, starts AP
    // but returns immediately so serial can still work
    wm.setConfigPortalBlocking(false);
    wm.setConnectTimeout(8);
    wm.setConfigPortalTimeout(0);  // Portal stays open until configured
    wm.setTitle("AgentDeck");

    // Try auto-connect with saved credentials
    if (wm.autoConnect(AP_SSID)) {
        IPAddress ip = WiFi.localIP();
        snprintf(ipBuf, sizeof(ipBuf), "%d.%d.%d.%d", ip[0], ip[1], ip[2], ip[3]);
        Serial.printf("[WiFi] Connected: %s\n", ipBuf);
        // Sync NTP so time(nullptr) works for reset time parsing
        configTzTime("UTC", "pool.ntp.org", "time.google.com");
        Serial.println("[WiFi] NTP sync started (UTC)");
        wifiWasConnected = true;
        portalActive = false;
    } else {
        Serial.printf("[WiFi] No saved credentials — AP portal active: %s\n", AP_SSID);
        Serial.println("[WiFi] Connect to AP and visit 192.168.4.1 to configure");
        portalActive = true;
    }
}

void wifiLoop() {
    if (portalActive) {
        wm.process();

        // Check if user configured WiFi via portal
        if (WiFi.isConnected() && !wifiWasConnected) {
            IPAddress ip = WiFi.localIP();
            snprintf(ipBuf, sizeof(ipBuf), "%d.%d.%d.%d", ip[0], ip[1], ip[2], ip[3]);
            Serial.printf("[WiFi] Connected via portal: %s\n", ipBuf);
            configTzTime("UTC", "pool.ntp.org", "time.google.com");
            Serial.println("[WiFi] NTP sync started (UTC)");
            wifiWasConnected = true;
            portalActive = false;
        }
    }
}

bool wifiConnected() {
    return WiFi.isConnected();
}

bool wifiConnectWith(const char* ssid, const char* password) {
    Serial.printf("[WiFi] Connecting to %s...\n", ssid);

    // Disconnect from current network (if any)
    WiFi.disconnect(false);
    delay(100);

    WiFi.begin(ssid, password);

    // Wait up to 10 seconds for connection
    uint32_t start = millis();
    while (!WiFi.isConnected() && (millis() - start < 10000)) {
        delay(250);
    }

    if (WiFi.isConnected()) {
        IPAddress ip = WiFi.localIP();
        snprintf(ipBuf, sizeof(ipBuf), "%d.%d.%d.%d", ip[0], ip[1], ip[2], ip[3]);
        Serial.printf("[WiFi] Connected via provision: %s\n", ipBuf);
        // Start NTP
        configTzTime("UTC", "pool.ntp.org", "time.google.com");
        Serial.println("[WiFi] NTP sync started (UTC)");
        wifiWasConnected = true;
        portalActive = false;
        return true;
    }

    Serial.printf("[WiFi] Failed to connect to %s\n", ssid);
    return false;
}

void wifiReset() {
    wm.resetSettings();
    ESP.restart();
}

const char* wifiLocalIP() {
    return ipBuf;
}

}  // namespace Net
