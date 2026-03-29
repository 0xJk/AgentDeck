#pragma once

/* === Screen === */
#define SCREEN_W     960   /* logical width (after 90° rotation) */
#define SCREEN_H     540   /* logical height */
#define FB_W         540   /* framebuffer physical width */
#define FB_H         960   /* framebuffer physical height */
#define FB_BPP       4     /* BGRA32 */
#define FB_PAGE_SIZE (FB_W * FB_H * FB_BPP)

/* === Key Grid: 3 rows × 5 cols, row2 col3+4 merged = 14 keys === */
#define KEY_COLS     5
#define KEY_ROWS     3
#define KEY_COUNT    14
#define COL_W        (SCREEN_W / KEY_COLS)  /* 192 */
#define ROW_H        (SCREEN_H / KEY_ROWS)  /* 180 */
#define KEY_GAP      3

/* === Network === */
#define DAEMON_HOST  "127.0.0.1"
#define DAEMON_PORT  9120
#define WS_RECONNECT_MIN_MS  1000
#define WS_RECONNECT_MAX_MS  8000

/* === Button input via HID gadget === */
/* MCU scans 14-key matrix internally, sends HID reports to /dev/hidg1 */
#define BUTTON_SCAN_MS  20
#define DEBOUNCE_MS     100

/* === Display === */
#define BL_POWER_PATH    "/sys/class/backlight/soc:backlight/bl_power"
#define BL_BRIGHT_PATH   "/sys/class/backlight/soc:backlight/brightness"
#define FB_DEVICE        "/dev/fb0"
#define RENDER_FPS       15
#define RENDER_MS        (1000 / RENDER_FPS)
