/*
 * D200H display probe tool.
 *
 * Current best hypothesis:
 * - /dev/fb0 writes succeed but remain hidden behind zkgui's MI_GFX path
 * - MI_SYS DISP GetBuf/PutBuf also succeeds but targets a layer that is not visible
 * - zkgui likely renders into the visible layer using MI_GFX
 *
 * This tool now supports three on-device probes:
 *   1. DISP buffer submission (`--disp`)
 *   2. MI_GFX fill against a DISP-acquired surface (`--gfx`)
 *   3. /proc maps inspection for zkgui/zkdisplay (`--maps`)
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <linux/fb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

typedef unsigned char      MI_U8;
typedef unsigned short     MI_U16;
typedef unsigned int       MI_U32;
typedef unsigned long long MI_U64;
typedef signed int         MI_S32;
typedef signed short       MI_S16;
typedef unsigned long long MI_PHY;
typedef unsigned char      MI_BOOL;
typedef MI_S32             MI_SYS_BUF_HANDLE;

typedef enum {
    E_MI_MODULE_ID_DISP = 15,
    E_MI_MODULE_ID_FB = 10,
} MI_ModuleId_e;

typedef enum {
    E_MI_SYS_PIXEL_FRAME_YUV422_YUYV = 0,
    E_MI_SYS_PIXEL_FRAME_ARGB8888 = 1,
    E_MI_SYS_PIXEL_FRAME_ABGR8888 = 2,
    E_MI_SYS_PIXEL_FRAME_BGRA8888 = 3,
    E_MI_SYS_PIXEL_FRAME_RGB565 = 4,
} MI_SYS_PixelFormat_e;

typedef enum {
    E_MI_SYS_COMPRESS_MODE_NONE = 0,
} MI_SYS_CompressMode_e;

typedef enum {
    E_MI_SYS_FRAME_SCAN_MODE_PROGRESSIVE = 0,
} MI_SYS_FrameScanMode_e;

typedef enum {
    E_MI_SYS_FIELDTYPE_NONE = 0,
} MI_SYS_FieldType_e;

typedef enum {
    E_MI_SYS_FRAME_TILE_MODE_NONE = 0,
} MI_SYS_FrameTileMode_e;

typedef enum {
    REALTIME_FRAME_DATA = 0,
} MI_SYS_FrameData_PhySignalType;

typedef enum {
    E_MI_SYS_BUFDATA_RAW = 0,
    E_MI_SYS_BUFDATA_FRAME = 1,
} MI_SYS_BufDataType_e;

typedef struct {
    MI_ModuleId_e eModId;
    MI_U32 u32DevId;
    MI_U32 u32ChnId;
    MI_U32 u32PortId;
} MI_SYS_ChnPort_t;

typedef struct {
    MI_U16 u16X;
    MI_U16 u16Y;
    MI_U16 u16Width;
    MI_U16 u16Height;
} MI_SYS_WindowRect_t;

typedef struct {
    MI_U16 u16BufHAlignment;
    MI_U16 u16BufVAlignment;
    MI_U16 u16BufChromaAlignment;
    MI_BOOL bClearPadding;
} MI_SYS_FrameBufExtraConfig_t;

typedef struct {
    MI_U16 u16Width;
    MI_U16 u16Height;
    MI_SYS_FrameScanMode_e eFrameScanMode;
    MI_SYS_PixelFormat_e eFormat;
    MI_SYS_FrameBufExtraConfig_t stFrameBufExtraConf;
} MI_SYS_BufFrameConfig_t;

typedef struct {
    MI_U32 u32Size;
} MI_SYS_BufRawConfig_t;

typedef struct {
    MI_SYS_BufDataType_e eBufType;
    MI_U32 u32Flags;
    MI_U64 u64TargetPts;
    union {
        MI_SYS_BufFrameConfig_t stFrameCfg;
        MI_SYS_BufRawConfig_t stRawCfg;
    };
} MI_SYS_BufConf_t;

typedef struct {
    MI_U32 eType;
    union {
        MI_U32 u32GlobalGradient;
    } uIspInfo;
} MI_SYS_FrameIspInfo_t;

typedef struct {
    MI_SYS_FrameTileMode_e eTileMode;
    MI_SYS_PixelFormat_e ePixelFormat;
    MI_SYS_CompressMode_e eCompressMode;
    MI_SYS_FrameScanMode_e eFrameScanMode;
    MI_SYS_FieldType_e eFieldType;
    MI_SYS_FrameData_PhySignalType ePhylayoutType;
    MI_U16 u16Width;
    MI_U16 u16Height;
    void *pVirAddr[3];
    MI_PHY phyAddr[3];
    MI_U32 u32Stride[3];
    MI_U32 u32BufSize;
    MI_U16 u16RingBufStartLine;
    MI_U16 u16RingBufRealTotalHeight;
    MI_SYS_FrameIspInfo_t stFrameIspInfo;
    MI_SYS_WindowRect_t stContentCropWindow;
} MI_SYS_FrameData_t;

typedef struct {
    void *pVirAddr;
    MI_PHY phyAddr;
    MI_U32 u32BufSize;
    MI_U32 u32ContentSize;
    MI_BOOL bEndOfFrame;
    MI_U64 u64SeqNum;
} MI_SYS_RawData_t;

typedef struct {
    MI_U64 u64Pts;
    MI_U64 u64SidebandMsg;
    MI_SYS_BufDataType_e eBufType;
    MI_BOOL bEndOfStream;
    MI_BOOL bUsrBuf;
    MI_U32 u32SequenceNumber;
    union {
        MI_SYS_FrameData_t stFrameData;
        MI_SYS_RawData_t stRawData;
    };
} MI_SYS_BufInfo_t;

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
typedef MI_S32 (*fn_MI_SYS_ChnInputPortGetBuf)(
    MI_SYS_ChnPort_t *pstChnPort,
    MI_SYS_BufConf_t *pstBufConf,
    MI_SYS_BufInfo_t *pstBufInfo,
    MI_SYS_BUF_HANDLE *bufHandle,
    MI_S32 s32TimeOutMs);
typedef MI_S32 (*fn_MI_SYS_ChnInputPortPutBuf)(
    MI_SYS_BUF_HANDLE bufHandle,
    MI_SYS_BufInfo_t *pstBufInfo,
    MI_BOOL bDropBuf);

typedef MI_S32 (*fn_MI_DISP_u32_u32)(MI_U32, MI_U32);
typedef MI_S32 (*fn_MI_DISP_u32_u32_ptr)(MI_U32, MI_U32, void *);

typedef MI_S32 (*fn_MI_GFX_Open)(void);
typedef MI_S32 (*fn_MI_GFX_Close)(void);
typedef MI_S32 (*fn_MI_GFX_QuickFill)(
    MI_GFX_Surface_t *pstDst,
    MI_GFX_Rect_t *pstDstRect,
    MI_U32 u32ColorVal,
    MI_U16 *pu16Fence);
typedef MI_S32 (*fn_MI_GFX_BitBlit)(
    MI_GFX_Surface_t *pstSrc,
    MI_GFX_Rect_t *pstSrcRect,
    MI_GFX_Surface_t *pstDst,
    MI_GFX_Rect_t *pstDstRect,
    MI_GFX_Opt_t *pstOpt,
    MI_U16 *pu16Fence);
typedef MI_S32 (*fn_MI_GFX_WaitAllDone)(MI_BOOL bBlock, MI_U32 u32TimeoutMs);

typedef struct {
    void *h_sys;
    void *h_disp;
    void *h_gfx;
    int gfx_is_open;
    fn_MI_SYS_Init sys_init;
    fn_MI_SYS_ChnInputPortGetBuf get_buf;
    fn_MI_SYS_ChnInputPortPutBuf put_buf;
    fn_MI_DISP_u32_u32 enable_input_port;
    fn_MI_DISP_u32_u32 disable_input_port;
    fn_MI_DISP_u32_u32_ptr get_input_port_attr;
    fn_MI_DISP_u32_u32 clear_input_port_buffer;
    fn_MI_GFX_Open gfx_open;
    fn_MI_GFX_Close gfx_close;
    fn_MI_GFX_QuickFill gfx_quick_fill;
    fn_MI_GFX_BitBlit gfx_bitblit;
    fn_MI_GFX_WaitAllDone gfx_wait_all_done;
} MiApi;

static int find_pid_by_name(const char *needle);
static MI_PHY find_fb0_offset_for_pid(int pid);
static MI_PHY g_gfx_bus_override = 0;
static MI_U32 g_gfx_height_override = 0;
static MI_U32 g_gfx_width_override = 0;
static MI_U32 g_gfx_page_override = 0;
static int g_gfx_use_page_override = 0;
static int g_do_copy_test = 0;

static MI_PHY guess_bus_alias(MI_PHY cpu_addr) {
    if (cpu_addr >= 0x30000000ULL && cpu_addr < 0x40000000ULL) {
        return cpu_addr + 0x20000000ULL;
    }
    return cpu_addr;
}

static void backlight_on(void) {
    FILE *f = fopen("/sys/class/backlight/soc:backlight/bl_power", "w");
    if (f) {
        fprintf(f, "0");
        fclose(f);
    }
    f = fopen("/sys/class/backlight/soc:backlight/brightness", "w");
    if (f) {
        fprintf(f, "255");
        fclose(f);
    }
}

static void print_usage(const char *argv0) {
    printf("usage: %s [--disp] [--gfx] [--copy-test] [--maps] [--maps-pid PID] [--gfx-bus HEX] [--gfx-height N] [--gfx-width N] [--gfx-page N] [--all]\n", argv0);
}

static int load_symbol(void **out, void *handle, const char *name, int required) {
    *out = dlsym(handle, name);
    if (!*out && required) {
        fprintf(stderr, "missing symbol %s: %s\n", name, dlerror());
        return -1;
    }
    return 0;
}

static int mi_api_open(MiApi *api) {
    memset(api, 0, sizeof(*api));
    api->h_sys = dlopen("libmi_sys.so", RTLD_NOW | RTLD_GLOBAL);
    api->h_disp = dlopen("libmi_disp.so", RTLD_NOW | RTLD_GLOBAL);
    api->h_gfx = dlopen("libmi_gfx.so", RTLD_NOW | RTLD_GLOBAL);

    if (!api->h_sys || !api->h_disp) {
        fprintf(stderr, "dlopen failed: sys=%p disp=%p err=%s\n",
                api->h_sys, api->h_disp, dlerror());
        return -1;
    }
    if (!api->h_gfx) {
        fprintf(stderr, "dlopen gfx failed: %s\n", dlerror());
    }

    if (load_symbol((void **)&api->sys_init, api->h_sys, "MI_SYS_Init", 0) < 0) return -1;
    if (load_symbol((void **)&api->get_buf, api->h_sys, "MI_SYS_ChnInputPortGetBuf", 1) < 0) return -1;
    if (load_symbol((void **)&api->put_buf, api->h_sys, "MI_SYS_ChnInputPortPutBuf", 1) < 0) return -1;
    if (load_symbol((void **)&api->enable_input_port, api->h_disp, "MI_DISP_EnableInputPort", 0) < 0) return -1;
    if (load_symbol((void **)&api->disable_input_port, api->h_disp, "MI_DISP_DisableInputPort", 0) < 0) return -1;
    if (load_symbol((void **)&api->get_input_port_attr, api->h_disp, "MI_DISP_GetInputPortAttr", 0) < 0) return -1;
    if (load_symbol((void **)&api->clear_input_port_buffer, api->h_disp, "MI_DISP_ClearInputPortBuffer", 0) < 0) return -1;

    if (api->h_gfx) {
        load_symbol((void **)&api->gfx_open, api->h_gfx, "MI_GFX_Open", 0);
        load_symbol((void **)&api->gfx_close, api->h_gfx, "MI_GFX_Close", 0);
        load_symbol((void **)&api->gfx_quick_fill, api->h_gfx, "MI_GFX_QuickFill", 0);
        load_symbol((void **)&api->gfx_bitblit, api->h_gfx, "MI_GFX_BitBlit", 0);
        load_symbol((void **)&api->gfx_wait_all_done, api->h_gfx, "MI_GFX_WaitAllDone", 0);
    }

    return 0;
}

static void mi_api_close(MiApi *api) {
    if (api->gfx_is_open && api->gfx_close) api->gfx_close();
    if (api->h_gfx) dlclose(api->h_gfx);
    if (api->h_disp) dlclose(api->h_disp);
    if (api->h_sys) dlclose(api->h_sys);
}

static void print_attr_probe(MiApi *api) {
    if (!api->get_input_port_attr) return;
    MI_U8 attr_buf[128];
    memset(attr_buf, 0, sizeof(attr_buf));
    printf("MI_DISP_GetInputPortAttr(0,0) -> %d bytes probe\n", (int)sizeof(attr_buf));
    printf("  ret=%d data=%02x %02x %02x %02x\n",
           api->get_input_port_attr(0, 0, attr_buf),
           attr_buf[0], attr_buf[1], attr_buf[2], attr_buf[3]);
}

static int acquire_disp_surface(MiApi *api, MI_SYS_BufInfo_t *buf_info, MI_SYS_BUF_HANDLE *handle, int clear_port) {
    MI_SYS_ChnPort_t port;
    MI_SYS_BufConf_t conf;
    memset(&port, 0, sizeof(port));
    memset(&conf, 0, sizeof(conf));
    memset(buf_info, 0, sizeof(*buf_info));

    port.eModId = E_MI_MODULE_ID_DISP;
    port.u32DevId = 0;
    port.u32ChnId = 0;
    port.u32PortId = 0;

    conf.eBufType = E_MI_SYS_BUFDATA_FRAME;
    conf.stFrameCfg.u16Width = 540;
    conf.stFrameCfg.u16Height = 960;
    conf.stFrameCfg.eFrameScanMode = E_MI_SYS_FRAME_SCAN_MODE_PROGRESSIVE;
    conf.stFrameCfg.eFormat = E_MI_SYS_PIXEL_FRAME_ARGB8888;

    if (api->enable_input_port) {
        printf("calling MI_DISP_EnableInputPort...\n");
        MI_S32 ret = api->enable_input_port(0, 0);
        printf("MI_DISP_EnableInputPort(0,0): %d\n", ret);
    }
    if (clear_port && api->clear_input_port_buffer) {
        printf("calling MI_DISP_ClearInputPortBuffer...\n");
        MI_S32 ret = api->clear_input_port_buffer(0, 0);
        printf("MI_DISP_ClearInputPortBuffer(0,0): %d\n", ret);
    }

    printf("calling MI_SYS_ChnInputPortGetBuf...\n");
    MI_S32 ret = api->get_buf(&port, &conf, buf_info, handle, 3000);
    printf("MI_SYS_ChnInputPortGetBuf(DISP:0:0:0): ret=%d handle=%d\n", ret, *handle);
    if (ret != 0) return -1;

    printf("  type=%d format=%d %ux%u stride=%u size=%u vaddr=%p phy=0x%llx\n",
           buf_info->eBufType,
           buf_info->stFrameData.ePixelFormat,
           buf_info->stFrameData.u16Width,
           buf_info->stFrameData.u16Height,
           buf_info->stFrameData.u32Stride[0],
           buf_info->stFrameData.u32BufSize,
           buf_info->stFrameData.pVirAddr[0],
           buf_info->stFrameData.phyAddr[0]);

    return 0;
}

static void fill_cpu_pattern(MI_SYS_BufInfo_t *buf_info) {
    uint8_t *base = (uint8_t *)buf_info->stFrameData.pVirAddr[0];
    MI_U32 stride = buf_info->stFrameData.u32Stride[0] ? buf_info->stFrameData.u32Stride[0] : 540 * 4;
    int width = buf_info->stFrameData.u16Width ? buf_info->stFrameData.u16Width : 540;
    int height = buf_info->stFrameData.u16Height ? buf_info->stFrameData.u16Height : 960;
    int x;
    int y;

    if (!base) {
        printf("  no CPU-visible vaddr for pattern fill\n");
        return;
    }

    for (y = 0; y < height; y++) {
        uint32_t *row = (uint32_t *)(base + y * stride);
        for (x = 0; x < width; x++) {
            if (y < height / 3) row[x] = 0xFFFF0000;
            else if (y < (height * 2) / 3) row[x] = 0xFF00FF00;
            else row[x] = 0xFF0000FF;
        }
    }
    printf("  wrote CPU RGB stripes into returned buffer\n");
}

static int run_disp_probe(MiApi *api) {
    MI_SYS_BufInfo_t buf_info;
    MI_SYS_BUF_HANDLE handle = -1;

    printf("=== DISP probe ===\n");
    if (api->sys_init) printf("MI_SYS_Init: %d\n", api->sys_init());
    print_attr_probe(api);

    if (acquire_disp_surface(api, &buf_info, &handle, 1) != 0) return 1;
    fill_cpu_pattern(&buf_info);

    printf("MI_SYS_ChnInputPortPutBuf: %d\n", api->put_buf(handle, &buf_info, 0));
    printf("Expected result: visible RGB horizontal stripes if DISP path is exposed\n");
    return 0;
}

static int run_gfx_probe(MiApi *api) {
    MI_GFX_Surface_t surface;
    MI_GFX_Surface_t src_surface;
    MI_GFX_Surface_t dst_surface;
    MI_GFX_Rect_t rect;
    MI_GFX_Rect_t src_rect;
    MI_GFX_Rect_t dst_rect;
    MI_GFX_Opt_t opt;
    MI_U16 fence = 0;
    MI_S32 ret;
    struct fb_fix_screeninfo fix;
    struct fb_var_screeninfo var;
    int fb_fd;
    int zkgui_pid;
    MI_PHY zkgui_fb0_offset;
    MI_U32 page_size;
    size_t bytes;
    unsigned char *fb_map;

    printf("=== MI_GFX probe ===\n");
    if (!api->h_gfx || !api->gfx_open || !api->gfx_quick_fill) {
        fprintf(stderr, "MI_GFX symbols unavailable\n");
        return 1;
    }

    if (api->sys_init) printf("MI_SYS_Init: %d\n", api->sys_init());
    ret = api->gfx_open();
    printf("MI_GFX_Open: %d\n", ret);
    if (ret != 0) return 1;
    api->gfx_is_open = 1;

    fb_fd = open("/dev/fb0", O_RDWR);
    if (fb_fd < 0) {
        perror("open /dev/fb0");
        return 1;
    }
    if (ioctl(fb_fd, FBIOGET_FSCREENINFO, &fix) != 0) {
        perror("FBIOGET_FSCREENINFO");
        close(fb_fd);
        return 1;
    }
    if (ioctl(fb_fd, FBIOGET_VSCREENINFO, &var) != 0) {
        perror("FBIOGET_VSCREENINFO");
        close(fb_fd);
        return 1;
    }
    close(fb_fd);
    zkgui_pid = find_pid_by_name("zkgui");
    if (zkgui_pid <= 0) zkgui_pid = find_pid_by_name("zkgui_ui");
    zkgui_fb0_offset = zkgui_pid > 0 ? find_fb0_offset_for_pid(zkgui_pid) : 0;

    memset(&surface, 0, sizeof(surface));
    surface.phyAddr = g_gfx_bus_override
        ? g_gfx_bus_override
        : (zkgui_fb0_offset ? zkgui_fb0_offset : guess_bus_alias((MI_PHY)fix.smem_start));
    surface.u32Width = g_gfx_width_override ? g_gfx_width_override : (var.xres ? var.xres : 540);
    surface.u32Height = g_gfx_height_override ? g_gfx_height_override : (var.yres_virtual ? var.yres_virtual : var.yres);
    surface.u32Stride = fix.line_length ? fix.line_length : surface.u32Width * 4;
    surface.eColorFmt = 11; /* E_MI_GFX_FMT_ARGB8888 */
    page_size = (var.yres ? var.yres : 960) * surface.u32Stride;
    if (g_gfx_use_page_override) {
        surface.phyAddr += ((MI_PHY)g_gfx_page_override) * page_size;
        printf("  applying page override=%u page_size=0x%x\n", g_gfx_page_override, page_size);
    }

    printf("  fb0 smem_start=0x%lx line_length=%u xres=%u yres=%u yres_virtual=%u bpp=%u\n",
           (unsigned long)fix.smem_start, fix.line_length,
           var.xres, var.yres, var.yres_virtual, var.bits_per_pixel);
    if (zkgui_fb0_offset) {
        printf("  zkgui fb0 map offset=0x%llx (preferred GFX bus addr)\n", zkgui_fb0_offset);
    } else {
        printf("  zkgui fb0 map not found, guessed bus alias=0x%llx from smem_start\n",
               (unsigned long long)guess_bus_alias((MI_PHY)fix.smem_start));
    }
    printf("  surface phy=0x%llx w=%u h=%u stride=%u colorFmt=%u\n",
           surface.phyAddr, surface.u32Width, surface.u32Height,
           surface.u32Stride, surface.eColorFmt);

    memset(&rect, 0, sizeof(rect));
    rect.u32Width = surface.u32Width;
    rect.u32Height = surface.u32Height;
    ret = api->gfx_quick_fill(&surface, &rect, 0xFF202020, &fence);
    printf("MI_GFX_QuickFill full bg: ret=%d fence=%u\n", ret, fence);

    rect.s32Xpos = 20;
    rect.s32Ypos = 20;
    rect.u32Width = 160;
    rect.u32Height = 160;
    ret = api->gfx_quick_fill(&surface, &rect, 0xFFFF0000, &fence);
    printf("MI_GFX_QuickFill red block: ret=%d fence=%u\n", ret, fence);

    rect.s32Xpos = 200;
    rect.s32Ypos = 20;
    rect.u32Width = 160;
    rect.u32Height = 160;
    ret = api->gfx_quick_fill(&surface, &rect, 0xFF00FF00, &fence);
    printf("MI_GFX_QuickFill green block: ret=%d fence=%u\n", ret, fence);

    rect.s32Xpos = 380;
    rect.s32Ypos = 20;
    rect.u32Width = 140;
    rect.u32Height = 160;
    ret = api->gfx_quick_fill(&surface, &rect, 0xFF0000FF, &fence);
    printf("MI_GFX_QuickFill blue block: ret=%d fence=%u\n", ret, fence);

    if (api->gfx_wait_all_done) {
        ret = api->gfx_wait_all_done(1, 1000);
        printf("MI_GFX_WaitAllDone: %d\n", ret);
    }

    if (g_do_copy_test && api->gfx_bitblit) {
        bytes = (size_t)page_size * 2;
        fb_fd = open("/dev/fb0", O_RDWR);
        if (fb_fd < 0) {
            perror("open /dev/fb0 copy-test");
            return 1;
        }
        fb_map = mmap(NULL, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fb_fd, 0);
        close(fb_fd);
        if ((void *)fb_map == (void *)-1) {
            perror("mmap /dev/fb0 copy-test");
            return 1;
        }

        memset(fb_map + page_size, 0x00, page_size);
        for (MI_U32 y = 0; y < 960; y++) {
            uint32_t *row = (uint32_t *)(fb_map + page_size + y * 2160);
            for (MI_U32 x = 0; x < 540; x++) {
                if (y < 320) row[x] = 0xFFFF0000;
                else if (y < 640) row[x] = 0xFF00FF00;
                else row[x] = 0xFF0000FF;
            }
        }

        src_surface = surface;
        dst_surface = surface;
        src_surface.phyAddr = (g_gfx_bus_override
            ? g_gfx_bus_override
            : (zkgui_fb0_offset ? zkgui_fb0_offset : guess_bus_alias((MI_PHY)fix.smem_start))) + page_size;
        src_surface.u32Height = 960;
        dst_surface.phyAddr = g_gfx_bus_override
            ? g_gfx_bus_override
            : (zkgui_fb0_offset ? zkgui_fb0_offset : guess_bus_alias((MI_PHY)fix.smem_start));
        dst_surface.u32Height = 960;

        memset(&src_rect, 0, sizeof(src_rect));
        memset(&dst_rect, 0, sizeof(dst_rect));
        src_rect.u32Width = 540;
        src_rect.u32Height = 960;
        dst_rect.u32Width = 540;
        dst_rect.u32Height = 960;
        memset(&opt, 0, sizeof(opt));
        opt.u32Dummy[0] = 0;
        opt.u32Dummy[1] = 0;
        opt.u32Dummy[2] = 540;
        opt.u32Dummy[3] = 960;

        printf("copy-test src=0x%llx dst=0x%llx\n", src_surface.phyAddr, dst_surface.phyAddr);
        ret = api->gfx_bitblit(&src_surface, &src_rect, &dst_surface, &dst_rect, &opt, &fence);
        printf("MI_GFX_BitBlit copy-test: ret=%d fence=%u\n", ret, fence);
        if (api->gfx_wait_all_done) {
            ret = api->gfx_wait_all_done(1, 1000);
            printf("MI_GFX_WaitAllDone copy-test: %d\n", ret);
        }
        munmap(fb_map, bytes);
    }
    printf("Expected result: dark framebuffer with RGB blocks if MI_GFX reaches visible fb0 memory\n");
    return 0;
}

