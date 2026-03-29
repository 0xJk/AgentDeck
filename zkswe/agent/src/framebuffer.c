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
#include <stdlib.h>
#include <dlfcn.h>

static int fb_fd = -1;
static uint8_t *fb_mem = NULL;
static uint8_t *canvas_mem = NULL;

typedef unsigned int       MI_U32;
typedef unsigned short     MI_U16;
typedef unsigned long long MI_PHY;
typedef signed int         MI_S32;
typedef unsigned char      MI_BOOL;

typedef struct {
    MI_PHY phyAddr;
    MI_U32 eColorFmt;
    MI_U32 u32Width;
    MI_U32 u32Height;
    MI_U32 u32Stride;
} MI_GFX_Surface_t;

typedef struct {
    MI_S32 s32Xpos;
    MI_S32 s32Ypos;
    MI_U32 u32Width;
    MI_U32 u32Height;
} MI_GFX_Rect_t;

typedef MI_S32 (*fn_MI_SYS_Init)(void);
typedef MI_S32 (*fn_MI_GFX_Open)(void);
typedef MI_S32 (*fn_MI_GFX_Close)(void);
typedef MI_S32 (*fn_MI_GFX_BitBlit)(
    MI_GFX_Surface_t *pstSrc,
    MI_GFX_Rect_t *pstSrcRect,
    MI_GFX_Surface_t *pstDst,
    MI_GFX_Rect_t *pstDstRect,
    void *pstOpt,
    MI_U16 *pu16Fence);
typedef MI_S32 (*fn_MI_GFX_WaitAllDone)(MI_BOOL bBlock, MI_U32 u32TimeoutMs);

static struct {
    void *h_sys;
    void *h_gfx;
    fn_MI_SYS_Init sys_init;
    fn_MI_GFX_Open gfx_open;
    fn_MI_GFX_Close gfx_close;
    fn_MI_GFX_BitBlit gfx_bitblit;
    fn_MI_GFX_WaitAllDone gfx_wait_all_done;
    int active;
    MI_PHY bus_base;
    MI_U32 page_size;
    MI_GFX_Surface_t src;
    MI_GFX_Surface_t dst;
    MI_GFX_Rect_t rect;
} mi = {0};

static int fb_try_init_mi_backend(void) {
    mi.h_sys = dlopen("libmi_sys.so", RTLD_NOW | RTLD_GLOBAL);
    mi.h_gfx = dlopen("libmi_gfx.so", RTLD_NOW | RTLD_GLOBAL);
    if (!mi.h_sys || !mi.h_gfx) return -1;

    mi.sys_init = (fn_MI_SYS_Init)dlsym(mi.h_sys, "MI_SYS_Init");
    mi.gfx_open = (fn_MI_GFX_Open)dlsym(mi.h_gfx, "MI_GFX_Open");
    mi.gfx_close = (fn_MI_GFX_Close)dlsym(mi.h_gfx, "MI_GFX_Close");
    mi.gfx_bitblit = (fn_MI_GFX_BitBlit)dlsym(mi.h_gfx, "MI_GFX_BitBlit");
    mi.gfx_wait_all_done = (fn_MI_GFX_WaitAllDone)dlsym(mi.h_gfx, "MI_GFX_WaitAllDone");
    if (!mi.gfx_open || !mi.gfx_bitblit || !mi.gfx_wait_all_done) return -1;

    if (mi.sys_init && mi.sys_init() != 0) return -1;
    if (mi.gfx_open() != 0) return -1;

    mi.bus_base = 0x50101000ULL;
    mi.page_size = FB_PAGE_SIZE;
    mi.src.phyAddr = mi.bus_base + mi.page_size;
    mi.src.eColorFmt = 11; /* E_MI_GFX_FMT_ARGB8888 */
    mi.src.u32Width = FB_W;
    mi.src.u32Height = FB_H;
    mi.src.u32Stride = FB_W * FB_BPP;
    mi.dst = mi.src;
    mi.dst.phyAddr = mi.bus_base;

    mi.rect.s32Xpos = 0;
    mi.rect.s32Ypos = 0;
    mi.rect.u32Width = FB_W;
    mi.rect.u32Height = FB_H;

    mi.active = 1;
    return 0;
}

int fb_init(void) {
    fb_fd = open(FB_DEVICE, O_RDWR);
    if (fb_fd < 0) { perror("open fb0"); return -1; }

    fb_mem = (uint8_t *)mmap(NULL, FB_PAGE_SIZE * 2, PROT_READ | PROT_WRITE,
                              MAP_SHARED, fb_fd, 0);
    if (fb_mem == MAP_FAILED) { perror("mmap fb0"); close(fb_fd); return -1; }

    canvas_mem = (uint8_t *)calloc(1, FB_PAGE_SIZE);
    if (!canvas_mem) {
        perror("calloc canvas");
        munmap(fb_mem, FB_PAGE_SIZE * 2);
        close(fb_fd);
        fb_mem = NULL;
        fb_fd = -1;
        return -1;
    }

    fb_try_init_mi_backend();
    fb_set_backlight(255);
    return 0;
}

void fb_close(void) {
    if (mi.active && mi.gfx_close) mi.gfx_close();
    if (mi.h_gfx) dlclose(mi.h_gfx);
    if (mi.h_sys) dlclose(mi.h_sys);
    free(canvas_mem);
    if (fb_mem && fb_mem != MAP_FAILED) munmap(fb_mem, FB_PAGE_SIZE * 2);
    if (fb_fd >= 0) close(fb_fd);
    memset(&mi, 0, sizeof(mi));
    canvas_mem = NULL;
    fb_mem = NULL;
    fb_fd = -1;
}

/* Screen(sx,sy) → fb(sy, 959-sx)
 * Write to BOTH pages of the double buffer so the display shows our
 * content regardless of which page the hardware is scanning. */
void fb_set_pixel(int sx, int sy, Color c) {
    int fx = sy;
    int fy = (FB_H - 1) - sx;
    if (!canvas_mem || fx < 0 || fx >= FB_W || fy < 0 || fy >= FB_H) return;
    int off = (fy * FB_W + fx) * FB_BPP;
    canvas_mem[off]   = c.b;
    canvas_mem[off+1] = c.g;
    canvas_mem[off+2] = c.r;
    canvas_mem[off+3] = c.a;
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

void fb_present(void) {
    if (!canvas_mem || !fb_mem || fb_mem == MAP_FAILED) return;
    if (mi.active) {
        MI_U16 fence = 0;
        memcpy(fb_mem + FB_PAGE_SIZE, canvas_mem, FB_PAGE_SIZE);
        if (mi.gfx_bitblit(&mi.src, &mi.rect, &mi.dst, &mi.rect, NULL, &fence) == 0) {
            mi.gfx_wait_all_done(1, 1000);
            return;
        }
        mi.active = 0;
    }
    memcpy(fb_mem, canvas_mem, FB_PAGE_SIZE);
    memcpy(fb_mem + FB_PAGE_SIZE, canvas_mem, FB_PAGE_SIZE);
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
