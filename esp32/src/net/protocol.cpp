#include "protocol.h"
#include "wifi_manager.h"
#include "../state/agent_state.h"
#include "config.h"
#include <ArduinoJson.h>
#include <Arduino.h>
#include <WiFi.h>

// Reusable JSON document — sized for typical bridge messages
static JsonDocument doc;

static AgentState parseState(const char* s) {
    if (!s) return AgentState::DISCONNECTED;
    if (strcmp(s, "idle") == 0)                 return AgentState::IDLE;
    if (strcmp(s, "processing") == 0)           return AgentState::PROCESSING;
    if (strcmp(s, "awaiting_permission") == 0)  return AgentState::AWAITING_PERMISSION;
    if (strcmp(s, "awaiting_option") == 0)      return AgentState::AWAITING_OPTION;
    if (strcmp(s, "awaiting_diff") == 0)        return AgentState::AWAITING_DIFF;
    return AgentState::DISCONNECTED;
}

static void handleStateUpdate(JsonObject& obj) {
    lockState();

    g_state.state = parseState(obj["state"].as<const char*>());

    // Project & model
    if (obj["projectName"].is<const char*>())
        strncpy(g_state.projectName, obj["projectName"].as<const char*>(), sizeof(g_state.projectName) - 1);
    if (obj["modelName"].is<const char*>())
        strncpy(g_state.modelName, obj["modelName"].as<const char*>(), sizeof(g_state.modelName) - 1);
    if (obj["agentType"].is<const char*>())
        strncpy(g_state.agentType, obj["agentType"].as<const char*>(), sizeof(g_state.agentType) - 1);
    if (obj["effortLevel"].is<const char*>())
        strncpy(g_state.effortLevel, obj["effortLevel"].as<const char*>(), sizeof(g_state.effortLevel) - 1);

    // Current tool
    if (obj["currentTool"].is<const char*>())
        strncpy(g_state.currentTool, obj["currentTool"].as<const char*>(), sizeof(g_state.currentTool) - 1);
    else
        g_state.currentTool[0] = '\0';
    if (obj["toolInput"].is<const char*>())
        strncpy(g_state.toolInput, obj["toolInput"].as<const char*>(), sizeof(g_state.toolInput) - 1);
    else
        g_state.toolInput[0] = '\0';

    // Permission/Options
    if (obj["question"].is<const char*>())
        strncpy(g_state.question, obj["question"].as<const char*>(), sizeof(g_state.question) - 1);
    if (obj["promptType"].is<const char*>())
        strncpy(g_state.promptType, obj["promptType"].as<const char*>(), sizeof(g_state.promptType) - 1);

    // Options array
    if (obj["options"].is<JsonArray>()) {
        JsonArray opts = obj["options"].as<JsonArray>();
        g_state.optionCount = min((int)opts.size(), 8);
        for (uint8_t i = 0; i < g_state.optionCount; i++) {
            JsonObject o = opts[i].as<JsonObject>();
            strncpy(g_state.options[i].label, o["label"] | "", sizeof(g_state.options[i].label) - 1);
            g_state.options[i].index = o["index"] | i;
            g_state.options[i].recommended = o["recommended"] | false;
            g_state.options[i].selected = o["selected"] | false;

            // Build action string
            if (o["shortcut"].is<const char*>()) {
                strncpy(g_state.options[i].action, o["shortcut"].as<const char*>(),
                        sizeof(g_state.options[i].action) - 1);
            }
        }
    }

    // Gateway
    g_state.gatewayAvailable = obj["gatewayAvailable"] | false;
    g_state.gatewayHasError = obj["gatewayHasError"] | false;

    // Derive creature states
    g_state.updateCreatureStates();

    unlockState();
}

