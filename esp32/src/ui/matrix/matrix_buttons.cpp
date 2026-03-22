#ifdef BOARD_ULANZI_TC001
#include "matrix_buttons.h"
#include <Arduino.h>
#include "../../../boards/board_config.h"

namespace MatrixButtons {

static constexpr uint32_t DEBOUNCE_MS   = 50;
static constexpr uint32_t LONG_PRESS_MS = 800;

struct ButtonState {
    uint8_t  pin;
    bool     lastRaw     = true;   // Pull-up → HIGH when released
    bool     stable      = true;
    uint32_t debounceMs  = 0;
    uint32_t pressStartMs = 0;
    bool     pressed     = false;
    Press    pending     = Press::NONE;
};

static ButtonState buttons[3];
static uint32_t buzzerOffMs = 0;

void init() {
    buttons[0].pin = BOARD_PIN_BTN_LEFT;
    buttons[1].pin = BOARD_PIN_BTN_MID;
    buttons[2].pin = BOARD_PIN_BTN_RIGHT;

    for (auto& b : buttons) {
        pinMode(b.pin, INPUT_PULLUP);
    }
    pinMode(BOARD_PIN_BUZZER, OUTPUT);
    digitalWrite(BOARD_PIN_BUZZER, LOW);
}

void update(uint32_t nowMs) {
    for (auto& b : buttons) {
        bool raw = digitalRead(b.pin);  // LOW = pressed (active low)

        if (raw != b.lastRaw) {
            b.debounceMs = nowMs;
            b.lastRaw = raw;
        }

        if ((nowMs - b.debounceMs) >= DEBOUNCE_MS) {
            bool nowPressed = !b.stable && raw == b.stable ? b.pressed : !raw;

            if (!raw && !b.pressed) {
                // Just pressed
                b.pressed = true;
                b.pressStartMs = nowMs;
            } else if (raw && b.pressed) {
                // Just released
                uint32_t held = nowMs - b.pressStartMs;
                b.pending = (held >= LONG_PRESS_MS) ? Press::LONG : Press::SHORT;
                b.pressed = false;
            }
            b.stable = raw;
        }
    }

    // Buzzer auto-off
    if (buzzerOffMs > 0 && nowMs >= buzzerOffMs) {
        digitalWrite(BOARD_PIN_BUZZER, LOW);
        buzzerOffMs = 0;
    }
}

Press getPress(Button btn) {
    auto& b = buttons[static_cast<uint8_t>(btn)];
    Press p = b.pending;
    b.pending = Press::NONE;
    return p;
}

void beep(uint16_t durationMs) {
    digitalWrite(BOARD_PIN_BUZZER, HIGH);
    buzzerOffMs = millis() + durationMs;
}

} // namespace MatrixButtons
#endif // BOARD_ULANZI_TC001
