#include "particles.h"
#include "draw.h"
#include "renderer.h"
#include "../theme.h"
#include "config.h"
#include <cmath>

// Food crumb — glowing data particle
struct FoodCrumb {
    float x, y;
    float driftX, driftY;
    float age;
    float alpha;
    float pulsePhase;
    uint32_t color;
    bool alive;
};

static FoodCrumb crumbs[MAX_FOOD_CRUMBS];
static float spawnTimer = 0;

// Android-matching colors: cyan (tool), amber (message), green (code)
static const uint32_t FOOD_COLORS[] = {
    Theme::TetraNeon,      // 0x00E5FF cyan
    Theme::StatusAmber,    // 0xFBBF24 amber
    Theme::StatusGreen,    // 0x22C55E green
};
static const int NUM_FOOD_COLORS = 3;
static int colorIdx = 0;

constexpr float FOOD_LIFETIME = 5.0f;
constexpr float FOOD_EAT_RADIUS = 0.03f;
constexpr float SPAWN_SPREAD_X = 0.08f;
constexpr float SPAWN_SPREAD_Y = 0.06f;

// Simple deterministic pseudo-random
static uint32_t rngState = 12345;
static float rngFloat() {
    rngState = rngState * 1103515245 + 12345;
    return (float)((rngState >> 16) & 0x7FFF) / 32767.0f;
}

static void spawnCrumb(float srcX, float srcY) {
    // Find dead slot or oldest
    int slot = -1;
    float maxAge = -1;
    for (int i = 0; i < MAX_FOOD_CRUMBS; i++) {
        if (!crumbs[i].alive) { slot = i; break; }
        if (crumbs[i].age > maxAge) { maxAge = crumbs[i].age; slot = i; }
    }
    if (slot < 0) return;

    FoodCrumb& c = crumbs[slot];
    c.x = srcX + (rngFloat() - 0.5f) * 2.0f * SPAWN_SPREAD_X;
    c.y = srcY + (rngFloat() - 0.5f) * 2.0f * SPAWN_SPREAD_Y;
    // Clamp to tetra swim zone
    c.x = fmaxf(Layout::TetraSwimMinX, fminf(Layout::TetraSwimMaxX, c.x));
    c.y = fmaxf(Layout::TetraSwimMinY, fminf(Layout::TetraSwimMaxY, c.y));
    c.driftX = (rngFloat() - 0.5f) * 0.012f;
    c.driftY = -0.001f - rngFloat() * 0.004f;  // float upward
    c.age = 0;
    c.alpha = 0.9f + rngFloat() * 0.1f;
    c.pulsePhase = rngFloat() * 6.28f;
    c.color = FOOD_COLORS[colorIdx % NUM_FOOD_COLORS];
    colorIdx++;
    c.alive = true;
}

namespace Particles {

void init() {
    for (int i = 0; i < MAX_FOOD_CRUMBS; i++) {
        crumbs[i].alive = false;
    }
    spawnTimer = 0;
}

void update(float dt, float time, CreatureState octState, uint8_t octCount,
            CrayfishState cfState, bool showCrayfish) {
    // Determine spawn rate
    bool octWorking = (octState == CreatureState::WORKING);
    bool cfRouting = showCrayfish && (cfState == CrayfishState::ROUTING);

    float spawnInterval;
    if (octWorking || cfRouting) {
        spawnInterval = 0.15f;  // ~7 crumbs/sec (STREAMING)
    } else {
        spawnInterval = 999.0f;  // no spawning
    }

    // Spawn
    spawnTimer += dt;
    if (spawnTimer >= spawnInterval) {
        spawnTimer = 0;

        // Spawn near working octopus
        if (octWorking) {
            float ox = Layout::OctHomeX;
            float oy = Layout::OctWorkingY;
            spawnCrumb(ox, oy);
        }
        // Spawn near routing crayfish
        if (cfRouting) {
            spawnCrumb(Layout::CfHomeX, Layout::CfRoutingY);
        }
    }

    // Update existing crumbs
    for (int i = 0; i < MAX_FOOD_CRUMBS; i++) {
        FoodCrumb& c = crumbs[i];
        if (!c.alive) continue;

        c.age += dt;
        if (c.age >= FOOD_LIFETIME) {
            c.alive = false;
            continue;
        }

        c.x += c.driftX * dt;
        c.y += c.driftY * dt;
        c.alpha = (FOOD_LIFETIME - c.age) / FOOD_LIFETIME;
    }
}

void render(uint16_t* buf, int w, int h, float time) {
    for (int i = 0; i < MAX_FOOD_CRUMBS; i++) {
        FoodCrumb& c = crumbs[i];
        if (!c.alive || c.alpha < 0.05f) continue;

        int px = (int)(c.x * w);
        int py = (int)(c.y * h);

        float pulse = fastSin(c.pulsePhase + time * 3.0f) * 0.15f + 0.85f;
        float radius = w * 0.007f * pulse;  // ~3px core

        uint8_t coreA = (uint8_t)(255 * c.alpha);
        uint8_t glowA = (uint8_t)(80 * c.alpha);
        uint8_t outerA = (uint8_t)(30 * c.alpha);

        // Outer glow
        int outerR = (int)(radius * 3.5f);
        Draw::circle(px, py, outerR, c.color, outerA);

        // Inner glow
        int innerR = (int)(radius * 2.0f);
        Draw::circle(px, py, innerR, c.color, glowA);

        // Core
        int coreR = (int)(radius);
        if (coreR < 1) coreR = 1;
        Draw::circle(px, py, coreR, c.color, coreA);

        // Bright highlight center
        Draw::pixelA(px, py, 0xFFFFFF, (uint8_t)(180 * c.alpha));
    }
}

bool nearestFood(float fx, float fy, float& outX, float& outY, float& outDist) {
    float bestDist2 = 999.0f;
    int bestIdx = -1;
    for (int i = 0; i < MAX_FOOD_CRUMBS; i++) {
        if (!crumbs[i].alive) continue;
        float dx = crumbs[i].x - fx;
        float dy = crumbs[i].y - fy;
        float d2 = dx * dx + dy * dy;
        if (d2 < bestDist2) {
            bestDist2 = d2;
            bestIdx = i;
        }
    }
    if (bestIdx < 0) return false;
    outX = crumbs[bestIdx].x;
    outY = crumbs[bestIdx].y;
    outDist = sqrtf(bestDist2);
    return true;
}

void eatNear(float fx, float fy, float radius) {
    for (int i = 0; i < MAX_FOOD_CRUMBS; i++) {
        if (!crumbs[i].alive) continue;
        float dx = crumbs[i].x - fx;
        float dy = crumbs[i].y - fy;
        if (dx * dx + dy * dy < radius * radius) {
            crumbs[i].alpha *= 0.6f;
            crumbs[i].age += 1.0f;  // accelerate death
        }
    }
}

}  // namespace Particles
