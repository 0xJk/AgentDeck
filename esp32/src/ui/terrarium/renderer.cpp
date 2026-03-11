#include "renderer.h"
#include "draw.h"
#include "water.h"
#include "terrain.h"
#include "kelp.h"
#include "octopus.h"
#include "crayfish.h"
#include "tetra.h"
#include "particles.h"
#include "bubbles.h"
#include "../../state/agent_state.h"
#include "../theme.h"
#include "config.h"

#include <lvgl.h>
#include <Arduino.h>
#include <cmath>
#include <algorithm>
using std::min;
using std::max;

static lv_obj_t* canvas = nullptr;
static lv_draw_buf_t draw_buf;
static uint16_t* canvas_buf = nullptr;
static float totalTime = 0;

// Sin lookup table for fast sin/cos
static float sinTable[SIN_TABLE_SIZE];
static bool sinTableInit = false;

float fastSin(float rad) {
    if (!sinTableInit) {
        for (int i = 0; i < SIN_TABLE_SIZE; i++) {
            sinTable[i] = sinf((float)i / SIN_TABLE_SIZE * 2.0f * M_PI);
        }
        sinTableInit = true;
    }
    float norm = fmodf(rad, 2.0f * M_PI);
    if (norm < 0) norm += 2.0f * M_PI;
    int idx = (int)(norm / (2.0f * M_PI) * SIN_TABLE_SIZE) % SIN_TABLE_SIZE;
    return sinTable[idx];
}

float fastCos(float rad) {
    return fastSin(rad + M_PI / 2.0f);
}

// RGB565 byte-swap for SWAPPED format (big-endian)
static inline uint16_t swap16(uint16_t v) {
    return (v >> 8) | (v << 8);
}

static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) {
    uint16_t c = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
#if defined(BOARD_BOX_86)
    return swap16(c);  // Match LV_COLOR_FORMAT_RGB565_SWAPPED
#else
    return c;
#endif
}

// Decode a pixel back to R/G/B (handles swap)
static inline void decodePixel(uint16_t px, uint8_t& r, uint8_t& g, uint8_t& b) {
#if defined(BOARD_BOX_86)
    px = swap16(px);
#endif
    r = ((px >> 11) & 0x1F) << 3;
    g = ((px >> 5) & 0x3F) << 2;
    b = (px & 0x1F) << 3;
}

// Inline pixel setter for direct buffer manipulation
static inline void setPixel(int x, int y, uint16_t color) {
    if (x >= 0 && x < SCREEN_W && y >= 0 && y < SCREEN_H) {
        canvas_buf[y * SCREEN_W + x] = color;
    }
}

static inline void setPixelAlpha(int x, int y, uint32_t color24, uint8_t alpha) {
    if (x < 0 || x >= SCREEN_W || y < 0 || y >= SCREEN_H || alpha == 0) return;
    uint16_t* px = &canvas_buf[y * SCREEN_W + x];
    if (alpha >= 250) {
        *px = rgb565((color24 >> 16) & 0xFF, (color24 >> 8) & 0xFF, color24 & 0xFF);
        return;
    }
    // Alpha blend with existing pixel
    uint8_t bgr, bgg, bgb;
    decodePixel(*px, bgr, bgg, bgb);

    uint8_t fgr = (color24 >> 16) & 0xFF;
    uint8_t fgg = (color24 >> 8) & 0xFF;
    uint8_t fgb = color24 & 0xFF;

    uint8_t a = alpha;
    uint8_t ia = 255 - a;
    *px = rgb565((fgr * a + bgr * ia) >> 8, (fgg * a + bgg * ia) >> 8, (fgb * a + bgb * ia) >> 8);
}

// Draw filled rectangle
static void fillRect(int x, int y, int w, int h, uint16_t color) {
    for (int j = y; j < y + h; j++) {
        for (int i = x; i < x + w; i++) {
            setPixel(i, j, color);
        }
    }
}

// Draw filled circle
static void fillCircle(int cx, int cy, int r, uint32_t color24, uint8_t alpha) {
    int r2 = r * r;
    for (int dy = -r; dy <= r; dy++) {
        for (int dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy <= r2) {
                setPixelAlpha(cx + dx, cy + dy, color24, alpha);
            }
        }
    }
}

