#include "dashboard.h"
#include "framebuffer.h"
#include "config.h"
#include <string.h>
#include <stdio.h>

/* Theme colors */
static const Color C_BG        = {20, 20, 25, 255};
static const Color C_IDLE      = {60, 50, 40, 255};
static const Color C_PROC      = {160, 80, 20, 255};
static const Color C_AWAIT     = {30, 140, 200, 255};
static const Color C_ERR       = {40, 40, 180, 255};
static const Color C_TEXT      = {220, 220, 220, 255};
static const Color C_DIM       = {120, 120, 120, 255};
static const Color C_ACCENT    = {200, 140, 40, 255};
static const Color C_GREEN     = {60, 180, 60, 255};
static const Color C_BAR_BG    = {50, 50, 55, 255};
static const Color C_BAR_5H    = {180, 160, 40, 255};
static const Color C_BAR_7D    = {160, 80, 40, 255};

static Color state_color(const char *state) {
    if (strcmp(state, "PROCESSING") == 0) return C_PROC;
    if (strncmp(state, "AWAITING", 8) == 0) return C_AWAIT;
    if (strcmp(state, "ERROR") == 0) return C_ERR;
    return C_IDLE;
}

/* Key position helper */
static void key_rect(int col, int row, int colSpan, int *x1, int *y1, int *x2, int *y2) {
    *x1 = col * COL_W + KEY_GAP;
    *y1 = row * ROW_H + KEY_GAP;
    *x2 = (col + colSpan) * COL_W - KEY_GAP;
    *y2 = (row + 1) * ROW_H - KEY_GAP;
}

void dashboard_init(void) { /* nothing for now */ }

