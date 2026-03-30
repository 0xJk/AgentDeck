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
#include <stdarg.h>

static int fb_fd = -1;
static uint8_t *fb_mem = NULL;
static uint8_t *canvas_mem = NULL;
static const char *boot_log_path = "/data/agentdeck-boot.log";

typedef unsigned int       MI_U32;
typedef unsigned short     MI_U16;
typedef unsigned long long MI_PHY;
typedef signed int         MI_S32;
typedef unsigned char      MI_BOOL;

static MI_PHY fb_cpu_base = 0;

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

typedef struct {
    MI_U32 u32Dummy[24];
} MI_GFX_Opt_t;

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
    void *h_disp;
    void *h_pnl;
    void *h_vo;
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
    MI_GFX_Opt_t opt;
} mi = {0};

/* /dev/mem direct bus access — works with static musl (no dlopen needed) */
static uint8_t *devmem_page0 = NULL;
static int present_log_count = 0;

static void boot_log(const char *fmt, ...) {
    FILE *f = fopen(boot_log_path, "a");
    if (!f) return;
    va_list ap;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
    fclose(f);
}

static MI_PHY fb_guess_bus_alias(MI_PHY cpu_addr) {
    /* On D200H the visible MI_GFX target has been observed as fb smem_start
     * plus a 0x20000000 bus alias offset. Example:
     *   0x30101000 -> 0x50101000
     * Newer boots can report a shifted fb base, so derive the alias instead
     * of pinning a single absolute address. */
    if (cpu_addr >= 0x30000000ULL && cpu_addr < 0x40000000ULL) {
        return cpu_addr + 0x20000000ULL;
    }
    return cpu_addr;
}

#define MAX_BUFFERS 8
static uint8_t *mapped_buffers[MAX_BUFFERS] = {NULL};
static int mapped_buffer_count = 0;

static void fb_hunt_buffers(void) {
    FILE *f = fopen("/proc/mi_sys/mi_sys_buf_mgr", "r");
    if (!f) return;
    char line[256];
    int fd = open("/dev/mem", O_RDWR | O_SYNC);
    if (fd < 0) { fclose(f); return; }

    boot_log("fb_hunt_buffers: scanning for 2MB display buffers...");
    while (fgets(line, sizeof(line), f)) {
        /* Example: [BUF_HANDLE: 0] phyAddr: 0x30121000 size: 2073600 refCnt: 1 */
        if (strstr(line, "phyAddr") && strstr(line, "size: 2073600")) {
            char *p = strstr(line, "phyAddr: ");
            if (p) {
                MI_PHY phy = strtoull(p + 9, NULL, 0);
                if (phy == 0) continue;
                
                /* We try both direct and +0x20000000 alias to be sure */
                MI_PHY targets[2] = { phy, fb_guess_bus_alias(phy) };
                for (int i = 0; i < 2; i++) {
                    if (mapped_buffer_count >= MAX_BUFFERS) break;
                    
                    /* Skip if already mapped (basic check) */
                    int skip = 0;
                    for (int j = 0; j < mapped_buffer_count; j++) {
                        /* We don't have the original phy stored easily, but mmap addr check is fine */
                    }

                    uint8_t *ptr = (uint8_t *)mmap(NULL, FB_PAGE_SIZE, PROT_READ | PROT_WRITE,
                                                   MAP_SHARED, fd, targets[i]);
                    if (ptr != MAP_FAILED) {
                        mapped_buffers[mapped_buffer_count++] = ptr;
                        boot_log("fb_hunt: mapped win at 0x%llx (idx %d)", (unsigned long long)targets[i], mapped_buffer_count-1);
                    }
                }
            }
        }
    }
    close(fd);
    fclose(f);
    boot_log("fb_hunt: complete, found %d buffer targets", mapped_buffer_count);
}

