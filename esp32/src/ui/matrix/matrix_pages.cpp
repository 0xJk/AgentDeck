#ifdef BOARD_ULANZI_TC001
#include "matrix_pages.h"
#include "matrix_font.h"
#include "config.h"
#include "state/agent_state.h"
#include "../../../boards/board_config.h"
#include <cmath>

extern DashboardState g_state;

// Serpentine XY → LED index
static inline int xyToIdx(int x, int y) {
    if (x < 0 || x >= MATRIX_W || y < 0 || y >= MATRIX_H) return -1;
    return (y % 2 == 0) ? (y * MATRIX_W + x) : (y * MATRIX_W + (MATRIX_W - 1 - x));
}

static inline void setPixel(CRGB* leds, int x, int y, CRGB color) {
    int idx = xyToIdx(x, y);
    if (idx >= 0) leds[idx] = color;
}

// Map timeline entry type string to color
static CRGB typeColor(const char* type) {
    if (strstr(type, "chat_start"))    return CRGB(0, 60, 0);    // green
    if (strstr(type, "tool"))          return CRGB(0, 0, 60);    // blue
    if (strstr(type, "chat_end"))      return CRGB(60, 40, 0);   // amber
    if (strstr(type, "error"))         return CRGB(60, 0, 0);    // red
    if (strstr(type, "model"))         return CRGB(0, 40, 40);   // cyan
    if (strstr(type, "memory"))        return CRGB(40, 0, 40);   // purple
    return CRGB(20, 20, 20);
}

// ===== PAGE: STATE =====
void MatrixPages::renderState(CRGB* leds, float animTime) {
    lockState();
    AgentState st = g_state.state;
    bool connected = g_state.wsConnected;
    unlockState();

    CRGB bg;
    const char* label;

    if (!connected) {
        bg = CRGB(20, 0, 0);
        label = "DIS";
    } else {
        switch (st) {
            case AgentState::IDLE:
                bg = CRGB(0, 0, 30);
                label = "IDL";
                break;
            case AgentState::PROCESSING: {
                uint8_t pulse = 20 + (uint8_t)(20.0f * (0.5f + 0.5f * sinf(animTime * 4.0f)));
                bg = CRGB(0, pulse, 0);
                label = "RUN";
                break;
            }
            case AgentState::AWAITING_PERMISSION:
            case AgentState::AWAITING_OPTION:
            case AgentState::AWAITING_DIFF: {
                bool blink = fmodf(animTime, 1.0f) < 0.5f;
                bg = blink ? CRGB(40, 25, 0) : CRGB(10, 6, 0);
                label = "ASK";
                break;
            }
            default:
                bg = CRGB(10, 10, 10);
                label = "---";
                break;
        }
    }

    // Fill background
    for (int i = 0; i < MATRIX_LEDS; i++) leds[i] = bg;

    // Draw 3-char label centered (y=2)
    int labelX = (MATRIX_W - 3 * 4 + 1) / 2;
    MatrixFont::drawScrollText(leds, label, labelX, 2, CRGB(255, 255, 255), MATRIX_W, MATRIX_H);
}

// ===== PAGE: TEXT (scrolling project + model) =====
void MatrixPages::renderText(CRGB* leds, float animTime) {
    for (int i = 0; i < MATRIX_LEDS; i++) leds[i] = CRGB::Black;

    lockState();
    char project[40];
    char model[32];
    strncpy(project, g_state.projectName[0] ? g_state.projectName : "NO PROJECT", sizeof(project) - 1);
    project[sizeof(project) - 1] = '\0';
    strncpy(model, g_state.modelName[0] ? g_state.modelName : "---", sizeof(model) - 1);
    model[sizeof(model) - 1] = '\0';
    unlockState();

    // Convert to uppercase for font
    for (char* p = project; *p; p++) *p = toupper(*p);
    for (char* p = model; *p; p++) *p = toupper(*p);

    // Scroll positions (wrap around)
    int projW = MatrixFont::textWidth(project);
    int modelW = MatrixFont::textWidth(model);
    int scrollMs = (int)(animTime * 1000.0f);

    int projCycle  = projW + MATRIX_W + 8;
    int modelCycle = modelW + MATRIX_W + 8;
    int projOffset  = MATRIX_W - ((scrollMs / (int)SCROLL_SPEED_MS) % (projCycle > 0 ? projCycle : 1));
    int modelOffset = MATRIX_W - (((scrollMs / (int)SCROLL_SPEED_MS) + MATRIX_W / 2) % (modelCycle > 0 ? modelCycle : 1));

    // Top: project name in cyan (rows 0-4)
    MatrixFont::drawScrollText(leds, project, projOffset, 0, CRGB(0, 180, 255), MATRIX_W, MATRIX_H);

    // Bottom: model name in green (rows 3-7)
    MatrixFont::drawScrollText(leds, model, modelOffset, 3, CRGB(0, 200, 80), MATRIX_W, MATRIX_H);
}

