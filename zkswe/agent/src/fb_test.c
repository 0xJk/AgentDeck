/*
 * MI_DISP direct render test for D200H (SSD210)
 * Uses correct SigmaStar MI SDK struct layouts from steward-fu/nds + loop0728/zkgui_sample
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <dlfcn.h>

/* === MI Base Types === */
typedef unsigned char      MI_U8;
typedef unsigned short     MI_U16;
typedef unsigned int       MI_U32;
typedef unsigned long long MI_U64;
typedef signed int         MI_S32;
typedef unsigned long long MI_PHY;
typedef unsigned long      MI_VIRT;
typedef unsigned char      MI_BOOL;
typedef MI_S32             MI_SYS_BUF_HANDLE;

/* === Module IDs === */
typedef enum {
    E_MI_MODULE_ID_DISP   = 15,
    E_MI_MODULE_ID_FB     = 10,
} MI_ModuleId_e;

/* === Pixel Formats === */
typedef enum {
    E_MI_SYS_PIXEL_FRAME_YUV422_YUYV = 0,
    E_MI_SYS_PIXEL_FRAME_ARGB8888,
    E_MI_SYS_PIXEL_FRAME_ABGR8888,
    E_MI_SYS_PIXEL_FRAME_BGRA8888,
    E_MI_SYS_PIXEL_FRAME_RGB565,
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
    NORMAL_FRAME_DATA = 2,
} MI_SYS_FrameData_PhySignalType;

typedef enum {
    E_MI_SYS_BUFDATA_RAW = 0,
    E_MI_SYS_BUFDATA_FRAME,
} MI_SYS_BufDataType_e;

/* === Structs === */
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
    union { MI_U32 u32GlobalGradient; } uIspInfo;
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

/* === Function pointer types === */
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

static void backlight_on(void) {
    FILE *f;
    f = fopen("/sys/class/backlight/soc:backlight/bl_power", "w");
    if (f) { fprintf(f, "0"); fclose(f); }
    f = fopen("/sys/class/backlight/soc:backlight/brightness", "w");
    if (f) { fprintf(f, "255"); fclose(f); }
}

