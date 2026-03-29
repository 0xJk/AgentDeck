# D200H Display Rendering Research

## Problem
D200H (SSD210) 기기에 커스텀 화면을 렌더링해야 했고, 최종적으로 MI_GFX 경로로 해결했다. fbdev(`/dev/fb0`) mmap/write는 끝까지 직접 visible하지 않았고, MI_DISP API GetBuf/PutBuf도 ret=0 성공이지만 화면 변화가 없었다.

## Hardware
- **SoC**: SigmaStar SSD210 (dual Cortex-A7 1GHz)
- **Display**: nv3052c LCD, 540×960 물리해상도, TTL 6-bit, 59fps
- **FB**: 540×1920 (더블버퍼), BGRA32, stride 2160
- **OS**: FlythingsOS V2.1, glibc 2.30, kernel with MI modules
- **모델**: `Zkswe_SSD21X_SPINOR`, `ro.product.manufacturer=zkswe`

## 검증된 사실

### fbdev 경로 (실패)
- `/dev/fb0` open, mmap, write 모두 성공 (에러 없음)
- FBIOPAN_DISPLAY, FBIOPUT_VSCREENINFO, FBIO_BLANK 모두 성공
- VSCREENINFO: 540x960, virtual 540x1920, 32bpp, activate=16
- **결과: 화면에 아무것도 안 나옴** — 흰색/빨간색/초록색 모두 시도
- fbdev.ini: `FB_HWLAYER_ID=0, FB_HWWIN_ID=0, FB_TIMMING_WIDTH=1024, FB_TIMMING_HEIGHT=600`

### MI_DISP API 경로 (실패)
- dlopen으로 `/lib/libmi_sys.so`, `/lib/libmi_disp.so` 로드 성공
- `MI_SYS_Init()`: ret=0 (성공)
- `MI_DISP_GetInputPortAttr(0,0)`: ret=0
- `MI_DISP_EnableInputPort(0,0)`: ret=0
- `MI_DISP_ClearInputPortBuffer(0,0)`: ret=31
- `MI_SYS_ChnInputPortGetBuf(DISP:0:0:0, 540x960 ARGB8888)`: **ret=0**, handle 유효, vaddr=0x401d7000, stride=2160
- `MI_SYS_ChnInputPortPutBuf(handle, &bufInfo, 0)`: **ret=0**
- **결과: API는 전부 성공하지만 화면에 아무것도 안 나옴**

### zkgui/zkdisplay (정상 동작)
- zkdisplay (26KB): MI_PANEL_Init, MI_DISP_SetPubAttr, MI_DISP_Enable, MI_DISP_BindVideoLayer 등 호출
- zkgui (9KB → libzkgui.so 421KB): libnanovg.so + MI_GFX를 사용해 렌더링
- zkgui가 살아있으면 화면 정상 표시 (기본 Ulanzi 버튼 이미지)
- zkgui 죽이면 마지막 프레임이 남아있다가 화면이 검게 변함

### MI_GFX 경로 (성공)
- `libmi_gfx.so`는 `MI_GFX_Open`, `MI_GFX_QuickFill`, `MI_GFX_BitBlit`, `MI_GFX_WaitAllDone`를 export
- 처음에는 `dlsym` 실패처럼 보였지만, 실제 원인은 `libmi_gfx.so`가 `_MI_PRINT_GetDebugLevel`을 `libmi_sys.so`에서 찾으므로 `dlopen("libmi_sys.so", RTLD_NOW | RTLD_GLOBAL)`가 필요했던 것
- `/proc/{zkgui_pid}/maps`에서 `/dev/fb0` mapping offset이 `0x50101000`임을 확인
- fb ioctl이 돌려주는 `smem_start=0x30101000`는 CPU 관점 주소이고, **실제 MI_GFX에서 visible target으로 먹는 주소는 `0x50101000` bus alias**
- `MI_GFX_QuickFill()`로 `0x50101000` page0를 직접 칠하면 LCD에 즉시 반영됨
- `540x960` 단일 page만 칠해야 보이며, `540x1920` 전체 virtual surface를 한 번에 다루면 visible 결과가 불안정하거나 hang 가능
- `page0 = 0x50101000`, `page1 = 0x50101000 + 540*960*4 = 0x502fa400`
- `page1`에 CPU로 BGRA32를 쓰고 `MI_GFX_BitBlit(page1 -> page0)`하는 경로로 AgentDeck renderer 연결 가능
- 초기 검은 화면 원인은 page1이 비어 있는 상태에서 init 시점에 `BitBlit(page1 -> page0)`를 먼저 수행한 버그였음

### 빌드 환경
- Cross-compile: `zig cc -target arm-linux-gnueabihf.2.30` (동적) 또는 `arm-linux-musleabihf` (정적)
- 동적 빌드 시 기기의 glibc 2.30 + dlopen으로 MI 라이브러리 사용 가능
- 정적(musl) 빌드에서는 dlopen 불가

## 현재 결론

1. **직접 fbdev 표시 경로는 실패**: `/dev/fb0` write 자체는 되지만 visible layer가 아님
2. **MI_DISP input port 경로도 실패**: API는 성공하지만 visible target이 아님
3. **정답은 MI_GFX + zkgui와 동일한 bus alias**: visible target은 `0x50101000` page0
4. **실전 구현 방식**: 소프트웨어 렌더 결과를 staging page에 쓰고 `MI_GFX_BitBlit()`으로 visible page0에 복사

## 추가 접근법 / 후속 작업

### 1. MI_GFX 직접 사용
완료. `MI_GFX_QuickFill()`과 `MI_GFX_BitBlit()` 모두 사용 가능하며, visible target은 `0x50101000` page0.

