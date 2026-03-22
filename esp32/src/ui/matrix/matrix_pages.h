#pragma once

#include <FastLED.h>
#include "matrix_display.h"

namespace MatrixPages {

void renderState(CRGB* leds, float animTime);
void renderText(CRGB* leds, float animTime);
void renderGauge(CRGB* leds, float animTime);
void renderTimeline(CRGB* leds, float animTime);
void renderCreature(CRGB* leds, float animTime);

} // namespace MatrixPages
