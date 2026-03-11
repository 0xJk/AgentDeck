/**
 * AgentDeck ESP32-S3 Touch Display Client
 *
 * FreeRTOS dual-core architecture:
 *   Core 0: WiFi + mDNS + WebSocket (network task)
 *   Core 1: LVGL rendering + touch (UI task)
 *
 * Screens:
 *   Splash → Aquarium ↔ Timeline (swipe up/down)
 *   Settings (long press on aquarium)
 *   Permission → octopus "?" speech bubble (no modal)
 *
 * Deep sleep after 5 minutes disconnected.
 */

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <esp_sleep.h>

#include "config.h"
#include "state/agent_state.h"
#include "net/serial_client.h"
#include "net/wifi_manager.h"
#include "net/mdns_discovery.h"
#include "net/ws_client.h"
#include "ui/display.h"
#include "ui/screens/splash.h"
#include "ui/screens/aquarium.h"
#include "ui/screens/timeline_scr.h"
#include "ui/screens/settings.h"
#include "ui/screens/permission.h"

// ===== Global state =====
DashboardState g_state;
SemaphoreHandle_t g_stateMutex = nullptr;

// ===== Screen objects =====
static lv_obj_t* scrSplash = nullptr;
static lv_obj_t* scrAquarium = nullptr;
static lv_obj_t* scrTimeline = nullptr;
static lv_obj_t* scrSettings = nullptr;

static enum {
    VIEW_SPLASH,
    VIEW_AQUARIUM,
    VIEW_TIMELINE,
    VIEW_SETTINGS
} currentView = VIEW_SPLASH;

// Deep sleep: 5 minutes (300s) without connection
static constexpr uint32_t DEEP_SLEEP_TIMEOUT_MS = 5 * 60 * 1000;
static uint32_t lastConnectedMs = 0;
static bool everConnected = false;