static void handleUsageUpdate(JsonObject& obj) {
    lockState();

    // Percent fields: use -1.0f sentinel for "no data" (0 is a valid value).
    // When bridge omits the field (stale TTL expired), clear to sentinel
    // instead of keeping the old sticky value.
    g_state.fiveHourPercent = obj["fiveHourPercent"].is<float>()
        ? obj["fiveHourPercent"].as<float>() : -1.0f;
    g_state.sevenDayPercent = obj["sevenDayPercent"].is<float>()
        ? obj["sevenDayPercent"].as<float>() : -1.0f;

    g_state.inputTokens = obj["inputTokens"] | g_state.inputTokens;
    g_state.outputTokens = obj["outputTokens"] | g_state.outputTokens;
    g_state.toolCalls = obj["toolCalls"] | g_state.toolCalls;
    g_state.sessionDurationSec = obj["sessionDurationSec"] | g_state.sessionDurationSec;
    g_state.estimatedCostUsd = obj["estimatedCostUsd"].is<float>()
        ? obj["estimatedCostUsd"].as<float>() : -1.0f;
    g_state.usageStale = obj["usageStale"] | false;

    // Reset times: pre-formatted "Xh Ym" (relay) or ISO 8601 (bridge WebSocket)
    auto storeResetTime = [](JsonObject& obj, const char* key, char* out, size_t outLen) {
        if (!obj[key].is<const char*>()) { out[0] = '\0'; return; }
        const char* val = obj[key].as<const char*>();

        // Already formatted (no 'T' separator) — store directly
        if (strchr(val, 'T') == nullptr) {
            strncpy(out, val, outLen - 1);
            out[outLen - 1] = '\0';
            return;
        }

        // ISO 8601 — parse and compute relative time (needs NTP)
        struct tm tm = {};
        int tzH = 0, tzM = 0;
        char tzSign = '+';
        if (sscanf(val, "%d-%d-%dT%d:%d:%d",
                   &tm.tm_year, &tm.tm_mon, &tm.tm_mday,
                   &tm.tm_hour, &tm.tm_min, &tm.tm_sec) >= 6) {
            // Parse timezone offset (e.g. "+00:00", "+09:00")
            const char* tz = strrchr(val, '+');
            if (!tz) tz = strrchr(val, '-');
            // Make sure it's not the date separator
            if (tz && tz > val + 10) {
                tzSign = *tz;
                sscanf(tz + 1, "%d:%d", &tzH, &tzM);
            }

            tm.tm_year -= 1900;
            tm.tm_mon -= 1;

            // Convert to UTC epoch using timegm-equivalent
            // (mktime uses local time, but we set TZ to UTC via configTzTime)
            time_t resetEpoch = mktime(&tm);
            // Apply timezone offset to get UTC
            int offsetSec = (tzH * 3600 + tzM * 60) * (tzSign == '+' ? -1 : 1);
            resetEpoch += offsetSec;

            time_t now = time(nullptr);
            // Check if NTP has synced (time > 2025-01-01)
            if (now < 1735689600) {
                // No NTP yet — can't compute relative time
                out[0] = '\0';
                return;
            }

            int diffSec = (int)(resetEpoch - now);
            if (diffSec <= 0) {
                strncpy(out, "now", outLen - 1);
                out[outLen - 1] = '\0';
                return;
            }

            int diffMin = diffSec / 60;
            if (diffMin < 60) {
                snprintf(out, outLen, "%dm", diffMin);
            } else {
                int h = diffMin / 60;
                int m = diffMin % 60;
                if (h < 24) {
                    if (m > 0) snprintf(out, outLen, "%dh %dm", h, m);
                    else snprintf(out, outLen, "%dh", h);
                } else {
                    int d = h / 24;
                    int rh = h % 24;
                    if (rh > 0) snprintf(out, outLen, "%dd %dh", d, rh);
                    else snprintf(out, outLen, "%dd", d);
                }
            }
        } else {
            out[0] = '\0';
        }
    };

    storeResetTime(obj, "fiveHourResetsAt", g_state.fiveHourReset, sizeof(g_state.fiveHourReset));
    storeResetTime(obj, "sevenDayResetsAt", g_state.sevenDayReset, sizeof(g_state.sevenDayReset));

    unlockState();
}

