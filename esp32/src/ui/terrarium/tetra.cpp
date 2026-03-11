#include "tetra.h"
#include "particles.h"
#include "draw.h"
#include "../theme.h"
#include "config.h"
#include <cmath>

constexpr float BOID_SPEED = 0.3f;
constexpr float STREAM_SPEED = 1.5f;
constexpr float SEPARATION_R = 0.04f;
constexpr float ALIGNMENT_R = 0.08f;
constexpr float COHESION_R = 0.12f;
constexpr float SCHOOL_ATTRACTOR_W = 0.4f;
constexpr float TAIL_SPEED = 8.0f;

struct Fish {
    float x, y;
    float vx, vy;
    float heading;
    float tailPhase;
    float speed;
};

static Fish fish[MAX_TETRA];
static float schoolCenterX = 0.5f, schoolCenterY = 0.35f;

namespace Tetra {

void init() {
    for (int i = 0; i < MAX_TETRA; i++) {
        fish[i].x = 0.3f + (i % 3) * 0.15f + ((i * 7) % 11) * 0.01f;
        fish[i].y = 0.25f + (i / 3) * 0.1f + ((i * 13) % 7) * 0.01f;
        fish[i].vx = 0.01f * ((i % 2) ? 1 : -1);
        fish[i].vy = 0.005f * ((i % 3) ? 1 : -1);
        fish[i].heading = (i % 2) ? 0.0f : M_PI;
        fish[i].tailPhase = i * 0.9f;
        fish[i].speed = 0.9f + (i % 3) * 0.15f;
    }
}

void update(float dt, float time, TetraState tState, CreatureState octState, uint8_t octCount) {
    float baseSpeed = (tState == TetraState::STREAMING) ? BOID_SPEED * STREAM_SPEED : BOID_SPEED;

    // Lissajous school center path
    schoolCenterX = 0.45f + 0.15f * fastSin(time * 0.08f);
    schoolCenterY = 0.30f + 0.08f * fastCos(time * 0.06f + 1.0f);

    for (int i = 0; i < MAX_TETRA; i++) {
        Fish& f = fish[i];
        float ax = 0, ay = 0;

        // Boids: separation + alignment + cohesion
        for (int j = 0; j < MAX_TETRA; j++) {
            if (i == j) continue;
            float dx = f.x - fish[j].x;
            float dy = f.y - fish[j].y;
            float dist = sqrtf(dx * dx + dy * dy) + 0.001f;

            // Separation (all fish)
            if (dist < SEPARATION_R) {
                float force = (SEPARATION_R - dist) / SEPARATION_R;
                ax += dx / dist * force * 2.0f;
                ay += dy / dist * force * 2.0f;
            }
            // Alignment + Cohesion (same school — all in one school for ESP32)
            if (dist < ALIGNMENT_R) {
                ax += fish[j].vx * 0.5f;
                ay += fish[j].vy * 0.5f;
            }
            if (dist < COHESION_R) {
                ax += (fish[j].x - f.x) * 0.3f;
                ay += (fish[j].y - f.y) * 0.3f;
            }
        }

        // Food pursuit — chase nearest data particle
        float foodX, foodY, foodDist;
        bool hasFood = Particles::nearestFood(f.x, f.y, foodX, foodY, foodDist);

        if (hasFood && tState == TetraState::STREAMING) {
            // Aggressive pursuit during STREAMING
            float dx = foodX - f.x;
            float dy = foodY - f.y;
            float d = foodDist + 0.001f;
            ax += dx / d * 1.0f;
            ay += dy / d * 0.4f;  // horizontal preference

            // Eat when close
            if (foodDist < 0.03f) {
                Particles::eatNear(f.x, f.y, 0.03f);
            }
        } else if (hasFood && tState == TetraState::CIRCLING) {
            // Moderate pursuit during CIRCLING
            float dx = foodX - f.x;
            float dy = foodY - f.y;
            float d = foodDist + 0.001f;
            ax += dx / d * 0.5f;
            ay += dy / d * 0.2f;

            if (foodDist < 0.03f) {
                Particles::eatNear(f.x, f.y, 0.03f);
            }

            // Still attract to school center
            ax += (schoolCenterX - f.x) * SCHOOL_ATTRACTOR_W;
            ay += (schoolCenterY - f.y) * SCHOOL_ATTRACTOR_W;
        } else {
            // No food — school attractor only
            ax += (schoolCenterX - f.x) * SCHOOL_ATTRACTOR_W;
            ay += (schoolCenterY - f.y) * SCHOOL_ATTRACTOR_W;
        }

        // Boundary avoidance (soft walls)
        if (f.x < Layout::TetraSwimMinX + 0.05f) ax += 0.5f;
        if (f.x > Layout::TetraSwimMaxX - 0.05f) ax -= 0.5f;
        if (f.y < Layout::TetraSwimMinY + 0.05f) ay += 0.5f;
        if (f.y > Layout::TetraSwimMaxY - 0.05f) ay -= 0.5f;

        // Apply acceleration
        f.vx += ax * dt;
        f.vy += ay * dt;

        // Speed limiting
        float speed = sqrtf(f.vx * f.vx + f.vy * f.vy);
        float maxSpeed = baseSpeed * f.speed;
        if (speed > maxSpeed) {
            f.vx = f.vx / speed * maxSpeed;
            f.vy = f.vy / speed * maxSpeed;
        }

        // Move
        f.x += f.vx * dt;
        f.y += f.vy * dt;

        // Clamp to boundaries
        f.x = fmaxf(Layout::TetraSwimMinX, fminf(Layout::TetraSwimMaxX, f.x));
        f.y = fmaxf(Layout::TetraSwimMinY, fminf(Layout::TetraSwimMaxY, f.y));

        // Update heading
        if (speed > 0.001f) {
            f.heading = atan2f(f.vy, f.vx);
        }
    }
}

void render(uint16_t* buf, int w, int h) {
    for (int i = 0; i < MAX_TETRA; i++) {
        Fish& f = fish[i];
        int fx = (int)(f.x * w);
        int fy = (int)(f.y * h);
        float size = w * Layout::TetraSize;
        float cosH = fastCos(f.heading);
        float sinH = fastSin(f.heading);

        // Fish body — elongated oval
        int bodyLen = (int)(size * 1.5f);
        int bodyH2 = (int)(size * 0.4f);
        for (int bl = -bodyLen / 2; bl <= bodyLen / 2; bl++) {
            float t = (float)abs(bl) / (bodyLen / 2 + 1);
            int halfH = (int)(bodyH2 * (1.0f - t * t));
            for (int bh = -halfH; bh <= halfH; bh++) {
                int px = fx + (int)(bl * cosH - bh * sinH);
                int py = fy + (int)(bl * sinH + bh * cosH);
                Draw::pixelA(px, py, Theme::TetraBody, 200);
            }
        }

        // Neon cyan stripe (middle)
        for (int bl = -bodyLen / 3; bl <= bodyLen / 3; bl++) {
            int px = fx + (int)(bl * cosH);
            int py = fy + (int)(bl * sinH);
            Draw::pixelA(px, py, Theme::TetraNeon, 240);
            Draw::pixelA(px + (int)sinH, py - (int)cosH, Theme::TetraNeon, 160);
        }

        // Tail (forked, animated wag)
        float tailWag = fastSin(f.tailPhase + f.x * 20 + f.y * 20) * 0.4f;
        int tailX = fx - (int)(bodyLen / 2 * cosH);
        int tailY = fy - (int)(bodyLen / 2 * sinH);
        float tailAngle1 = f.heading + M_PI + 0.4f + tailWag;
        float tailAngle2 = f.heading + M_PI - 0.4f + tailWag;
        int tailLen = (int)(size * 0.8f);

        Draw::line(tailX, tailY,
                   tailX + (int)(tailLen * fastCos(tailAngle1)),
                   tailY + (int)(tailLen * fastSin(tailAngle1)),
                   Theme::TetraFin, 180);
        Draw::line(tailX, tailY,
                   tailX + (int)(tailLen * fastCos(tailAngle2)),
                   tailY + (int)(tailLen * fastSin(tailAngle2)),
                   Theme::TetraFin, 180);

        // Eye (small bright dot)
        int eyeX = fx + (int)(bodyLen / 3 * cosH);
        int eyeY = fy + (int)(bodyLen / 3 * sinH);
        Draw::pixelA(eyeX, eyeY, 0xFFFFFF, 220);

        // Update tail phase
        f.tailPhase += TAIL_SPEED * 0.033f;  // ~30fps
    }
}

}  // namespace Tetra
