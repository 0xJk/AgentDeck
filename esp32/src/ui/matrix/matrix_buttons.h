#pragma once

#include <cstdint>

namespace MatrixButtons {

enum class Button : uint8_t { LEFT, MID, RIGHT };
enum class Press  : uint8_t { NONE, SHORT, LONG };

void init();
void update(uint32_t nowMs);

// Returns press type and resets (call once per frame)
Press getPress(Button btn);

// Buzzer feedback
void beep(uint16_t durationMs = 50);

} // namespace MatrixButtons
