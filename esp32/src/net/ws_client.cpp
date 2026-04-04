#include "ws_client.h"
#include "serial_client.h"
#include "protocol.h"
#include "config.h"
#include "../state/agent_state.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>
#include <Arduino.h>

static WebSocketsClient ws;
static bool connected = false;
static uint32_t reconnectMs = WS_RECONNECT_MIN_MS;
static uint32_t lastReconnectAttempt = 0;
static char savedIp[16] = {0};
static uint16_t savedPort = 0;
static char savedToken[40] = {0};

static void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
    switch (type) {
        case WStype_DISCONNECTED:
            Serial.println("[WS] Disconnected");
            connected = false;
            lockState();
            // Only mark disconnected if serial is also not connected
            // (serial data is authoritative — don't override it)
            if (!Net::serialConnected()) {
                g_state.wsConnected = false;
                g_state.state = AgentState::DISCONNECTED;
                g_state.updateCreatureStates();
            }
            unlockState();
            break;

        case WStype_CONNECTED:
            Serial.printf("[WS] Connected to %s:%d\n", savedIp, savedPort);
            connected = true;
            reconnectMs = WS_RECONNECT_MIN_MS;
            ws.setReconnectInterval(reconnectMs);
            lockState();
            g_state.wsConnected = true;
            g_state.lastMessageMs = millis();
            unlockState();
            // Request initial state
            Net::wsSendCommand("query_usage");
            break;

        case WStype_TEXT:
            Protocol::parseMessage((const char*)payload, length);
            lockState();
            g_state.lastMessageMs = millis();
            unlockState();
            break;

        case WStype_PING:
            // Library handles pong automatically
            break;

        case WStype_PONG:
            break;

        case WStype_ERROR:
            Serial.println("[WS] Error");
            break;

        default:
            break;
    }
}

namespace Net {

void wsInit() {
    // Nothing to do until connect
}

void wsConnect(const char* ip, uint16_t port, const char* token) {
    strncpy(savedIp, ip, sizeof(savedIp) - 1);
    savedPort = port;
    strncpy(savedToken, token, sizeof(savedToken) - 1);

    // Build URL path with token
    char path[80];
    if (token[0] != '\0') {
        snprintf(path, sizeof(path), "/?token=%s", token);
    } else {
        strcpy(path, "/");
    }

    ws.begin(ip, port, path);
    ws.onEvent(onWsEvent);
    ws.setReconnectInterval(reconnectMs);
    ws.enableHeartbeat(WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS, 2);

    Serial.printf("[WS] Connecting to %s:%d\n", ip, port);
}

void wsDisconnect() {
    ws.disconnect();
    connected = false;
}

void wsLoop() {
    ws.loop();

    // Exponential backoff reconnection. The library's internal reconnect timer
    // is driven by setReconnectInterval(); we must push updated values into it
    // whenever our backoff grows, otherwise it sticks at whatever was set at
    // wsConnect() time.
    if (!connected && savedIp[0] != '\0') {
        uint32_t now = millis();
        if (now - lastReconnectAttempt > reconnectMs) {
            lastReconnectAttempt = now;
            uint32_t next = reconnectMs * 2;
            if (next > WS_RECONNECT_MAX_MS) next = WS_RECONNECT_MAX_MS;
            reconnectMs = next;
            ws.setReconnectInterval(reconnectMs);
        }
    }
}

uint32_t wsLastAttemptMs() {
    return lastReconnectAttempt;
}

uint32_t wsBackoffMs() {
    return reconnectMs;
}

bool wsConnected() {
    return connected;
}

void wsSend(const char* json) {
    if (connected) {
        ws.sendTXT(json);
    }
}

void wsSendCommand(const char* type) {
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"type\":\"%s\"}", type);
    wsSend(buf);
}

void wsSendRespond(const char* value) {
    char buf[128];
    snprintf(buf, sizeof(buf), "{\"type\":\"respond\",\"value\":\"%s\"}", value);
    wsSend(buf);
}

void wsSendSelectOption(uint8_t index) {
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"type\":\"select_option\",\"index\":%d}", index);
    wsSend(buf);
}

void wsSendInterrupt() {
    wsSendCommand("interrupt");
}

void wsSendEscape() {
    wsSendCommand("escape");
}

}  // namespace Net
