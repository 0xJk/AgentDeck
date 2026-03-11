#include "crayfish.h"
#include "draw.h"
#include "../theme.h"
#include "config.h"
#include <cmath>

/**
 * Front-facing crayfish — approximation of Android SVG (viewBox 0 0 120 120).
 *
 * DORMANT:  completely still, dropped down, dimmed (alpha 0.4)
 * SITTING:  nearly still on rocks, subtle heartbeat glow only
 * ROUTING:  full animation — claw clap, signal waves, eye flash, antenna wiggle
 * SICK:     desaturated, tilted, drooping claws
 */

constexpr float SVG_VB = 120.0f;
constexpr float HEARTBEAT_PERIOD = 4.0f;

namespace Crayfish {

void init() {}

// Draw filled ellipse
static void fillEllipse(int cx, int cy, int rx, int ry,
                        uint32_t color, uint8_t alpha) {
    for (int dy = -ry; dy <= ry; dy++) {
        float t = (float)dy / (ry + 1);
        int hw = (int)(rx * sqrtf(1.0f - t * t));
        for (int dx = -hw; dx <= hw; dx++) {
            Draw::pixelA(cx + dx, cy + dy, color, alpha);
        }
    }
}

// Draw rounded claw blob (matching Android SVG: compact oval, not long pincer)
// SVG claws are ~20×20 unit rounded shapes that pivot-rotate around attachment point
static void drawClaw(int pivotX, int pivotY, float scale,
                     float side, float angleDeg,
                     uint32_t color, uint8_t alpha) {
    float rad = angleDeg * M_PI / 180.0f;
    float cosA = fastCos(rad);
    float sinA = fastSin(rad);

    // Claw center offset from pivot (SVG: claw center ~12 units outward, ~5 units down)
    float offsetX = side * 12.0f * scale;
    float offsetY = 5.0f * scale;
    // Rotate offset around pivot
    int clawCX = pivotX + (int)(offsetX * cosA - offsetY * sinA);
    int clawCY = pivotY + (int)(offsetX * sinA + offsetY * cosA);

    // Claw size: rounded blob ~18×16 SVG units
    int rx = (int)(9.0f * scale);
    int ry = (int)(8.0f * scale);

    // Draw filled ellipse for claw blob
    fillEllipse(clawCX, clawCY, rx, ry, color, alpha);

    // Small notch/slit at tip to suggest pincer (2px dark line)
    int notchX = clawCX + (int)(side * rx * 0.7f * cosA);
    int notchY = clawCY + (int)(side * rx * 0.7f * sinA);
    int notchLen = (int)(4.0f * scale);
    Draw::line(notchX, notchY - notchLen / 2,
               notchX, notchY + notchLen / 2,
               0x050810, (uint8_t)(alpha * 0.5f));
}

void render(uint16_t* buf, int w, int h, float time, CrayfishState state) {
    if (state == CrayfishState::DORMANT) return;

    // Body size from layout config
    float bodyW = w * Layout::CfWidthFrac;
    float scale = bodyW / SVG_VB;

    int cx = (int)(Layout::CfHomeX * w);
    int baseY;

    uint32_t shellColor = Theme::CrayfishShell;
    uint32_t shellDark = Theme::CrayfishDark;
    uint32_t eyeColor = Theme::CrayfishEye;
    uint8_t alpha = 255;
    float vertBob = 0;
    float clawAngle = 0;
    float antennaWiggleX = 0;
    float antennaWiggleY = 0;

    switch (state) {
        case CrayfishState::SITTING: {
            baseY = (int)(Layout::CfSittingY * h);
            // Nearly still — matches Android's 0.008f factor (imperceptible)
            vertBob = fastSin(time * 0.5f) * bodyW * 0.008f;
            clawAngle = fastSin(time * 0.4f) * 1.5f;
            antennaWiggleX = fastSin(time * 0.8f) * 0.7f * scale;
            antennaWiggleY = fastSin(time * 0.5f) * 0.4f * scale;

            // Heartbeat glow (4s double-pulse) — very subtle
            float cycle = fmodf(time, HEARTBEAT_PERIOD);
            float pulse = 0;
            if (cycle < 0.15f) {
                pulse = fastSin(cycle / 0.15f * M_PI);
            } else if (cycle >= 0.25f && cycle < 0.40f) {
                pulse = fastSin((cycle - 0.25f) / 0.15f * M_PI) * 0.6f;
            }
            if (pulse > 0.01f) {
                int glowR = (int)(bodyW * (0.25f + pulse * 0.08f));
                Draw::circle(cx, baseY, glowR, Theme::CrayfishEye, (uint8_t)(pulse * 20));
            }
            break;
        }

        case CrayfishState::ROUTING: {
            baseY = (int)(Layout::CfRoutingY * h);
            vertBob = fastSin(time * 3.0f) * bodyW * 0.05f;
            // Claw clap ±28°
            float phase = time * 2 * M_PI / 1.2f;
            clawAngle = fastSin(phase) * 28.0f;
            antennaWiggleX = fastSin(time * 7.0f) * 4.0f * scale;
            antennaWiggleY = fastSin(time * 5.0f) * 3.0f * scale;

            // Body color pulse
            float colorPulse = (fastSin(time * 4.0f) * 0.5f + 0.5f) * 0.3f;
            shellColor = lerpColor(Theme::CrayfishShell, Theme::CrayfishBodyLight, colorPulse);
            shellDark = lerpColor(Theme::CrayfishDark, Theme::CrayfishShell, colorPulse);

            // Eye flash
            float eyeFlash = fastSin(time * 2 * M_PI / 0.8f) * 0.5f + 0.5f;
            eyeColor = lerpColor(Theme::CrayfishEye, 0xFFFFFF, eyeFlash * 0.5f);

            // Shell glow
            float glow = fastSin(time * 4.0f) * 0.5f + 0.5f;
            int glowR = (int)(bodyW * (0.4f + glow * 0.15f));
            Draw::circle(cx, baseY, glowR, Theme::CrayfishEye, (uint8_t)(glow * 38));

            // Signal waves (arcs behind creature)
            for (int i = 0; i < 4; i++) {
                float prog = fmodf(time * 2.0f + i * 0.25f, 1.0f);
                int waveR = (int)(bodyW * 0.3f + prog * w * 0.15f);
                uint8_t waveAlpha = (uint8_t)((1.0f - prog) * 90);
                for (int a = 120; a < 240; a += 3) {
                    float rad = a * M_PI / 180.0f;
                    int wx = cx + (int)(fastCos(rad) * waveR);
                    int wy = baseY + (int)(fastSin(rad) * waveR);
                    Draw::pixelA(wx, wy, Theme::CrayfishEye, waveAlpha);
                    Draw::pixelA(wx + 1, wy, Theme::CrayfishEye, waveAlpha / 2);
                }
            }
            break;
        }

        case CrayfishState::SICK: {
            baseY = (int)(Layout::CfSittingY * h) + (int)(bodyW * 0.08f);
            vertBob = fastSin(time * 0.7f) * bodyW * 0.02f;
            alpha = 178;
            shellColor = lerpColor(Theme::CrayfishShell, 0x8B7B7B, 0.55f);
            shellDark = lerpColor(Theme::CrayfishDark, 0x5A4A4A, 0.55f);
            eyeColor = lerpColor(Theme::CrayfishEye, 0x5A4A4A, 0.55f);
            clawAngle = -8.0f + fastSin(time * 0.5f) * 2.0f;
            antennaWiggleX = fastSin(time * 0.3f) * 0.4f * scale;
            antennaWiggleY = 2.0f * scale + fastSin(time * 0.4f) * 0.5f * scale;
            break;
        }

        default:
            return;
    }

    int cy = baseY + (int)vertBob;

    // === Draw body (SVG-like rounded blob) ===
    // Main body: ellipse roughly mapping SVG body shape
    // SVG body: 90 wide × 90 tall centered at (60, 55) in 120×120
    int bodyRX = (int)(45 * scale);  // half-width
    int bodyRY = (int)(42 * scale);  // half-height (slightly shorter than wide)

    // Sick tilt: offset the body
    int tiltOffX = 0;
    if (state == CrayfishState::SICK) {
        tiltOffX = (int)(bodyRX * 0.08f);
    }

    // Body fill with gradient (top lighter, bottom darker)
    for (int dy = -bodyRY; dy <= bodyRY; dy++) {
        float fy = (float)(dy + bodyRY) / (2 * bodyRY);  // 0=top, 1=bottom
        float t = fy;  // gradient factor
        uint32_t rowColor = lerpColor(shellColor, shellDark, t);
        float et = (float)dy / (bodyRY + 1);
        int hw = (int)(bodyRX * sqrtf(1.0f - et * et));
        // Taper top and bottom more for rounded-square blob look
        float taper = 1.0f;
        if (fy < 0.2f) taper = 0.7f + fy * 1.5f;
        else if (fy > 0.85f) taper = 0.7f + (1.0f - fy) * 2.0f;
        hw = (int)(hw * taper);
        for (int dx = -hw; dx <= hw; dx++) {
            Draw::pixelA(cx + dx + tiltOffX, cy + dy, rowColor, alpha);
        }
    }

    // Small leg bumps at bottom (like SVG v10/h10 segments)
    int legY = cy + bodyRY;
    int legW = (int)(5 * scale);
    int legH = (int)(8 * scale);
    int legSpacing = (int)(10 * scale);
    for (int i = 0; i < 2; i++) {
        int lx = cx - legSpacing + i * legSpacing * 2 + tiltOffX;
        for (int dy = 0; dy < legH; dy++) {
            for (int dx = -legW / 2; dx <= legW / 2; dx++) {
                Draw::pixelA(lx + dx, legY + dy, shellDark, alpha);
            }
        }
    }

    // === Claws (SVG: pivot at (20,45) and (100,45) in 120×120 viewbox) ===
    // Left claw pivot: SVG (20,45) → offset from center (60,55) = (-40, -10)
    int lpx = cx - (int)(40 * scale) + tiltOffX;
    int lpy = cy - (int)(10 * scale);
    drawClaw(lpx, lpy, scale, -1.0f, clawAngle, shellColor, alpha);
    // Right claw pivot: SVG (100,45) → offset from center = (+40, -10)
    int rpx = cx + (int)(40 * scale) + tiltOffX;
    int rpy = cy - (int)(10 * scale);
    drawClaw(rpx, rpy, scale, 1.0f, -clawAngle, shellColor, alpha);

    // === Eyes (SVG: at (45,35) and (75,35), radius 6) ===
    int eyeR = (int)(6 * scale);
    int eyeSpacing = (int)(15 * scale);
    int eyeY = cy - (int)(20 * scale);
    // Dark eye base
    Draw::circle(cx - eyeSpacing + tiltOffX, eyeY, eyeR, 0x050810, alpha);
    Draw::circle(cx + eyeSpacing + tiltOffX, eyeY, eyeR, 0x050810, alpha);
    // Teal highlight (smaller, offset up-right like Android)
    int hlR = (int)(2.5f * scale);
    Draw::circle(cx - eyeSpacing + (int)(1 * scale) + tiltOffX, eyeY - (int)(1 * scale),
                 hlR, eyeColor, alpha);
    Draw::circle(cx + eyeSpacing + (int)(1 * scale) + tiltOffX, eyeY - (int)(1 * scale),
                 hlR, eyeColor, alpha);

    // === Antennae (SVG: curved lines from (45,15)→(30,8) and (75,15)→(90,8)) ===
    int antBaseY = eyeY - eyeR;
    int antLen = (int)(15 * scale);
    // Left antenna
    Draw::line(cx - eyeSpacing + tiltOffX + (int)antennaWiggleX,
               antBaseY - (int)antennaWiggleY,
               cx - eyeSpacing - antLen + tiltOffX + (int)(antennaWiggleX * 1.5f),
               antBaseY - antLen + (int)(antennaWiggleY),
               shellColor, (uint8_t)(alpha * 0.8f));
    // Right antenna
    Draw::line(cx + eyeSpacing + tiltOffX - (int)antennaWiggleX,
               antBaseY - (int)antennaWiggleY,
               cx + eyeSpacing + antLen + tiltOffX - (int)(antennaWiggleX * 1.5f),
               antBaseY - antLen + (int)(antennaWiggleY),
               shellColor, (uint8_t)(alpha * 0.8f));
}

}  // namespace Crayfish
