#ifdef BOARD_ULANZI_TC001
#include "matrix_display.h"
#include "matrix_pages.h"
#include "matrix_buttons.h"
#include "config.h"
#include "state/agent_state.h"
#include "../../../boards/board_config.h"
#include <Arduino.h>
#include <FastLED.h>

extern DashboardState g_state;

namespace Matrix {

static CRGB leds[MATRIX_LEDS];
static Page currentPage = Page::USAGE;
static float animTime = 0.0f;
static bool autoCycle = true;
static float pageCycleTimer = 0.0f;
float smoothBrightness = MATRIX_BRIGHTNESS_DEF;  // non-static: accessed by matrix_pages

void init() {
    FastLED.addLeds<WS2812B, BOARD_PIN_LED_DATA, GRB>(leds, MATRIX_LEDS);
    FastLED.setBrightness(MATRIX_BRIGHTNESS_DEF);
    FastLED.setMaxRefreshRate(30);
    fill_solid(leds, MATRIX_LEDS, CRGB::Black);
    FastLED.show();
    MatrixButtons::init();
    pinMode(BOARD_PIN_LIGHT_SENSOR, INPUT);
    Serial.println("[Matrix] LED matrix initialized (32x8, 256 LEDs)");
}

void nextPage() {
    currentPage = static_cast<Page>((static_cast<uint8_t>(currentPage) + 1) % static_cast<uint8_t>(Page::PAGE_COUNT));
    pageCycleTimer = 0.0f;
    MatrixButtons::beep(30);
}

void prevPage() {
    uint8_t p = static_cast<uint8_t>(currentPage);
    uint8_t count = static_cast<uint8_t>(Page::PAGE_COUNT);
    currentPage = static_cast<Page>((p + count - 1) % count);
    pageCycleTimer = 0.0f;
    MatrixButtons::beep(30);
}

void actionPress() {
    autoCycle = !autoCycle;
    MatrixButtons::beep(autoCycle ? 30 : 80);
}

static void updateBrightness() {
    int raw = analogRead(BOARD_PIN_LIGHT_SENSOR);
    static uint32_t lastDebugMs = 0;
    uint32_t now = millis();
    if (now - lastDebugMs >= 5000) {
        lastDebugMs = now;
        Serial.printf("[Matrix] LDR raw=%d brightness=%.0f\n", raw, smoothBrightness);
    }
    float target = (float)map(constrain(raw, 300, 2800), 300, 2800,
                              MATRIX_BRIGHTNESS_MIN, MATRIX_BRIGHTNESS_MAX);
    smoothBrightness = smoothBrightness * 0.85f + target * 0.15f;
    FastLED.setBrightness((uint8_t)smoothBrightness);
}

void update(float dt) {
    animTime += dt;
    uint32_t nowMs = millis();

    MatrixButtons::update(nowMs);

    auto leftPress = MatrixButtons::getPress(MatrixButtons::Button::LEFT);
    auto midPress  = MatrixButtons::getPress(MatrixButtons::Button::MID);
    auto rightPress = MatrixButtons::getPress(MatrixButtons::Button::RIGHT);

    if (leftPress == MatrixButtons::Press::SHORT) prevPage();
    if (rightPress == MatrixButtons::Press::SHORT) nextPage();
    if (midPress == MatrixButtons::Press::SHORT) actionPress();
    if (midPress == MatrixButtons::Press::LONG) {
        autoCycle = !autoCycle;
        MatrixButtons::beep(autoCycle ? 30 : 80);
    }

    if (autoCycle) {
        pageCycleTimer += dt;
        if (pageCycleTimer >= PAGE_AUTO_CYCLE_MS / 1000.0f) {
            pageCycleTimer = 0.0f;
            currentPage = static_cast<Page>((static_cast<uint8_t>(currentPage) + 1) % static_cast<uint8_t>(Page::PAGE_COUNT));
        }
    }

    static uint32_t lastBrightnessMs = 0;
    if (nowMs - lastBrightnessMs >= 500) {
        lastBrightnessMs = nowMs;
        updateBrightness();
    }
}

void render() {
    fill_solid(leds, MATRIX_LEDS, CRGB::Black);

    switch (currentPage) {
        case Page::USAGE:  MatrixPages::renderUsage(leds, animTime);  break;
        case Page::AGENTS: MatrixPages::renderAgents(leds, animTime); break;
        case Page::INFO:   MatrixPages::renderInfo(leds, animTime);   break;
        default: break;
    }

    lockState();
    bool displayOn = g_state.hostDisplayOn;
    unlockState();
    if (!displayOn) fill_solid(leds, MATRIX_LEDS, CRGB::Black);

    FastLED.show();
}

} // namespace Matrix
#endif // BOARD_ULANZI_TC001