void dashboard_render(const DashState *s) {
    fb_clear(C_BG);

    int x1, y1, x2, y2, cx, cy;
    char buf[32];

    /* --- Row 0 --- */

    /* Key 0: MODE */
    key_rect(0, 0, 1, &x1, &y1, &x2, &y2);
    fb_fill_rect(x1, y1, x2, y2, C_IDLE);
    cx = (x1+x2)/2; cy = (y1+y2)/2;
    fb_draw_text_centered(cx, cy-16, "mode", 3, C_DIM);
    fb_draw_text_centered(cx, cy+10, s->mode, 3, C_TEXT);

    /* Key 1: SESSION */
    key_rect(1, 0, 1, &x1, &y1, &x2, &y2);
    fb_fill_rect(x1, y1, x2, y2, state_color(s->state));
    cx = (x1+x2)/2; cy = (y1+y2)/2;
    fb_draw_text_centered(cx, cy-20, s->projectName, 3, C_TEXT);
    fb_draw_text_centered(cx, cy+5, s->state, 2, C_DIM);

    /* Key 2: USAGE */
    key_rect(2, 0, 1, &x1, &y1, &x2, &y2);
    fb_fill_rect(x1, y1, x2, y2, C_IDLE);
    cx = (x1+x2)/2; cy = (y1+y2)/2;
    fb_draw_text_centered(cx, cy, "usage", 3, C_DIM);

    /* Key 3-4: Quick Actions (options) */
    for (int i = 0; i < 2; i++) {
        key_rect(3+i, 0, 1, &x1, &y1, &x2, &y2);
        cx = (x1+x2)/2; cy = (y1+y2)/2;
        if (i < s->optionCount && s->options[i][0]) {
            fb_fill_rect(x1, y1, x2, y2, C_ACCENT);
            fb_draw_text_centered(cx, cy, s->options[i], 3, C_TEXT);
        } else {
            fb_fill_rect(x1, y1, x2, y2, C_IDLE);
            snprintf(buf, sizeof(buf), "qa %d", i+1);
            fb_draw_text_centered(cx, cy, buf, 2, C_DIM);
        }
    }

    /* --- Row 1 --- */

    /* Key 5-6: Quick Actions 3-4 */
    for (int i = 0; i < 2; i++) {
        key_rect(i, 1, 1, &x1, &y1, &x2, &y2);
        cx = (x1+x2)/2; cy = (y1+y2)/2;
        if (i+2 < s->optionCount && s->options[i+2][0]) {
            fb_fill_rect(x1, y1, x2, y2, C_ACCENT);
            fb_draw_text_centered(cx, cy, s->options[i+2], 3, C_TEXT);
        } else {
            fb_fill_rect(x1, y1, x2, y2, C_IDLE);
            snprintf(buf, sizeof(buf), "qa %d", i+3);
            fb_draw_text_centered(cx, cy, buf, 2, C_DIM);
        }
    }

    /* Key 7: MODEL */
    key_rect(2, 1, 1, &x1, &y1, &x2, &y2);
    fb_fill_rect(x1, y1, x2, y2, C_IDLE);
    cx = (x1+x2)/2; cy = (y1+y2)/2;
    fb_draw_text_centered(cx, cy-12, "model", 2, C_DIM);
    fb_draw_text_centered(cx, cy+8, s->modelName, 3, C_TEXT);

    /* Key 8: 5H rate */
    key_rect(3, 1, 1, &x1, &y1, &x2, &y2);
    fb_fill_rect(x1, y1, x2, y2, C_IDLE);
    cx = (x1+x2)/2;
    fb_draw_text_centered(cx, y1+20, "5h", 2, C_DIM);
    fb_draw_gauge(x1+10, (y1+y2)/2-4, x2-x1-20, 12, s->fiveHourPercent, C_BAR_5H, C_BAR_BG);
    snprintf(buf, sizeof(buf), "%d%%", s->fiveHourPercent);
    fb_draw_text_centered(cx, y2-25, buf, 3, C_TEXT);

    /* Key 9: 7D rate */
    key_rect(4, 1, 1, &x1, &y1, &x2, &y2);
    fb_fill_rect(x1, y1, x2, y2, C_IDLE);
    cx = (x1+x2)/2;
    fb_draw_text_centered(cx, y1+20, "7d", 2, C_DIM);
    fb_draw_gauge(x1+10, (y1+y2)/2-4, x2-x1-20, 12, s->sevenDayPercent, C_BAR_7D, C_BAR_BG);
    snprintf(buf, sizeof(buf), "%d%%", s->sevenDayPercent);
    fb_draw_text_centered(cx, y2-25, buf, 3, C_TEXT);

    /* --- Row 2 --- */

    /* Key 10: STOP */
    key_rect(0, 2, 1, &x1, &y1, &x2, &y2);
    int is_proc = strcmp(s->state, "PROCESSING") == 0;
    fb_fill_rect(x1, y1, x2, y2, is_proc ? C_ERR : C_IDLE);
    cx = (x1+x2)/2; cy = (y1+y2)/2;
    fb_draw_text_centered(cx, cy, "stop", 3, is_proc ? C_TEXT : C_DIM);

    /* Key 11: TOKENS */
    key_rect(1, 2, 1, &x1, &y1, &x2, &y2);
    fb_fill_rect(x1, y1, x2, y2, C_IDLE);
    cx = (x1+x2)/2; cy = (y1+y2)/2;
    fb_draw_text_centered(cx, cy-12, "tokens", 2, C_DIM);
    if (s->totalTokens >= 1000)
        snprintf(buf, sizeof(buf), "%dk", s->totalTokens / 1000);
    else
        snprintf(buf, sizeof(buf), "%d", s->totalTokens);
    fb_draw_text_centered(cx, cy+10, buf, 3, C_TEXT);

    /* Key 12: COST */
    key_rect(2, 2, 1, &x1, &y1, &x2, &y2);
    fb_fill_rect(x1, y1, x2, y2, C_IDLE);
    cx = (x1+x2)/2; cy = (y1+y2)/2;
    fb_draw_text_centered(cx, cy-12, "cost", 2, C_DIM);
    snprintf(buf, sizeof(buf), "$%.2f", s->totalCost);
    fb_draw_text_centered(cx, cy+10, buf, 3, C_GREEN);

    /* Key 13: INFO (merged col3+4) */
    key_rect(3, 2, 2, &x1, &y1, &x2, &y2);
    fb_fill_rect(x1, y1, x2, y2, C_IDLE);
    cx = (x1+x2)/2; cy = (y1+y2)/2;
    if (s->currentTool[0]) {
        fb_draw_text_centered(cx, cy-12, "tool", 2, C_DIM);
        fb_draw_text_centered(cx, cy+10, s->currentTool, 2, C_TEXT);
    } else {
        fb_draw_text_centered(cx, cy-12, s->agentType, 2, C_DIM);
        fb_draw_text_centered(cx, cy+10, "agentdeck", 3, C_ACCENT);
    }
}