static void handleSessionsList(JsonObject& obj) {
    lockState();

    JsonArray sessions = obj["sessions"].as<JsonArray>();
    g_state.sessionCount = min((int)sessions.size(), 6);
    g_state.octopusCount = 0;
    g_state.crayfishCount = 0;

    for (uint8_t i = 0; i < g_state.sessionCount; i++) {
        JsonObject s = sessions[i].as<JsonObject>();
        strncpy(g_state.sessions[i].id, s["id"] | "", sizeof(g_state.sessions[i].id) - 1);
        strncpy(g_state.sessions[i].projectName, s["projectName"] | "",
                sizeof(g_state.sessions[i].projectName) - 1);
        strncpy(g_state.sessions[i].agentType, s["agentType"] | "claude-code",
                sizeof(g_state.sessions[i].agentType) - 1);
        strncpy(g_state.sessions[i].state, s["state"] | "",
                sizeof(g_state.sessions[i].state) - 1);
        g_state.sessions[i].port = s["port"] | 0;
        g_state.sessions[i].alive = s["alive"] | false;

        if (g_state.sessions[i].alive) {
            if (strcmp(g_state.sessions[i].agentType, "openclaw") == 0) {
                g_state.crayfishCount++;
                // Derive crayfish state from sibling
                if (strcmp(g_state.sessions[i].state, "processing") == 0)
                    g_state.crayfishState = CrayfishState::ROUTING;
                else if (g_state.sessions[i].state[0] != '\0')
                    g_state.crayfishState = CrayfishState::SITTING;
            } else if (strcmp(g_state.sessions[i].agentType, "daemon") != 0) {
                g_state.octopusCount++;
            }
        }
    }

    // Populate sessionNames for octopus name tags
    uint8_t nameIdx = 0;
    for (uint8_t i = 0; i < g_state.sessionCount && nameIdx < 3; i++) {
        if (g_state.sessions[i].alive &&
            strcmp(g_state.sessions[i].agentType, "openclaw") != 0 &&
            strcmp(g_state.sessions[i].agentType, "daemon") != 0) {
            const char* name = g_state.sessions[i].projectName;
            if (name[0]) {
                strncpy(g_state.sessionNames[nameIdx], name,
                        sizeof(g_state.sessionNames[nameIdx]) - 1);
                g_state.sessionNames[nameIdx][sizeof(g_state.sessionNames[nameIdx]) - 1] = '\0';
            } else {
                snprintf(g_state.sessionNames[nameIdx],
                         sizeof(g_state.sessionNames[nameIdx]), "Session %d", nameIdx + 1);
            }
            nameIdx++;
        }
    }

    // No OpenClaw sessions: check gateway availability
    if (g_state.crayfishCount == 0) {
        if (g_state.gatewayAvailable) {
            g_state.crayfishState = g_state.gatewayHasError
                ? CrayfishState::SICK : CrayfishState::SITTING;
        } else {
            g_state.crayfishState = CrayfishState::DORMANT;
        }
    }

    unlockState();
}

static void handleTimelineEvent(JsonObject& obj) {
    TimelineEntry entry;
    memset(&entry, 0, sizeof(entry));

    JsonObject e = obj["entry"].as<JsonObject>();
    uint64_t tsMs = e["ts"] | 0ULL;
    // Convert to seconds since midnight (compact for display)
    entry.ts = (uint32_t)((tsMs / 1000) % 86400);

    strncpy(entry.type, e["type"] | "", sizeof(entry.type) - 1);
    strncpy(entry.raw, e["raw"] | "", sizeof(entry.raw) - 1);
    if (e["detail"].is<const char*>())
        strncpy(entry.detail, e["detail"].as<const char*>(), sizeof(entry.detail) - 1);
    if (e["status"].is<const char*>())
        strncpy(entry.status, e["status"].as<const char*>(), sizeof(entry.status) - 1);

    lockState();
    // Upsert: check if existing entry matches (same ts + type)
    bool upsert = obj["upsert"] | false;
    if (upsert) {
        for (uint8_t i = 0; i < g_state.timelineCount; i++) {
            uint8_t idx = (g_state.timelineHead + i) % TIMELINE_MAX_ENTRIES;
            if (g_state.timeline[idx].ts == entry.ts &&
                strcmp(g_state.timeline[idx].type, entry.type) == 0) {
                g_state.timeline[idx] = entry;
                unlockState();
                return;
            }
        }
    }
    g_state.addTimelineEntry(entry);
    unlockState();
}