static int fb_try_revive_mstar_disp(void) {
#ifdef __musl__
    /* dlopen not supported in static musl build */
    return -1;
#else
    if (!mi.h_disp) {
        mi.h_disp = dlopen("libmi_disp.so", RTLD_NOW | RTLD_GLOBAL);
        if (!mi.h_disp) {
            boot_log("revive: dlopen libmi_disp failed: %s", dlerror());
            return -1;
        }
    }
    if (!mi.h_pnl) {
        mi.h_pnl = dlopen("libmi_pnl.so", RTLD_NOW | RTLD_GLOBAL);
        if (!mi.h_pnl) {
            boot_log("revive: dlopen libmi_pnl failed: %s", dlerror());
        }
    }
    if (!mi.h_vo) {
        mi.h_vo = dlopen("libmi_vo.so", RTLD_NOW | RTLD_GLOBAL);
        if (!mi.h_vo) {
            boot_log("revive: dlopen libmi_vo failed: %s", dlerror());
        }
    }
    if (!mi.h_sys) {
        mi.h_sys = dlopen("libmi_sys.so", RTLD_NOW | RTLD_GLOBAL);
        if (!mi.h_sys) {
            boot_log("revive: dlopen libmi_sys failed: %s", dlerror());
            return -1;
        }
    }

    typedef MI_S32 (*fn_MI_SYS_Init)(void);
    typedef MI_S32 (*fn_MI_DISP_u32)(MI_U32);
    typedef MI_S32 (*fn_MI_DISP_u32_bool)(MI_U32, MI_BOOL);
    typedef MI_S32 (*fn_MI_DISP_u32_u32)(MI_U32, MI_U32);
    typedef MI_S32 (*fn_MI_PNL_u32)(MI_U32);
    typedef MI_S32 (*fn_MI_PNL_u32_u16)(MI_U32, MI_U16);
    typedef MI_S32 (*fn_MI_VO_u32)(MI_U32);

    fn_MI_SYS_Init mi_sys_init = (fn_MI_SYS_Init)dlsym(mi.h_sys, "MI_SYS_Init");
    fn_MI_DISP_u32 mi_disp_enable = (fn_MI_DISP_u32)dlsym(mi.h_disp, "MI_DISP_Enable");
    fn_MI_DISP_u32 mi_disp_enable_layer = (fn_MI_DISP_u32)dlsym(mi.h_disp, "MI_DISP_EnableVideoLayer");
    fn_MI_DISP_u32_bool mi_disp_show_layer = (fn_MI_DISP_u32_bool)dlsym(mi.h_disp, "MI_DISP_ShowVideoLayer");
    fn_MI_DISP_u32 mi_disp_enable_port = (fn_MI_DISP_u32)dlsym(mi.h_disp, "MI_DISP_EnableInputPort");
    fn_MI_DISP_u32_u32 mi_disp_set_alpha = (fn_MI_DISP_u32_u32)dlsym(mi.h_disp, "MI_DISP_SetVideoLayerGlobalAlpha");

    fn_MI_PNL_u32 mi_pnl_open = mi.h_pnl ? (fn_MI_PNL_u32)dlsym(mi.h_pnl, "MI_PNL_Open") : NULL;
    fn_MI_PNL_u32_u16 mi_pnl_set_power = mi.h_pnl ? (fn_MI_PNL_u32_u16)dlsym(mi.h_pnl, "MI_PNL_SetPower") : NULL;
    fn_MI_PNL_u32_u16 mi_pnl_set_bl = mi.h_pnl ? (fn_MI_PNL_u32_u16)dlsym(mi.h_pnl, "MI_PNL_SetBackLightLevel") : NULL;

    fn_MI_VO_u32 mi_vo_enable_layer = mi.h_vo ? (fn_MI_VO_u32)dlsym(mi.h_vo, "MI_VO_EnableVideoLayer") : NULL;
    fn_MI_VO_u32 mi_vo_disable_layer = mi.h_vo ? (fn_MI_VO_u32)dlsym(mi.h_vo, "MI_VO_DisableVideoLayer") : NULL;
    fn_MI_DISP_u32_u32 mi_vo_set_priority = mi.h_vo ? (fn_MI_DISP_u32_u32)dlsym(mi.h_vo, "MI_VO_SetVideoLayerPriority") : NULL;

    if (mi_sys_init) mi_sys_init();
    
    if (mi_pnl_open) {
        MI_S32 ret = mi_pnl_open(0);
        boot_log("revive: MI_PNL_Open(0) ret=%d", ret);
    }
    if (mi_pnl_set_power) {
        /* Force Panel Power On (1) */
        MI_S32 ret = mi_pnl_set_power(0, 1);
        boot_log("revive: MI_PNL_SetPower(0, 1) ret=%d", ret);
    }
    if (mi_pnl_set_bl) {
        /* Force Backlight 255 */
        MI_S32 ret = mi_pnl_set_bl(0, 255);
        boot_log("revive: MI_PNL_SetBackLightLevel(0, 255) ret=%d", ret);
    }

    if (mi_vo_disable_layer) {
        /* Disable higher-priority Masking Layer 1 */
        MI_S32 ret = mi_vo_disable_layer(1);
        boot_log("revive: MI_VO_DisableVideoLayer(1) ret=%d", ret);
    }
    if (mi_vo_set_priority) {
        /* Move Hijacked Layer 0 to 10 (Highest) */
        MI_S32 ret = mi_vo_set_priority(0, 10);
        boot_log("revive: MI_VO_SetVideoLayerPriority(0, 10) ret=%d", ret);
    }
    if (mi_vo_enable_layer) {
        MI_S32 ret = mi_vo_enable_layer(0);
        boot_log("revive: MI_VO_EnableVideoLayer(0) ret=%d", ret);
    }

    if (mi_disp_enable) {
        MI_S32 ret = mi_disp_enable(0);
        boot_log("revive: MI_DISP_Enable(0) ret=%d", ret);
    }
    if (mi_disp_enable_layer) {
        MI_S32 ret = mi_disp_enable_layer(0);
        boot_log("revive: MI_DISP_EnableVideoLayer(0) ret=%d", ret);
    }
    if (mi_disp_show_layer) {
        MI_S32 ret = mi_disp_show_layer(0, 1);
        boot_log("revive: MI_DISP_ShowVideoLayer(0, 1) ret=%d", ret);
    }
    if (mi_disp_set_alpha) {
        /* Force Alpha to 255 (Opaque) */
        MI_S32 ret = mi_disp_set_alpha(0, 255);
        boot_log("revive: MI_DISP_SetVideoLayerGlobalAlpha(0, 255) ret=%d", ret);
    }
    if (mi_disp_enable_port) {
        MI_S32 ret = mi_disp_enable_port(0);
        boot_log("revive: MI_DISP_EnableInputPort(0) ret=%d", ret);
    }

    return 0;
#endif
}