int main(void) {
    backlight_on();
    printf("=== MI_DISP Render Test (correct SDK structs) ===\n");
    printf("sizeof BufConf_t=%zu BufInfo_t=%zu ChnPort_t=%zu\n",
           sizeof(MI_SYS_BufConf_t), sizeof(MI_SYS_BufInfo_t), sizeof(MI_SYS_ChnPort_t));

    void *h_sys = dlopen("libmi_sys.so", RTLD_NOW);
    void *h_disp = dlopen("libmi_disp.so", RTLD_NOW);
    if (!h_sys) { fprintf(stderr, "dlopen sys: %s\n", dlerror()); return 1; }
    if (!h_disp) { fprintf(stderr, "dlopen disp: %s\n", dlerror()); return 1; }

    fn_MI_SYS_Init pInit = dlsym(h_sys, "MI_SYS_Init");
    fn_MI_SYS_ChnInputPortGetBuf pGetBuf = dlsym(h_sys, "MI_SYS_ChnInputPortGetBuf");
    fn_MI_SYS_ChnInputPortPutBuf pPutBuf = dlsym(h_sys, "MI_SYS_ChnInputPortPutBuf");

    /* DISP functions */
    typedef MI_S32 (*fn_void_ret)(void);
    typedef MI_S32 (*fn_u32_u32)(MI_U32, MI_U32);
    typedef MI_S32 (*fn_u32_u32_ptr)(MI_U32, MI_U32, void*);

    fn_u32_u32 pEnableInputPort = dlsym(h_disp, "MI_DISP_EnableInputPort");
    fn_u32_u32 pDisableInputPort = dlsym(h_disp, "MI_DISP_DisableInputPort");
    fn_u32_u32_ptr pSetInputPortAttr = dlsym(h_disp, "MI_DISP_SetInputPortAttr");
    fn_u32_u32_ptr pGetInputPortAttr = dlsym(h_disp, "MI_DISP_GetInputPortAttr");
    fn_u32_u32 pClearInputPortBuffer = dlsym(h_disp, "MI_DISP_ClearInputPortBuffer");

    if (!pGetBuf || !pPutBuf) {
        fprintf(stderr, "Missing SYS functions\n"); return 1;
    }
    printf("All MI functions loaded\n");

    /* MI_SYS_Init */
    MI_S32 ret = pInit ? pInit() : 0;
    printf("MI_SYS_Init: %d\n", ret);

    /* Try to get current input port attr */
    if (pGetInputPortAttr) {
        MI_U8 attr_buf[128];
        memset(attr_buf, 0, sizeof(attr_buf));
        ret = pGetInputPortAttr(0, 0, attr_buf);
        printf("GetInputPortAttr(0,0): %d (data: %02x %02x %02x %02x ...)\n",
               ret, attr_buf[0], attr_buf[1], attr_buf[2], attr_buf[3]);
    }

    /* Enable input port 0 on DISP layer 0 */
    if (pEnableInputPort) {
        ret = pEnableInputPort(0, 0);
        printf("EnableInputPort(0,0): %d\n", ret);
    }

    /* Clear any old buffer */
    if (pClearInputPortBuffer) {
        ret = pClearInputPortBuffer(0, 0);
        printf("ClearInputPortBuffer(0,0): %d\n", ret);
    }

    /* DISP dev0, videoLayer0 (chn0), inputPort0 */
    MI_SYS_ChnPort_t port;
    memset(&port, 0, sizeof(port));
    port.eModId = E_MI_MODULE_ID_DISP;
    port.u32DevId = 0;
    port.u32ChnId = 0;
    port.u32PortId = 0;

    MI_SYS_BufConf_t conf;
    memset(&conf, 0, sizeof(conf));
    conf.eBufType = E_MI_SYS_BUFDATA_FRAME;
    conf.u32Flags = 0;
    conf.u64TargetPts = 0;
    conf.stFrameCfg.u16Width = 540;
    conf.stFrameCfg.u16Height = 960;
    conf.stFrameCfg.eFrameScanMode = E_MI_SYS_FRAME_SCAN_MODE_PROGRESSIVE;
    conf.stFrameCfg.eFormat = E_MI_SYS_PIXEL_FRAME_ARGB8888;

    MI_SYS_BufInfo_t bufInfo;
    MI_SYS_BUF_HANDLE handle = -1;
    memset(&bufInfo, 0, sizeof(bufInfo));

    printf("Calling GetBuf (DISP:0:0:0, 540x960 ARGB8888)...\n");
    ret = pGetBuf(&port, &conf, &bufInfo, &handle, 3000);
    printf("GetBuf: ret=%d handle=%d\n", ret, handle);

    if (ret == 0) {
        printf("BufInfo: type=%d w=%u h=%u stride=%u size=%u vaddr=%p phy=0x%llx\n",
               bufInfo.eBufType,
               bufInfo.stFrameData.u16Width,
               bufInfo.stFrameData.u16Height,
               bufInfo.stFrameData.u32Stride[0],
               bufInfo.stFrameData.u32BufSize,
               bufInfo.stFrameData.pVirAddr[0],
               bufInfo.stFrameData.phyAddr[0]);

        if (bufInfo.stFrameData.pVirAddr[0]) {
            uint8_t *p = (uint8_t*)bufInfo.stFrameData.pVirAddr[0];
            int stride = bufInfo.stFrameData.u32Stride[0];
            if (stride == 0) stride = 540 * 4;
            int h = bufInfo.stFrameData.u16Height;
            if (h == 0) h = 960;

            /* Fill RED */
            for (int y = 0; y < h; y++) {
                uint32_t *row = (uint32_t*)(p + y * stride);
                for (int x = 0; x < 540; x++) {
                    row[x] = 0xFFFF0000; /* ARGB red */
                }
            }
            printf("Filled RED, PutBuf...\n");
            ret = pPutBuf(handle, &bufInfo, 0);
            printf("PutBuf: ret=%d\n", ret);
            if (ret == 0) printf("=== 빨간 화면이 보여야 한다! ===\n");
        }
    } else {
        printf("GetBuf failed. Trying FB module (ID=10)...\n");
        port.eModId = E_MI_MODULE_ID_FB;
        ret = pGetBuf(&port, &conf, &bufInfo, &handle, 3000);
        printf("FB GetBuf: ret=%d\n", ret);

        if (ret != 0) {
            printf("Trying DISP port1...\n");
            port.eModId = E_MI_MODULE_ID_DISP;
            port.u32PortId = 1;
            ret = pGetBuf(&port, &conf, &bufInfo, &handle, 3000);
            printf("DISP port1 GetBuf: ret=%d\n", ret);
        }
    }

    sleep(10);
    dlclose(h_sys);
    printf("Done.\n");
    return 0;
}