static int is_numeric_name(const char *name) {
    size_t i;
    if (!name || !name[0]) return 0;
    for (i = 0; name[i]; i++) {
        if (!isdigit((unsigned char)name[i])) return 0;
    }
    return 1;
}

static int read_proc_file(const char *path, char *buf, size_t buf_size) {
    FILE *f = fopen(path, "r");
    size_t n;
    if (!f) return -1;
    n = fread(buf, 1, buf_size - 1, f);
    fclose(f);
    buf[n] = '\0';
    return (int)n;
}

static int find_pid_by_name(const char *needle) {
    DIR *dir = opendir("/proc");
    struct dirent *ent;
    char path[128];
    char cmdline[256];
    int pid = -1;

    if (!dir) {
        perror("opendir /proc");
        return -1;
    }

    while ((ent = readdir(dir)) != NULL) {
        if (!is_numeric_name(ent->d_name)) continue;
        snprintf(path, sizeof(path), "/proc/%s/cmdline", ent->d_name);
        if (read_proc_file(path, cmdline, sizeof(cmdline)) <= 0) continue;
        if (strstr(cmdline, needle)) {
            pid = atoi(ent->d_name);
            break;
        }
    }

    closedir(dir);
    return pid;
}

static void dump_maps_for_pid(int pid) {
    char path[128];
    char line[512];
    FILE *f;

    snprintf(path, sizeof(path), "/proc/%d/maps", pid);
    f = fopen(path, "r");
    if (!f) {
        fprintf(stderr, "open %s failed: %s\n", path, strerror(errno));
        return;
    }

    printf("=== /proc/%d/maps ===\n", pid);
    while (fgets(line, sizeof(line), f)) {
        if (strstr(line, "mi_") || strstr(line, "zkgui") || strstr(line, "zkdisplay")
            || strstr(line, "/dev/mem") || strstr(line, "/dev/fb0")
            || strstr(line, "anon")) {
            printf("%s", line);
        }
    }
    fclose(f);
}

