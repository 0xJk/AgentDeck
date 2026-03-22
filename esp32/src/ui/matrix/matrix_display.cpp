#ifdef BOARD_ULANZI_TC001
#include "matrix_display.h"
#include "matrix_pages.h"
#include "matrix_buttons.h"
#include "matrix_font.h"
#include "config.h"
#include "state/agent_state.h"
#include "../../../boards/board_config.h"
#include <Arduino.h>
#include <FastLED.h>

extern DashboardState g_state;

namespace Matrix {

// LED buffer
static CRGB leds[MATRIX_LEDS];

// State
static Page currentPage = Page::STATE;
static float animTime = 0.0f;
static bool autoCycle = true;
static float pageCycleTimer = 0.0f;

// Light sensor smoothing (EMA)
static float smoothBrightness = MATRIX_BRIGHTNESS_DEF;

void init() {
    FastLED.addLeds<WS2812B, BOARD_PIN_LED_DATA, GRB>(leds, MATRIX_LEDS);
    FastLED.setBrightness(MATRIX_BRIGHTNESS_DEF);
    FastLED.setMaxRefreshRate(30);

    // Clear display
    fill_solid(leds, MATRIX_LEDS, CRGB::Black);
    FastLED.show();

    // Init buttons
    MatrixButtons::init();

    // Light sensor
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
    // Context-sensitive mid button action
    lockState();
    AgentState st = g_state.state;
    unlockState();

    switch (st) {
        case AgentState::AWAITING_PERMISSION:
        case AgentState::AWAITING_OPTION:
        case AgentState::AWAITING_DIFF:
            // TODO: Send approval via serial/WS when command routing is implemented
            MatrixButtons::beep(100);
            break;
        default:
            // Toggle auto-cycle
            autoCycle = !autoCycle;
            MatrixButtons::beep(autoCycle ? 30 : 80);
            break;
    }
}

static void updateBrightness() {
    int raw = analogRead(BOARD_PIN_LIGHT_SENSOR);
    // Map ADC (0-4095) to brightness range
    float target = (float)map(raw, 0, 4095, MATRIX_BRIGHTNESS_MIN, MATRIX_BRIGHTNESS_MAX);
    // EMA filter (alpha = 0.05 for smooth transitions)
    smoothBrightness = smoothBrightness * 0.95f + target * 0.05f;
    FastLED.setBrightness((uint8_t)smoothBrightness);
}

void update(float dt) {
    animTime += dt;
    uint32_t nowMs = millis();

    // Update buttons
    MatrixButtons::update(nowMs);

    // Handle button presses
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

    // Auto-cycle pages
    if (autoCycle) {
        pageCycleTimer += dt;
        if (pageCycleTimer >= PAGE_AUTO_CYCLE_MS / 1000.0f) {
            pageCycleTimer = 0.0f;
            currentPage = static_cast<Page>((static_cast<uint8_t>(currentPage) + 1) % static_cast<uint8_t>(Page::PAGE_COUNT));
        }
    }

    // Update brightness from light sensor (every ~500ms)
    static uint32_t lastBrightnessMs = 0;
    if (nowMs - lastBrightnessMs >= 500) {
        lastBrightnessMs = nowMs;
        updateBrightness();
    }
}

void render() {
    // Clear
    fill_solid(leds, MATRIX_LEDS, CRGB::Black);

    // Render current page
    switch (currentPage) {
        case Page::STATE:    MatrixPages::renderState(leds, animTime);    break;
        case Page::TEXT:     MatrixPages::renderText(leds, animTime);     break;
        case Page::GAUGE:    MatrixPages::renderGauge(leds, animTime);    break;
        case Page::TIMELINE: MatrixPages::renderTimeline(leds, animTime); break;
        case Page::CREATURE: MatrixPages::renderCreature(leds, animTime); break;
        default: break;
    }

    // Display dimming: respect host display sleep
    lockState();
    bool displayOn = g_state.hostDisplayOn;
    unlockState();

    if (!displayOn) {
        fill_solid(leds, MATRIX_LEDS, CRGB::Black);
    }

    FastLED.show();
}

} // namespace Matrix
#endif // BOARD_ULANZI_TC001
