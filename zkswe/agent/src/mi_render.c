/*
 * MI_DISP direct rendering for D200H (SSD210)
 * Uses SigmaStar MI API via dlopen to render frames to the display.
 *
 * The SSD210 display pipeline: MI_GFX → MI_DISP → MI_PANEL → LCD
 * fbdev (/dev/fb0) is an input port on MI_DISP but gets hidden behind
 * zkgui's GFX layer. We need to either:
 * 1. Use MI_SYS_ChnInputPortGetBuf/PutBuf (direct frame submission)
 * 2. Use MI_GFX_QuickFill/BitBlit (hardware 2D blit)
 *
 * This module uses dlopen() to load /lib/libmi_*.so at runtime.
 */
#define _DEFAULT_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <dlfcn.h>

/* MI type definitions (from SigmaStar SDK headers, reconstructed) */
typedef int32_t MI_S32;
typedef uint32_t MI_U32;
typedef uint16_t MI_U16;
typedef uint8_t MI_U8;
typedef void* MI_PHY; /* physical address */

typedef struct {
    MI_U32 u32DispDevId;
} MI_DISP_DEV;

typedef struct {
    MI_U32 eType; /* 0=LCD */
    MI_U32 u32BgColor;
} MI_DISP_PubAttr_t;

typedef struct {
    MI_U32 u32Width;
    MI_U32 u32Height;
    MI_U32 ePixFmt;
    MI_U32 u32Stride[3];
    void *pVirAddr[3];
    MI_PHY phyAddr[3];
    MI_U32 u32BufSize;
} MI_SYS_BufInfo_t;

typedef struct {
    MI_U32 eModId;
    MI_U32 u32DevId;
    MI_U32 u32ChnId;
    MI_U32 u32PortId;
} MI_SYS_ChnPort_t;

typedef struct {
    MI_U32 u32X;
    MI_U32 u32Y;
    MI_U32 u32Width;
    MI_U32 u32Height;
} MI_SYS_WindowRect_t;

typedef struct {
    MI_SYS_WindowRect_t stDispWin;
    MI_U32 u32Priority;
} MI_DISP_InputPortAttr_t;

/* Pixel formats */
#define E_MI_SYS_PIXEL_FRAME_ARGB8888 0x0
#define E_MI_SYS_PIXEL_FRAME_ABGR8888 0x1
#define E_MI_SYS_PIXEL_FRAME_YUV422_YUYV 0x9

/* Module IDs */
#define E_MI_MODULE_ID_DISP 9

/* Function pointers */
static MI_S32 (*pMI_SYS_Init)(MI_U32) = NULL;
static MI_S32 (*pMI_SYS_ChnInputPortGetBuf)(MI_SYS_ChnPort_t*, MI_SYS_BufInfo_t*, MI_U32*, MI_S32) = NULL;
static MI_S32 (*pMI_SYS_ChnInputPortPutBuf)(MI_U32, MI_SYS_BufInfo_t*, int) = NULL;
static MI_S32 (*pMI_DISP_GetInputPortAttr)(MI_U32, MI_U32, MI_DISP_InputPortAttr_t*) = NULL;
static MI_S32 (*pMI_DISP_SetInputPortAttr)(MI_U32, MI_U32, MI_DISP_InputPortAttr_t*) = NULL;
static MI_S32 (*pMI_DISP_EnableInputPort)(MI_U32, MI_U32) = NULL;
static MI_S32 (*pMI_DISP_ClearInputPortBuffer)(MI_U32, MI_U32) = NULL;

static void *h_sys = NULL, *h_disp = NULL;

int mi_render_init(void) {
    h_sys = dlopen("/lib/libmi_sys.so", RTLD_NOW);
    h_disp = dlopen("/lib/libmi_disp.so", RTLD_NOW);

    if (!h_sys || !h_disp) {
        fprintf(stderr, "mi_render: dlopen failed: %s\n", dlerror());
        return -1;
    }

    pMI_SYS_Init = dlsym(h_sys, "MI_SYS_Init");
    pMI_SYS_ChnInputPortGetBuf = dlsym(h_sys, "MI_SYS_ChnInputPortGetBuf");
    pMI_SYS_ChnInputPortPutBuf = dlsym(h_sys, "MI_SYS_ChnInputPortPutBuf");
    pMI_DISP_GetInputPortAttr = dlsym(h_disp, "MI_DISP_GetInputPortAttr");
    pMI_DISP_SetInputPortAttr = dlsym(h_disp, "MI_DISP_SetInputPortAttr");
    pMI_DISP_EnableInputPort = dlsym(h_disp, "MI_DISP_EnableInputPort");
    pMI_DISP_ClearInputPortBuffer = dlsym(h_disp, "MI_DISP_ClearInputPortBuffer");

    if (!pMI_SYS_ChnInputPortGetBuf || !pMI_SYS_ChnInputPortPutBuf) {
        fprintf(stderr, "mi_render: missing MI_SYS functions\n");
        return -1;
    }

    printf("mi_render: MI API loaded OK\n");
    return 0;
}

void mi_render_close(void) {
    if (h_disp) dlclose(h_disp);
    if (h_sys) dlclose(h_sys);
}

/*
 * Submit a frame to MI_DISP input port.
 * Pixel data should be ARGB8888, 540x960 (physical fb dimensions).
 */
int mi_render_frame(const uint8_t *pixels, int width, int height) {
    MI_SYS_ChnPort_t port;
    MI_SYS_BufInfo_t buf;
    MI_U32 phyAddr = 0;

    memset(&port, 0, sizeof(port));
    port.eModId = E_MI_MODULE_ID_DISP;
    port.u32DevId = 0;
    port.u32ChnId = 0;
    port.u32PortId = 0; /* fbdev.ini FB_HWWIN_ID = 0 */

    memset(&buf, 0, sizeof(buf));

    /* Get a buffer from MI_DISP input port */
    MI_S32 ret = pMI_SYS_ChnInputPortGetBuf(&port, &buf, &phyAddr, 1000);
    if (ret != 0) {
        fprintf(stderr, "mi_render: GetBuf failed (%d)\n", ret);
        return -1;
    }

    /* Copy pixel data to the buffer */
    if (buf.pVirAddr[0]) {
        int stride = buf.u32Stride[0] ? buf.u32Stride[0] : width * 4;
        int src_stride = width * 4;
        for (int y = 0; y < height && y < (int)buf.u32Height; y++) {
            memcpy((uint8_t*)buf.pVirAddr[0] + y * stride,
                   pixels + y * src_stride,
                   src_stride < stride ? src_stride : stride);
        }
    }

    /* Submit the buffer */
    ret = pMI_SYS_ChnInputPortPutBuf(phyAddr, &buf, 0);
    if (ret != 0) {
        fprintf(stderr, "mi_render: PutBuf failed (%d)\n", ret);
        return -1;
    }

    return 0;
}

/* Test: fill screen with solid color via MI API */
int mi_render_test(void) {
    printf("mi_render: test - filling screen with colors\n");

    int w = 540, h = 960;
    uint8_t *pixels = malloc(w * h * 4);
    if (!pixels) return -1;

    /* White */
    memset(pixels, 255, w * h * 4);
    printf("mi_render: submitting WHITE frame\n");
    int ret = mi_render_frame(pixels, w, h);
    printf("mi_render: result = %d\n", ret);

    free(pixels);
    return ret;
}