static MI_PHY find_fb0_offset_for_pid(int pid) {
    char path[128];
    char line[512];
    FILE *f;

    snprintf(path, sizeof(path), "/proc/%d/maps", pid);
    f = fopen(path, "r");
    if (!f) return 0;

    while (fgets(line, sizeof(line), f)) {
        unsigned long start;
        unsigned long end;
        unsigned long offset;
        if (!strstr(line, "/dev/fb0")) continue;
        if (sscanf(line, "%lx-%lx %*4s %lx", &start, &end, &offset) == 3) {
            fclose(f);
            return (MI_PHY)offset;
        }
    }

    fclose(f);
    return 0;
}

static void run_maps_probe(int explicit_pid) {
    int pid = explicit_pid;
    if (pid <= 0) pid = find_pid_by_name("zkgui");
    if (pid <= 0) pid = find_pid_by_name("zkgui_ui");
    if (pid <= 0) {
        fprintf(stderr, "zkgui pid not found\n");
    } else {
        dump_maps_for_pid(pid);
    }

    pid = find_pid_by_name("zkdisplay");
    if (pid > 0) dump_maps_for_pid(pid);
}

int main(int argc, char **argv) {
    MiApi api;
    int do_disp = 0;
    int do_gfx = 0;
    int do_maps = 0;
    int maps_pid = -1;
    int i;

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--disp") == 0) do_disp = 1;
        else if (strcmp(argv[i], "--gfx") == 0) do_gfx = 1;
        else if (strcmp(argv[i], "--copy-test") == 0) do_gfx = g_do_copy_test = 1;
        else if (strcmp(argv[i], "--maps") == 0) do_maps = 1;
        else if (strcmp(argv[i], "--all") == 0) do_disp = do_gfx = do_maps = 1;
        else if (strcmp(argv[i], "--maps-pid") == 0 && i + 1 < argc) maps_pid = atoi(argv[++i]);
        else if (strcmp(argv[i], "--gfx-bus") == 0 && i + 1 < argc) g_gfx_bus_override = strtoull(argv[++i], NULL, 0);
        else if (strcmp(argv[i], "--gfx-height") == 0 && i + 1 < argc) g_gfx_height_override = (MI_U32)strtoul(argv[++i], NULL, 0);
        else if (strcmp(argv[i], "--gfx-width") == 0 && i + 1 < argc) g_gfx_width_override = (MI_U32)strtoul(argv[++i], NULL, 0);
        else if (strcmp(argv[i], "--gfx-page") == 0 && i + 1 < argc) {
            g_gfx_page_override = (MI_U32)strtoul(argv[++i], NULL, 0);
            g_gfx_use_page_override = 1;
        }
        else {
            print_usage(argv[0]);
            return 1;
        }
    }

    if (!do_disp && !do_gfx && !do_maps) {
        do_gfx = 1;
        do_maps = 1;
    }

    backlight_on();
    printf("=== D200H display probe ===\n");
    printf("sizeof(BufConf)=%zu sizeof(BufInfo)=%zu sizeof(GfxSurface)=%zu\n",
           sizeof(MI_SYS_BufConf_t), sizeof(MI_SYS_BufInfo_t), sizeof(MI_GFX_Surface_t));

    if ((do_disp || do_gfx) && mi_api_open(&api) != 0) return 1;

    if (do_disp) run_disp_probe(&api);
    if (do_gfx) run_gfx_probe(&api);
    if (do_maps) run_maps_probe(maps_pid);

    if (do_disp || do_gfx) {
        printf("sleeping 10s so the rendered frame stays visible if it worked\n");
        sleep(10);
        mi_api_close(&api);
    }

    return 0;
}
