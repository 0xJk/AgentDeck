#include "serial_client.h"
#include "protocol.h"
#include "wifi_manager.h"
#include "../state/agent_state.h"
#ifndef BOARD_ULANZI_TC001
#include "../ui/screens/splash.h"
#endif
#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoJson.h>

// Line buffer for incoming serial JSON
static constexpr int SERIAL_BUF_SIZE = 4096;
static char serialBuf[SERIAL_BUF_SIZE];
static int serialBufPos = 0;

// Connection tracking: consider "connected" if we got JSON within timeout
static constexpr uint32_t SERIAL_TIMEOUT_MS = 10000;  // 10s
static uint32_t lastSerialJsonMs = 0;
static bool hasReceivedJson = false;

// Device info sent flag — send once on first serial activity
static bool deviceInfoSent = false;

namespace Net {

static void sendDeviceInfoSerial() {
    JsonDocument resp;
    resp["type"] = "device_info";

    #if defined(BOARD_ULANZI_TC001)
    resp["board"] = "ulanzi_tc001";
    #elif IS_ROUND
    resp["board"] = "round_amoled";
    #elif defined(BOARD_BOX_86)
    resp["board"] = "86box";
    #else
    resp["board"] = "ips_35";
    #endif

    resp["version"] = "0.1.0";
    resp["wifiConfigured"] = (WiFi.SSID().length() > 0);
    resp["wifiConnected"] = wifiConnected();
    if (wifiConnected()) {
        resp["ip"] = wifiLocalIP();
    }

    char buf[256];
    serializeJson(resp, buf, sizeof(buf));
    Serial.println(buf);
}

void serialInit() {
    // Serial is already initialized in setup() at 115200
    serialBufPos = 0;
    hasReceivedJson = false;
    deviceInfoSent = false;
    Serial.println("[Serial] JSON listener ready");
}

void serialLoop() {
    while (Serial.available()) {
        char c = Serial.read();

        if (c == '\n' || c == '\r') {
            if (serialBufPos > 0) {
                serialBuf[serialBufPos] = '\0';

                // Only parse lines that look like JSON objects
                if (serialBuf[0] == '{') {
                    Protocol::parseMessage(serialBuf, serialBufPos);
                    uint32_t nowMs = millis();
                    lastSerialJsonMs = nowMs;

                    lockState();
                    g_state.lastMessageMs = nowMs;
                    unlockState();

                    if (!hasReceivedJson) {
                        hasReceivedJson = true;
                        Serial.println("[Serial] First JSON received — bridge connected via USB");

                        lockState();
                        g_state.wsConnected = true;  // Reuse connection flag
                        unlockState();
                    }

                    // Send device info on first bridge JSON contact
                    if (!deviceInfoSent) {
                        deviceInfoSent = true;
                        sendDeviceInfoSerial();
                    }
                }

                serialBufPos = 0;
            }
        } else {
            if (serialBufPos < SERIAL_BUF_SIZE - 1) {
                serialBuf[serialBufPos++] = c;
            } else {
                // Buffer overflow — discard line
                serialBufPos = 0;
            }
        }
    }

    // Detect serial disconnect (no JSON for timeout period)
    if (hasReceivedJson && (millis() - lastSerialJsonMs > SERIAL_TIMEOUT_MS)) {
        hasReceivedJson = false;
        deviceInfoSent = false;  // Re-send device info on reconnect
        Serial.println("[Serial] Bridge timeout — no JSON received");

        lockState();
        if (!Net::serialConnected()) {
            // Only mark disconnected if WiFi WS is also not connected
            // (handled by caller in networkTask)
        }
        unlockState();
    }
}

bool serialConnected() {
    return hasReceivedJson && (millis() - lastSerialJsonMs < SERIAL_TIMEOUT_MS);
}

}  // namespace Net