// ===== PAGE: GAUGE (rate limit bars) =====
void MatrixPages::renderGauge(CRGB* leds, float animTime) {
    for (int i = 0; i < MATRIX_LEDS; i++) leds[i] = CRGB::Black;

    lockState();
    float pct5h = g_state.fiveHourPercent;
    float pct7d = g_state.sevenDayPercent;
    unlockState();

    // No data sentinel
    if (pct5h < 0) pct5h = 0;
    if (pct7d < 0) pct7d = 0;
    if (pct5h > 100.0f) pct5h = 100.0f;
    if (pct7d > 100.0f) pct7d = 100.0f;

    auto barColor = [](float pct) -> CRGB {
        if (pct < 60) return CRGB(0, 40, 0);
        if (pct < 85) return CRGB(40, 30, 0);
        return CRGB(40, 0, 0);
    };

    // 5H bar: rows 0-2
    int fill5h = (int)(pct5h / 100.0f * (MATRIX_W - 6));  // Leave room for label
    CRGB c5 = barColor(pct5h);
    for (int x = 6; x < MATRIX_W; x++) {
        CRGB c = (x - 6 < fill5h) ? c5 : CRGB(5, 5, 5);
        setPixel(leds, x, 0, c);
        setPixel(leds, x, 1, c);
    }
    MatrixFont::drawScrollText(leds, "5H", 0, 0, CRGB(80, 80, 80), MATRIX_W, MATRIX_H);

    // Separator row 3
    for (int x = 0; x < MATRIX_W; x += 4) setPixel(leds, x, 3, CRGB(12, 12, 12));

    // 7D bar: rows 4-6
    int fill7d = (int)(pct7d / 100.0f * (MATRIX_W - 6));
    CRGB c7 = barColor(pct7d);
    for (int x = 6; x < MATRIX_W; x++) {
        CRGB c = (x - 6 < fill7d) ? c7 : CRGB(5, 5, 5);
        setPixel(leds, x, 5, c);
        setPixel(leds, x, 6, c);
    }
    MatrixFont::drawScrollText(leds, "7D", 0, 4, CRGB(80, 80, 80), MATRIX_W, MATRIX_H);

    // Percentage at right edge (row 7)
    char buf[8];
    snprintf(buf, sizeof(buf), "%d%%", (int)pct5h);
    int tw = MatrixFont::textWidth(buf);
    MatrixFont::drawScrollText(leds, buf, MATRIX_W - tw, 2, CRGB(150, 150, 150), MATRIX_W, MATRIX_H);
}

// ===== PAGE: TIMELINE (activity dots) =====
void MatrixPages::renderTimeline(CRGB* leds, float animTime) {
    for (int i = 0; i < MATRIX_LEDS; i++) leds[i] = CRGB::Black;

    lockState();
    uint8_t count = g_state.timelineCount;
    uint8_t head = g_state.timelineHead;

    for (int i = 0; i < count && i < MATRIX_W; i++) {
        // Most recent entry at rightmost column
        int entryIdx = (head + count - 1 - i) % TIMELINE_MAX_ENTRIES;
        int col = MATRIX_W - 1 - i;

        CRGB c = typeColor(g_state.timeline[entryIdx].type);

        // Height: newest = full, older = shorter
        int height = (i < 4) ? MATRIX_H : (i < 12) ? 4 : 2;

        for (int row = MATRIX_H - height; row < MATRIX_H; row++) {
            setPixel(leds, col, row, c);
        }
    }
    unlockState();
}

// ===== PAGE: CREATURE (mini octopus) =====
void MatrixPages::renderCreature(CRGB* leds, float animTime) {
    for (int i = 0; i < MATRIX_LEDS; i++) leds[i] = CRGB::Black;

    lockState();
    CreatureState cState = g_state.creatureState;
    bool gatewayAvail = g_state.gatewayAvailable;
    unlockState();

    // Terracotta body (#C07058)
    CRGB body = CRGB(192, 112, 88);
    CRGB eye  = CRGB(30, 30, 30);

    bool sleeping = (cState == CreatureState::SLEEPING);
    bool working  = (cState == CreatureState::WORKING);
    bool asking   = (cState == CreatureState::ASKING);

    if (sleeping) body = CRGB(60, 35, 28);

    // Gentle Y bob
    int bobY = 1 + (int)(0.5f + 0.5f * sinf(animTime * 2.0f));
    int ox = (MATRIX_W - 5) / 2;
    int oy = bobY;

    // Head (3x2)
    for (int dx = 1; dx <= 3; dx++) {
        setPixel(leds, ox + dx, oy, body);
        setPixel(leds, ox + dx, oy + 1, body);
    }
    // Eyes
    setPixel(leds, ox + 1, oy + 1, eye);
    setPixel(leds, ox + 3, oy + 1, eye);

    // Tentacles
    setPixel(leds, ox + 1, oy + 2, body);
    setPixel(leds, ox + 2, oy + 2, body);
    setPixel(leds, ox + 3, oy + 2, body);

    // Wiggling tips
    int wiggle = (int)(sinf(animTime * 3.0f));
    setPixel(leds, ox + 0 + wiggle, oy + 3, body);
    setPixel(leds, ox + 2, oy + 3, body);
    setPixel(leds, ox + 4 - wiggle, oy + 3, body);

    // Working: starburst flashes
    if (working) {
        uint8_t flash = (uint8_t)(80.0f * (0.5f + 0.5f * sinf(animTime * 8.0f)));
        CRGB star = CRGB(flash, flash, 0);
        setPixel(leds, ox - 1, oy - 1, star);
        setPixel(leds, ox + 5, oy - 1, star);
        setPixel(leds, ox - 1, oy + 3, star);
        setPixel(leds, ox + 5, oy + 3, star);
    }

    // Asking: blinking "?"
    if (asking) {
        if (fmodf(animTime, 0.8f) < 0.5f) {
            MatrixFont::drawChar(leds, ox + 6, oy, '?', CRGB(255, 200, 0), MATRIX_W, MATRIX_H);
        }
    }

    // Gateway indicator: red dot at top-right
    if (gatewayAvail) {
        setPixel(leds, MATRIX_W - 1, 0, CRGB(40, 0, 0));
    }
}
#endif // BOARD_ULANZI_TC001