static void handleTimelineHistory(JsonObject& obj) {
    JsonArray entries = obj["entries"].as<JsonArray>();

    lockState();
    // Reset timeline and load history
    g_state.timelineHead = 0;
    g_state.timelineCount = 0;

    for (JsonObject e : entries) {
        TimelineEntry entry;
        memset(&entry, 0, sizeof(entry));

        uint64_t tsMs = e["ts"] | 0ULL;
        entry.ts = (uint32_t)((tsMs / 1000) % 86400);
        strncpy(entry.type, e["type"] | "", sizeof(entry.type) - 1);
        strncpy(entry.raw, e["raw"] | "", sizeof(entry.raw) - 1);
        if (e["detail"].is<const char*>())
            strncpy(entry.detail, e["detail"].as<const char*>(), sizeof(entry.detail) - 1);
        if (e["status"].is<const char*>())
            strncpy(entry.status, e["status"].as<const char*>(), sizeof(entry.status) - 1);

        g_state.addTimelineEntry(entry);
    }
    unlockState();
}

static void handleWifiProvision(JsonObject& obj) {
    const char* ssid = obj["ssid"] | "";
    const char* password = obj["password"] | "";
    const char* bridgeIp = obj["bridgeIp"] | "";
    uint16_t bridgePort = obj["bridgePort"] | BRIDGE_DEFAULT_PORT;
    const char* authToken = obj["authToken"] | "";

    if (ssid[0] == '\0' || password[0] == '\0') {
        Serial.println("[Provision] Missing SSID or password");
        Serial.println("{\"type\":\"wifi_provision_ack\",\"success\":false,\"error\":\"missing credentials\"}");
        return;
    }

    Serial.printf("[Provision] Received WiFi credentials: SSID=%s\n", ssid);

    // Store bridge endpoint for direct WebSocket connection after WiFi connects
    lockState();
    strncpy(g_state.bridgeIp, bridgeIp, sizeof(g_state.bridgeIp) - 1);
    g_state.bridgePort = bridgePort;
    strncpy(g_state.authToken, authToken, sizeof(g_state.authToken) - 1);
    unlockState();

    // Connect WiFi using provisioned credentials
    bool ok = Net::wifiConnectWith(ssid, password);

    // Build ack response with ArduinoJson for safe serialization
    JsonDocument resp;
    resp["type"] = "wifi_provision_ack";
    resp["success"] = ok;
    if (ok) {
        resp["ip"] = Net::wifiLocalIP();
    } else {
        resp["error"] = "connection failed";
    }
    char buf[256];
    serializeJson(resp, buf, sizeof(buf));
    Serial.println(buf);
}

static void sendDeviceInfo() {
    JsonDocument resp;
    resp["type"] = "device_info";

    #if IS_ROUND
    resp["board"] = "round_amoled";
    #elif defined(IS_86BOX)
    resp["board"] = "86box";
    #else
    resp["board"] = "ips_35";
    #endif

    resp["version"] = "0.1.0";
    resp["wifiConfigured"] = (WiFi.SSID().length() > 0);
    resp["wifiConnected"] = Net::wifiConnected();
    if (Net::wifiConnected()) {
        resp["ip"] = Net::wifiLocalIP();
    }

    char buf[256];
    serializeJson(resp, buf, sizeof(buf));
    Serial.println(buf);
}

namespace Protocol {

void parseMessage(const char* json, size_t length) {
    doc.clear();
    DeserializationError err = deserializeJson(doc, json, length);
    if (err) {
        Serial.printf("[Protocol] JSON error: %s\n", err.c_str());
        return;
    }

    JsonObject obj = doc.as<JsonObject>();
    const char* type = obj["type"] | "";

    if (strcmp(type, "state_update") == 0) {
        handleStateUpdate(obj);
    } else if (strcmp(type, "usage_update") == 0) {
        handleUsageUpdate(obj);
    } else if (strcmp(type, "sessions_list") == 0) {
        handleSessionsList(obj);
    } else if (strcmp(type, "timeline_event") == 0) {
        handleTimelineEvent(obj);
    } else if (strcmp(type, "timeline_history") == 0) {
        handleTimelineHistory(obj);
    } else if (strcmp(type, "wifi_provision") == 0) {
        handleWifiProvision(obj);
    } else if (strcmp(type, "device_info_request") == 0) {
        sendDeviceInfo();
    } else if (strcmp(type, "connection") == 0) {
        // Connection status is handled by WS event callbacks
    }
    // Ignore: encoder_state, button_state, deck_slot_map, voice_state, display_state
    // (not needed for display-only client)
}

}  // namespace Protocol