// ===== Network task (Core 0) =====
static void networkTask(void* param) {
    Serial.println("[Net] Task started on core 0");

    // 1. Serial JSON listener (always active — USB is always connected)
    Net::serialInit();

    // 2. Connect WiFi (non-blocking attempt)
    Net::wifiInit();

    // 3. Start mDNS discovery
    Net::mdnsInit();

    // 4. Init WebSocket
    Net::wsInit();

    Net::BridgeInfo bridge;
    bool bridgeFound = false;

    while (true) {
        // === Always poll serial (USB JSON from bridge) ===
        Net::serialLoop();

        // === WiFi portal (non-blocking, processes captive portal if active) ===
        Net::wifiLoop();

        // === WiFi WebSocket (parallel to serial) ===
        if (!bridgeFound || !Net::wsConnected()) {
            if (Net::wifiConnected() && Net::mdnsPoll(bridge)) {
                Serial.printf("[Net] Bridge found via mDNS: %s:%d\n", bridge.ip, bridge.port);
                lockState();
                strncpy(g_state.bridgeIp, bridge.ip, sizeof(g_state.bridgeIp) - 1);
                g_state.bridgePort = bridge.port;
                strncpy(g_state.authToken, bridge.token, sizeof(g_state.authToken) - 1);
                unlockState();

                Net::wsConnect(bridge.ip, bridge.port, bridge.token);
                bridgeFound = true;
            }
        }

        // Process WebSocket events
        Net::wsLoop();

        // Update combined connection status (serial OR wifi)
        bool conn = Net::serialConnected() || Net::wsConnected();
        lockState();
        g_state.wsConnected = conn;
        unlockState();

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// ===== Settings long-press handler =====
static void onLongPress(lv_event_t* e) {
    if (currentView == VIEW_AQUARIUM) {
        lv_screen_load_anim(scrSettings, LV_SCR_LOAD_ANIM_FADE_IN, 200, 0, false);
        currentView = VIEW_SETTINGS;
    }
}

// ===== Settings gesture (swipe down = back to aquarium) =====
static void settingsGesture(lv_event_t* e) {
    lv_dir_t dir = lv_indev_get_gesture_dir(lv_indev_active());
    if (dir == LV_DIR_BOTTOM || dir == LV_DIR_TOP) {
        lv_screen_load_anim(scrAquarium, LV_SCR_LOAD_ANIM_FADE_IN, 200, 0, false);
        currentView = VIEW_AQUARIUM;
    }
}

// ===== UI task (Core 1) =====
static void uiTask(void* param) {
    Serial.println("[UI] Task started on core 1");

    // Initialize display + LVGL
    UI::displayInit();

    // Create screens
    scrSplash = Screens::splashCreate();
    lv_screen_load(scrSplash);
    Screens::splashSetStatus("Connecting...");

    scrAquarium = Screens::aquariumCreate();
    Screens::permissionCreate(scrAquarium);
    scrTimeline = Screens::timelineCreate();
    scrSettings = Screens::settingsCreate();

    // Long press on aquarium → settings
    lv_obj_add_event_cb(lv_obj_get_child(scrAquarium, 0), onLongPress, LV_EVENT_LONG_PRESSED, NULL);

    // Swipe on settings → back
    lv_obj_add_event_cb(scrSettings, settingsGesture, LV_EVENT_GESTURE, NULL);

    Serial.println("[UI] Screens created, entering main loop");

    uint32_t lastFrameMs = millis();
    bool wasTimelineView = false;
    lastConnectedMs = millis();

    while (true) {
        uint32_t now = millis();
        uint32_t dt_ms = now - lastFrameMs;
        float dt = dt_ms / 1000.0f;
        lastFrameMs = now;
        if (dt > 0.1f) dt = 0.1f;

        // LVGL tick
        if (dt_ms > 0) lv_tick_inc(dt_ms);

        // Read view state
        lockState();
        bool connected = g_state.wsConnected;
        bool wantTimeline = g_state.timelineView;
        unlockState();

        // Track connection for deep sleep
        if (connected) {
            lastConnectedMs = now;
            everConnected = true;
        }

        // Screen transitions
        if (currentView == VIEW_SPLASH && connected) {
            lv_screen_load_anim(scrAquarium, LV_SCR_LOAD_ANIM_FADE_IN, 300, 0, false);
            currentView = VIEW_AQUARIUM;
        } else if (currentView == VIEW_SPLASH && !connected) {
            if (Net::wifiConnected()) {
                Screens::splashSetStatus("Searching for bridge...");
            }
        }

        // Aquarium ↔ Timeline swipe
        if (currentView == VIEW_AQUARIUM && wantTimeline && !wasTimelineView) {
            lv_screen_load_anim(scrTimeline, LV_SCR_LOAD_ANIM_MOVE_TOP, 200, 0, false);
            currentView = VIEW_TIMELINE;
        } else if (currentView == VIEW_TIMELINE && !wantTimeline && wasTimelineView) {
            lv_screen_load_anim(scrAquarium, LV_SCR_LOAD_ANIM_MOVE_BOTTOM, 200, 0, false);
            currentView = VIEW_AQUARIUM;
        }
        wasTimelineView = wantTimeline;

        // Disconnect → splash (only if was previously connected)
        if (!connected && everConnected && currentView != VIEW_SPLASH && currentView != VIEW_SETTINGS) {
            lv_screen_load_anim(scrSplash, LV_SCR_LOAD_ANIM_FADE_IN, 300, 0, false);
            currentView = VIEW_SPLASH;
            Screens::splashSetStatus("Reconnecting...");
        }

        // Update current view
        switch (currentView) {
            case VIEW_AQUARIUM:
                Screens::aquariumUpdate(dt);
                break;
            case VIEW_TIMELINE:
                Screens::timelineUpdate();
                break;
            case VIEW_SETTINGS:
                Screens::settingsUpdate();
                break;
            case VIEW_SPLASH:
                break;
        }

        // LVGL timer handler
        lv_timer_handler();

        // Deep sleep: 5 minutes disconnected after first connection
        if (everConnected && !connected &&
            (now - lastConnectedMs > DEEP_SLEEP_TIMEOUT_MS)) {
            Serial.println("[Power] Deep sleep — disconnected 5 min");
            UI::setBrightness(0);
            vTaskDelay(pdMS_TO_TICKS(100));
            esp_deep_sleep_start();  // Wakes on reset/USB
        }

        // ~5ms yield for smooth animation
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

// ===== Arduino setup =====
void setup() {
    Serial.begin(115200);
    delay(100);
    Serial.println("\n=== AgentDeck ESP32-S3 Display ===");
    Serial.printf("Board: %s  Screen: %dx%d\n",
#if defined(BOARD_IPS_35)
        "IPS 3.5\"",
#elif defined(BOARD_BOX_86)
        "86 Box 4\"",
#elif defined(BOARD_ROUND_AMOLED)
        "AMOLED Round 1.8\"",
#else
        "Unknown",
#endif
        SCREEN_W, SCREEN_H);

    // Init PSRAM
    if (psramFound()) {
        Serial.printf("PSRAM: %d KB free\n", ESP.getFreePsram() / 1024);
    } else {
        Serial.println("WARNING: No PSRAM found!");
    }

    // Init state
    g_stateMutex = xSemaphoreCreateMutex();
    g_state.reset();

    // Launch tasks on separate cores
    xTaskCreatePinnedToCore(networkTask, "net", STACK_NETWORK, NULL, 1, NULL, CORE_NETWORK);
    xTaskCreatePinnedToCore(uiTask, "ui", STACK_LVGL, NULL, 2, NULL, CORE_LVGL);
}

void loop() {
    // Main loop unused — everything runs in FreeRTOS tasks
    vTaskDelay(portMAX_DELAY);
}