int fb_init(void) {
    struct fb_fix_screeninfo fix;
    struct fb_var_screeninfo var;
    unlink(boot_log_path);
    boot_log("fb_init: start (v1.3_multi_hijack)");

    fb_fd = open(FB_DEVICE, O_RDWR);
    if (fb_fd < 0) {
        perror("open fb0");
        boot_log("fb_init: open fb0 failed");
    }

    if (fb_fd >= 0 && ioctl(fb_fd, FBIOGET_FSCREENINFO, &fix) == 0) {
        fb_cpu_base = (MI_PHY)fix.smem_start;
        boot_log("fb_init: smem_start=0x%llx", (unsigned long long)fb_cpu_base);
    }

    /* Force resolution and format via FBIOPUT_VSCREENINFO if possible */
    if (fb_fd >= 0 && ioctl(fb_fd, FBIOGET_VSCREENINFO, &var) == 0) {
        var.xres = FB_W; var.yres = FB_H;
        var.xres_virtual = FB_W; var.yres_virtual = FB_H * 2;
        var.bits_per_pixel = 32;
        var.activate = FB_ACTIVATE_NOW | FB_ACTIVATE_FORCE;
        ioctl(fb_fd, FBIOPUT_VSCREENINFO, &var);
    }

    /* REVIVE THE ENGINE (calls MI SDK Enable/Show) */
    fb_try_revive_mstar_disp();

    /* DYNAMIC BUFFER HUNTING */
    fb_hunt_buffers();

    /* Fallback to standard fbdev mmap if no buffers found /dev/mem */
    if (mapped_buffer_count == 0 && fb_fd >= 0) {
        fb_mem = (uint8_t *)mmap(NULL, FB_PAGE_SIZE * 2, PROT_READ | PROT_WRITE,
                                  MAP_SHARED, fb_fd, 0);
        if (fb_mem != MAP_FAILED) {
            mapped_buffers[mapped_buffer_count++] = fb_mem;
            mapped_buffers[mapped_buffer_count++] = fb_mem + FB_PAGE_SIZE;
            boot_log("fb_init: fallback to fb0 mmap (2 pages)");
        }
    }

    canvas_mem = (uint8_t *)calloc(1, FB_PAGE_SIZE);
    if (!canvas_mem) {
        boot_log("fb_init: calloc canvas failed");
        return -1;
    }

    fb_set_backlight(255);
    boot_log("fb_init: complete (%d buffers active)", mapped_buffer_count);
    return 0;
}

void fb_close(void) {
    if (mi.active && mi.gfx_close) mi.gfx_close();
    if (mi.h_gfx) dlclose(mi.h_gfx);
    if (mi.h_vo) dlclose(mi.h_vo);
    if (mi.h_sys) dlclose(mi.h_sys);
    if (mi.h_disp) dlclose(mi.h_disp);
    
    for (int i = 0; i < mapped_buffer_count; i++) {
        if (mapped_buffers[i] && mapped_buffers[i] != fb_mem) {
            munmap(mapped_buffers[i], FB_PAGE_SIZE);
        }
    }
    if (fb_mem && fb_mem != MAP_FAILED) munmap(fb_mem, FB_PAGE_SIZE * 2);

    free(canvas_mem);
    if (fb_fd >= 0) close(fb_fd);
    memset(&mi, 0, sizeof(mi));
    canvas_mem = NULL; fb_mem = NULL; fb_fd = -1;
    mapped_buffer_count = 0;
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
    if (!canvas_mem || mapped_buffer_count == 0) return;

    /* Write to EVERY discovered buffer to survive page flips */
    for (int i = 0; i < mapped_buffer_count; i++) {
        if (mapped_buffers[i]) {
            memcpy(mapped_buffers[i], canvas_mem, FB_PAGE_SIZE);
        }
    }

    /* Force hardware sync via FBIOPAN_DISPLAY if fb0 is available */
    if (fb_fd >= 0) {
        struct fb_var_screeninfo var;
        if (ioctl(fb_fd, FBIOGET_VSCREENINFO, &var) == 0) {
            ioctl(fb_fd, FBIOPAN_DISPLAY, &var);
        }
    }
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