// Draw line (Bresenham)
static void drawLine(int x0, int y0, int x1, int y1, uint32_t color24, uint8_t alpha) {
    int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    while (true) {
        setPixelAlpha(x0, y0, color24, alpha);
        if (x0 == x1 && y0 == y1) break;
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

namespace Terrarium {

void init(lv_obj_t* parent) {
    // Allocate canvas buffer in PSRAM
    canvas_buf = (uint16_t*)ps_malloc(SCREEN_W * SCREEN_H * sizeof(uint16_t));
    if (!canvas_buf) {
        Serial.println("[Terrarium] PSRAM alloc failed!");
        return;
    }

    // Create LVGL canvas — format must match display
#if defined(BOARD_BOX_86)
    lv_color_format_t canvasFmt = LV_COLOR_FORMAT_RGB565_SWAPPED;
#else
    lv_color_format_t canvasFmt = LV_COLOR_FORMAT_RGB565;
#endif
    canvas = lv_canvas_create(parent);
    lv_draw_buf_init(&draw_buf, SCREEN_W, SCREEN_H, canvasFmt,
                     0, canvas_buf, SCREEN_W * SCREEN_H * sizeof(uint16_t));
    lv_canvas_set_draw_buf(canvas, &draw_buf);
    lv_obj_align(canvas, LV_ALIGN_TOP_LEFT, 0, 0);

    // Init fast sin table
    fastSin(0);

    // Init sub-renderers
    Water::init();
    Terrain::init();
    Kelp::init();
    Octopus::init();
    Crayfish::init();
    Particles::init();
    Tetra::init();
    Bubbles::init();

    Serial.printf("[Terrarium] Canvas %dx%d allocated (%d KB PSRAM)\n",
                  SCREEN_W, SCREEN_H, SCREEN_W * SCREEN_H * 2 / 1024);
}

void render(float dt) {
    if (!canvas_buf) return;

    totalTime += dt;

    // Read state snapshot
    lockState();
    CreatureState cState = g_state.creatureState;
    CrayfishState cfState = g_state.crayfishState;
    TetraState tState = g_state.tetraState;
    uint8_t octCount = max((uint8_t)1, g_state.octopusCount);
    bool showCrayfish = g_state.gatewayAvailable || g_state.crayfishCount > 0;
    unlockState();

    // Render layers bottom-to-top (direct buffer writes)

    // 1. Water gradient background (fills entire buffer)
    Water::renderBackground(canvas_buf, SCREEN_W, SCREEN_H);

    // 2. Light rays from surface (subtle volumetric shafts)
    Water::renderLightRays(canvas_buf, SCREEN_W, SCREEN_H, totalTime);

    // 3. Sand + rocks (terrain)
    Terrain::render(canvas_buf, SCREEN_W, SCREEN_H);

    // 4. Caustic light patterns on sand
    Water::renderCaustics(canvas_buf, SCREEN_W, SCREEN_H, totalTime);

    // 5. Kelp (animated sway)
    Kelp::render(canvas_buf, SCREEN_W, SCREEN_H, totalTime);

    // 6. Crayfish (if visible)
    if (showCrayfish) {
        Crayfish::render(canvas_buf, SCREEN_W, SCREEN_H, totalTime, cfState);
    }

    // 7. Octopus(es)
    for (uint8_t i = 0; i < octCount && i < MAX_OCTOPUS; i++) {
        Octopus::render(canvas_buf, SCREEN_W, SCREEN_H, totalTime, cState, i, octCount);
    }

    // 8. Data particles (food crumbs from working agents)
    Particles::update(dt, totalTime, cState, octCount, cfState, showCrayfish);
    Particles::render(canvas_buf, SCREEN_W, SCREEN_H, totalTime);

    // 9. Neon tetra school (chases food particles)
    Tetra::update(dt, totalTime, tState, cState, octCount);
    Tetra::render(canvas_buf, SCREEN_W, SCREEN_H);

    // 10. Floating particles (plankton/dust)
    Water::renderParticles(canvas_buf, SCREEN_W, SCREEN_H, totalTime);

    // 11. Bubbles
    Bubbles::update(dt, totalTime, cState);
    Bubbles::render(canvas_buf, SCREEN_W, SCREEN_H);

    // 12. Water surface waves + sparkles
    Water::renderSurface(canvas_buf, SCREEN_W, SCREEN_H, totalTime);

    // Invalidate LVGL canvas to trigger flush
    lv_obj_invalidate(canvas);
}

lv_obj_t* getCanvas() {
    return canvas;
}

}  // namespace Terrarium

// C-linkage accessor for sub-renderers that need LVGL canvas drawing
lv_obj_t* Terrarium_getCanvas() {
    return Terrarium::getCanvas();
}

// Expose drawing primitives for sub-renderers
namespace Draw {
    void pixel(int x, int y, uint16_t color) { setPixel(x, y, color); }
    void pixelA(int x, int y, uint32_t color24, uint8_t alpha) { setPixelAlpha(x, y, color24, alpha); }
    void rect(int x, int y, int w, int h, uint16_t color) { fillRect(x, y, w, h, color); }
    void circle(int cx, int cy, int r, uint32_t color24, uint8_t alpha) { fillCircle(cx, cy, r, color24, alpha); }
    void line(int x0, int y0, int x1, int y1, uint32_t color24, uint8_t alpha) { drawLine(x0, y0, x1, y1, color24, alpha); }
}
