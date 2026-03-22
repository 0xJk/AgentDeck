#pragma once

#include <cstdint>

namespace Matrix {

enum class Page : uint8_t {
    STATE,      // Full-screen state color + abbreviation
    TEXT,       // Scrolling project name + model
    GAUGE,      // Rate limit bars
    TIMELINE,   // Activity dots
    CREATURE,   // Mini octopus animation
    PAGE_COUNT
};

void init();
void update(float dt);
void render();

// Called from button handlers
void nextPage();
void prevPage();
void actionPress();

} // namespace Matrix
