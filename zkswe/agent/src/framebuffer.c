#include "framebuffer.h"
#include "config.h"
#include "font.h"
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/ioctl.h>
#include <linux/fb.h>
#include <unistd.h>
#include <ctype.h>

static int fb_fd = -1;
static uint8_t *fb_mem = NULL;

int fb_init(void) {
    fb_fd = open(FB_DEVICE, O_RDWR);
    if (fb_fd < 0) { perror("open fb0"); return -1; }

    fb_mem = (uint8_t *)mmap(NULL, FB_PAGE_SIZE * 2, PROT_READ | PROT_WRITE,
                              MAP_SHARED, fb_fd, 0);
    if (fb_mem == MAP_FAILED) { perror("mmap fb0"); close(fb_fd); return -1; }

    fb_set_backlight(255);
    return 0;
}

void fb_close(void) {
    if (fb_mem && fb_mem != MAP_FAILED) munmap(fb_mem, FB_PAGE_SIZE * 2);
    if (fb_fd >= 0) close(fb_fd);
    fb_mem = NULL;
    fb_fd = -1;
}

/* Screen(sx,sy) → fb(sy, 959-sx)
 * Write to BOTH pages of the double buffer so the display shows our
 * content regardless of which page the hardware is scanning. */
void fb_set_pixel(int sx, int sy, Color c) {
    int fx = sy;
    int fy = (FB_H - 1) - sx;
    if (fx < 0 || fx >= FB_W || fy < 0 || fy >= FB_H) return;
    int off = (fy * FB_W + fx) * FB_BPP;
    /* Page 0 */
    fb_mem[off]   = c.b;
    fb_mem[off+1] = c.g;
    fb_mem[off+2] = c.r;
    fb_mem[off+3] = c.a;
    /* Page 1 */
    fb_mem[FB_PAGE_SIZE + off]   = c.b;
    fb_mem[FB_PAGE_SIZE + off+1] = c.g;
    fb_mem[FB_PAGE_SIZE + off+2] = c.r;
    fb_mem[FB_PAGE_SIZE + off+3] = c.a;
}

void fb_clear(Color c) {
    fb_fill_rect(0, 0, SCREEN_W, SCREEN_H, c);
}

void fb_fill_rect(int x1, int y1, int x2, int y2, Color c) {
    if (x1 < 0) x1 = 0; if (y1 < 0) y1 = 0;
    if (x2 > SCREEN_W) x2 = SCREEN_W; if (y2 > SCREEN_H) y2 = SCREEN_H;
    for (int sy = y1; sy < y2; sy++)
        for (int sx = x1; sx < x2; sx++)
            fb_set_pixel(sx, sy, c);
}

void fb_draw_text(int x, int y, const char *text, int scale, Color c) {
    int cx = x;
    for (; *text; text++) {
        char ch = tolower((unsigned char)*text);
        const uint8_t *glyph = font_get(ch);
        if (!glyph) { cx += 4 * scale; continue; }
        for (int dy = 0; dy < 5; dy++)
            for (int dx = 0; dx < 3; dx++)
                if (glyph[dy] & (1 << (2 - dx)))
                    for (int ssy = 0; ssy < scale; ssy++)
                        for (int ssx = 0; ssx < scale; ssx++)
                            fb_set_pixel(cx + dx*scale + ssx, y + dy*scale + ssy, c);
        cx += 4 * scale;
    }
}

void fb_draw_text_centered(int cx, int cy, const char *text, int scale, Color c) {
    int len = (int)strlen(text);
    int tw = len * 4 * scale;
    int th = 5 * scale;
    fb_draw_text(cx - tw/2, cy - th/2, text, scale, c);
}

void fb_draw_gauge(int x, int y, int w, int h, int percent, Color bar, Color bg) {
    fb_fill_rect(x, y, x+w, y+h, bg);
    int filled = w * (percent < 0 ? 0 : percent > 100 ? 100 : percent) / 100;
    fb_fill_rect(x, y, x+filled, y+h, bar);
}

void fb_set_backlight(int brightness) {
    FILE *f;
    f = fopen(BL_POWER_PATH, "w");
    if (f) { fprintf(f, "0"); fclose(f); }
    f = fopen(BL_BRIGHT_PATH, "w");
    if (f) { fprintf(f, "%d", brightness); fclose(f); }
}