### 2. nanovg 레이어 사용
zkgui가 libnanovg.so를 사용. nanovg는 MI_GFX 위에서 동작하는 2D 벡터 그래픽 라이브러리. 직접 사용 가능할 수 있음.

### 3. DISP VideoLayer z-order 조작
fbdev가 DISP의 VideoLayer 0에 바인딩되어 있지만, zkgui의 GFX 레이어가 더 높은 z-order에서 덮고 있을 수 있음. `MI_DISP_SetVideoLayerAttr`로 z-order 변경 시도.

### 4. zkdisplay의 초기화 시퀀스 완전 복제
zkdisplay를 역어셈블해서 정확한 MI API 호출 순서와 파라미터를 복제. 특히:
- `MI_DISP_SetPubAttr` 파라미터
- `MI_DISP_BindVideoLayer` 파라미터
- `MI_DISP_SetVideoLayerAttr` 파라미터

### 5. zkgui를 죽이지 않고 공존
부분적으로 확인 완료. zkgui 프로세스의 `/proc/{pid}/maps`에서 `/dev/fb0 offset=0x50101000`을 통해 visible bus alias를 찾을 수 있었다.

### 6. FlythingsOS UI 프레임워크 활용
zkgui는 FlythingsOS의 UI 프레임워크. `/dev/socket/zkdisp` UNIX 소켓을 통해 zkdisplay와 통신. 이 소켓 프로토콜을 역공학하면 렌더링을 제어할 수 있을 수 있음.

### 7. zkgui 직접 교체 (동적 링크)
기기의 MI 라이브러리들에 직접 링크한 우리 자체 GUI 바이너리를 만들어 zkgui 대신 실행. zkdisplay가 초기화한 후 우리 바이너리가 MI_GFX + MI_DISP로 렌더링.

## 기기에 있는 관련 파일

```
/lib/libmi_sys.so       (17KB) — MI System API
/lib/libmi_disp.so      (17KB) — MI Display API
/lib/libmi_panel.so     (9KB)  — MI Panel API
/lib/libmi_gfx.so       (9KB)  — MI 2D Graphics API
/lib/libmi_common.so    (14KB) — MI Common
/res/lib/libzkgui.so    (421KB) — FlythingsOS UI framework
/res/lib/libnanovg.so   — NanoVG 2D vector graphics
/lib/libzkhardware.so   (49KB) — GPIO, backlight, display control
/bin/zkdisplay          (26KB) — Display initialization daemon
/bin/zkgui              (9KB)  — UI application launcher
/misc/fbdev.ini         — Framebuffer device config
```

## MI SDK 참조

정확한 구조체 정의는 아래 오픈소스에서 확인:
- https://github.com/steward-fu/nds/blob/master/inc/mini/mi_sys_datatype.h (SSD202D)
- https://github.com/loop0728/zkgui_sample/blob/master/SSD_sample/jni/sdkdir/include/ (ZKSWE/FlythingsOS)
- https://wx.comake.online/doc/d8clf27cnes2-SSD20X/customer/development/mi/en/mi_sys.html (공식 문서)

주요 주의사항:
- `E_MI_MODULE_ID_DISP = 15` (9가 아님)
- `MI_SYS_BUF_HANDLE = MI_S32` (SSD20X 시리즈)
- `MI_SYS_Init(void)` — 파라미터 없음
- `MI_PHY = unsigned long long` (64비트)

## 버튼 입력 (해결됨)

GPIO 매트릭스 확인 완료:
- **출력 핀 (행)**: 4, 5, 6, 9, 85
- **입력 핀 (열)**: 0, 1, 84 (HIGH 풀업)
- 5×3 = 15 조합, 물리 14키에 충분
- sysfs GPIO 스캔으로 `OUT=6→IN=1`, `OUT=9→IN=1` 감지 확인
- 코드: `zkswe/agent/src/buttons.c` (sysfs GPIO 매트릭스 스캐너)
- 전체 14키 매핑은 미완료 (물리적으로 하나씩 눌러가며 캘리브레이션 필요)

## 프로브 도구

`zkswe/agent/` 디렉토리에 빌드된 ARM 바이너리:
- `gpio-probe` — chardev GPIO 열거/스캔
- `sysfs-probe` — sysfs GPIO 매트릭스 스캔 (버튼 발견에 사용)
- `hid-sniff` — /dev/hidg1 HID report 캡처
- `uart-sniff` — UART ttyS1 프로토콜 스니핑
- `fb-test` — 디스플레이 렌더링 테스트 (최신: MI_DISP API)
  - 최신 버전은 `--gfx`, `--copy-test`, `--maps` 모드로 MI_GFX / bus alias / page 검증 가능

## 기기 접근 방법

```bash
# USB 리플러그 후 4초 안에 실행
adb -s 0123456789ABCDEF shell "chmod 444 /sys/class/zkswe_usb/zkswe0/functions /sys/class/zkswe_usb/zkswe0/enable"

# zkgui 무력화 (bind mount)
adb -s 0123456789ABCDEF shell "mount -o bind /dev/null /bin/zkgui"
adb -s 0123456789ABCDEF shell "kill -9 $(ps | busybox awk '/zkgui_ui/{print $1}')"

# 바이너리 배포 (/data 4MB, /tmp tmpfs 16MB)
adb -s 0123456789ABCDEF push binary /tmp/binary
adb -s 0123456789ABCDEF shell "chmod +x /tmp/binary; LD_LIBRARY_PATH=/lib /tmp/binary"

# 백라이트 유지
echo 0 > /sys/class/backlight/soc:backlight/bl_power
echo 255 > /sys/class/backlight/soc:backlight/brightness
```
