#pragma once

#include <cstdint>

namespace Matrix {

enum class Page : uint8_t {
    USAGE,      // Rate limit gauges (5H/7D) with slide transition
    AGENTS,     // Octopus/crayfish sprites with state colors
    PAGE_COUNT
};

void init();
void update(float dt);
void render();

void nextPage();
void prevPage();
void actionPress();

} // namespace Matrix
