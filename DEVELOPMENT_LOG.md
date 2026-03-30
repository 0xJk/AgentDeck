# AgentDeck Development Log

---

## 2026-03-30 — D200H: ADB 펌웨어 해킹 → 순정 HID 프로토콜 전환

### 문제
D200H 커스텀 펌웨어 개조 시도가 모두 실패:
- fbdev 직접 쓰기: ioctl 성공하지만 화면 출력 없음 (zkgui의 MI 하드웨어 레이어가 가림)
- MI_GFX 동적 바이너리: dlopen/BitBlit 성공하지만 visible target address가 부팅마다 drift → 검은 화면
- ADB 불안정: 첫 shell만 동작, reverse 행, 4초 ADB→HID 전환

### 해결
**D200H는 D200과 동일한 HID 프로토콜을 사용한다는 것을 발견** — 이미 커뮤니티가 완전히 역공학한 프로토콜.

검증 과정:
1. D200H USB 재연결 → 4초 후 HID 모드 (VID `0x2207` / PID `0x0019`) 확인
2. Python `hidapi`로 Consumer Control 인터페이스 열기 성공
3. `SET_BUTTONS` (ZIP: manifest.json + 196×196 PNG) 전송 → 화면 표시 확인
4. `DEVICE_INFO` 응답: `{"DeviceType":"D200","HardwareVersion":"SSD210V100","Dversion":"5.3.0"}`

### 핵심 설계 결정
- **ADB 경로 완전 포기**: 커스텀 온디바이스 에이전트, MI_GFX, GPIO 스캐닝 모두 불필요
- **순정 HID 프로토콜 채택**: `strmdck` 라이브러리와 호환, 1024바이트 고정 패킷
- **node-hid optionalDependencies**: node-pty와 동일 패턴 (네이티브 모듈 옵셔널)
- **두 HID 인터페이스**: Interface 0 (Consumer, usagePage=12) = 디스플레이/명령, Interface 1 (Keyboard, usagePage=1) = 버튼 이벤트
- **macOS 키보드 독점 문제**: 버튼 이벤트는 Keyboard 인터페이스를 통해 오는데 macOS가 독점 사용. Swift IOKit `IOHIDManager`로 해결 필요

### 후속 작업 (완료, 2026-03-30 후반)
- **D200hHidModule.swift** 구현: IOKit `IOHIDManager` + `kIOHIDOptionsTypeSeizeDevice`로 Keyboard 인터페이스 독점 열기 → 버튼 이벤트 수신. Consumer Control은 디스플레이 쓰기 + keep-alive. Core Graphics PNG 렌더링
- **ADB 코드 정리**: `AdbModule.swift` 400→120줄 (ADB reverse tunnel만 유지), `adb-reverse.ts` 390→115줄, `adb-module.ts` D200H 코드 제거
- **zkswe/agent/** → **zkswe/agent-archive/** 아카이브 (C 온디바이스 에이전트, GPIO/MI_GFX/HID 탐침 코드)
- DaemonServer에 D200hHidModule 등록 + broadcast 배선

### 미완료
- `agentdeck daemon start` → D200H 자동 감지 → 화면 갱신 실시간 통합 테스트
- macOS Xcode 빌드 검증 (IOKit framework linking)

---

## 2026-03-29 — ESP32 IPS 3.5" Portrait Mode + Multi-agent 버그 수정

### 문제
1. OpenCode 크리처가 ESP32/Stream Deck에 안 보임
2. 86 Box (CH340) daemon 시리얼 연결 안 됨
3. IPS 3.5" 세로 모드 지원 필요
4. IPS 3.5" 터치 미동작 (하드웨어 이슈로 판단 — 원본 펌웨어에서도 동일)

### 해결
1. **OpenCode 미표시**: `bridge/src/index.ts`에서 OpenCodeAdapter의 HookServer 초기화 누락 → `/health`에 state/agentType 없음 → sessions_list enrichment 실패. Plugin에서도 `proxiedAgentType`이 'opencode'를 인식 안 함 → `capsForProxiedAgent()` 헬퍼 추가
2. **CH340 미감지**: `esp32-serial.ts`의 `detectESP32Ports()`가 `ls /dev/cu.usb*`만 사용 → `cu.wchusbserial*` 누락. `ESP32_PORT_PATTERNS`에도 `cu.wchusbserial` 정규식 없음
3. **Portrait 모드**: `SCREEN_W`/`SCREEN_H` constexpr → `g_screenW`/`g_screenH` 런타임 전역변수. `UI::setOrientation()` + NVS 영속 + `set_orientation` 프로토콜 + Settings 토글. HUD portrait: 전체폭 상단 패널 + bottom-right 탱크 스택
4. **터치**: git checkout으로 원본 복원해도 동일 — 코드 변경 무관, FPC 커넥터 또는 라이브러리 업데이트 이슈

### 핵심 설계 결정
- `g_screenW`/`g_screenH` 전역변수 선택 (함수호출 대비 hot loop 성능 보존 — setPixel에서 수십만회/프레임 접근)
- canvas_buf 재할당 불필요 (320×480 = 480×320 = 동일 153,600px)
- 화면 전환 시 LVGL 스크린 전체 재생성 (부분 업데이트보다 단순하고 안전)
- NVS `Preferences` 사용 (ESP32 Arduino 내장, 추가 의존성 없음)

---

## 2026-03-29 — D200H 현재 점검: 실행 경로 불일치 정리

### 상황
- 저장소에는 D200H 디스플레이가 `MI_GFX + bus alias 0x50101000` 경로로 해결되었다는 기록이 있음
- 그러나 실제 실행 경로는 여전히 정적 musl 바이너리(`agentdeck-d200h`)를 우선 선택하고 있었고, 이 바이너리는 `dlopen(libmi_gfx.so)`를 쓸 수 없어 `/dev/mem` 또는 fbdev 폴백에 의존
- 그 결과 "문서상 해결"과 "실제 배포 바이너리"가 달라져, 재부팅 후 기본 UI 복귀나 검은 화면이 재현될 때 원인 판단이 꼬이기 쉬운 상태였음
- Apple Swift daemon의 `AdbModule.swift`는 아직 Node bridge의 single-shot foreground agent 전략을 따라오지 못하고, 여러 번의 `adb shell` 호출과 `input text` 기반 푸시에 머물러 있어 D200H 경로와 아키텍처가 어긋남

### 조치
- `bridge/src/adb-reverse.ts`에서 D200H 에이전트 선택 우선순위를 `agentdeck-d200h-dyn` → `agentdeck-d200h`로 변경
- `zkswe/agent/build.sh`가 메인 에이전트를 정적/동적으로 둘 다 빌드하도록 수정
- `--deploy`는 동적 glibc 바이너리(`agentdeck-d200h-dyn`)를 `/data/agentdeck`로 배포하도록 변경
- Swift `AdbModule.swift`를 Node bridge와 같은 single-shot foreground agent 구조로 재작성
- 산재한 D200H 기록을 `zkswe/D200H_STATUS.md`로 통합

### 현재 판단
- **D200H 디스플레이의 1차 가설은 "렌더링 기법 미해결"보다 "잘못된 바이너리/실행 경로 사용" 쪽이 더 강하다**
- Node bridge 경로를 기준 SSOT로 보고, Swift daemon도 동일한 foreground agent 전략으로 수렴시켰다
- 다음 실제 검증은 `fb-test --gfx --copy-test`와 동적 메인 에이전트 실행 로그를 같은 세션에서 확보하는 순서가 맞다

---

## 2026-03-29 — D200H 현재 점검: first-shell 로그로 MI_GFX 성공 확인, visible target 재의심

### 상황
- 재부팅 직후 첫 `adb shell`에서만 유의미한 정보가 나오는 경우가 많고, 그 이후 `adbd`가 쉽게 hang함
- 한동안 실험이 계속 오염됐는데, 원인 중 하나는 호스트에서 별도로 돌던 전역 프로세스:
  - `node /Users/puritysb/Library/pnpm/agentdeck opencode`
- 이 프로세스가 정적 `/data/agentdeck`용 `adb push`와 `adb shell`을 계속 되살려 로컬 repo 기준 테스트와 충돌했음

### 조치
- 전역 `agentdeck opencode` 프로세스를 강제로 종료
- D200H 실행 경로를 `/data/agentdeck-dyn`로 분리한 상태를 유지
- on-device agent stdout/stderr를 무버퍼로 변경
- device shell에 `sleep`이 없어 single-shot takeover 스크립트에서 `sleep 1` 제거
- first-shell takeover를 직접 실행해 startup 로그를 확보

### first-shell startup 로그 핵심
- `AgentDeck D200H Agent v1.0`
- `fb0 smem_start=0x30121000 line_length=2160`
- `MI_GFX backend initialized (bus_base=0x50121000)`
- `MI_GFX: active`
- `Framebuffer OK (960x540)`

### 현재 판단
- 동적 agent는 실제로 실행되고, `MI_GFX` 초기화도 성공함
- 그런데 이 부트에서 agent가 선택한 타깃 `0x50121000`은 여전히 검은 화면이었음
- 반면 저장소 기록과 과거 실기기 성공 경로는 `0x50101000`
- 따라서 지금의 가장 강한 가설은:
  - takeover 자체는 됨
  - 문제는 `MI_GFX` 존재 여부가 아니라 **visible target 주소 드리프트**

### 후속 조치
- `zkswe/agent/src/framebuffer.c`와 `zkswe/agent/src/fb_test.c`를 다시 수정해
  D200H에서는 `0x50101000`을 우선 사용하도록 변경
- 새 `agentdeck-d200h-dyn`를 재빌드
- 그러나 직후 실검은 ADB window collapse와 stock firmware 복귀 때문에
  끝까지 안정적으로 검증하지 못함

---

## 2026-03-29 — Native USB 보드 복구 절차 확정 + 플래시 안전장치 강화

### 문제
3.5" IPS와 Round AMOLED가 잘못된 펌웨어로 인해 Native USB가 부팅 직후 끊기는 상태가 되었고, 기존 포트 번호 기반 플래시 습관으로는 동일 사고가 다시 날 수 있었음.

### 해결
- **IPS 3.5" 실기기에서 BOOT/RST 물리 버튼 확인**: 분해 사진 기준 좌상단 daughterboard에 `BOOT`, `RST` 스위치 존재
- **복구 절차 검증**: `BOOT` 누른 채 USB 연결 또는 `RST` 펄스 → `/dev/cu.usbmodem*` 지속 노출 → `pio run -e ips_35 -t upload --upload-port ...` 성공
- **Round AMOLED도 동일 방식으로 복구**: BOOT/RST로 다운로드 모드 진입 후 `round_amoled` 전체 펌웨어 업로드 성공
- **결론 정리**: 두 보드 모두 "완전 벽돌"이 아니라 잘못된 앱이 Native USB를 끊는 상태였음. BOOT/RST로 ROM 다운로드 모드 진입 가능하면 정상 복구 가능
- **문서 보강**: `CLAUDE.md`에 ESP32 Flash Safety 규칙 추가
- **스크립트 보강**: `esp32/scripts/flash.sh`를 포트 번호 추정 대신 `device_info_request` 기반 식별로 변경하고, 응답 없는 Native USB 보드는 명시적 env/port 없이는 중단하도록 강화

### 교훈 / 핵심 설계 결정
- **Native USB 보드는 포트명 자동 매핑이 아니라 보드 응답 기반 식별이 유일하게 안전하다**
- **복구 모드에서는 `device_info_request`가 안 되므로 사람이 env를 명시해야 한다**
- **복구 직후 계속 esptool이 즉시 붙으면 BOOT(GPIO0)가 계속 LOW인 상태를 먼저 의심한다**

---

## 2026-03-29 — D200H on-device agent: GPIO 버튼 + 디스플레이 렌더링 해결

### 문제
ULANZI D200H (SSD210)에 커스텀 대시보드를 렌더링하고 14키 물리 버튼을 읽어야 함.

### 해결 (버튼 — 완료)
- 초기 가설: GPIO 매트릭스 → HID gadget으로 전환 → 다시 GPIO로 복귀
- `/dev/hidg1`에서 HID report를 읽을 수 있었으나, 이는 zkgui가 호스트PC로 보내려고 **write한** 데이터였음 (MCU→SSD210 방향 아님)
- zkgui 죽인 후 `/dev/hidg1` 데이터 없음 → GPIO가 실제 버튼 입력 경로 확인
- sysfs GPIO 스캔으로 `OUT=6→IN=1`, `OUT=9→IN=1` 감지. 출력 {4,5,6,9,85}, 입력 {0,1,84}

### 해결 (디스플레이 — 완료)
- fbdev (`/dev/fb0`) mmap/write: 모든 ioctl 성공하지만 화면 변화 없음
- MI_DISP API (dlopen): `GetBuf`/`PutBuf` ret=0 성공하지만 화면 변화 없음
- `/proc/{zkgui_pid}/maps` 확인 결과, zkgui는 `/dev/fb0`를 `offset=0x50101000`으로 매핑하고 MI_GFX를 사용
- **핵심 발견**: visible target은 fbdev가 보고하는 `smem_start=0x30101000`이 아니라, GFX에서 접근하는 bus alias `0x50101000`의 **page0**
- `MI_GFX_Open()`은 처음엔 실패했으나, 원인은 `libmi_gfx.so`가 `_MI_PRINT_GetDebugLevel`을 `libmi_sys.so`에서 동적 해석해야 하는데 `dlopen(..., RTLD_GLOBAL)`이 빠졌던 것
- `MI_GFX_QuickFill()`로 `0x50101000` page0를 직접 칠하면 AgentDeck 화면이 실제 LCD에 표시됨
- `framebuffer.c`를 수정해 소프트웨어 백버퍼를 `/dev/fb0` page1에 쓴 뒤 `MI_GFX_BitBlit()`으로 visible page0에 복사하는 MI backend로 교체
- 초기 검은 화면 원인은 MI backend init 직후 비어 있는 page1을 page0로 복사한 버그였고, 초기 bitblit 제거로 해결
- 최종적으로 `/tmp/agentdeck --stdin` 실행 시 D200H에서 AgentDeck UI 표시 확인

### 핵심 설계 결정
- 버튼: sysfs GPIO 매트릭스 스캔 (`buttons.c`), 20ms 주기, open/close 방식 (lseek 불안정)
- 통신: Bridge `dispatchCommand()` + D200H agent stdout JSON 파싱 (stdin 모드)
- zkgui bind mount 무력화: `mount -o bind /dev/null /bin/zkgui` (init 재시작 차단)
- MI SDK 구조체: steward-fu/nds + loop0728/zkgui_sample에서 확인 (`E_MI_MODULE_ID_DISP=15`)
- MI_GFX 로더: `libmi_sys.so`, `libmi_gfx.so`는 `RTLD_GLOBAL`로 열어야 `_MI_PRINT_GetDebugLevel` 해석 가능
- D200H 렌더 target: `0x50101000` bus alias의 page0 (visible), page1은 staging source로 사용 가능
- agent 렌더 구조: draw는 기존 소프트웨어 경로 유지, `fb_present()`만 MI_GFX bitblit backend로 교체
- 디스플레이 조사 문서: `zkswe/DISPLAY_RESEARCH.md`, 이어서 작업 프롬프트: `zkswe/PROMPT.md`

---

## 2026-03-29 — Simulator 기준 전 플랫폼 캐릭터 shape language 통일

### 문제
각 플랫폼 renderer가 독자적으로 캐릭터를 그리고 있어서 simulator(SSOT)와 괴리 발생. Claude는 플랫폼마다 14×5 pixel grid, 8×12 glyph, 6-lobe cloud 등 제각각. OpenCode 캐릭터는 대부분 플랫폼에서 미구현.

### 해결
Simulator `tools/creature-simulator/index.html`의 `PIXEL_GRIDS`를 기준으로 전 플랫폼 정렬:

| 캐릭터 | Simulator Grid | 반영 플랫폼 |
|--------|---------------|------------|
| Claude | 12×8 block glyph (claudecode-color.svg) | ESP32 octopus.cpp, Pixoo |
| Codex | 12×10 smooth pill (codex-color.svg) | ESP32 cloud.cpp, Pixoo, Android E-ink |
| OpenCode | 10×9 nested-square (opencode-logo) | ESP32 (신규), Pixoo (신규), TUI (신규), Android (신규), Apple (신규), Stream Deck (신규) |

### 핵심 설계 결정
- **ESP32 octopus**: 14×5 portrait-rect pixel grid (Android 스타일) → 12×8 square-cell block glyph. arm/leg 셀타입 애니메이션 제거, sparkle line working effect로 대체
- **ESP32 cloud**: 6-blob cumulus circle overlap → 12×10 pill glyph grid. 상단 3행 gradient 유지, >_ prompt overlay 단순화
- **Pixoo creatureTypeFor()**: 2타입(octopus/jellyfish) → 3타입(+opencode). drawOpenCode() 신규 + OpenCode 색상 팔레트
- **TUI OpenCode**: braille가 아닌 box-drawing 문자(┌─┐│└─┘)로 렌더. 유일하게 비생물형 캐릭터
- **Stream Deck watermark**: 72px 통일 (Claude scale 6→4.5, OpenClaw 120→72px). Codex/OpenCode 로고 추가
- **Deploy 스킬**: ESP32 플래시 전 device_info 확인 필수 절차 추가. 포트↔보드 매핑 실수 방지

### 교훈
- ESP32-S3 JTAG 보드(IPS/Round)는 usbmodem 포트가 USB 허브 위치에 따라 변동. **반드시 device_info_request로 보드 식별 후 플래시**. 잘못된 display driver firmware → 화면 안 켜짐 + USB 재등록 실패
- Linter가 코드를 되돌리는 경우가 있으므로, 변경 후 실제 반영 여부를 빌드/grep으로 재확인 필요

---

## 2026-03-29 — Swift Native Daemon for Mac App Store

### 문제
AgentDeck daemon이 Node.js 의존으로 설치 장벽 높음 (`npm install -g @agentdeck/bridge` + `agentdeck daemon install`). Mac App Store 단일 앱 배포 불가.

### 해결
daemon-server.ts 전체를 **Swift로 재작성** (29 files, ~4800 LOC). macOS 앱(`apple/AgentDeck/Daemon/`)에 in-process 통합.

**핵심 아키텍처**: 별도 daemon 프로세스가 아니라 앱 안에서 직접 실행
- `DaemonService` → `DaemonServer.startServices()` — 앱 시작 시 자동 기동
- WS 서버 (Network.framework) + HTTP 서버 (커스텀 TCP 파서) — 같은 포트 불가하여 port/port+1
- `MenuBarExtra` — Show Dashboard / Launch Session / Start at Login / Quit
- 기존 대시보드(`AgentStateHolder`)는 `ws://127.0.0.1:{port}`로 in-process daemon에 연결

**외부 의존 완전 제거**:
- python3 (CoreGraphics) → `CGDisplayIsAsleep()` 직접 호출
- osascript (볼륨/밝기) → CoreAudio `AudioObjectGetPropertyData` + IOKit `IODisplaySetFloatParameter`
- bonjour-service → Network.framework `NWListener.Service`
- ws/express → Network.framework 네이티브 WS + 커스텀 HTTP

**"설치 한 번이면 끝" 기능들**:
- `HookInstaller` — 앱 시작 시 `~/.claude/settings.local.json`에 hooks 자동 설치
- `SessionLauncher` — 메뉴바에서 Terminal.app으로 `agentdeck claude` 실행
- `DaemonVoiceAssistant` — AVAudioEngine + whisper + AVSpeechSynthesizer
- `PixooRenderer` — 상태→64x64 RGB 픽셀 프레임 변환 (3x5 폰트 내장)

### 핵심 설계 결정
1. **SMAppService.agent()가 아닌 in-process 방식 채택**: agent 바이너리 분리 시 App Review 리스크 + 코드 공유 어려움. 앱 자체가 daemon + dashboard 겸용. Login Item으로 자동 시작
2. **Singleton guard**: Node.js daemon이 이미 실행 중이면 Swift daemon 시작 안 함 → 기존 Node.js 인프라와 공존 가능
3. **HTTP 포트 분리**: Network.framework에서 WS + HTTP 같은 포트 불가 → HTTP는 port+1, 실패 시 port+2~+10 자동 시도
4. **`[String: Any]` Sendable 문제**: Swift 6 strict concurrency에서 dict가 actor 경계를 넘을 수 없음 → `SendableDict` wrapper + `broadcastRaw(Data)` 패턴
5. **GatewayProbe 크래시**: `withCheckedContinuation` + NWConnection `stateUpdateHandler`에서 timer/state 이중 resume → POSIX socket `poll()` 방식으로 교체
6. **MCP는 AgentDeck 제어에 부적합**: MCP 방향이 반대 (Claude→MCP Server). 외부 앱이 Claude Code를 제어하는 유일한 공식 메커니즘은 **Hooks**
7. **80/20 배포 전략**: Mac App(hooks) → 모니터링+권한응답 (80% 사용자), CLI Bridge 추가 → 옵션 선택/모드 전환/diff (20% 파워 유저)

### 파일 (apple/AgentDeck/Daemon/)
- `Server/` — DaemonServer, WebSocketServer, HTTPServer, AuthManager
- `Core/` — StateMachine, DaemonLogger, UsageAPIClient, HookInstaller, SessionLauncher
- `Session/` — SessionRegistry, SessionAggregator, TimelineRelay
- `Modules/` — ESP32Serial, SerialModule, AdbModule (D200H), MdnsModule, PixooModule, PixooRenderer, WifiConfig, ModuleManager
- `System/` — DisplayMonitor, UtilityProxy
- `Gateway/` — OpenClawAdapter (Ed25519 CryptoKit), GatewayProbe
- `Timeline/` — DaemonTimelineStore, TimelineSummarizer, BridgeLogStream
- `Voice/` — DaemonVoiceAssistant
- `DaemonService.swift` — in-process lifecycle + Login Item

---

## 2026-03-29 — macOS 앱 세션 실행 fallback 정리

### 문제
메뉴바의 `Launch Claude Session`이 여전히 `agentdeck claude` 전용 경로에 묶여 있어, Swift native daemon을 앱에 통합한 뒤에도 Claude Code CLI만 설치된 환경에서는 앱에서 세션 시작이 불가능했음. 이는 "App Store 단일 앱 + hooks 기반 80/20 전략"과 어긋남.

### 해결
- `SessionLauncher.swift`에 실행 계획 해석 로직(`resolveLaunchPlan`) 추가
- 우선순위를 `installed bridge` → `bundled bridge` → `plain claude`로 정리
- plain `claude` 실행에도 현재 daemon 포트를 `AGENTDECK_PORT`로 주입하도록 변경
- 프로젝트 경로가 있으면 `cd <project> && ...` 형태로 시작하도록 정리
- macOS 단위 테스트 `SessionLauncherTests.swift` 추가

### 핵심 설계 결정
- **Bridge는 옵션, Claude CLI는 필수**: Bridge가 없어도 hooks 기반 모니터링/권한 응답이 가능하므로, 런처는 plain `claude`를 1급 경로로 지원해야 함
- **포트는 런처에서 명시 전달**: plain `claude`는 기본적으로 `AGENTDECK_PORT`를 모르므로, 메뉴바 런치 시 앱 daemon 포트를 명시해 hook 타깃을 고정
- **실행 선택 로직은 순수 함수화**: AppKit/Terminal 실행과 분리해 테스트 가능하게 만듦

---

## 2026-03-29 — OpenCode Agent Integration

### 문제
AgentDeck이 Claude Code와 Codex CLI만 지원. OpenCode (Go 기반 코딩 에이전트) 추가 필요.

### 해결
OpenCode가 구조화된 HTTP API + SSE 이벤트를 제공한다는 것을 발견 (`opencode serve`, `GET /global/event`). 처음에는 API-only(non-PTY) 방식으로 구현했으나, 사용자가 TUI에서 직접 작업하길 원해 **PTY + SSE 하이브리드** 방식으로 전환.

**최종 구조**: `OpenCodeAdapter extends PtyAdapter`
- PTY: `opencode --port XXXX` — 사용자가 TUI에서 직접 코딩
- SSE: 내장 서버의 `/global/event`에 연결 — 구조화된 이벤트 수신
- TUI 파싱 불필요 — SSE가 상태/도구/토큰/모델 정보를 모두 제공

### 핵심 설계 결정
1. **SSE 이벤트가 TUI 파싱을 완전 대체**: Codex CLI는 TUI 출력을 regex로 파싱(CodexOutputParser)하지만 OpenCode는 SSE 이벤트가 있어 `wireOutputParser()`와 `feedParser()`가 no-op. 더 안정적이고 유지보수 용이
2. **내장 서버 포트**: `opencode --port XXXX`로 실행하면 TUI와 HTTP 서버가 동시에 뜸. 어댑터가 랜덤 포트(14096+) 할당
3. **세션 자동 추적**: SSE의 `session.status` 이벤트에서 첫 번째 세션을 자동으로 추적
4. **OpenCode API 검증**: `opencode serve` + curl로 직접 검증. SSE 이벤트 타입: `session.status` (busy/idle), `message.part.updated` (tool/text/step-finish), `message.updated` (model/tokens/cost), `permission.requested`
5. **setPtyMode 분기**: `hasTerminal` 기반으로 변경 — non-PTY 어댑터(Monitor, OpenClaw)에서 stderr 로그가 숨겨지는 버그 수정

### 파일
- `bridge/src/opencode-client.ts` — HTTP API 클라이언트 + SSE EventSource
- `bridge/src/adapters/opencode-adapter.ts` — PtyAdapter + SSE 하이브리드
- `bridge/src/__tests__/opencode-client.test.ts` — 클라이언트 단위 테스트 (13개)
- `shared/src/adapter.ts` — `'opencode'` AgentType + OPENCODE_CAPABILITIES
- `bridge/src/cli.ts` — `agentdeck opencode` CLI 커맨드

---

## 2026-03-26 — Usage 리셋 버그 + E-ink 시간 표시 잘림 + Daemon 좀비 프로세스

### 문제
1. **Usage % 미리셋**: 5h/7d 윈도우 만료 시 시간은 "now"로 표시되나 사용량 %는 이전 값 유지
2. **E-ink 리셋 시간 잘림**: `EinkStatusCompact`의 gauge+percent+reset을 한 줄(`maxLines=1`)에 넣어 "4h 12m"이 "4h"로 잘림. 태블릿/Apple은 별도 줄이라 문제 없음
3. **Pantone 6 rotation 실패**: APK 재설치 시 `WRITE_SETTINGS` 권한 초기화 → RK3566의 system rotation fallback 무효
4. **Daemon 좀비**: `httpServer.close(callback)` — CLOSE_WAIT 연결이 드레인 안 되면 callback의 `process.exit(0)` 미실행, 프로세스가 LISTEN 소켓 없이 좀비화

### 해결
1. `adjustUsagePercent(percent, resetsAt)` — `resetsAt <= now`이면 0% 반환. Bridge broadcast 계층(`usage-event.ts`)에 적용하여 모든 WS 클라이언트 일괄 수정. Plugin standalone fetch 경로도 동일 적용. Apple `formatResetTime` nil→"now" 수정
2. E-ink `GaugeText`에서 리셋 시간을 `⟲ 4h 12m` 별도 줄로 분리 — 태블릿 `WaterGauge` 포맷과 통일
3. `onCreate` 즉시 `requestedOrientation = LANDSCAPE` + `applySystemRotation()` 호출 (DataStore 비동기 대기 제거). `!canWrite()` 시 `ACTION_MANAGE_WRITE_SETTINGS` 자동 열기
4. `setTimeout(() => process.exit(0), 5000).unref()` — Session bridge에는 이미 3초 failsafe 있었으나 daemon에만 누락

### 교훈 / 핵심 설계 결정
- **Bridge broadcast 계층이 최적의 수정 지점**: 모든 클라이언트(TUI/Android/Apple/ESP32)가 WS로 데이터 수신 → bridge에서 한 번 보정하면 전체 적용
- **E-ink 30% 컬럼에 monospace 한 줄은 22자 초과 시 잘림**: 향후 E-ink 텍스트는 가로 여유 확인 필수
- **`httpServer.close()` 콜백은 보장되지 않음**: CLOSE_WAIT 연결이 있으면 무한 대기. 항상 shutdown timeout 패턴 적용
- **특수 권한(`WRITE_SETTINGS`)은 APK 재설치 시 초기화**: manifest 선언만으로 부족, 앱에서 자동 요청 로직 필수

---

## 2026-03-25 — Robot 리포트 시나리오 상세화 + ESP32 퍼포먼스 벤치마크 + 실기기 테스트 안정화

### 문제
1. **Robot 탭이 플랫 리스트** — 33개 테스트가 구조 없이 나열, 시나리오/보드 매핑 불가
2. **리포트에 실행 시간 미표시** — output.xml에 `elapsed` 있지만 무시
3. **metadata 불일치** — `run-metadata.json`이 stale하면 Android/Robot이 NOT RUN으로 표시
4. **실기기 테스트 불안정** — daemon 시리얼 점유, 포트 이름 변동, 이미 부팅된 기기 미인식

### 해결
1. **Robot 탭 3단 구조**: Suite(file-block) → Scenario(describe-group, board matrix ✓/✗) → BDD Steps (Given=파란, When=노란, Then=초록) → 개별 test cases + elapsed
2. **Performance Table**: Board × Metric 비교 테이블 (Build, Flash+Boot, Boot Time, FW Size, Heap, Latency). `[PERF]` log 메시지 자동 추출
3. **metadata 자동 보정**: 실제 데이터 존재 시 `executed: false` 자동 override
4. **ESP32Serial.py 확장**: `Get Boot Time`, `Measure Response Latency`, `Measure Burst Throughput`, `Get Inventory Port`, `Scan All Ports` 키워드
5. **이미 부팅된 기기 fallback**: boot marker timeout 시 `device_info_request` 프로브로 대체
6. **variables.py**: `ulanzi_tc001` 보드 설정 누락 수정 (500KB–2MB)
7. **platformio.ini**: `boot_test` 환경에 pioarduino platform 추가 (PIO 미러 장애 우회)

### 교훈 / 핵심 설계 결정
- **Robot output.xml의 `<status elapsed="">` 속성**이 keyword-level까지 제공 — 커스텀 타이머 없이 빌드/플래시/부트 시간 추출 가능
- **시리얼 포트 이름은 USB 리플러그마다 변동** — 정적 인벤토리만으로 부족, `device_info_request` 프로브 기반 자동 식별 필요
- **daemon이 시리얼 점유 시 Robot 테스트 불가** — 테스트 전 daemon 중지 필수. 향후 daemon에 "test mode" (시리얼 양보) 추가 고려
- **ESP32가 이미 실행 중이면 boot marker 미출력** — `connected and booted` 키워드에 fallback probe 패턴 필수 (boot timeout → device_info probe)

---

## 2026-03-24 — 테스트 프레임워크 분석 + hooks 유령 테스트 수정 + 리포트 탭 SPA 전환

### 문제
1. **hooks 테스트 coverage 0%** — `install.test.ts`가 실제 소스를 import하지 않고 핵심 로직을 테스트 파일 내에서 재구현. 20개 테스트가 통과하지만 소스 코드는 한 번도 실행되지 않는 "유령 테스트" 상태
2. **테스트 리포트가 flat 파일 리스트** — 26개 파일이 의미 없이 나열되어 테스트 목적 파악 불가
3. **리포트 생성 시 vitest.json 누락** — `--coverage`와 `--reporter=json` 별도 실행 시 서로 덮어쓰는 문제

### 해결
1. `hooks/src/install.ts` 리팩터링: 순수 로직 함수 export (`applyHooks`, `removeHooks`, `migrateHooks`) + `migrateHooksIfNeeded` 파일시스템 래퍼. Bridge의 44줄 중복 마이그레이션 코드를 `import { migrateHooksIfNeeded } from '@agentdeck/hooks'`로 대체
2. 테스트 리포트를 **탭 기반 SPA**로 전면 재설계: 사이드바 네비게이션 (Overview + 10개 테스트 레이어 + Android + Robot + Scenarios + Coverage). 각 레이어 탭에 목적 질문(한국어), describe 블록별 그룹핑, 모든 테스트 케이스 기본 표시
3. `test-report.sh`의 `run_vitest()`에 `--reporter=default --coverage` 추가하여 한 번의 실행으로 JSON + coverage 동시 생성

### 교훈 / 핵심 설계 결정
- **테스트가 소스를 import하지 않으면 coverage 0%** — 재구현 기반 테스트는 소스와의 동기화가 깨질 수 있고, 소스 버그를 발견할 수 없다. 순수 로직을 export하여 테스트 가능하게 만드는 것이 정답
- **테스트 리포트는 "왜 이 테스트가 존재하는가"를 전달해야 함** — 파일 이름 나열이 아닌 목적별 레이어 분류 + 검증 질문이 핵심. 10개 레이어: Terminal Parsing / State Machine / Timeline / Daemon / Integration / Plugin UI / TUI / Serial / Display / Hooks
- **Robot Framework output.xml 파싱 방어** — Robot 7에서 `</robot>` 이후 잔여 데이터가 붙는 케이스가 있어, truncation 후 retry 로직 추가

---

## 2026-03-24 — Ulanzi TC001 플래싱 실패 복구 (CH340 baud rate 문제)

### 문제
Ulanzi TC001 펌웨어 플래싱이 비정상 종료. 재시도 시 esptool이 firmware.bin 기록 ~9% 지점에서 "The chip stopped responding" 에러로 반복 실패. baud rate 460800 사용 중이었음.

### 해결
- 빌드 아티팩트 점검: bootloader.bin, partitions.bin, firmware.bin 3파일 정상, 최신 소스 반영 확인
- baud rate를 **115200으로 하향** → full flash (3파일) 성공, 71초 소요
- 부팅 검증: WiFi 자동 연결, mDNS daemon 발견, LED matrix 정상 동작

### 교훈 / 핵심 설계 결정
- **CH340 USB-UART는 460800 baud에서 불안정** — ESP32-S3 Native USB CDC와 달리 CH340은 높은 baud rate에서 데이터 손실 발생. Ulanzi TC001 플래시 시 **115200 baud 필수**
- 비정상 종료 의심 시 firmware만이 아닌 **bootloader+partitions+firmware 3파일 full flash**가 안전
- esptool CLI deprecated 문법 정리: `esptool.py` → `esptool`, `write_flash` → `write-flash`, `--flash_mode` → `--flash-mode`

---

## 2026-03-23 — 에이전트 아이콘/세션 목록 전체 플랫폼 통일 + ESP32 플랫폼 전환

### 문제
에이전트 세션 목록의 아이콘, 상태 표시, 정렬 순서가 플랫폼마다 파편화. Apple은 Anthropic "A" + 🦞 이모지, Android는 🐙, TUI는 ☁️ 등 비일관. 세션 순서도 플랫폼마다 달랐고, Apple에서 크리처 겹침 발생. ESP32 86Box는 PIO 미러 장애로 `espressif32@^6.9.0` 빌드 불가.

### 해결
- **아이콘 통일**: claude.svg (Claude 스파클) + openai.svg (OpenAI 매듭) + openclaw.svg (가재) — Apple/Android SVG path (`BrandIcon.kt`), TUI 유니코드 (✻/❯/🦞)
- **상태 점 제거**: Apple/Android 세션 목록에서 색상 점 삭제, 상태 텍스트에 색상 적용
- **세션 정렬 통일**: 모든 플랫폼 — stateRank(processing>awaiting>idle>disconnected) + projectName 알파벳순
- **Apple 겹침 수정**: siblings를 ID 기반 정렬 → 안정적 슬롯 할당. 2-세션 Y간격 확대, 3-세션 삼각 배치
- **ESP32 86Box**: pioarduino(ESP-IDF 5.x)로 전환 — `mdns_discovery.cpp`에 `BOARD_BOX_86` ifdef 추가
- **ESP32 HUD**: `hud_bar.cpp`에 codex-cli `CloudBody` 인디고 색상 추가
- **배포**: Bridge, macOS, Android 3대, ESP32 3대(Round AMOLED, 86Box, IPS 3.5") 완료

### 교훈 / 핵심 설계 결정
- **PIO 글로벌 lock**: 다른 세션의 `pio run`이 lock을 잡으면 모든 빌드 hang — `ps aux | grep pio` 확인 필수
- **pioarduino vs espressif32**: ESP32-S3 보드는 pioarduino (ESP-IDF 5.x), Ulanzi TC001(ESP32 classic)은 espressif32@^6.9.0 필수. mDNS API 분기(`MDNS.address()` vs `MDNS.IP()`)
- **PIO `| tail` 파이프 hang**: PIO 출력을 파이프로 필터링하면 버퍼링으로 hang 발생 — 파이프 없이 실행 권장
- **Android PathParser arc flag 비호환**: `androidx.core.graphics.PathParser`는 SVG arc 명령어의 플래그 압축(`01` → `0 1`)을 지원하지 않음. Apple의 SVG path를 Android에서 재사용 시 `fixArcFlags()` 전처리 필수. `AgentMark.kt`의 기존 경로는 arc 미사용이라 문제 없었음

---

## 2026-03-23 — GitHub Pages test report with scenario coverage matrix

### 문제
테스트 프레임워크 정비(Vitest 850+, Android 82, Robot 8)가 완료되었으나 결과를 팀에서 쉽게 열람할 방법이 없었고, 주요 사용자 시나리오별 테스트 커버리지가 어느 정도인지 한눈에 파악 불가.

### 해결
- **GitHub Pages 자동 배포**: `.github/workflows/test-report.yml` — push to master 시 Vitest + Android JUnit + Robot Framework(no-hw) 실행 → `generate-html-report.py`로 HTML 대시보드 생성 → Pages artifact 배포
- **시나리오 매트릭스**: `scenario-matrix.json`에 10개 핵심 사용자 시나리오(Session Lifecycle, Permission Flow, Multi-agent Monitoring 등) 정의, vitest JSON 결과와 크로스 레퍼런스하여 unit/integration/platform/e2e 커버리지 상태를 색상 코딩 표시
- **테스트 카테고리 태그**: 파일명 패턴으로 `[unit]`/`[integration]`/`[snapshot]` 자동 분류 + 필터 버튼
- **히스토리 스파크라인**: `history.json` 50건 유지, 배포 간 `curl`로 전달, 2회차부터 SVG 스파크라인 표시
- **랜딩 페이지**: `scripts/pages-index.html` — 루트에 프로덕트 소개, `/reports/`에 테스트 리포트
- **Robot Framework CI**: `pip install robotframework platformio` → `no-hw` 태그 빌드 테스트만 실행 (하드웨어 불필요)

### 핵심 설계 결정
- `ci.yml`과 `test-report.yml` 분리 — CI는 빠른 피드백(test+typecheck만), Pages 배포는 별도 워크플로우에서 전체 프레임워크 실행
- `gh-pages` 브랜치 대신 Actions artifact 기반 배포 — 브랜치 오염 방지
- vitest `|| true` — 스냅샷 테스트 환경 차이(CI vs 로컬)로 실패해도 배포 차단하지 않음, 결과는 리포트에 반영
- Robot Framework `--include no-hw --exclude hw` — CI에서 실행 가능한 빌드 테스트만 선별

---

## 2026-03-23 — Daemon crash on device disconnect

### 문제
Dashboard 기기(ESP32, Android 등)가 끊어질 때 daemon이 크래시됨.

### 해결
`ws-server.ts`에서 3가지 크래시 경로 수정:
1. **Set iterator 무효화** — ping timer가 `wss.clients` Set을 순회하면서 `ws.terminate()` 호출 → ws 라이브러리가 Set에서 동기적으로 제거 → iterator 깨짐. Dead 클라이언트를 배열에 모은 후 루프 밖에서 terminate하도록 수정. `close()` 메서드도 `[...wss.clients]` spread.
2. **`send()` throw** — `readyState === OPEN` 체크 후에도 socket이 CLOSING으로 전이 가능 → `broadcast()`, `broadcastExcept()`, `sendTo()` 세 메서드에 try-catch 추가.
3. **SSE 초기 write** (`hook-server.ts`) — `writeHead()` 직후 클라이언트 즉시 끊김 시 state snapshot write에서 throw → try-catch 추가.

### 교훈
- `ws` 라이브러리의 `wss.clients`는 live Set — `terminate()`/`close()` 호출 시 동기적으로 수정됨. 순회 중 변경 불가.
- `readyState` 체크는 TOCTOU 취약 — `send()`는 항상 try-catch 필요.

---

## 2026-03-22 — Codex CLI 어댑터 + 구름 크리처 전 플랫폼 구현

### 문제
AgentDeck이 Claude Code만 지원하여 다른 코딩 에이전트(OpenAI Codex CLI 등) 확장 불가.

### 해결

**1. Codex CLI 어댑터 (bridge)**
- `CodexCliAdapter` extends `PtyAdapter` — `codex` PTY 스폰, `CodexOutputParser` 연결
- `CodexOutputParser` — Codex Ink TUI 출력 패턴 감지: `›` 프롬프트(U+203A), `Working(0s •` 스피너, 상태줄 모델 추출
- `agentdeck codex` CLI 명령 추가, agent-aware 의존성 체크 (`checkDependencies(agentType)`)
- `AgentType` union에 `'codex-cli'` 이미 선언되어 있었으나 미구현 → 완전 구현

**2. 구름 크리처 (전 플랫폼)**
- **Apple**: 6개 원 겹치기 + `drawLayer` clip으로 seam-free 그라데이션. `>_` morphing 애니메이션
- **Android LCD**: `CloudCreature.kt` — 동일 6-lobe 패턴, Compose Canvas `drawCircle` + `Brush.linearGradient`
- **Android E-ink**: `drawEinkCloud()` — 16-level 그레이스케일
- **TUI**: 14×10 braille grid
- **ESP32**: `cloud.cpp` — LVGL filled circles + pixel `>_`

**3. Apple 배포 인프라 완성**
- Mac App Distribution + Mac Installer Distribution 인증서 생성
- iOS + macOS TestFlight 업로드 성공 검증
- CI workflow `if: false` 제거, ExportOptions-macOS.plist 분리
- GitHub Secrets 7개 (인증서 + 프로파일 + ASC API key)

**4. Apple 겹침/UX 버그 수정**
- `CreatureLayout.swift`: `case 0` → 빈 배열, grid 경계 수정
- `OctopusCreature.swift`: `currentY` 초기값 `standingY` → `homeY`
- `BridgeDiscovery.swift`: `.waiting` 상태 감지 → 자동 `restartBrowser()` (로컬 네트워크 권한 후 앱 재시작 불필요)
- `DisplaySyncService.swift`: 5분 안전 타이머, brightness 0.0 저장 방지

### 교훈 / 핵심 설계 결정
- **Codex CLI는 HTTP hooks 없음** — PTY 파싱만으로 상태 감지. `›` 프롬프트 + `Working(Ns •` 패턴이 핵심
- **6-lobe circle 겹침선**: 개별 circle fill → alpha 중첩/even-odd 구멍. Apple은 `drawLayer` + clip으로 해결, Android는 동일 gradient brush 공유로 해결
- **Pantone 6 (MOAAN)**: 앱 재설치 시 시스템 회전 설정 초기화 — `adb shell settings put system user_rotation 1` 필수
- **macOS App Store 배포**: `LSApplicationCategoryType` Info.plist 필수, rsync Homebrew/system 충돌 주의

---

## 2026-03-22 — 에이전트 브랜드 아이콘 통합 (Apple + TUI)

### 문제
에이전트 세션 목록의 아이콘이 기기별로 파편화. Apple은 Anthropic "A" mark (claude-code), OpenAI knot (codex-cli), 🦞 이모지 (openclaw)를 혼용. TUI는 ✦, ☁️ 등 비관련 유니코드 사용. `assets/logos/`에 실제 브랜드 SVG가 준비되었으나 미적용 상태.

### 해결
- **Apple**: `BrandIcon`을 멀티패스 + `eoFill` 지원으로 확장. `claudeCodePath` (Antigravity 픽셀), `codexPath` (터미널 `>_`, evenodd), `openclawPaths` (가재 5-path) 적용. `parseSvgPath()`에 SVG arc(`A`/`a`) → cubic bezier 변환 알고리즘 추가 (W3C SVG spec F.6)
- **TUI**: codex-cli `☁️` → `❯` (U+276F) 교체. `creatureBrandColor()` 헬퍼로 truecolor 터미널에서 에이전트별 브랜드색 (terracotta/red/indigo) 적용

### 교훈 / 핵심 설계 결정
- **SVG arc 파싱**: `parseSvgPath()`가 M/L/H/V/C/S/Q/Z만 지원하여 openclaw/codex SVG 렌더 불가 → arc→bezier 변환 추가. Flag 파라미터(0/1)가 공백 없이 연속될 수 있어 `parseNumber()`로 처리
- **모노 SVG + 단색**: 13×13px에서 gradient는 무의미. 모노 variant(`fill=currentColor`) + 단색 적용이 최적
- **eoFill 필요성**: Codex 아이콘의 `>_` 컷아웃은 `clip-rule="evenodd"`로 구현 — SwiftUI Canvas에서 `FillStyle(eoFill: true)` 필수

---

## 2026-03-22 — Pixoo 다중 세션 문어를 숫자 대신 색상 톤으로 구분

### 문제
Pixoo 64×64에서는 Claude Code/Codex CLI 다중 세션을 `#1`, `#2` 같은 텍스트로 붙여 구분하기가 어렵고, 좌상단 점 개수만으로는 각 개체를 대응해 보기 부족했음.

### 해결
- Pixoo 문어 스프라이트에 세션 인덱스 기반 terracotta 밝기 램프 추가
- 첫 세션은 기존 톤 유지, 추가 세션은 조금씩 더 어두운 body/leg/starburst 팔레트 사용
- OpenClaw 가재는 단일 개체 역할이므로 변경하지 않음

### 교훈 / 핵심 설계 결정
- **64×64 LED 매트릭스에서는 번호보다 색상 계조가 더 읽기 쉽다**
- **멀티세션 구분은 hue 변경보다 동일 hue 내 밝기 차등이 안전하다** — 기존 Claude 계열 아이덴티티를 유지하면서도 개체 구분 가능

---

## 2026-03-22 — Pixoo Claude Code limit reset 시간 상세 표기 복구

### 문제
Pixoo HUD의 Claude Code limit reset 시간이 어느 시점부터 `1h`, `4d`처럼 한 단위만 보이도록 축약되어, 이전보다 정보 밀도가 떨어졌음.

### 해결
- Pixoo HUD 전용 reset formatter를 `1h23`, `4d6`, `59m` 형태의 상세 포맷으로 복구
- 2컬럼 HUD에서는 공백을 제거해 픽셀 폭을 아껴 상세 시간을 유지
- 숫자 뒤 배경 fill gauge는 제거하고, 각 컬럼 하단 1px usage bar로 변경

### 교훈 / 핵심 설계 결정
- **Pixoo도 완전한 한 단위 축약까지는 필요 없다** — `h+m`, `d+h` 조합이 시인성과 정보량의 균형이 가장 좋음
- **좁은 HUD에서는 정보를 줄이기보다 공백을 줄이는 편이 낫다**
- **텍스트 자체를 배경색으로 채우면 숫자 폭이 매 프레임 달라져 어색해진다** — 얇은 보조 게이지가 더 안정적

---

## 2026-03-22 — Session bridge에서 serial/pixoo 모듈 완전 분리

### 문제
`agentdeck claude`만 실행하고 daemon이 없을 때, Pixoo와 ESP32(TC001)가 session bridge로부터 직접 상태를 받고 있었음. 설계 원칙(daemon = sole hub for all dashboard devices)에 위배.

### 해결
- `cli.ts`: claude/codex 명령에서 `serial`/`pixoo`를 항상 `false`로 고정 (`--no-serial`/`--no-pixoo` 옵션도 제거)
- `index.ts`: `findExistingDaemon()` 기반 다운그레이드 로직 제거 (불필요), 기본값도 `serial: false`로 변경

### 핵심 설계 결정
- **mDNS/serial/pixoo 3개 모듈 모두 daemon-only**. Session bridge는 adb만 `'auto'` (reverse tunnel은 session 단위 필요)
- 이전 로직은 "daemon이 있으면 비활성화"였으나, 올바른 원칙은 "session bridge는 절대 활성화하지 않음". Daemon 유무와 무관하게 일관된 동작

---

## 2026-03-22 — TUI 모델명 미표시 수정 (데이터 경로 문제)

### 문제
TUI 대시보드의 MODELS 패널에 Claude Code OAuth 모델 카탈로그가 표시되지 않고, AGENTS 패널에 세션별 모델명이 없음. Codex에게 수정을 시켰으나 렌더러만 고치고 데이터 경로를 건드리지 않아 실질적 개선 없었음.

### 해결
**근본 원인**: TUI는 daemon에 연결되는데, daemon의 데이터에 Claude Code 세션 정보가 3가지 경로 모두 누락:
1. `state_update.modelName` — daemon 자체 StateMachine 값이라 null (daemon은 coding agent가 아님)
2. `state_update.modelCatalog` — Gateway(OpenClaw)에서만 설정됨, Claude Code 세션 catalog 미수집
3. `sessions_list[].modelName` — `SessionInfo` 타입에 필드 자체가 없었음

**수정**:
- `SessionInfo.modelName?` 추가 (shared protocol) + `/health` 응답에 포함 + session-aggregator에서 매핑
- `SessionTimelineRelay`에 `state_update.modelCatalog` 캡처 콜백 추가 → daemon이 sibling session의 Claude OAuth catalog을 merge
- TUI renderer에서 daemon 모드 세션별 `modelName` 표시

### 교훈 / 핵심 설계 결정
- **렌더러 수정만으로는 안 됨**: daemon hub 아키텍처에서 데이터가 실제로 daemon까지 도달하는 경로를 먼저 확인해야 함. Codex가 놓친 건 "TUI→daemon→session bridge" 데이터 흐름 이해 부족
- **daemon은 coding agent가 아님**: `modelName`, `modelCatalog` 등 세션 고유 데이터는 session bridge에서 daemon으로 relay되어야 TUI/Android/Apple에서 사용 가능
- **`/health` 엔드포인트 확장**: `modelName` 추가로 `SessionInfo`가 풍부해짐 — 향후 다른 세션 메타데이터도 같은 패턴으로 확장 가능

---

## 2026-03-22 — Ulanzi TC001 LED Matrix 보드 추가

### 문제
새 ESP32 디바이스 Ulanzi TC001 추가. 기존 3대(ESP32-S3 + LCD/AMOLED)와 완전히 다른 하드웨어: ESP32 classic (D0WD), 8MB flash, no PSRAM, **WS2812B 8×32 LED matrix** (LCD 아님).

### 해결
1. **하드웨어 인식**: USB 연결 초기 미인식 → CH340 드라이버 설치 시도 중 USB 방향 바꿔 끼우니 인식됨. `esptool chip_id`로 ESP32-D0WD 확인
2. **팩토리 백업**: `esptool --no-stub read_flash` (115200 baud, ~10분 소요) → `esp32/backups/ulanzi-tc001-factory-8MB.bin`
3. **별도 렌더링 경로**: LVGL은 8×32에 사용 불가 → FastLED로 직접 픽셀 제어. `build_src_filter`로 LVGL 소스 제외 + `#ifdef BOARD_ULANZI_TC001`로 cpp guard
4. **4페이지 대시보드**: USAGE(gradient gauge bars), AGENTS(5×6 creature sprites), INFO(model+project), TIMELINE(scroll+density bar)
5. **밝기 튜닝**: 초기 렌더링 색상값이 낮아(~45/255) 밝은 방에서도 어둡게 보임 → 색상값 150-200 레벨로 올리고, auto-brightness 상한 80→200, ADC 매핑 범위 조정(300-2800)

### 교훈 / 핵심 설계 결정
- **WS2812B 밝기 = FastLED brightness × 렌더링 색상값**: brightness를 올려도 색상값이 낮으면 어두움. 양쪽 모두 높여야 함
- **8×32 해상도에서 텍스트보다 컬러가 효과적**: 3×5 폰트로 8자/줄 한계. 게이지 바 그라디언트, 상태별 색상, 스프라이트 아이콘이 더 직관적
- **ESP32 classic vs S3 격리**: `board = esp32dev` (not esp32-s3-devkitc-1), no PSRAM flag, no USB CDC, STACK_UI 4096 (vs 16384)
- **PIO upload hang 우회**: PlatformIO mirror(contabostorage) 접속 불가 시 `pio run -t upload`가 무한 재시도. `esptool.py` 직접 사용으로 우회
- **Serpentine wiring**: `idx = (y%2==0) ? y*32+x : y*32+(31-x)` — TC001 실기기에서 확인 완료

---

## 2026-03-22 — 다중 클라이언트 파편화 진단 + Daemon Timeline Relay

### 문제
Android/Apple/TUI/Plugin 4개 클라이언트에 mDNS 디스커버리, WS 재연결, Timeline 생성 등 공통 로직이 분산 구현되어 유지보수 리스크 존재. KMP/Rust 통합 제안 검토 필요.

### 해결
코드 탐색 결과 **실제 중복은 Timeline(~580줄) + Protocol 타입(~700줄)만** — 네트워킹(mDNS/WS/waterfall)은 의도적 플랫폼 분기로 확인. KMP/Rust 대신 경량 대안 2개 구현:

1. **SessionTimelineRelay** (`bridge/src/session-timeline-relay.ts`): Daemon이 sibling session bridge WS에 연결하여 `timeline_event`/`timeline_history` relay. 클라이언트 `StateTimelineGenerator` 불필요화
2. **Protocol codegen** (`scripts/generate-protocol.sh`): `protocol.ts` → JSON Schema → quicktype → Swift/Kotlin 자동 생성. `pnpm generate-protocol`

### 교훈 / 핵심 설계 결정
- 코드 중복과 의도적 플랫폼 분기를 구별해야 함 — Apple의 NWConnection endpoint resolution과 Android의 NsdManager TXT 선호는 각 OS의 특성에 맞는 의도적 선택
- KMP/Rust는 1,300줄 중복에 수주 FFI 인프라라 과잉 — 서버사이드 통합(daemon relay)이 ~130줄로 동일 효과
- 역대 버그(stale IP, localhost retry, reconnect race)는 전부 플랫폼 고유 동작에서 발생 — 공통 코어로 방지 불가

---

## 2026-03-22 — Terminal Badge: MODEL_INFO 정규식 개행 버그 + 마일스톤 병합

### 문제
1. **Badge 모델명에 빈 줄 삽입**: `MODEL_INFO` 정규식의 `\s*`가 개행 문자를 포함한 모든 공백을 매칭. 멀티라인 PTY 청크에서 "opus"와 다음 줄의 숫자 "423"을 하나의 모델명 `"opus\n\n423"`으로 캡처 → badge에서 3줄로 렌더링
2. **같은 분 마일스톤 반복**: `PROCESSING→IDLE` 전환마다 마일스톤 1개 생성. 짧은 작업 사이클이 반복되면 `16:16` 같은 시간 3줄 소비 → 5줄 히스토리 공간 낭비

### 해결
1. `output-parser.ts` MODEL_INFO 정규식: `\s*` → `[ \t]*` (수평 공백만 매칭, 개행 차단)
2. `terminal-status.ts` 마일스톤 연속작업 병합:
   - `Milestone` 인터페이스에 `endTime`, `tools` 추가
   - `MERGE_GAP_MS=90초`: 이전 마일스톤 종료 후 90초 이내 새 라운드는 같은 마일스톤에 병합
   - 병합 시 전체 도구 기록으로 LLM 재요약 → 작업 덩어리의 의미 있는 요약 생성

### 교훈 / 핵심 설계 결정
- **정규식 `\s*`는 개행을 포함한다**: PTY 출력을 멀티라인 청크로 처리하는 파서에서 `\s*`는 의도치 않게 줄을 넘어 매칭. 단일 행 패턴에는 `[ \t]*` 사용
- **마일스톤 병합 기준은 시간 갭**: 단순 같은-분 그룹핑보다 `endTime→다음 startTime` 갭(90초)이 "연속 작업" 판단에 더 정확. LLM 재요약으로 파일 나열 대신 의미 있는 작업 요약 제공

---

## 2026-03-22 — OpenClaw Gateway 이중 연결 정리 (Plugin→Daemon 단일 경로)

### 문제
Plugin이 OpenClaw Gateway(port 18789)에 **독립적으로** WS 연결을 유지하고 있었음 — daemon과 별개로 Ed25519 인증, `openclaw logs --follow --json` subprocess, timeline enrichment를 모두 중복 수행. Gateway 관점에서 동일 device의 WS 연결 2개 + log subprocess 2개 = 리소스 낭비 + 상태 혼란(불안정성 원인 추정).

### 해결
Plugin의 직접 Gateway 연결을 완전 제거, daemon 경유 단일 경로로 전환:
- `plugin/src/gateway-client.ts` (1200줄), `log-stream.ts`, `timeline-summarizer.ts` 삭제 (순 -2288줄)
- `ConnectionManager` 재작성: `GatewayClient`/`activeLink` 이중 링크 → `BridgeClient` 단일 연결
- `switch_agent` WS 커맨드 추가 (`shared/protocol.ts` + `daemon-server.ts`) — 에이전트 전환을 daemon에 위임
- Session button의 `activateGateway()`/`activateBridge()` → `switchToOpenClaw()`/`switchToClaude()`

### 교훈 / 핵심 설계 결정
- **Gateway 연결은 daemon 단독** — Android/Apple/TUI/ESP32 모두 이미 daemon 경유. Plugin만 이중 연결이었음
- `receivingBridgeTimeline` 플래그로 이벤트만 억제해도 WS 연결 자체는 유지되어 Gateway에 부하. 근본 해결은 연결 자체 제거
- Daemon이 이미 `onCommand` 핸들러에서 Plugin WS 커맨드를 `OpenClawAdapter.handleCommand()`에 라우팅하고 있었으므로, 새 인프라 추가 없이 `switch_agent` 커맨드만 추가하여 해결

---

## 2026-03-22 — 디바이스 연결 실패 진단 (mDNS stale IP, ESP32 포트 식별)

### 문제
1. iPad/iPhone이 daemon에 연결 안 됨 (ConnectionOverlay 표시)
2. ESP32 Round AMOLED이 "No WiFi" 표시 (시리얼 데이터는 수신 중)
3. Daemon이 간헐적으로 크래시 (stderr 로그 없이 죽음)

### 해결
1. **mDNS stale IP**: daemon 시작 시 `getLanIp()`가 반환한 IP가 DHCP 갱신으로 변경되었지만 mDNS TXT 레코드가 갱신되지 않음. `mdns.ts` recovery timer에 IP 변경 감지 추가. Apple 앱에서 TXT `ip` 필드를 무시하고 항상 `NWConnection` endpoint resolution 사용. iOS waterfall을 macOS와 동일하게 mDNS-first로 변경 (stale `savedUrl` 5초 대기 제거)
2. **Session mDNS 광고 버그**: `cli.ts`에서 session bridge가 `mdns: true`로 mDNS 광고하고 있었음. `mdns: false`로 수정
3. **ESP32 "No WiFi"**: 펌웨어가 connection overlay에서 `serialConnected()` 상태를 무시하고 WiFi 없으면 무조건 "No WiFi" 표시. 시리얼 연결도 유효한 연결로 간주하도록 `main.cpp` 수정
4. **Daemon 크래시 추적**: `uncaughtException`에서 `process.exit(0)`하기 전 `~/.agentdeck/daemon-crash.log`에 스택 트레이스 append
5. **ESP32 포트 혼동**: `usbmodem` 번호가 USB 허브 포트/케이블에 따라 변동됨. `device_info_request` JSON으로 보드 식별하는 방식으로 전환

### 교훈 / 핵심 설계 결정
- **ESP32 USB 포트 번호는 고정이 아님** — 같은 보드도 다른 허브 포트/케이블에 꽂으면 번호 변경. 플래시 전 반드시 `device_info_request`로 보드 확인 필수
- **mDNS TXT record의 `ip` 필드는 신뢰할 수 없음** — Bonjour 캐시 + DHCP 갱신으로 stale 가능. endpoint resolution이 유일한 확실한 방법
- **`uncaughtException` → `process.exit(0)`은 LaunchAgent `SuccessfulExit: false`와 조합 시 재시작 안 됨** — crash log 별도 보존 필수
- **시리얼 연결은 WiFi와 동등한 "연결" 상태** — ESP32 펌웨어에서 connection overlay 로직이 WiFi만 체크하면 시리얼 전용 환경에서 영구 "No WiFi" 표시

---

## 2026-03-22 — 로깅 인프라 통합 + Terminal Badge 개선

### 문제
1. `agentdeck claude` PTY 세션에서 `[agentdeck] mDNS error (ignored): EADDRNOTAVAIL` 같은 내부 에러가 사용자에게 노출. 이미 "ignored"라고 하면서 출력하는 모순.
2. Terminal badge(iTerm2) 글씨가 너무 작고, 한국어 요약이 어색.

### 해결
1. **로깅 이중 시스템 통합**: `bridge-core.ts`, `index.ts`, `voice-assistant.ts`, `wake-word.ts`에 각각 있던 로컬 `log()` (항상 stderr) → `logger.ts`의 `log()` (PTY 모드 시 억제)로 교체. mDNS "ignored" 에러 → `debug()` (디버그 파일 전용). `logError()` 신규 추가 (치명적 에러만 PTY에서도 표시).
2. **Badge 3줄 고정**: 줄 수가 폰트 크기를 결정하므로 project/summary/state 3줄로 제한. 높이 30%, 다크모드 자동 감지. LLM 요약 영어로 전환.

### 교훈 / 핵심 설계 결정
- **로깅 3단계**: `debug()` (파일 전용) < `log()` (PTY 시 억제) < `logError()` (항상 표시). daemon은 PTY 없으므로 로컬 `log()` 유지 정상
- **iTerm2 badge 폰트 = 줄 수의 함수**: 내용이 많을수록 자동 축소. 큰 글씨를 원하면 줄 수를 줄여야 함. `BADGE_MAX_HEIGHT_FRACTION` 증가만으로는 불충분
- **LLM 요약은 영어가 자연스러움**: 코드 작업 컨텍스트에서 한국어 요약("터미널 포스트잇 기능 구현 중")은 부자연스럽고 토큰 효율도 낮음

---

## 2026-03-21 — E2E 테스트 전략 수립 + 통합 테스트 인프라 구축

### 문제
기존 11개 vitest 유닛 테스트(~6,600줄)가 데이터 변환 레이어(OutputParser, StateMachine, Timeline dedup)를 잘 커버하지만, 실제 HTTP/WS 서버 스택, Daemon 싱글톤 라이프사이클, ESP32 시리얼 브릿지(Node.js 측), 프로토콜 계약 등 **통합 레이어가 전혀 테스트되지 않음**. 이 "빠진 중간 레이어"가 실제 프로덕션 버그(daemon 이중 실행, Usage 429, hook format migration 실패 등)의 주요 원인.

### 해결
- **프레임워크**: Vitest 단일화 (Robot Framework는 ESP32 HW 전용 유지). 새 프레임워크 도입 없음
- **테스터빌리티 개선**: `session-registry.ts`에 `AGENTDECK_DATA_DIR` 환경변수 오버라이드 추가, `esp32-serial.ts`에서 `prepareForSerial`/`handleSerialLine`/패턴 상수를 `@internal` export
- **테스트 헬퍼 3종**: `temp-data-dir.ts` (격리된 임시 디렉토리), `ws-test-client.ts` (BridgeEvent 수집 + waitFor), `mock-adapter.ts` (스크립트된 AgentAdapter)
- **6개 통합 테스트 파일**: server-integration (hook→state→WS broadcast), protocol-contract (5 플랫폼 스키마 검증), daemon-lifecycle (싱글톤 가드 + 세션 레지스트리), esp32-serial-node (포트 감지 + 페이로드 최적화), connection-integration (실제 WS 서버), timeline-integration (store + dedup 파이프라인)
- **결과**: 11→17 test files, 510→578 tests, 전부 통과

### 교훈 / 핵심 설계 결정
- **소스 복제본 테스트 금지**: esp32-serial 첫 버전에서 `prepareForSerial`을 테스트 안에 재구현했는데, 소스가 변경되어도 테스트가 통과하는 위험한 패턴. 소스에서 `@internal` export하여 실제 함수를 테스트
- **Mock vs Real 경계**: HTTP/WS 서버는 real (ephemeral port), StateMachine/UsageTracker도 real, 파일 시스템은 real (temp dir). PTY/시리얼/mDNS/OAuth만 mock. 이 경계가 통합 테스트의 핵심
- **프로토콜 계약 테스트가 최고 장기 ROI**: 5개 클라이언트 플랫폼(Plugin, Android, Apple, ESP32, TUI)이 공유하는 프로토콜 타입의 필수 필드, 상태 enum 값, 이벤트 필터링을 검증. 프로토콜 필드 추가/삭제 시 즉시 잡아줌
- **Gemini 제안 비판 결과**: Unity/Catch2 C++ 유닛 테스트(펌웨어 2,000줄에 과도), OTA 테스트(AgentDeck에 OTA 없음 — 아키텍처 오독), 멀티플랫폼 호스트 테스트(Bridge는 macOS 전용)는 부적절. Daemon 싱글톤 가드, Usage relay 429 방지, Hook format migration 같은 실제 버그 소스를 놓침

---

## 2026-03-21 — Timeline dedup 미동작 근본 원인 + cron 최적화

### 문제
이전 세션에서 `deduplicateEntry()`, `isRepetitiveEntry()` 등 dedup 인프라를 구현했으나, timeline.json에 100개 중 81개가 WhatsApp 반복 — `repeatCount=0`, `automated=false`. Dedup이 전혀 동작하지 않았음.

### 근본 원인
1. **Plugin이 3/20 16:34 구 코드 실행 중** — 빌드(3/21 17:41) 후 재시작 안 됨. timeline.json은 plugin이 쓰는 파일이므로 dedup 코드 미적용
2. **`mergeHistory()` dedup 우회** — bridge 재연결 시 `timeline_history` → `mergeHistory()` → exact `ts:type:raw` 매칭만, `deduplicateEntry()` 미호출
3. **cron CLI 출력이 로그 스트림 유입** — `openclaw cron list/edit` 테이블 행·JSON blob이 `parseLogLine()`에서 error/memory_recall로 오분류

### 해결
1. `mergeHistory()`에 `deduplicateEntry()` 적용
2. `parseLogLine()` — cron 테이블 행 감지, error 상태만 `"Cron error: {name}"` 한 줄 요약 (ok/skipped 스킵). JSON blob·fragment 필터
3. WhatsApp 헬스체크 cron `*/5` → `*/30` (30분, heartbeat과 일치)
4. Plugin + Daemon 재시작, timeline.json 초기화

### 교훈 / 핵심 설계 결정
- **코드 변경 후 프로세스 재시작 확인 필수** — `ps -p PID -o lstart=`으로 빌드 시간 vs 프로세스 시작 시간 비교
- `mergeHistory()`처럼 bypass 경로가 있으면 dedup이 무력화됨 — 모든 입구에 dedup 파이프라인 적용
- cron list 출력 같은 "도구 출력"이 로그 스트림으로 유입되는 건 예측 어려움 — 패턴 기반 필터보다 구조적 필터(subsystem/module) 우선, 나머지는 UUID·JSON 패턴으로 보충
- 5분 LLM 헬스체크는 근본적으로 낭비 — cron 주기를 heartbeat(30분)에 맞추는 게 적절

---

## 2026-03-21 — Pantone 6 화면 회전 미적용 수정

### 문제
Pantone 6 (MOAAN, RK3566, Android 11)에서 앱 Settings의 Landscape 버튼이 동작하지 않음. `Activity.requestedOrientation = SCREEN_ORIENTATION_LANDSCAPE` 호출은 정상이나 화면 전환 없음.

### 해결
adb 진단으로 `ro.surface_flinger.primary_display_orientation = ORIENTATION_270` (패널 270° 보정), `persist.sys.mogu.rotation = 1` (MOAAN 커스텀 속성) 확인. MOAAN 펌웨어가 앱 레벨 `requestedOrientation` API를 무시하지만, `Settings.System.USER_ROTATION` 시스템 설정은 정상 동작 (`user_rotation=1` → landscape 전환 확인).

`MainActivity.kt`에서 `orientationFlow.collect` 블록에 시스템 레벨 fallback 추가: `Settings.System.putInt(USER_ROTATION, Surface.ROTATION_90)`. `WRITE_SETTINGS` 권한은 기존 BrightnessController와 동일 전제 (`adb shell appops set`).

### 교훈 / 핵심 설계 결정
- **E-ink 리더 OEM ROM은 `requestedOrientation`을 무시할 수 있음**: 6인치 리더는 세로 고정 정책이 흔함. `Settings.System.USER_ROTATION` 시스템 설정이 확실한 fallback
- **Rockchip RK3566 진단**: `ro.surface_flinger.primary_display_orientation`과 `persist.sys.mogu.rotation`이 핵심 속성. `ro.sf.hwrotation`은 미설정
- **`Settings.System.canWrite()` 가드 필수**: 권한 없으면 silent skip (앱 크래시 방지)

---

## 2026-03-21 — Terminal Post-it 경량화: Badge 제거, Tab Title 유지

### 문제
Claude Code가 세션 이름을 prompt bar에 네이티브로 표시하고 `--resume`으로 세션 목록도 제공하게 되면서 terminal-postit 기능과 가치가 일부 중복됨. 5줄 LLM 요약 오버레이로 강화하는 방안도 검토 필요.

### 해결
분석 결과 Claude 네이티브는 **정적 세션 이름**, 우리는 **동적 실시간 상태** — 근본적으로 다른 정보. iTerm2 badge(Layer 2)는 워터마크라 rich 정보 표시에 부적합 (폰트 크기 제어 불가, Dynamic Profile 해킹 fragile). Tab title(Layer 1)은 모든 터미널에서 작동하며 탭 바에서 `● AgentDeck | Edit app.ts` 형태로 유일하게 cross-tab 상태 인식 제공.

- `terminal-postit.ts`(435줄) → `terminal-status.ts`(109줄)로 교체
- Layer 2(badge), Dynamic Profile, Story accumulator, LLM 세션 요약 제거
- `timeline-summarizer.ts`에서 `summarizeSessionContext()` + `callLLM()` 제거
- Layer 1(tab title) + Layer 3(user vars) 유지

### 핵심 설계 결정
- **Tab title(OSC 1)이 핵심 가치**: 터미널 여러 개 띄울 때 탭 바만으로 각 세션 상태 파악 가능. Claude 네이티브 세션 이름과 보완 관계
- **Badge는 잘못된 매체**: 워터마크 오버레이는 1-2단어 ambient label용이지 5줄 정보 패널용이 아님
- **LLM 호출 제거**: 실시간 tool name(`Edit app.ts`)이 LLM 한국어 요약(`포스트잇 기능 구현 중`)보다 즉시적이고 정확

---

## 2026-03-21 — Node.js >=22 + node-pty source build (#3)

### 문제
Node.js 24 (LTS)에서 prebuilt node-pty 바이너리 ABI 불일치 → `posix_spawnp failed` 에러로 bridge 시작 불가. prebuilt 디렉토리는 존재하지만 Node 24 ABI와 호환되지 않음.

### 해결
1. **engines `>=22`**: Node 20 EOL (2026-04) 앞두고 최소 버전 상향. setup.ts, install.sh, package.json, README 일괄 변경
2. **Setup source build**: `npm_config_build_from_source=true` 환경변수로 node-pty 설치 시 항상 소스 빌드 강제. prebuild ABI 문제 원천 차단
3. **PtyManager 에러 안내**: `posix_spawnp` 에러 catch → rebuild 명령어 + `npx @agentdeck/setup` 재설치 안내

### 교훈
- node-pty `prebuild.js`는 디렉토리 존재만 체크, 실제 바이너리 호환성 검증 없음
- `npm_config_build_from_source=true`가 prebuild.js에서 직접 참조하는 환경변수 — npm CLI 플래그(`--build-from-source`)는 `node-pre-gyp` 전용
- 네이티브 addon은 Node major 버전마다 ABI 변경 가능 — LTS 버전만 지원하되 source build 기본 전략이 안전

---

## 2026-03-21 — mDNS EADDRNOTAVAIL 크래시 → 복구 로직

### 문제
macOS 슬립/WiFi 재연결 시 `bonjour-service`가 mDNS multicast (`224.0.0.251:5353`)로 `send()` 호출 → `EADDRNOTAVAIL` 에러를 비동기 throw → `uncaughtException` 핸들러가 `"already in use"` 문자열만 체크 → 미매칭 → `shutdown()` 호출 → shutdown 중 동일 에러 재발 → 프로세스 종료. Daemon과 session bridge 양쪽에서 동시 발생. LaunchAgent `last exit code = 0` + `successful exit` semaphore로 재시작 루프 안 돎.

### 해결
1. `bridge-core.ts` `uncaughtException`: `EADDRNOTAVAIL` + `5353` 패턴도 무시 → 프로세스 생존
2. `invalidateMdnsInstance()`: 에러 발생 시 Bonjour 인스턴스 destroy + null 마킹
3. `mdns.ts` 복구 타이머 (30s): `instance === null` + `getLanIp() !== undefined` 감지 시 자동 re-publish

### 교훈
- `bonjour-service`는 자체 복구/재연결 없음. 소켓 에러 시 `errorCallback`으로 throw만 함
- 에러 무시만으로는 불충분 — mDNS 광고가 죽은 상태로 남아 원격 클라이언트 발견 불가
- 네트워크 상태 변화에 대한 방어는 "무시 + 복구" 쌍으로 구현해야 함

---

## 2026-03-21 — Timeline automated tagging: cron 채팅 노이즈 근본 해결

### 문제
타임라인 94/100 엔트리가 WhatsApp 연결 상태 확인 cron (30분 간격) 결과로 채워짐. 근본 원인: OpenClaw Gateway `chat` 이벤트가 cron vs user 구분 없이 동일 프로토콜로 방출, `parseLogLine()` 필터는 log stream 전용이라 Gateway 경유 chat 이벤트 우회, semantic dedup(60%, 1h)는 LLM 요약 변형으로 일부 통과.

### 해결
1. **`automated` 태깅**: `TimelineEntry.automated?: boolean` 추가. Bridge adapter + Plugin gateway-client 양쪽에서 `!lastPrompt` (사용자 프롬프트 없이 시작된 채팅 = cron/web/channel) 감지 → `automated: true`. chat_start/chat_end/aborted/LLM upsert 모두 전파
2. **공격적 dedup**: `isRepetitiveEntry()`에서 automated 엔트리끼리는 8시간 윈도우 + content 비교 없이 즉시 중복 판정. 일반 엔트리 1시간 keyword dedup 유지
3. **에러 보존**: `type: 'error'`는 dedup 대상 외 (chat_end/chat_start만) → cron 실패 에러는 항상 표시

### 교훈
- Gateway 프로토콜에 `trigger` 필드가 없어 `lastPrompt` null 여부가 유일한 cron 식별 신호. OpenClaw에 `trigger: 'cron'|'user'|'web'` 필드 추가 요청 필요
- `parseLogLine()` 필터와 Gateway chat 이벤트 경로가 완전히 분리되어 있어, log stream 필터만으로는 Gateway 채팅 노이즈 해결 불가
- 웹 UI 직접 채팅도 `automated: true` 태깅되나, 내용이 매번 다르므로 최초 1회는 항상 표시됨 (실질적 false-positive 없음)

---

## 2026-03-21 — 구조 점검: shared 공통화 + 프로토콜 드리프트 수정

### 문제
구조 점검에서 3가지 핵심 이슈 발견: (1) `formatResetTime()` 7중 구현 (bridge 4 + Apple 2 + Android 1), `extractTopicHint()`/`cleanLLMOutput()` bridge/plugin 95% 중복, timeline-store dedup 로직 복사 (2) Android `OcSessionStatus.uptime` 타입 불일치 (`Int?` vs TS `String?`), `tokenStatus` 필드 Android/Apple 누락 (3) Android에 포트 9120 하드코딩 14곳, WS 타임아웃 상수 미정의.

### 해결
1. **shared 공통화**: `shared/src/format-utils.ts` (formatResetTime, formatResetTimeCompact, formatCount, formatBytes, formatUptime, gaugeBar), `shared/src/timeline-summarizer.ts` (extractTopicHint, cleanLLMOutput, SUMMARY_SYSTEM_PROMPT), `shared/src/timeline.ts`에 `deduplicateEntry()` 추가. bridge/plugin에서 import 교체, 자체 구현 삭제. Net -50줄
2. **Dead code 제거**: Apple `SessionMetrics.swift` 59줄 전체 (한 번도 참조되지 않은 dead code) + Xcode 프로젝트에서 제거
3. **이미지 최적화**: `docs/media/desk-setup-2.png` 16MB → `.jpg` 617KB (96% 감소)
4. **프로토콜 동기화**: Android `uptime` Int→String, Android/Apple `tokenStatus` 필드 추가
5. **Android 상수**: `BridgeConstants.kt` 생성 (WS_PORT, GATEWAY_PORT, 타임아웃 7개), 11곳 하드코딩 교체

### 교훈
- 멀티플랫폼에서 프로토콜 타입은 "쓰지 않는 필드"도 선언해두는 게 안전 — 나중에 사용할 때 드리프트 발견이 어려움
- shared 패키지 공통화는 함수 수준보다 "파이프라인 수준" (deduplicateEntry)이 효과적 — 호출 패턴까지 통합해야 진짜 중복 제거
- `SessionMetrics.swift`처럼 dead code는 grep 한번이면 발견 가능 — 주기적 점검 필요

---

## 2026-03-21 — Voice Assistant 녹음 안정성: CoreAudio device release delay

### 문제
PvRecorder(wake word)에서 sox/rec(녹음)으로 전환 시 CoreAudio 디바이스 경합 발생. PvRecorder.stop()이 비동기로 디바이스를 해제하므로 rec가 즉시 시작하면 corrupted/empty 오디오 캡처.

### 해결
1. **300ms delay**: PvRecorder stop → 300ms setTimeout → rec start (device release 대기)
2. **Retry on empty**: RMS > threshold×3인데 전사 비어있으면 1회 재녹음 시도
3. **Log 가시성**: debug() → log() (Transcription result, Sending prompt)
4. **Doc update**: Piper TTS → macOS say (현재 구현 반영)

### 교훈
- CoreAudio 디바이스 해제는 비동기 — stop() 반환 후에도 ~200ms 점유 가능
- RMS가 높은데 전사 비어있으면 녹음 품질 문제 (hallucination 아닌 device contention)

---

## 2026-03-21 — Timeline 노이즈 제거: Keyword 유사도 dedup + Store-level 텍스트 정제

### 문제
WhatsApp 헬스체크 cron(5분 간격)이 동일한 chat_start/chat_end 쌍을 생성하여 타임라인 100개 중 94개가 같은 내용. `parseLogLine()` 필터는 Gateway `chat` 이벤트에 무력. LLM 요약이 매번 미묘하게 다른 문장 생성 (`"확인 완료"` vs `"확인 완료, 정상"` vs `"연결 확인 완료"`) → exact string 비교로 dedup 불가.

### 해결
1. **Keyword 유사도 dedup**: `extractKeywords()` — 한국어 어미 정규화 + filler 제거 후 keyword bag 추출. `isSimilarCore()` — 60% overlap threshold. 1시간 윈도우 (5분 cron 대응)
2. **Store-level 텍스트 정제**: `addEntry()` 입구에서 `cleanRawText()`+`cleanNopMarkers()` 일괄 적용
3. **Paired chat_start 안전 제거**: chat_end dedup 시 `isRepetitiveEntry()` 검증 후에만 paired chat_start 제거 (고유 이벤트 보호)
4. **폴백 라벨 개선**: `'Prompt sent'` → `'자동 작업'`, `'Completed'` → `extractTopicHint(response)` 폴백

### 교훈 / 핵심 설계 결정
- LLM 요약이 non-deterministic이므로 exact string dedup은 반복 cron에 무력 — keyword bag 유사도 필요
- 한국어 어미 변형은 suffix strip stemming으로 해결 (`확인하겠습니다`/`확인합니다`/`확인한다` → `확인`)
- Store 입구 텍스트 정제가 adapter별 산재보다 유지보수 우수
- 실시간에서는 `repeatCount` 엔트리의 `ts` 갱신으로 윈도우가 sliding → 배치보다 효과적

---

## 2026-03-21 — ESP32 마이크 하드웨어 부재 확인 + 코드베이스 정리

### 문제
Wake word detection 구현을 위해 3대 ESP32 보드(86 Box, IPS 3.5", Round AMOLED)의 마이크 하드웨어를 조사. I2C scan, audio output test, mic pin scan 테스트 펌웨어를 Round AMOLED에 올려 확인.

### 결과
- 3대 모두 MEMS 마이크 칩 미실장. Round AMOLED의 GPIOs 45/46은 헤더에 노출되어 있으나 I2S 페리페럴 미연결
- 3.5mm 잭은 오디오용이 아님 (안테나/시리얼 디버그 용도)
- 마이크 내장 보드 필요 → ESP32-S3-BOX-3 구매 계획

### 정리 작업
- Round AMOLED 정상 펌웨어 복구 (테스트 펌웨어 → `env:round_amoled`)
- `platformio.ini`에서 테스트 환경 3개 제거 (`i2c_scan`, `audio_out`, `mic_scan`) + 소스 3개 삭제
- `board_round_amoled.h` 오디오 핀 주석 업데이트 (미실장 명시)
- CLI stub 제거: `codex` (미구현 placeholder), `attach` (미구현 stub)
- `stop [session]` → `stop` (미사용 인자 제거)
- README.md: `agentdeck claude` 포트 설명 수정 (9120 → 동적 포트), 서피스 제어 범위 정확화, 미구현 명령 제거

### 교훈
- 저가 ESP32 디스플레이 보드는 대부분 MEMS 마이크 미실장 — 오디오 기능 필요 시 전용 보드(ESP32-S3-BOX-3) 사용
- README와 CLI 구현의 정합성을 주기적으로 점검해야 함 — stub 명령이 사용자에게 노출되면 혼란 유발

---

## 2026-03-20 — Timeline 노이즈 제거: Store-level dedup + 폴백 라벨 개선

### 문제
WhatsApp 헬스체크 cron(5분 간격)이 동일한 chat_start/chat_end 쌍을 생성하여 타임라인 94/100 엔트리가 같은 내용으로 채워짐. `parseLogLine()` 필터는 Gateway `chat` 이벤트(delta→final)를 통과시키므로 무력. LLM 요약 실패 시 "Completed", cron 시작 시 "Prompt sent" 등 무의미한 라벨도 문제.

### 해결
1. **Store-level semantic dedup**: `isRepetitiveEntry()` 공유 함수 — `extractSemanticCore()`로 chat_end의 첫 ` · ` 이전 부분만 비교 (duration/tool suffix 무시). 10분 윈도우 내 동일 core 발견 시 `repeatCount` 증가 + paired chat_start 제거. Bridge/Plugin 양쪽 store에 적용
2. **폴백 라벨 개선**: `'Prompt sent'` → `'자동 작업'` (cron/web), `'Completed'` → `extractTopicHint(response) || 'Completed'` (LLM 미가용 시 응답 첫줄 topic 사용)
3. **텍스트 정제 함수**: `cleanRawText()` (inline **bold**/heading/link/backtick strip), `cleanNopMarkers()` (NOP/NOOP 제거)

### 교훈 / 핵심 설계 결정
- Gateway `chat` 이벤트 기반 timeline은 log-level 필터링으로 제어 불가 — adapter/store 레이어에서 semantic dedup 필요
- `extractSemanticCore()`로 duration/tool suffix를 무시하는 것이 cron 반복 감지의 핵심 (같은 작업이라도 매번 duration이 다름)
- Plugin에도 `extractTopicHint()` 추가 필요 (bridge 없이 Gateway 직접 연결 시 동일 enrichment 보장)

---

## 2026-03-20 — Display Dim: E-ink 프론트라이트 동적 탐색 + Pantone 6 한계 발견

### 문제
macOS display sleep 시 Android 기기 밝기를 제어하는데, Pantone 6(컬러 e-ink)에서 프론트라이트가 안 꺼짐. 기존 코드가 `/sys/class/backlight/warm/white`만 하드코딩 — Pantone 6의 `aw99703` 경로를 모름.

### 조사 과정
1. **sysfs 동적 탐색**: `KNOWN_BACKLIGHT_DEVICES` 목록으로 probe → `aw99703` 발견했으나 SELinux가 앱 프로세스의 읽기/쓰기 모두 차단
2. **MOAAN Settings 디컴파일** (jadx): `/proc/aw99703/led_brightness` + `led_current` 경로 발견. `FunctionSettingsControl.setLedValue()` → `FileWriter`로 직접 쓰기. 시스템앱(`/system/app/`)이라 SELinux 통과
3. **Settings.Global** (`mogu_warm_led_status` 등): 값은 바뀌지만 하드웨어 미반영 (`mBacklight=null` — framework 연결 없음)
4. **Runtime.exec("cat/echo")**: fork된 프로세스도 앱의 SELinux context 상속 → 동일 차단
5. **KEYCODE_SLEEP/screen_off_timeout**: 화면 OFF는 되지만, wake 시 MOAAN 드라이버가 프론트라이트를 자동 복원 안 함 → 영구 꺼짐

### 결과
- **Crema S**: sysfs `warm/white` app-writable → 정상 동작
- **Pantone 6**: dim 스킵 (프론트라이트 제어 불가, root 필요)
- **Lenovo LCD**: brightness=0 + SCREEN_OFF_TIMEOUT=2s (기존 방식 유지)

### 교훈
- E-ink 프론트라이트 제어는 벤더별 완전히 다름 — sysfs, proc, Settings.Global 어느 것도 표준이 아님
- SELinux가 파일 퍼미션(`rwxrwxrwx`)과 무관하게 앱 context 기반으로 차단
- `Runtime.exec()`은 앱의 SELinux context를 상속 — `adb shell`과 다른 결과
- 화면 sleep 시 프론트라이트가 0으로 리셋되면 앱에서 복원 불가 → screen off 방식은 e-ink에 위험
- MOAAN 전용 API: `/proc/aw99703*/led_{brightness,current}` + `android.os.MoanLedParam` LUT + `Settings.Global` `mogu_*` 키 (하드웨어 무관)

---

## 2026-03-20 — Timeline 품질 개선: LLM 요약 확장 + detail 클리닝 + 필터 정밀화

### 문제
1. Claude Code chat_end에 LLM 요약이 없어 "Completed · 15s · Read, Edit"로만 표시 (OpenClaw만 LLM 요약 적용)
2. detail 필드에 `**bold**`, `## heading`, code fence 등 마크다운 artifact 그대로 노출
3. `parseLogLine()`의 broad 키워드 필터(`/whatsapp/i`, `/WebSocket error/i`)가 사용자 작업 로그까지 삼킴 — 에이전트가 "WhatsApp API 연동" 작업 시 tool/error 로그 소실

### 해결
- **Claude Code LLM 요약**: `bridge/src/index.ts` Stop hook에 `summarizeResponse()` + `upsertEntry()` async enrichment 추가 (OpenClaw 패턴 동일)
- **`cleanDetailText()`**: `shared/src/timeline.ts`에 추가. markdown 제거(bold/heading/fence/link/list/blockquote/inline code), JSON blob 감지(시스템 JSON 필터, error 필드 추출), blank line 축소. Bridge/plugin 3곳에서 detail 저장 전 적용
- **`extractTopicHint()` 개선**: code fence 내부 스킵(`inCodeFence` toggle), markdown decorator 제거 후 평가, 한국어 접두사 chained 제거("네, 확인했습니다." → 핵심만)
- **필터 정밀화**: broad 키워드 → `isChannelInfra` subsystem/module 기반 플래그로 전환. `model_fallback_decision` JSON, `Delivery exceeded max retries` 추가 필터

### 교훈 / 핵심 설계 결정
- **로그 필터는 메시지 내용이 아닌 출처(subsystem/module)로 판단해야** false-positive 방지 가능. OpenClaw 로그는 구조화된 `subsystem`/`module` 필드를 제공하므로 이를 우선 사용
- **Source-rich, Client-truncate 원칙**은 detail 클리닝에도 적용: 원본은 넉넉히 전달하되, 클라이언트가 표시 전에 `cleanDetailText()` 거치도록

---

## 2026-03-20 — Pixoo 세션 로그 오염 수정 + HUD 게이지 복원 + 4 FPS

### 문제
1. `agentdeck claude` 실행 시 Pixoo push 로그(`[Pixoo] → 192.168.0.105: OK`)가 Claude Code PTY에 무한 출력. `process.stderr.write()`가 debug 로거를 우회
2. Pixoo HUD 하단 사용률 게이지 바(비율에 따른 배경 fill)가 7d 2컬럼 레이아웃 추가 시 실수로 제거됨
3. 물 배경색이 사용률에 따라 blue→teal→amber→red로 변하여 수족관 분위기 깨짐

### 해결
1. **세션에서 Pixoo 비활성화**: `index.ts` default `pixoo: false` (daemon-only, mDNS와 동일 정책). `pixoo-bridge.ts` `process.stderr.write()` → `debug()` 방어적 교체
2. **HUD 게이지 fill 복원**: 2컬럼(5h|7d) 유지하면서 각 zone별 왼쪽부터 pct만큼 `gaugeColor` 0.3 alpha fill. Dark base(black 0.55) 위에 오버레이
3. **물색 파랑 고정**: `getWaterPalette(usagePct)` → `ZONE_BLUE` 상수. 사용률 표현은 HUD 게이지에서만
4. **4 FPS**: 333ms → 250ms. Pixoo64 하드웨어 상한(~4 FPS) 근처이나 안정 동작 확인

### 교훈 / 핵심 설계 결정
- **Pixoo는 daemon-only 모듈**: 세션 bridge에서 로드하면 stderr 로그가 PTY에 혼입. mDNS와 동일 정책
- **Pixoo64 실측 FPS 한계**: 공식 스펙 없음. Python pixoo 라이브러리는 1 FPS 권장이나 보수적. PicNum:1 + PicID increment로 4 FPS 안정 확인. PicID ~300 오버플로 주의 (250에서 resync)
- **수족관 물색은 고정**: 사용률을 물색 그라데이션으로 표현하면 LED 매트릭스에서 탁한 색 발생. HUD 게이지 fill + 텍스트 색상으로 충분

---

## 2026-03-19 — 컬러 E-ink (Kaleido 3) 대응 + 멀티플랫폼 배포

### 문제
MOAAN Pantone 6 (Kaleido 3 컬러 e-ink, RK3566) 추가. 컬러 수족관을 구현했으나 애니메이션 프레임마다 CFA(Color Filter Array) 재계산이 화면 깜빡임(flicker)을 유발.

### 해결
**"움직이는 건 정적, 정적인 건 컬러"** 전략 확정:
- 테라리움: 애니메이션 루프 비활성화, 상태 변경 시만 정적 컬러 프레임 렌더
- UI 텍스트(게이지/타임라인/라벨): 컬러 적용 (갱신 빈도 낮아 CFA 플래시 안 보임)
- `EinkDetector.isColorEink()`: MOAAN/Boox C/Bigme Gallery 자동 감지
- `einkPick(gray, color)` 인라인 함수로 B&W/컬러 팔레트 전환

시도한 접근 (실패):
1. EPD 수동 명령 스킵 + RKCFA에 위임 → 여전히 깜빡임
2. `LAYER_TYPE_SOFTWARE` 제거 → 더 심해짐
3. 프레임 간격 2배 (800ms) → 여전히 깜빡임
4. 테라리움만 그레이스케일 → CFA가 주변 컬러 UI 감지하여 여전히 깜빡임

### 교훈 / 핵심 설계 결정
- **Kaleido 3 CFA 한계**: 컬러 콘텐츠 + 반복 갱신 = 불가피한 플래시. 하드웨어 레벨 제약
- **Rockchip CFA 로그**: `RKCFA nColorDep:70` — 시스템이 프레임 색상 깊이를 자동 감지하여 waveform 결정. 소프트웨어에서 제어 불가
- **manufacturer="rockchip"**: MOAAN 기기의 Build.MANUFACTURER가 "moaan"이 아닌 "rockchip". model "Pantone6"으로 매칭
- **Apple CI signing 삽질**: Automatic+Distribution 충돌 → Manual+profile 필요 → Development cert도 필요 → 최종: Dev+Dist 합친 .p12 + Automatic signing

---

## 2026-03-19 — 멀티플랫폼 CI/CD 파이프라인

### 완료
- **Android v0.3.0**: GitHub Actions → APK Release (성공)
- **ESP32 v0.1.0**: PlatformIO 순차 빌드 (box_86→ips_35→round_amoled), firmware .bin Release (성공)
- **Apple iOS v0.1.0**: TestFlight CI 파이프라인 구축 (signing 진행 중)

### 교훈
- Apple CI signing: Development + Distribution 인증서 **모두** 필요. `security export -t identities` 로 전체 키체인 .p12 추출하면 간단
- `DisplaySyncService`: Swift 6 strict concurrency — `@unchecked Sendable` 로 해결 (`DispatchQueue.main.async { self }` 는 data race 에러)
- ESP32 PlatformIO: `max-parallel: 1` 로 순차 빌드 필수 (리소스 충돌 방지)

---

## 2026-03-19 — ESP32 Wake Word Detection 시도 (microWakeWord)

### 문제
Mac Studio 모니터에 달린 마이크로 Porcupine "오픈클로" wake word를 감지하고 있었으나, 모니터 sleep 시 마이크가 비활성화되어 감지 불가. ESP32 상시 전원 마이크로 해결하려 함.

### 시도
1. **Picovoice Porcupine ESP32 지원 조사**: ESP32는 Xtensa 아키텍처라 Porcupine 미지원 (ARM Cortex-M만). Console에서 ESP32 타겟으로 .ppn 모델 빌드 불가
2. **microWakeWord 선택**: TFLite Micro 기반 오픈소스 wake word 엔진. ESP32-S3 + PSRAM 네이티브 지원
3. **한국어 TTS 샘플 생성**: Piper TTS에 한국어 없어서 Edge-TTS(Microsoft)로 945개 "오픈클로" 샘플 생성 (3 음성 × 7 속도 × 3 피치 × 3 볼륨 × 5 텍스트변형)
4. **모델 훈련 성공**: Apple Silicon trainer + Metal GPU, 40,000 steps. 최종 Accuracy 100%, Recall 100%, FRR 0%. 62KB TFLite 모델 생성
5. **ESP32 I2S PDM 드라이버**: legacy API (`driver/i2s.h`) ESP-IDF 5.x에서 broken → 새 API (`driver/i2s_pdm.h`) 사용. 드라이버 정상 동작 확인
6. **TFLite Micro 빌드 실패**: pioarduino GCC 14와 오래된 TFLite Micro 라이브러리 호환 불가 (`std::is_pod` deprecated, flatbuffers 버전 충돌)
7. **마이크 하드웨어 부재 발견**: Round AMOLED (JC3636W518) 보드에 I2S 핀 정의는 있으나 MEMS 마이크 칩 미실장. I2S read 결과 DC offset ~1310 고정. 보유 3종 전부 마이크 없음

### 교훈 / 핵심 설계 결정
- **Guition(Jingcai) 디스플레이 보드**: 오디오 핀 정의 ≠ 실제 마이크 탑재. 보드 구매 시 실물 스펙 확인 필수
- **ESP-IDF 5.x I2S**: legacy API 사용 불가, `i2s_pdm.h` 새 API 필수
- **pioarduino + TFLite Micro**: GCC 14의 strict C++20 체크로 오래된 라이브러리 빌드 불가 — ESP-IDF 네이티브 빌드로 전환 필요
- **microWakeWord 훈련 환경**: arm64 Python 3.11 + TF 2.16 Metal + arm64 ffmpeg@7 (symlink `/opt/homebrew/opt/ffmpeg` 필수)
- **보관된 성과물**: `esp32/models/openclaw_wake_word.tflite`, `esp32/src/audio/`, `docs/wake-word.md`, 훈련 환경 `~/github/microWakeWord-Trainer-AppleSilicon/`
- **재개 조건**: MEMS 마이크 내장 ESP32-S3 보드 구매

---

## 2026-03-19 — Apple Release (TestFlight) CI/CD 설정

### 문제
Apple 앱(iOS/macOS)을 TestFlight으로 자동 배포하는 파이프라인이 없었음. Android는 GitHub Actions + APK Release가 이미 구축되어있었으나 Apple 쪽은 미구축.

### 해결
1. **Bundle ID 변경**: `dev.agentdeck.dashboard` → `bound.serendipity.agentdeck` 시도 → Personal Team에서 글로벌 선점되어 사용 불가 → `bound.serendipity.agentdeck.dashboard`로 확정
2. **project.yml + project.pbxproj + SettingsScreen.swift**: bundle ID 전체 반영, iOS 테스트 타겟 오타 수정 (`agentdec` → `agentdeck`)
3. **GitHub Actions workflow**: `.github/workflows/apple-release.yml` — `apple-v*` 태그 트리거, iOS/macOS 병렬 빌드, keychain cert import + ASC API key 인증, `xcodebuild archive` → `exportArchive` → `altool --upload-app`
4. **로컬 빌드 스크립트**: `scripts/build-apple-release.sh` — `--ios`/`--macos`/`--all` 옵션, ASC env vars 설정 시 TestFlight 업로드
5. **ExportOptions.plist**: `app-store-connect` method, automatic signing
6. **App Store Connect**: 앱 "AgentDeck Dashboard" 등록, API Key 생성 완료

### 교훈 / 핵심 설계 결정
- **Apple Bundle ID는 글로벌 유니크**: 도메인 소유권 검증 없음. Xcode 자동 signing이 Personal Team으로 빌드하면 해당 Bundle ID를 글로벌 선점 — 유료 팀에서 재등록 불가. Personal Team의 App ID는 developer portal에도 안 보여서 진단이 어려움
- **Plugin UUID ≠ Apple Bundle ID**: Stream Deck 플러그인 UUID(`bound.serendipity.agentdeck`)와 Apple 앱 Bundle ID는 별개 시스템이므로 일치할 필요 없음
- **Distribution Managed 인증서**: Xcode 자동 관리 인증서로 CI에서도 `-allowProvisioningUpdates` + ASC API key 조합으로 프로비저닝 해결 가능

---

## 2026-03-18 — Daemon Hub 아키텍처 + daemon.json 포트 디스커버리

### 문제
1. **mDNS daemon-preference 버그**: EinkMonitorScreen에 daemon 우선 grace period 없음 → NSD가 session bridge를 먼저 발견하면 daemon 대신 session bridge에 연결
2. **`/health` 필드 불일치**: daemon은 `mode: 'daemon'`, session bridge는 `mode` 필드 없음 → Apple 클라이언트가 session bridge 식별 불가
3. **근본 설계 문제**: 모든 bridge가 각자 mDNS + WS 서빙하는 구조가 daemon-preference 로직의 근본 원인

### 해결
1. **EinkMonitorScreen**: `withTimeoutOrNull(4000)` 4초 daemon grace period 추가 (MainActivity 패턴과 동일)
2. **hook-server.ts**: `/health` 응답에 `mode` 필드 추가 (daemon과 동일한 필드명)
3. **Daemon hub 아키텍처 설계** (Phase 1 — daemon.json 포트 디스커버리):
   - `session-registry.ts`: `DaemonInfo` 타입, `writeDaemonInfo()`/`readDaemonInfo()`/`removeDaemonInfo()`/`probeDaemonHealth()`/`findDaemonPort()` 추가
   - `daemon-server.ts`: 3단계 singleton guard (daemon.json → sessions.json → /health probe) + 포트 fallback (non-daemon 점유 시 자동 대체) + bind 후 daemon.json 기록 + shutdown 시 삭제
   - 모든 클라이언트 (cli.ts, daemon.ts, dashboard.ts) 업데이트
4. **세션 전환 UI 지연 수정**: `cycleSession()`/`switchToPort()`에서 stale state 즉시 초기화 + `broadcastStateUpdate()` 콜백으로 전체 UI 플러시
5. **문서 전면 업데이트**: CLAUDE.md, README.md, docs/protocol.md, docs/devices.md, memory/MEMORY.md — daemon-only hub 아키텍처 반영

### 교훈 / 핵심 설계 결정
- **daemon.json이 정답**: `sessions.json` 스캔 + PID 검증보다 전용 파일이 단순하고 빠름. PID alive 검증 포함, stale 시 자동 삭제
- **`/health` probe가 최종 방어선**: daemon.json/sessions.json 모두 stale일 수 있으므로 실제 HTTP probe로 확인. 2s timeout
- **포트 fallback 시 EADDRINUSE race**: probe와 bind 사이에 포트가 잡힐 수 있음 → catch에서 `findAvailablePort()` 재시도
- **세션 전환 시 stale state = 시각적 지연의 원인**: `currentState`/`currentTool`/`currentModel`을 즉시 초기화하지 않으면 이전 세션의 상태가 잠깐 표시됨. `refreshAll()`은 세션 버튼만 갱신하므로 `broadcastStateUpdate()` 콜백이 필수

---

## 2026-03-18 — Terminal Post-it: iTerm2 badge 제어의 한계

### 문제
터미널 탭 전환 시 세션 컨텍스트를 즉시 파악하기 위해 iTerm2 badge에 자연어 요약을 오버레이하려 했으나, badge 크기/색상 제어에 심각한 제약 발견.

### 해결
1. **LLM 요약**: `timeline-summarizer.ts`에 `summarizeSessionContext()` 추가 — 도구 호출 이력을 MLX/Ollama로 한국어 1줄 요약. 5회 도구 사용 or IDLE 전환 시 트리거
2. **badge 크기 고정**: `SetProfileProperty` escape sequence는 **존재하지 않음** (iTerm2 Python API 전용). Dynamic Profile JSON (`~/Library/Application Support/iTerm2/DynamicProfiles/agentdeck.json`)을 생성 후 `SetProfile` escape sequence로 전환하는 방식으로 해결
3. **badge 색상**: Dynamic Profile의 `Badge Color` 프로퍼티로 amber(#FFC107, alpha 50%) 설정
4. **box-drawing 포기**: badge 폰트가 프로포셔널이라 `╭│╰` 정렬 깨짐 — plain text + emoji(📂)로 전환
5. **크기 제어**: `Badge Max Width/Height`는 터미널 크기의 **비율(0~1)**. 폭 넓게(0.5) + 높이 작게(0.05) 조합으로 줄바꿈 없이 작은 폰트 유지

### 교훈 / 핵심 설계 결정
- iTerm2 badge 제어 가능한 escape sequence: `SetBadgeFormat`(텍스트), `SetProfile`(프로필 전환) — 이 2개뿐. 크기/색상/폰트는 escape sequence로 불가
- `Badge Max Width/Height`는 점(points)이 아닌 **비율(fraction)**. iTerm2 소스(`iTermAdvancedSettingsModel.m`)에서 확인: `badgeMaxWidthFraction` default 0.5, `badgeMaxHeightFraction` default 0.2
- Dynamic Profile의 `Dynamic Profile Parent Name`으로 사용자 기존 프로필 상속 가능 — badge 속성만 오버라이드하면 나머지 설정 유지
- 프로포셔널 폰트에서 Unicode box-drawing은 사용 불가 — 정렬 보장이 안 됨

---

## 2026-03-18 — Apple 앱 iPhone OOM + macOS 연결 불안정 수정

### 문제
1. **iPhone OOM (16분 후 kill)**: `TerrariumView`의 `@State lastDate` 변경이 매 Canvas 프레임마다 `DispatchQueue.main.async`로 SwiftUI re-render 트리거. ProMotion 120Hz x 2 (double render) = 240fps 실효 렌더 → 메모리 압력 누적
2. **macOS/iOS 연결 불안정**: Bridge 사망 시 receive loop error + ping error 동시 발생 → `handleDisconnect` 2회 호출. `defer { isHandlingDisconnect = false }` 가 serial queue에서 순차 실행 시 guard 무효화 → 이중 reconnect 스케줄 → 소켓 2개 경쟁 → cascade failure
3. **mDNS 중복 브리지 표시**: `DiscoveredBridge.id`가 `host:port` → 같은 서비스가 WiFi/Ethernet 양쪽 인터페이스에서 별도 항목으로 표시

### 해결
1. **OOM**: `lastDate`를 `TerrariumRenderer` (plain class)로 이동 → `@State` mutation 제거 → double render 해소. `TimelineView(.animation(minimumInterval: 1.0/60))` 60fps cap 추가
2. **handleDisconnect 이중 호출**: `defer` 제거. `isHandlingDisconnect`는 `connectInternal()`에서만 reset — disconnect~reconnect 구간 동안 두 번째 error callback 차단. 모든 early return 경로에서도 적절히 reset
3. **ping timer thread-safety**: `Timer`+`RunLoop.main` → `DispatchSourceTimer` on `queue`. `stopPingTimer()`는 `DispatchSource.cancel()` (thread-safe) 직접 호출으로 동기화 보장
4. **mDNS dedup**: `DiscoveredBridge.id`를 mDNS service name으로 변경. `handleResults`에서 service name 기준 pre-dedup
5. **waitsForConnectivity**: iOS만 `true` (cold-start WiFi 대기), macOS는 `false` (빠른 failure → 빠른 reconnect)
6. **Suspend threshold**: 20s → 15s (서버 실제 pong timeout = 15s)

### 교훈 / 핵심 설계 결정
- **SwiftUI Canvas에서 `@State` mutation 금지**: `DispatchQueue.main.async { @State = value }` 패턴은 매 프레임 re-render 유발. Canvas 내 시간 추적은 renderer 객체 내부 property로 처리
- **Serial queue `defer` reset은 guard 무효화**: 동일 serial queue에 2개 block이 enqueue되면 첫 block의 `defer` reset 후 두 번째 block이 guard를 통과함. "disconnect~reconnect 구간 동안 true 유지" 패턴이 올바름
- **`DispatchSource.cancel()`은 thread-safe**: `stopPingTimer`를 async 대신 직접 호출 가능. async dispatch는 `disconnect()`와 race condition 유발
- **서버 ping 15s + 클라이언트 ping 15s = 위험**: 동일 간격은 경쟁 가능. iOS 클라이언트 background 복귀 시 15s 초과면 소켓 확정 사망으로 즉시 reconnect

---

## 2026-03-17 — Pixoo HUD 레이아웃 개선: 7d 추가 + gauge fill 제거

### 문제
Pixoo64 하단 HUD가 5h rate limit만 표시. 7d 데이터는 `UsageEvent`에 존재하나 렌더링 안 됨.

### 해결
1. **단일 행 two-column**: rows 57-63 하나에 좌측=5h / 우측=7d 나란히 표시
2. **Dark base 먼저**: full-width `blendPixel(black, 0.55)` → 카메라 와이드 시 모래(갈색) 은폐
3. **Gauge fill 제거**: 배경 fill로 usage를 표현하는 방식 폐기 — 텍스트 색상(blue/teal/amber/red)만으로 충분
4. **Compact format**: 5h=시간만(`4h`), 7d=일수만(`6d`) — 32px 존에 맞춤
5. **3 FPS**: 500ms → 333ms (디바이스 한계 ~4FPS 내 안전)

### 교훈 / 핵심 설계 결정
- **Pixoo HUD dark base 필수**: camera zoom에 따라 rows 57-63이 물(수면) 또는 모래를 표시. text-only 커버리지는 모래 노출로 갈색 배경 문제 → 항상 full-width dark base 먼저 깔 것
- **Gauge fill = 불필요한 복잡성**: 물 색상이 이미 usage zone을 표현하므로 HUD에서 fill 중복 불필요. 텍스트 색상만으로 충분
- **`d` 글리프**: 3×5 픽셀 폰트에 `d` 없어서 day 표시 불가 — 새 glyph `[0b001,0b001,0b011,0b101,0b011]` 추가

---

## 2026-03-17 — macOS App Sandbox + mDNS TXT 부재로 daemon 연결 실패

### 문제
macOS 앱이 Android 태블릿과 동일 daemon에 연결되어야 하나, 3가지 데이터 차이 발생 (agent 목록, timeline, 모델). 근본 원인 2가지:
1. **App Sandbox**: `~/.agentdeck/sessions.json` 읽기 불가 — `FileManager.homeDirectory`가 컨테이너 경로 (`~/Library/Containers/bound.serendipity.agentdeck/Data/`) 반환
2. **mDNS TXT 레코드 비어있음**: NWBrowser가 `metadata=<none>` 반환 → `agentType`이 전부 nil → daemon preference 작동 불가 → 랜덤 session bridge에 연결 → 불완전한 데이터

### 해결
1. `LocalSessionDiscovery` 사용 중단 (sandbox에서 작동 불가, App Store 배포 필수)
2. macOS도 mDNS 기반으로 전환 (Android과 동일 패턴)
3. `BridgeDiscovery.fetchHealthInfo()` — `/health` 응답의 `mode: "daemon"` 필드로 agentType 취득 (TXT 레코드 부재 대응)
4. `autoConnectPolling` — agentType 미해결 bridge 있으면 최대 4초 grace period 후 fallback

### 교훈
- **App Sandbox**: `NSHomeDirectory()`, `FileManager.homeDirectory` 모두 컨테이너 경로 반환. `getpwuid(getuid())` 로 실제 홈 경로 취득 가능하나, sandbox가 파일 접근 자체를 차단하므로 무의미
- **mDNS TXT 레코드**: Apple NWBrowser는 TXT 레코드를 비동기/지연 전달할 수 있음. TXT에만 의존하지 말고 HTTP fallback 필수
- **daemon 우선 연결은 모든 클라이언트의 기본 전제**: daemon 없이 session bridge에 직접 연결하면 sessions_list, timeline, gateway 정보가 불완전. 이 전제가 깨지면 모든 UI가 틀어짐

---

## 2026-03-16 — Display Sleep/Wake 전 기기 밝기 동기화

### 문제
Mac 모니터 sleep 감지(`DisplayMonitor` → `display_state` 이벤트)가 Android만 처리 중. Pixoo64 LED, Stream Deck+, Apple app도 모니터 꺼짐 시 화면을 끄거나 어둡게 해야 함.

### 해결
1. **Shared**: `DISPLAY_FORWARDED_EVENTS`에 `display_state` 추가 → ESP32 `SERIAL_FORWARDED_EVENTS`에도 자동 전파
2. **Pixoo64**: `setBrightness(ip, 0)` + 2FPS 스트림 타이머 정지 (HTTP 요청 절약 → 안정성↑). Wake 시 원래 밝기 복원 + 100ms 후 스트림 재개. `doStreamPush()` guard 추가
3. **SD+ Plugin**: `FORWARDED_EVENTS`에 추가. `displayDimmed` 플래그 + `dimAllActions()` (전체 버튼/LCD에 검정 SVG). `broadcastStateUpdate()` guard로 dimmed 중 렌더 스킵. Wake 시 `broadcastStateUpdate()` 호출로 전체 재렌더
4. **Apple iOS**: `DisplaySyncService` — `UIScreen.main.brightness` save/0/restore. 백그라운드 진입 시 pending 큐잉, foreground 복귀 시 적용. Disconnect 시 safety restore. Settings 토글 추가
5. **ESP32**: 이벤트는 자동 전달되지만 펌웨어 핸들러는 별도 작업

### 교훈 / 핵심 설계 결정
- **Pixoo 스트림 일시정지**: 밝기 0만으로는 부족 — HTTP push 계속하면 디바이스 부하. `clearInterval` + wake 시 `setInterval` 재시작이 깔끔
- **SD+ SDK에 `setBrightness` API 없음**: 하드웨어 밝기 제어 불가 → visual dimming (검정 이미지 일괄 설정)으로 대체
- **iOS 백그라운드 `UIScreen.brightness` 불가**: foreground 복귀 시 queued dim 적용 패턴 필요

---

## 2026-03-16 — mDNS 유령 엔트리 + 클라이언트 재연결 개선

### 문제
데몬 재시작 후 macOS/Android 태블릿이 자동 재연결 실패:
1. **유령 mDNS**: 이전 세션(port 9121)의 mDNS 엔트리가 남아 데몬(9120) 대신 죽은 포트로 무한 재시도
2. **Android 4001 거부 루프**: 데몬 재시작 → 새 auth 토큰 → 저장된 URL의 구 토큰 → 4001 → URL 클리어 → `LaunchedEffect(Unit)` 이미 완료되어 재탐색 미발생
3. **ForEach 중복 ID**: `GroupedEntry.id = entry.ts` (Double) → 동일 밀리초 이벤트에서 SwiftUI 경고

### 해결
1. **mDNS 서비스명 단축**: `AgentDeck-${project}-${port}` → `${project}-${port}` (불필요한 접두사 제거)
2. **macOS 실패 브릿지 블랙리스트**: `failedBridgeIds: Set<String>` — reconnect 소진 시 bridge.id 추가, browseResults 갱신 시 클리어. `startAutoConnectPolling()`과 `onReconnectAttempt` 양쪽에서 필터
3. **LocalSessionDiscovery 디버그 로깅**: file not found / decode error / session count 로그 추가
4. **Android 재탐색**: `LaunchedEffect(connectionStatus, currentUrl)` — DISCONNECTED + null URL 시 1초 딜레이 후 mDNS 재탐색
5. **ForEach ID**: `GroupedEntry.id`를 `"\(ts)-\(type)-\(count)"` String으로 변경, ForEach에서 `\.offset` 사용

### 교훈 / 핵심 설계 결정
- **mDNS 유령 엔트리는 OS 레벨 문제**: 프로세스 종료 후에도 Bonjour 레코드가 잠시 남을 수 있음. 클라이언트 측에서 실패한 브릿지를 기억하고 스킵하는 방어가 필수
- **LaunchedEffect(Unit)은 한 번만 실행**: 상태 변경 후 재실행이 필요한 로직은 반응형 key를 사용해야 함
- **SwiftUI ForEach ID로 Double 사용 금지**: 부동소수점 동등성 문제 + 같은 타임스탬프 충돌 가능성

---

## 2026-03-16 — WS 클라이언트별 OpenClaw 세션 중복/미표시 수정

### 문제
daemon이 Gateway 연결 시 `agentType: 'openclaw'`로 브로드캐스트. 클라이언트별 다른 증상:
1. **TUI 중복**: `agentType !== 'daemon'` → session-bridge 분기 → self를 OpenClaw로 렌더 + sessions_list의 virtual OpenClaw = 2개
2. **macOS 미표시**: Gateway disconnect → daemon이 `connection: disconnected` 포워딩 → macOS가 bridge 끊김으로 오인 → HUD 숨김
3. **Android 구조적 동일**: dedup으로 가려져 있었지만 같은 패턴

### 해결
1. **daemon-server.ts**: Gateway adapter `connection` 이벤트를 WS에 포워딩하지 않음. Gateway 상태는 `state_update.gatewayAvailable` + `sessions_list`로 전달
2. **isDaemonLike 패턴**: `agentType == 'daemon' || sessions.any { it.agentType == agentType }` — TUI(renderer.ts+dashboard.ts), Android(SessionListPanel.kt+EinkAgentColumn.kt), Apple(SessionListPanel.swift) 7곳 통일 적용
3. **Gateway health**: OpenClaw adapter가 WS `health` 이벤트를 `gateway_health` metadata로 emit (폴링 대체)

### 교훈 / 핵심 설계 결정
- **daemon의 agentType이 'daemon'이 아닌 경우가 있다**: Gateway 연결 시 'openclaw'으로 변경됨. 모든 "daemon인지 판별" 로직은 `isDaemonLike` 패턴 사용 필수
- **Gateway adapter의 connection 이벤트는 bridge connection과 의미가 다르다**: 클라이언트는 "자신의 bridge 연결"과 "gateway 연결"을 구분해야 함. 절대 혼동해서 포워딩하면 안 됨
- **Android mDNS daemon preference**: NSD resolve 순서가 비결정적 — session bridge가 daemon보다 먼저 resolve될 수 있음. 4초 grace period 추가 (`MainActivity.kt`)
- **실제 디바이스 확인 필수**: WS 프로토콜만 확인하면 부족. Crema(daemon 연결)에서 확인한 후 태블릿(WiFi→session bridge)에서 다른 결과 발견 → 실행 중인 프로세스의 코드 버전 불일치 문제까지 추적

---

## 2026-03-16 — ESP32 Daemon 상태 매핑 + 멀티 문어 수영

### 문제
1. **Daemon→ESP32 상태 매핑 버그**: Daemon이 OpenClaw Gateway 연결 시 `agentType: "openclaw"`을 전송. ESP32 `renderer.cpp`의 `isDaemon`이 `"daemon"`만 매칭 → OpenClaw만 ROUTING일 때 문어까지 WORKING 애니메이션 동작
2. **ESP32 시리얼 전용 연결 시 sessions_list 중단**: `bridge-core.ts` 폴링 가드들이 `getClientCount() > 0` (WS만 카운트). ESP32 시리얼은 WS가 아니므로 ESP32만 연결된 경우 데이터 업데이트 중단
3. **멀티 문어 파티클/버블**: `Octopus::getX(0)` 하드코딩으로 두 번째 문어 주변에 데이터 파티클/exhale 버블 없음
4. **세션 이름 중복**: 같은 프로젝트명 세션 → 문어 이름 모자 동일 (Android/Apple에는 `#1`, `#2` 로직 있으나 ESP32 누락)
5. **Idle 문어 위치**: Round AMOLED(0.55)과 Rectangular(0.59) 모두 모래(0.65)에서 너무 멀리 떠있음

### 해결
1. **`isDaemon` 확장**: `strcmp("daemon") || strcmp("openclaw")` — daemon만 "openclaw" agentType 전송하므로 안전
2. **`hasClients()` 도입**: `BridgeCore`에 `setExternalClientCountProvider()` + `hasClients()` 메서드. WS + 시리얼 합산. `daemon-server.ts`/`index.ts`에서 `esp32ConnectionCount()` 등록
3. **파티클**: `octStates[]` 배열 파라미터 추가, WORKING 문어를 round-robin 순회하며 spawn. **버블**: `octCount` 파라미터로 모든 문어에서 exhale
4. **세션 이름 dedup**: `protocol.cpp` `handleSessionsList` — 2-pass (rawNames 수집 → 중복 감지 → `"AgentDeck #1"` 형식)
5. **Standing Y 조정**: Round 0.55→0.62, Rect 0.59→0.63 (sand 0.65 바로 위)

### 교훈
- **Daemon agentType 이중성**: Daemon은 gateway 상태에 따라 `"daemon"` 또는 `"openclaw"`을 동적 전환. 모든 클라이언트가 이 구분을 인지해야 함. Android `TerrariumState.kt`는 이미 올바르게 처리, ESP32만 누락
- **시리얼 ≠ WS 클라이언트**: ESP32 시리얼 연결은 WsServer 클라이언트가 아님. 폴링 가드에 시리얼 카운트도 포함 필요
- **86 Box 플래싱**: Daemon이 시리얼 포트 점유 중이면 PIO 업로드 실패. 반드시 `daemon stop` → flash → `daemon start`
- **PIO 패키지 미러 다운 시**: `~/.platformio/tools/tool-esptoolpy`를 `packages/`로 복사 + `package.json` 생성으로 우회

---

## 2026-03-15 — Pixoo 프레임 푸시 영구 중단 버그

### 문제
Pixoo64가 42프레임 이후 영구 중단. 디바이스 HTTP는 정상(ping OK, PicID=42 고정), Bridge 2.5시간 가동 중 push 없음.

### 원인
`doStreamPush()`에서 `pushing = true` 설정 후 `renderFrame()`이 동기 exception을 던지면, `Promise.all().then(() => { pushing = false })` 경로에 도달하지 못해 `pushing` 플래그가 영원히 `true`로 고착. 모든 후속 프레임이 `if (pushing) return`에서 차단됨.

### 해결
`renderFrame()` + `pushFrame()` 호출을 try/catch로 감싸서 동기 에러 시 `pushing = false` 즉시 복원. 비동기 `pushFrame` 실패는 기존 `.catch()`로 이미 처리됨.

### 교훈
- 비동기 가드 플래그(`pushing`)는 동기+비동기 양쪽 실패 경로 모두에서 해제해야 함
- `Promise.all().then()`만으로는 동기 에러 전 코드의 실패를 커버할 수 없음

## 2026-03-15 — iOS 앱 접속 불안정 수정 (ScenePhase + WebSocket 라이프사이클)

### 문제
iOS 앱이 Android 대비 접속 불안정. 핵심 원인: **ScenePhase 미처리** — 백그라운드 복귀 시 죽은 WebSocket을 감지/복구하는 로직 부재. Bridge 서버가 15초 ping interval로 30초 후 zombie terminate → iOS 앱은 죽은 소켓을 들고 있음.

### 해결
6가지 수정 적용 (4개 파일, +207/-21줄):

1. **ContentView ScenePhase**: `@Environment(\.scenePhase)` + `.onChange` → `handleForegroundReturn()`/`handleBackgroundEntry()`
2. **3-tier 복구 전략** (AgentStateHolder): suspend 시간 기반 — >20s=force disconnect+waterfall restart, 5~20s=health check(3s timeout), <5s=ping timer restart. `restartWaterfall()`로 waterfallStage 강제 idle 리셋
3. **BridgeConnection health check**: `forceHealthCheck(completion:)` — 즉시 ping + 3초 timeout, NSLock 기반 thread-safe completion guard. `forceDisconnectAndRestart()`, `resetReconnectCount()` 추가
4. **Ping 타이머 개선**: 30s→15s (서버와 동기화), RunLoop `.default`→`.common` (UI 스크롤 중에도 동작)
5. **URLSession 설정**: `timeoutIntervalForRequest=15`, `waitsForConnectivity=false`. Max reconnect 10→20
6. **handleDisconnect race guard**: `isHandlingDisconnect` flag — ping callback + receive loop 동시 호출 방지

### 교훈 / 핵심 설계 결정
1. **iOS 백그라운드 = 연결 소멸 수용**: Background Execution Mode 추가 불가 (VoIP/audio 앱이 아니므로 심사 거절). "백그라운드에서 끊어짐을 수용하고, 포그라운드 복귀 시 즉시 복구"가 올바른 iOS 패턴
2. **Suspend 시간 기반 분기**: 짧은 suspend(<5s)에서 force reconnect하면 불필요한 재연결. 20s 이상이면 서버가 이미 terminate했으므로 health check 생략하고 바로 disconnect. 5~20s 구간만 실제 health check 필요
3. **Ping interval 동기화**: 클라이언트 30s > 서버 15s → 서버가 먼저 zombie 판정. 동일 interval로 맞춰야 서버 terminate 전에 클라이언트가 감지 가능
4. **RunLoop `.common` mode**: `.default` mode Timer는 UI 스크롤/애니메이션 중 suspend됨. 네트워크 heartbeat 같은 타이머는 반드시 `.common`으로 등록

---

## 2026-03-15 — TUI 테라리움 스케일링 + 멀티세션 표시 버그 수정

### 문제
1. **멀티세션 문어 1마리만 표시**: `setOctopi()`가 `o.name === s.name`으로 기존 문어 매칭 → 같은 프로젝트의 세션 2개가 동일 name이면 `find()`가 항상 첫 번째만 반환, 두 번째 문어 미생성
2. **세션 목록 primary 누락**: renderer에서 `state.sessions.length > 0`이면 siblings만 표시하고 자기 자신(primary) 빠뜨림. session bridge 연결 시 항상 1개 부족
3. **OpenClaw 목록 미표시**: gateway probe로만 감지된 OpenClaw가 sessions 목록에 없으면 좌측 패널에 안 나옴
4. **이름 겹침**: 같은 프로젝트명 세션 구분 불가
5. **이름표 위치**: large 스케일 시 `nameYOff=3`으로 문어와 2줄 간격

### 해결
- `OctopusInstance`에 `id` 필드 추가, 세션 `id`로 매칭 (name 매칭 제거)
- 동일 `projectName` 세션 자동 번호 부여 (`AgentDeck #1`, `#2`)
- renderer: daemon 연결=sessions만, session bridge=self+siblings 표시
- `gatewayAvailable && !hasOcSession` → 가상 OpenClaw 엔트리 추가
- 이름표 `oy - 1` 고정 (스케일 무관, 스프라이트 바로 위)
- 가재 이름표 추가 (`ctx.crayfish.name || 'OpenClaw'`)
- 3단계 스프라이트 스케일링: small(1×)/large(2×, 100×20)/xlarge(3×, 160×35)
- 가재 ROUTING 시각 효과: signal wave rings + orbiting cyan dots
- 테트라 인력 대상: processing octopus > routing crayfish > none

### 교훈 / 핵심 설계 결정
1. **`name` 매칭의 함정**: 같은 프로젝트 디렉토리에서 여러 세션 실행 시 `projectName`이 동일 → display name은 표시용이고 식별에는 session ID 사용 필수
2. **Self vs Siblings 구분**: daemon은 모든 세션을 siblings로 보고, session bridge는 자신 제외 siblings만 전송. 렌더러가 "primary 포함 여부"를 `agentType`으로 분기해야 함
3. **`scaleGridN(n)` 범용화**: 2× 전용 `scaleGrid()` 대신 N배율 범용 함수로, 추후 스케일 단계 추가 시 코드 변경 최소화

---

## 2026-03-15 — TUI 모니터링 대시보드 (`agentdeck dashboard`)

### 문제
터미널에서 직접 에이전트를 모니터링할 방법이 없었음. SSH 환경, 리모트 서버, 추가 디바이스 없는 상황에서 실시간 상태 확인 불가.

### 해결
`bridge/src/tui/` 6개 파일 (~1700줄) + CLI 명령어 추가. 신규 의존성 없이 raw ANSI escape code로 구현.

- **WS 클라이언트 아키텍처**: Android/iOS 앱과 동일한 패턴 — `session-registry.ts` 자동 디스커버리 → daemon 우선 연결 → WS로 `BridgeEvent` 수신
- **적응형 3단계 레이아웃**: wide (120+), standard (80-119), narrow (60-79). `flushBuf()`에서 마지막 줄 `q quit` 힌트 예약
- **테라리움**: Braille 문자로 수중 생태계 애니메이션 (10fps). Octopus 14×5→7×2, Crayfish 16×8→8×2 (문어보다 크게), Tetra 5+5 boids
- **반블록 픽셀 폰트**: 4×6 픽셀 → 4×3 반블록(▀▄█) 변환. `FONT` 테이블 + `renderPixelFont()` 범용 함수
- **STATUS 2컬럼**: E-ink `EinkStatusCompact`와 동일한 LIMITS│MODELS 분할
- **로컬 타임라인 생성**: `state_update` 이벤트에서 상태 전환/도구 변경 추적 → `TimelineEntry` 생성. `receivingBridgeTimeline` 플래그로 bridge 이벤트 수신 시 로컬 생성 억제

### 교훈 / 핵심 설계 결정
1. **Width 계산 엄밀성**: 모든 라인이 정확히 `cols` 문자여야 터미널이 줄바꿈하지 않음. `borderFill(prefix, suffix, targetWidth)` 헬퍼로 동적 prefix 길이 대응. 하드코딩 hLine 길이는 connIcon/spinnerStr/staleTag 등 가변 콘텐츠에서 반드시 어긋남
2. **flushBuf 패턴**: 콘텐츠 행 수와 터미널 높이 불일치 시 마지막 줄(q quit)이 잘림 → `maxBoxRows = rows - 1`로 예약 + 잔여 행 클리어
3. **크리처 Y 위치**: idle=0.88(바닥 밀착), processing=0.30(수영), awaiting=0.50(중간). `lerp * 0.05`로 부드러운 전환. bob 진폭도 상태별 분리 (idle 0.005 vs processing 0.02)

---

## 2026-03-15 — Pixoo64 LED 픽셀아트 리디자인 + 활동 상태 표시 수정

### 문제
1. **문어 스프라이트 품질**: 14×5 그리드 + PIXEL_ASPECT 2.0 + outline/glow → LED에서 형태 불분명, 원본 캐릭터와 괴리
2. **Daemon에서 활동 상태 미표시**: Pixoo 모듈이 daemon에서 실행될 때, daemon의 IDLE state가 세션의 실제 state를 덮어씀
3. **agentType 판별 오류**: Daemon이 Gateway 연결 시 `agentType: 'openclaw'`로 보내므로 단순 negative-match 불충분
4. **몸통 찢어짐**: 소수점 cellSz(1.067)에서 인접 셀의 정수 반올림 불일치 → 매 프레임 1px 갭 발생
5. **가재 눈 표현 애매**: 그리드 셀 크기 의존 렌더링 → zoom/LOD에 따라 크기 변동
6. **Idle 카메라 단조로움**: wide↔full-tank 간 zoom 차이 0.1로 거의 변화 없음

### 해결

**문어 LED 픽셀아트 리디자인** (`pixoo-sprites.ts`):
- 그리드: 14×5 (PIXEL_ASPECT 2.0) → **13×13 정사각형** — 팩맨 고스트 스타일 각진 돔 머리
- 셀 크기: `cellSz = 1` 고정 (1셀 = 1LED픽셀) — 소수점 반올림 갭 원천 차단
- 모든 좌표/offset 정수: `Math.round(baseX)`, breathPx, dx 전부 integer
- 눈: 검정 네거티브 스페이스 2행 (세로 2px), blink 애니메이션 제거
- 팔: 3행 두께, body 동일 색상, 움직임 없음 (몸통 분리 방지)
- 촉수만 `Math.round` 정수 dx로 애니메이션
- 아웃라인/글로우 완전 제거 — LED 자체 발광으로 엣지 정의 충분

**가재 렌더링 개선**:
- 3×3 고정 눈: teal 중심 1px + 검정 8-neighbor surround (그리드 독립 오버레이)
- 둥근 body 그리드 (head dome 확장, LOD 확장)
- 하단 terrain: rock 색상 → warm earth 톤 (모래와 자연스러운 연결)

**Daemon 상태 전파** (`pixoo-renderer.ts`):
- `CODING_AGENTS` set 기반 positive-match: `claude-code`/`codex-cli`/`opencode`만 primary state override
- `_primary` fallback도 CODING_AGENTS만 생성
- `effectiveState`: creature 인스턴스 기반 state 산출 → bubbleDensity, drawSurface에 적용

**카메라 시스템** (`pixoo-camera.ts`):
- Active zoom: 2.0 → **3.2** (원본 캐릭터 수준 클로즈업)
- Idle cycle: `wide(1.0) → pan-left(cx=0.35, 1.15) → wide → pan-right(cx=0.65, 1.15)` 좌우 패닝
- CAMERA_WIDE zoom: 1.1 → 1.0

**기타**:
- Reset time "m" 표시: 분 단위만 남으면 `53m` 형태. 시간+분은 기존대로 `4h53`
- Pixel font "m" 글리프: `101,111,101,101,101` (두 기둥 형태, "n"과 구별)

### 교훈 / 핵심 설계 결정
- **LED 픽셀아트는 1셀=1픽셀이 정답**: 소수점 셀 크기는 반올림 불일치로 갭/중복 유발. 정수 고정으로 원천 해결
- **LED에서 아웃라인/글로우 불필요**: 각 LED 픽셀이 자체 발광하므로 외곽선 없이도 형태 인지 가능. 오히려 실루엣 번짐 유발
- **Daemon agentType은 상황 가변**: Gateway 연결 시 `'openclaw'`, 미연결 시 `'daemon'`. `CODING_AGENTS` positive-match가 안정적
- **팔 애니메이션은 body 분리 위험**: 인접 셀이 dx로 이동하면 gap 발생 → 팔은 고정, 촉수만 애니메이션이 안전

---

## 2026-03-15 — Unified Brand Icon + Disconnected Screen + Timeline 수정

### 문제
1. **브랜드 일관성 부재**: 각 플랫폼(Android/Apple/ESP32) disconnected 화면이 제각각 — 아이콘, 카드 레이아웃, 버튼 스타일 불일치
2. **앱 아이콘 미설정**: Apple AppIcon 슬롯 전체 비어있음, Android는 기본 벡터 XML
3. **Apple Timeline 미표시**: SwiftUI `@Observable` 중첩 객체 관찰 문제 — `TimelineStore`(nested @Observable) 변경이 UI에 전파 안 됨
4. **OpenClaw 중복 표시**: Daemon이 `agentType=openclaw`로 primary 전송 + virtual `openclaw-gateway` sibling 주입 → #1, #2 중복
5. **Apple reconnecting 버튼 깜빡임**: `connectInternal()`이 매 reconnect마다 `disconnect(reconnect: false)` 호출 → `isReconnecting=false` 리셋
6. **Apple은 bridge timeline 이벤트에만 의존**: Daemon IDLE시 timeline_event 미전송 → Android(StateTimelineGenerator 로컬 생성)만 timeline 보임

### 해결

**브랜드 통일**:
- `~/Desktop/agentdeck-icon.png` (640×640 3D 테라리움) → Android drawable + Apple imageset + ESP32 LVGL canvas
- Android tablet: 80dp icon + card layout (기존 유지, icon 추가)
- Android e-ink: 48dp grayscale icon (`setToSaturation(0f)`)
- Apple: ZStack scrim + centered card (360pt, rounded 16) — `.secondary` → 명시적 `slateText` (#94A3B8)
- ESP32: LVGL canvas 48×48 (jar + octopus silhouette 프리미티브 드로잉) — 사용자가 "{ }" 텍스트 아이콘으로 변경

**앱 런처 아이콘**:
- Apple: `sips` 리사이즈 7개 PNG (16~1024) → AppIcon.appiconset 11슬롯 매핑
- Android: 5개 mipmap density (mdpi 48px ~ xxxhdpi 192px), adaptive icon XML 제거 → PNG 직접

**Timeline 수정 (3단계 디버깅)**:
- 1차: `@State grouped` + `onChange(of: entries.count)` → 중첩 Observable 미전파
- 2차: `timelineVersion` counter + `onChange` → body에서 안 읽혀 observation 미등록
- 최종: `timelineVersion` computed property + `.id(timelineVersion)` — body에서 반드시 읽히는 `.id()` 메커니즘으로 observation 강제 등록
- **근본 해결**: `StateTimelineGenerator.swift` 추가 — Android와 동일하게 state 전환에서 로컬 timeline 생성, bridge rich timeline 수신 시 억제

**OpenClaw 중복 수정**:
- Apple SessionListPanel + Android 3곳 (SessionListPanel, EinkAgentColumn, EinkPortraitHeader)
- 로직: sibling.agentType == primary agentType이고 이미 entries에 존재하면 skip

**Reconnecting 깜빡임 수정**:
- Apple `connectInternal()`: `disconnect(reconnect: false)` 대신 소켓만 직접 정리, `isReconnecting`/`reconnectAttempt` 보존
- Android는 reconnect 경로에서 `doConnect()` 직접 호출 (disconnect 미경유) → 문제 없었음

**iOS 화면 회전**:
- `UIDevice.setValue` (deprecated, 미동작) → `UIWindowScene.requestGeometryUpdate()` (iOS 16+)
- 아이콘: `arrow.triangle.2.circlepath` → `rectangle.portrait.rotate`, 투명도 0.6→0.35

### 교훈 / 핵심 설계 결정
- **SwiftUI @Observable 중첩 객체**: nested @Observable의 프로퍼티 변경은 부모의 body에서 추적 안 됨. 부모에 version counter 두고 `.id()` modifier로 강제 observation 등록이 가장 확실
- **Timeline은 로컬 생성 필수**: Bridge가 timeline을 항상 보내는 것은 아님 (IDLE, 특정 adapter 미지원 등). 각 클라이언트가 state 변화에서 로컬 timeline을 생성하되, bridge rich timeline 수신 시 억제하는 2-tier 패턴
- **Daemon primary agentType 치환**: Daemon이 Gateway 연결 시 primary를 `openclaw`로 보내면서 virtual sibling도 주입 → 모든 세션 리스트 UI에서 중복 방지 로직 필요
- **Reconnect 상태 보존**: reconnect 시도 시 이전 연결을 정리할 때 reconnecting 상태 플래그를 리셋하면 안 됨 — Android 패턴(소켓만 정리, 상태 유지) 따를 것

---

## 2026-03-15 — Apple Monitor UI 2차 보정 + 멀티디바이스 상태 동기화

### 문제
1. Apple/Android Monitor UI 시각 차이: WaterEffect caustic 강도, Timeline 65/35 비율, TankStatus 줄간격, nil agentType 아이콘, macOS 버튼 테두리
2. Apple 기기에서 OpenClaw 상태 변화 미반영 (terrarium 업데이트 안 됨)
3. Apple 기기에서 bridge 단절 시 disconnect 상태 미표시
4. 멀티디바이스 간 상태 불일치 — Apple/ESP32가 session bridge(10초 폴링)에 연결되어 daemon(실시간) 대비 지연

### 해결
**시각 보정**:
- SwiftUI `plusLighter` blend mode는 Android `BlendMode.Plus`보다 ~20배 강함 → caustic alpha `0.85→0.04`, lineCount `8→5`, strokeWidth 절반
- Timeline GeometryReader 감싸서 65/35 명시적 비율 적용
- Android TankStatus `includeFontPadding=false` + spacing 4dp, Apple도 spacing 4pt 통일
- nil agentType: Apple `🐙→●` (Android 일치), macOS `.buttonStyle(.plain)`, iOS 회전 버튼 추가

**상태 동기화**:
- Apple terrarium: `.onChange(of: siblingSessions.count)` → content-based `siblingStatesKey` 추가 (내부 state 변경 감지)
- Apple disconnect: `BridgeConnection.onDisconnect` 콜백 추가 → `resetToDisconnected()` 호출
- **Daemon-preference discovery**: 3 플랫폼 모두 mDNS auto-connect 시 `agentType == "daemon"` 우선 선택
  - Apple: `discovery.bridges.first(where: { $0.agentType == "daemon" })`
  - Android: `BridgeDiscovery.kt`에 `agentType` 필드 추가 + `agent` TXT 파싱, `firstOrNull { it.agentType == "daemon" }`
  - ESP32: 2-pass scan — daemon TXT 먼저 검색, 없으면 첫 번째 사용

### 교훈 / 핵심 설계 결정
- SwiftUI와 Android의 blend mode 강도 차이가 매우 큼 — alpha 값을 플랫폼별로 독립 튜닝해야
- `@Observable` `.onChange(of: collection.count)`는 요소 내부 변경 미감지 — content-based key 필요
- WebSocket `receive` failure가 유일한 disconnect 감지 경로 — 별도 `onDisconnect` 콜백으로 UI 즉시 반영
- **mDNS 서비스 선택이 상태 일관성의 핵심**: session bridge는 sibling 10초 폴링이라 OpenClaw 상태 변화가 최대 10초 지연. Daemon은 모든 세션을 직접 관리하므로 실시간

---

## 2026-03-14 — Pixoo64 HTTP 서버 크래시 (빈번한 요청)

### 문제
Pixoo64 테라리움 표시 후 ~54분(~6500프레임) 경과 시 기기 내장 HTTP 서버가 `ECONNREFUSED` 크래시. ping은 정상이나 HTTP 포트 80이 응답 거부. 전원 사이클 외에 복구 방법 없음.

### 해결 (진행 중)
1. `ANIM_INTERVAL_MS` 500→800 (2fps→1.25fps), `DEBOUNCE_MS` 400→600
2. `switchToCustomChannel`을 fire-and-forget에서 **await**로 변경 — 프레임 전송과 채널 재확인이 동시에 Pixoo로 가는 것 방지
3. `CHANNEL_REASSERT_INTERVAL` 25→50 (채널 재확인 빈도 절반)

### 교훈 / 핵심 설계 결정
- **Pixoo64 임베디드 HTTP 서버는 동시 요청에 극히 취약** — `maxSockets:1`만으로 부족, 코드 레벨에서 절대 동시 요청 안 되게 직렬화 필수
- **감마 보정**: LED 디스플레이는 sRGB 감마 없음. `pow(v/255, 0.7) * 255` LUT로 디바이스 전송 직전에만 보정 (렌더러/프리뷰 미적용)
- **animFrame 시간 기반**: `Date.now() / 166` — 프리뷰/디바이스 호출이 같은 카운터를 공유하면 속도 변동 발생
- 800ms 간격 장기 안정성 미확인 — 다음 세션에서 전원 사이클 후 10분+ 테스트 필요

---

## 2026-03-14 — Usage API 파싱 실패 + Bridge 종료 hang (2차)

### 문제
1. **Usage LIMITS 미표시**: `usage-cache.json`에 `inferredBillingType: "subscription"`이지만 `fiveHourPercent: null`. API 응답의 `five_hour` 객체는 존재하나 `utilization` 필드가 없거나 구조 변경됨. 429 과다 발생 (bridge 60s + daemon 60s + plugin 60s + Claude Code 자체)
2. **Bridge 종료 hang (2차)**: 이전 세션에서 `adapter.on('exit')` → `shutdown()` 호출 추가했지만, `hookServer.close()`가 열린 SSE/HTTP 연결 대기로 여전히 hang

### 해결
1. **Usage 파싱 resilient**: `parseUtilization()` / `parseResetsAt()` 헬퍼 — `utilization`/`percentage`/`percent`/`usage` + `resets_at`/`resetsAt`/`reset_at`/`expires_at` 다중 필드명 탐색. Raw 응답을 `~/.agentdeck/usage-raw-debug.json`에 덤프하여 실제 구조 확인 가능
2. **429 감소**: 폴 인터벌 60s → 120s, cache TTL 60s → 120s, Retry-After 헤더 존중
3. **종료 hang 해결**: `hookServer.close()` 전에 `server.closeAllConnections()` 호출, stdin `pause()` + `removeAllListeners()`, `BridgeCore.shutdown()` — shutdown callbacks에 2초 budget 후 즉시 `process.exit(0)`

### 교훈 / 핵심 설계 결정
- **API 응답 방어적 파싱**: 외부 API 필드명은 언제든 바뀔 수 있음. 여러 가능한 필드명을 탐색하고 raw 응답 덤프를 항상 남길 것
- **HTTP server.close() 교착**: `server.close()` 콜백은 모든 활성 연결이 닫힐 때까지 호출 안 됨. SSE 같은 장기 연결이 있으면 영원히 대기. 반드시 `closeAllConnections()` 선행 필요
- **다중 폴러 429**: 같은 OAuth 토큰으로 bridge+daemon+plugin이 각자 폴링하면 429 폭발. 공유 파일 캐시(120s TTL)로 실제 API 호출 최소화

---

## 2026-03-13 — macOS 앱 WebSocket 연결 실패 (isLocalConnection 자기 IP 미인식)

### 문제
macOS Apple 앱이 같은 머신의 bridge/daemon에 연결 실패. URLSession이 "Socket is not connected" (errno 57) 보고. 실제 원인은 WS 서버의 4001 close (Unauthorized).

머신에 두 IP (`192.168.0.102`, `192.168.0.107`)가 있고, `isLocalConnection()`이 `127.0.0.1`/`::1`만 localhost로 인식. 앱이 LAN IP로 토큰 없이 연결하면 "remote" 취급 → 4001 거부.

### 해결
1. `bridge/src/auth.ts` — `isLocalConnection()`에 `os.networkInterfaces()` 순회 추가. 머신 자체 IP (IPv4 + `::ffff:` 매핑) 모두 local로 인식
2. `Info.plist` — `NSAppTransportSecurity` / `NSAllowsLocalNetworking` 추가 (ws:// 연결 ATS 예외)
3. 이전 세션에서 추가한 `onReconnectAttempt` 콜백 + `LocalSessionDiscovery.readSessionsNow()` — reconnect 실패 시 sessions.json에서 로컬 브리지 자동 발견

### 교훈 / 핵심 설계 결정
- **URLSession 4001 → errno 57**: WebSocket 서버가 upgrade 단계에서 4001로 닫으면 URLSession은 "Socket is not connected"로 보고. 실제 원인 파악 어려움 — WS 서버 로그를 먼저 확인할 것
- **듀얼 NIC 환경**: macOS에서 유선+무선 동시 사용 시 IP가 여러 개. localhost 판별은 반드시 `networkInterfaces()` 순회 필요
- **sessions.json 기반 로컬 디스커버리**: macOS 앱은 같은 머신이므로 mDNS 대신 `~/.agentdeck/sessions.json` 직접 읽기가 더 확실 (Phase 1에서 구현)

---

## 2026-03-13 — ESP32 IPS 3.5" (JC3248W535) AXS15231B QSPI 드라이버 구현

### 문제
JC3248W535 보드(3.5" IPS 480×320)의 AXS15231B QSPI 디스플레이가 `gfx->begin()` OK를 반환하고 `fillScreen()` 실행도 크래시 없이 완료하지만, 화면은 완전 검은 상태. LovyanGFX → Arduino_GFX 전환 후에도 동일 증상.

### 해결
1. **Arduino_Canvas 래퍼 필수**: Arduino_GFX의 JC3248W535 프리셋을 조사한 결과 `Arduino_Canvas` 래퍼 사용 확인. Canvas는 PSRAM에 프레임버퍼(~307KB)를 할당하고 `flush()`로 전체 프레임을 한 번에 QSPI 전송. 직접 draw는 화면에 표시 안 됨 (ST77916과 다른 AXS15231B의 특성)
2. **init 시퀀스**: `axs15231b_320480_type1_init_operations` 명시 필요 (기본값은 360×640 AMOLED용)
3. **standalone 테스트로 격리**: `test/main_axs15231b_test.cpp` 작성 → 프리셋 완전 복제로 화면 정상 동작 확인 → display.cpp에 Canvas 적용
4. **LVGL flush 최적화**: `lv_display_flush_is_last(display)` 체크하여 프레임의 마지막 partial update에서만 전체 canvas flush (dirty rect마다 307KB 전송 방지)

### 교훈 / 핵심 설계 결정
- **AXS15231B ≠ ST77916**: 동일한 QSPI 버스지만 AXS15231B는 Canvas 래퍼 필수, ST77916은 불필요. 새 QSPI 디스플레이 추가 시 항상 라이브러리 프리셋 먼저 확인
- **검은 화면 디버깅**: begin() 성공 + fillScreen() 정상인데 검은 화면 = 버스 레벨 문제. standalone 테스트로 라이브러리 프리셋 완전 재현이 가장 빠른 해결책
- **Native USB JTAG 크래시 루프 탈출**: BOOT 버튼 없는 보드에서 `--connect-attempts 1` + 빠른 재시도 루프로 bootloader 윈도우 포착
- **디버그 레벨 관리**: `CORE_DEBUG_LEVEL=5`는 I2C 로그 폭풍 → esptool 업로드 방해. 브링업 후 3으로 낮추기

---

## 2026-03-13 — Apple (iOS/iPad/macOS) Dashboard 앱 Phase 1

### 작업
Android 태블릿/e-ink 대시보드 완성 후 Apple 플랫폼 확장. SwiftUI Multiplatform (iOS 17.0 / macOS 14.0) 단일 프로젝트로 iPhone, iPad, Mac 동시 지원.

### 구현 (Phase 1: Protocol + Networking)
- `apple/` 디렉토리 생성, 22 Swift 파일, `swiftc -typecheck` 전체 통과
- **Model**: `shared/src/*.ts` → Swift Codable structs 포팅 (13 BridgeEvent 타입, 11 PluginCommand)
- **Net**: `URLSessionWebSocketTask` + exponential backoff (1s→8s), `NWBrowser` mDNS, JSON type discriminator
- **State**: `@Observable` AgentStateHolder (null-coalescing update 패턴 — Android 동일), TimelineStore (groupConsecutive)
- **UI**: 3-tab 구조 (Dashboard/Deck/Settings), ConnectionOverlay, 기본 HUD, DeckButton/EncoderStrip
- **Tests**: ProtocolTests (12), TimelineTests (9)
- `project.yml` (xcodegen) → Xcode 프로젝트 자동 생성

### 핵심 설계 결정
- **xcodegen 사용**: `.xcodeproj` 수동 관리 대신 `project.yml` 선언형 → `xcodegen generate`
- **iOS + macOS 분리 타겟**: `platform: [iOS, macOS]` 합체 타겟은 test dependency 이슈 → `AgentDeck_iOS` + `AgentDeck_macOS` 분리
- **Swift 6 호환**: `@Observable` + `@unchecked Sendable` 패턴, `AnyCodable`은 `@unchecked Sendable`
- **NWTXTRecord API**: `.keyValue` entry 패턴 매칭은 Swift 6에서 변경 → `.string` + key=value 파싱
- **Bundle ID**: `dev.agentdeck.dashboard`

### 남은 작업
Phase 2 (Terrarium 60fps) → Phase 3 (HUD) → Phase 4 (Deck) → Phase 5 (Voice/QR) → Phase 6 (App Store)

---

## 2026-03-12 — Daemon 가재 DORMANT/SICK 비정상 표시 수정

### 문제
Android Dashboard에서 OpenClaw Gateway 실행 중임에도 가재가 DORMANT(투명) 또는 SICK(기울기+탈색)으로 표시. 3가지 원인이 겹쳐 있었음:

1. **StateMachine 초기 state `DISCONNECTED` 미전환**: Daemon 모드에는 PTY가 없어 `SessionStart` hook이 안 들어옴 → Gateway 연결 후에도 state가 `DISCONNECTED` 유지 → Android에서 `agentType:"openclaw"` + `DISCONNECTED` → DORMANT
2. **초기 probe 후 broadcast 누락**: `probeGateway()` 완료 후 `cachedGatewayAvailable = true` 갱신만 하고 `state_changed` emit 안 함
3. **`openclaw doctor` timeout**: DOCTOR_TIMEOUT 5초인데 실제 실행 7초+ → timeout kill → `gatewayHasError: true` → 가재 SICK

### 해결
1. Gateway 연결(connection event `connected`) 시 StateMachine이 아직 DISCONNECTED이면 `handleHookEvent('SessionStart', {})` 호출 → IDLE 전환
2. 초기 `probeGateway().then()` 완료 후 `stateMachine.emit('state_changed', ...)` 추가 (daemon-server.ts + index.ts)
3. Adapter `.catch()` 에서도 state broadcast 추가 (adapter 실패해도 gatewayAvailable: true 전달)
4. DOCTOR_TIMEOUT 5s → 15s

### 교훈
- **Daemon 모드는 PTY 없이 StateMachine이 `DISCONNECTED`에 고착**: 외부 adapter 연결이 session lifecycle을 대체해야 함
- **`openclaw doctor`는 네트워크 체크 포함 7초+**: execFile timeout은 넉넉하게 (15초)
- **복합 디버깅**: DORMANT(state 문제) → 수정 후 SICK(health check 문제) → 수정 후에도 SICK(다른 bridge가 구 코드) — 3중 원인이 순차적으로 드러남
- **멀티 bridge 환경**: 태블릿이 daemon(9120)이 아닌 session bridge(9121-9123)에 mDNS로 연결될 수 있음 → 모든 bridge가 동일 코드로 실행되어야 일관된 상태 전달

---

## 2026-03-12 — ESP32 serial `stty` blocking 수정

### 문제
`sdc` 시작 시 `startESP32Serial()` → `execSync('stty -f /dev/cu.usbmodem201301 ...')`가 USB 디바이스 불량 상태(uninterruptible kernel I/O)에서 무한 블로킹. `execSync` timeout이 SIGTERM 보내지만 커널 I/O 대기 중인 `stty`는 SIGTERM 무시. Node.js 이벤트 루프 전체 정지 → WebSocket 서버 생성, 터미널 attach 모두 불가.

### 해결
`execSync` → async `exec` + Promise 래퍼 (`execWithKill`). 3초 timeout 후 SIGTERM, +1초 후 SIGKILL 에스컬레이션. `detectESP32Ports()`, `openPort()`, `pollForDevices()` 모두 async 전환. `startESP32Serial()`은 sync 유지하되 `pollForDevices().catch()` fire-and-forget 호출 — 브리지 startup을 절대 블로킹하지 않음. 10초 poll interval이 실패한 디바이스 자동 재시도.

### 교훈
- **Node.js에서 `execSync`는 시한폭탄**: 외부 프로세스가 커널 I/O에 갇히면 timeout+SIGTERM으로도 해결 불가. USB/시리얼 관련 명령은 반드시 async + SIGKILL 에스컬레이션
- **Bridge startup path에 sync I/O 금지**: 하나의 불량 디바이스가 전체 서비스 startup을 막을 수 있음

---

## 2026-03-12 — ESP32 86 Box 완성 (데이터 파티클, 가재 수정, HUD, WiFi)

### 문제
1. **Reset time 깨짐**: Bridge가 ISO 8601 (`2026-03-11T16:00:00+00:00`) 전송 → ESP32가 20-char 버퍼에 truncate → 깨진 텍스트 표시. `mktime()` 비교도 NTP 없어서 무의미.
2. **가재 안 보임**: `gatewayAvailable: true`가 relay에서 전송되지만, `crayfishState`가 `handleSessionsList()`에서만 설정됨. Relay는 `sessions_list`를 보내지 않아서 `crayfishState = DORMANT` 유지.
3. **WORKING 효과 안 보임**: 옥토퍼스 스타버스트(선 방사) 효과가 작은 화면에서 잘 안 보임.
4. **HUD 하단 여백**: 빈 stale label이 flex에서 공간 차지.

### 해결
1. **Reset time**: Relay에서 ISO→상대 시간 변환 후 전송 ("1h 30m", "2d 4h"). ESP32 파서는 'T' 없는 문자열은 그대로 사용, ISO면 NTP(WiFi 시) 파싱. WiFi 연결 시 `configTzTime("UTC", ...)` NTP 동기화.
2. **가재**: `updateCreatureStates()`에 `crayfishCount == 0 && gatewayAvailable → SITTING` 폴백 추가. Relay도 daemon(9120) `/health`에서 gateway 상태 폴링.
3. **데이터 파티클**: Android `DataParticleSystem` 포팅 — WORKING/ROUTING 시 3색 발광 입자(cyan/amber/green) 생성, 4중 동심원 렌더링, 테트라가 먹이로 추적/소비. 스타버스트 제거.
4. **HUD**: `LV_OBJ_FLAG_HIDDEN`으로 빈 stale label 숨김, `pad_bottom=0`.

### 교훈
- **ESP32는 시계가 없다**: NTP 없이 time() = epoch 0. 시간 관련 계산은 호스트(relay/bridge)에서 선처리
- **상태 파생은 모든 메시지 경로에 폴백 필요**: sessions_list 전용 로직은 serial relay 경로에서 누락됨
- **daemon vs session bridge**: daemon(9120)만 gateway 상태 보유, session bridge(9124+)에는 없음
- **LVGL flex에서 빈 라벨도 공간 차지**: `LV_OBJ_FLAG_HIDDEN`으로 제거해야 함

---

## 2026-03-12 — Usage 데이터 불일치 수정 (Android/ESP32/Plugin)

### 문제
Android LIMITS, ESP32 TANK STATUS, Claude 실제 사용량이 서로 다르게 표시. Bridge가 단일 소스로 동일 JSON broadcast하지만 3가지 버그로 표시값이 달라짐.

### 해결
**Bug 1 — `buildUsageEvent` DRY 위반**: `index.ts`(5개 파라미터)와 `daemon-server.ts`(4개, ollamaStatus 누락)에 동일 함수 복붙. → `bridge/src/usage-event.ts` 단일 파일로 추출, 양쪽 import. Daemon 8개 call site 모두 `cachedOllamaStatus` 추가.

**Bug 2 — ESP32 sticky values**: Bridge에서 10분 TTL 만료 시 percent 필드 생략 → ESP32 `if (is<float>())` 조건부 파싱이 기존 값 유지 → 오래된 % 계속 표시. → sentinel `-1.0f` 패턴: 필드 부재 시 `-1.0f` 할당, reset 문자열도 빈 문자열로 클리어.

**Bug 3 — ESP32 HUD no-data 표시**: `updateGauge()`에 sentinel 처리 추가 — `pct < 0` → "--" + 빈 게이지. stale 시 "72%!" 표시 (Android과 동일).

### 교훈
- **코드 복제 = drift 불가피**: `buildUsageEvent` 같은 함수를 2곳에 복붙하면 파라미터 추가 시 한쪽이 빠짐. 공용 모듈 추출 필수
- **C/C++ 조건부 파싱의 함정**: `if (field.is<T>()) state = field` 패턴은 필드 부재 시 이전 값 유지 — JSON optional 필드에서는 반드시 else 분기로 sentinel/default 할당
- **sentinel convention**: float에서 0은 유효 값이므로 -1.0f를 "no data" sentinel으로 사용. `reset()` 에서도 0이 아닌 -1.0f로 초기화

---

## 2026-03-12 — Timeline 중복 표시 버그 (daemon upsert 누락)

### 문제
Android TimelineStrip에서 `chat_start` 이벤트가 동일 timestamp로 중복 표시. "Prompt sent" + "MoltBook 야간 스웜 작업 시작"처럼 원본+enriched 버전이 둘 다 나타남.

### 해결
**근본 원인**: `daemon-server.ts`가 adapter의 `evt.upsert` 플래그를 무시하고 항상 `addEntry()` 호출. `extractTopicHint()`가 chat_start를 enrichment할 때 upsert로 보내지만, daemon이 새 항목으로 추가 → raw가 다르므로 5s dedup도 통과 → WS broadcast에도 upsert 플래그 누락 → Android가 2개 항목 저장.

3곳 수정:
1. **daemon-server.ts timeline case**: `evt.upsert` 분기 추가 → `upsertEntry()`/`addEntry()` 분리
2. **daemon-server.ts onEntry 리스너**: `(entry, upsert)` 시그니처 + broadcast에 `upsert: true` 포함
3. **Android TimelineStore.addEntry()**: 5s 윈도우 type+summary dedup 안전장치 추가

### 교훈
- **코드 복제 시 분기 누락 위험**: `index.ts`(coding bridge)에는 upsert 분기가 있었으나 `daemon-server.ts`에는 누락. 동일 이벤트를 처리하는 두 경로가 있으면 반드시 양쪽 동기화 확인
- **dedup은 다층 방어**: source(upsert) + store(5s dedup) + client(dedup) — 어느 한 층이 실패해도 다른 층에서 잡아야

---

## 2026-03-11 — ESP32 디바이스 조사 및 펌웨어 백업

### 배경
AgentDeck Dashboard의 ESP32 기기 확장을 위해 보유 3대 디바이스 조사 및 백업 수행.

### 디바이스 조사 결과
3대 모두 ESP32-S3 (QFN56 rev0.2), 8MB PSRAM, 16MB Flash, DIO, 40MHz:
- **86 Box 4인치**: CH340 외장 USB, Arduino+IDF v5.1.1 (2023-11), LVGL BSP, OTA 미지원 (7MB factory 단일), 파일시스템 없음
- **IPS 3.5인치**: Native USB JTAG, IDF v5.1.4 (2024-08), 듀얼 OTA (2MB×2), FAT 11MB, 멀티미디어/AIDA64
- **AMOLED 1.8인치 원형**: Native USB JTAG, IDF v5.1.4 (2025-02), 듀얼 OTA (3MB×2), SPIFFS 9MB, AI 음성/시계

### CH340 백업 문제 및 해결
86 Box의 CH340 시리얼 칩이 16MB 연속 전송 시 반복적 데이터 손상 (`Corrupt data, expected 0x1000 bytes but received 0xNNN bytes`). 케이블 교체로도 해결 안 됨.
- **해결**: 1MB 청크 16분할 + 실패 자동 재시도. 1차 성공률 56% (9/16), 재시도로 100% 달성
- **교훈**: CH340 기반 ESP32-S3 보드는 장시간 연속 시리얼 전송에 취약. 청크 분할 백업이 필수

### 백업 위치
`~/Desktop/esp32-backups/` — 3개 `.bin` (각 16MB) + `DEVICE_INVENTORY.md`

---

## 2026-03-11 — OpenClaw Timeline 중복 & 노이즈 이벤트 수정

### 문제
1. **이벤트 중복**: Bridge 연결 중에도 plugin `logStream`이 독립 실행 → 같은 `openclaw logs` 출력을 bridge(relay)와 plugin(직접 파싱) 양쪽에서 추가하여 동일 이벤트 2회 표시
2. **에러 노이즈**: `web_fetch timed out` 같은 일시적 네트워크 에러가 타임라인에 노출 (에이전트가 내부 재시도하는 에러)
3. **"Prompt sent" 고착**: 외부 트리거 채팅(cron, 웹 UI)에서 토픽 추출 윈도우가 20~200자로 너무 좁아, 첫 delta가 200자 넘으면 추출 기회 0

### 해결
1. **logStream 자동 관리**: `receivingBridgeTimeline` setter에서 `logStream.stop()/start()` 호출 — bridge 연결 시 중복 소스 제거
2. **timeline-store dedup 안전망**: plugin/bridge 양쪽 `addEntry()`에 5초 윈도우 type+raw 중복 검사
3. **transient error 필터**: `shared/timeline.ts` `parseLogLine()`에서 web_fetch+timeout/ECONNREFUSED 패턴 필터
4. **토픽 추출 개선**: `topicExtracted` 플래그 도입 + 200자 상한 제거. 한 번 추출 후 반복 덮어쓰기 방지, 큰 첫 delta에서도 추출 가능

### 교훈
- 다중 소스 파이프라인에서는 **소스 제거가 dedup보다 우선** — dedup은 안전망일 뿐
- 토픽 추출 같은 one-shot 로직에는 반드시 완료 플래그 필요 (윈도우 상한보다 명시적)

---

## 2026-03-11 — Timeline "Completed" 고착 버그 수정

### 문제
AgentDeck 타임라인에서 `chat_end` 항목이 항상 "Completed"로만 표시됨. 한국어 LLM 요약이 동작하지 않음.

### 원인
1. MLX 서버 크래시 (CloudStorage 데드락 → `reload=True` 문제, 별도 수정 완료) 시 `timeline-summarizer.ts`에서 `mlxAvailable = false`가 영구 설정됨
2. Ollama도 실패하면 `ollamaAvailable = false` → 두 LLM 모두 영구 스킵 → `summarizeResponse()` 항상 `null` 반환
3. Plugin에는 bridge와 달리 요약기 자체가 없어, bridge 없이 단독 운영 시 요약 불가

### 해결
1. **Bridge `timeline-summarizer.ts`**: availability flag에 60초 TTL 추가 — 실패 후 60초 경과 시 재시도
2. **Plugin `timeline-summarizer.ts`** (신규): plugin용 경량 MLX 요약기 추가
3. **Plugin `gateway-client.ts`**: `chat_end` 후 비동기 LLM 요약 → `upsertEntry()`로 "Completed" 교체
4. **Plugin `timeline-store.ts`**: `upsertEntry()` 메서드 추가 (ts+type ±1s 매칭)

### 교훈
- Boolean availability flag는 영구 disable 위험 — 반드시 TTL/retry 메커니즘 필요
- Bridge와 plugin 양쪽에 동일 기능 필요 시, bridge 단독 의존은 SPOF — plugin도 독립 동작 가능해야 함

---

## 2026-03-11 — Usage Percent Staleness Fix

### 문제
Android rate limit 게이지가 실제와 크게 다름 (7% 표시, 실제 33%). 실측: bridge 캐시가 3.4시간~15.5시간 전 데이터를 무기한 broadcast. API 429 실패 → `apiUsageStale=true` 마킹하지만 `cachedApiUsage` 값은 유지 → 시간이 갈수록 캐시 낙후. Daemon은 `usageStale` 필드 자체가 누락.

### 해결
**(1) Bridge 10분 TTL** (`bridge/src/index.ts`): 5초 broadcast tick에서 `lastApiFetchTime`이 10분 초과 시 `cachedApiUsage = null` 클리어. Android가 null 수신 → 게이지 숨김.

**(2) Daemon fetchedAt 보존** (`bridge/src/daemon-server.ts`): `fetchUsageViaHttp` → `RelayedUsage { usage, fetchedAt }` 반환. Daemon의 `lastApiFetchTime`을 sibling의 원래 fetch 시각으로 설정 (자기 relay 시각이 아님). 동일 10분 TTL 적용.

**(3) Daemon `usageStale` 필드 추가**: `buildUsageEvent`에 `stale?` 파라미터 추가, `apiUsageStale` 상태 변수 도입. Relay 실패 시 `apiUsageStale = true`, 성공 시 `false`.

### 교훈 / 핵심 설계 결정
- Stale 캐시 표시(! suffix)만으로는 불충분 — 값 자체가 오래되면 **클리어**해야 클라이언트가 올바르게 반응 (숨김 vs 오래된 값 표시)
- Relay 체인에서 fetchedAt 보존이 중요 — daemon이 `Date.now()`를 사용하면 sibling의 오래된 캐시가 "방금 fetch"로 위장됨
- Bridge/Daemon 양쪽에 동일 TTL 상수 적용으로 일관성 확보

---

## 2026-03-11 — Timeline 중복 + Generic 라벨 + Daemon 이중 실행

### 문제
Android timeline에 "Prompt sent", "Completed" 같은 generic 라벨 + 중복 엔트리. 근본 원인 3가지:
1. Hook `prompt` 필드 미사용 → 모든 chat_start가 "Prompt sent"
2. Bridge upsert (topic hint 보강 등) → Android에서 새 엔트리로 추가 → 중복
3. Daemon 2개 중복 실행 → 같은 Gateway 이벤트 이중 relay → 중복

### 해결
**(1) Hook prompt 필드 활용** (`bridge/src/index.ts`): `emitChatStart()`에 hook body의 `prompt` 필드 (500자+detail) 전달. `last_assistant_message`로 topic hint 보강

**(2) Upsert 프로토콜** (`shared/src/protocol.ts` → `plugin/src/plugin.ts` → Android):
- `TimelineEventMsg.upsert?: boolean` 플래그 추가
- Plugin: upsert 시 `updateEntryRaw()` (기존 엔트리 교체)
- Android `TimelineStore.kt`: `upsertEntry()` + `updateLastOfType()`
- `StateTimelineGenerator.kt`: prompt-aware chat_start/chat_end, 소급 업데이트

**(3) Daemon singleton guard** (`session-registry.ts` + `daemon-server.ts` + `daemon.ts`):
- `findExistingDaemon()`: session registry에서 `agentType='daemon'` + PID alive 체크
- `startDaemon()` 진입부 + CLI `start` action 양쪽 guard
- `process.exit(0)` — LaunchAgent KeepAlive 재시작 루프 방지

### 교훈 / 핵심 설계 결정
- `findAvailablePort()`가 포트 충돌을 "해결"하는 것이 오히려 문제 — daemon은 반드시 1개만 실행되어야 하므로 singleton guard가 port scanning보다 우선
- Timeline enrichment는 source-rich, client-truncate 원칙 — bridge가 넉넉한 데이터 전달, 각 클라이언트(plugin/android)가 자체 truncation
- Upsert 패턴: 기존 broadcast 인프라에 boolean 플래그 하나 추가로 중복 없는 업데이트 구현

---

## 2026-03-10 — USB 해제 후 WiFi 재연결 불가 문제

### 문제
태블릿 USB 해제 시 (1) WiFi mDNS 디스커버리 미작동 → 대체 연결 수단 없음 (2) localhost 재연결 무한 루프 (adb reverse 터널 깨져도 포기 안 함) (3) USB 재연결해도 adb reverse 터널 미복구 (bridge 시작 시 1회만 설정)

### 해결
- **MonitorScreen mDNS 활성 조건 수정**: `currentUrl == null` 조건 제거 → 미연결 상태면 항상 mDNS 실행 (E-ink은 이미 수정됨)
- **ConnectionOverlay**: 재연결 중에도 WiFi 브리지 목록 + "Stop Reconnecting" 버튼 표시
- **BridgeConnection localhost 5회 제한**: 127.0.0.1/localhost 대상 5회 실패 시 자동 포기, URL 클리어 → mDNS 디스커버리 전환
- **adb reverse 30초 polling**: `startAdbReversePolling()` — USB 재연결 시 bridge 재시작 없이 터널 자동 복구

### 교훈 / 핵심 설계 결정
- mDNS 디스커버리 활성 조건은 "연결 안 됨"이면 충분 — URL 유무로 제한하면 재연결 루프 중 대체 수단 차단됨
- localhost 재연결은 반드시 상한 필요 — adb reverse는 USB 물리적 연결에 의존하므로 무한 재시도 무의미

---

## 2026-03-10 — 태블릿 테라리움 애니메이션 부드러움 최적화

### 문제
태블릿 테라리움이 60fps `withFrameMillis` 루프로 돌지만 체감 버벅임. (1) `Color.copy(alpha)` GC 압력 (80 plankton + 30 food + 14 fish + 70 octopus cells = 매 프레임 200+ Color 객체 생성) (2) 느린 lerp (dt*2f → ~1.5s 수렴) + 긴 waypoint 간격 (3~5s) (3) Caustics BlendMode.Overlay GPU framebuffer readback

### 해결
**Phase 1 — 움직임 dynamics**: 옥토퍼스 lerp 2×→4× (수렴 ~0.75s), FLOATING 호흡 bob 추가 (`sin(0.8)*0.002`), swim lerp 1.5→3.0, waypoint 간격 3~5s→1.5~3s

**Phase 2 — GC 감소**: 모든 `Color.copy(alpha=x)` → DrawScope `alpha` 파라미터로 교체 (PlanktonSystem, DataParticleSystem food+fish, OctopusCreature pixel+starburst+bubble+nametag, RockFormation). Name tag `measureText` 캐싱 (`CachedNameLayout`). Path 사전할당 (rock 6개, speech bubble tail)

**Phase 3 — GPU**: Caustics LINE_COUNT 12→8, BlendMode.Overlay→Plus (alpha 85% 보정), lineTo step 4→6. Boids separation sqrt→inverse-distSq

### 교훈 / 핵심 설계 결정
- `DrawScope.drawRect/Circle/Path`의 `alpha` 파라미터는 `Color.copy(alpha)` 대비 GC-free. 핫 루프에서 항상 우선 사용
- `BlendMode.Plus` (additive)는 `BlendMode.Overlay`보다 GPU 비용 훨씬 낮음 — Overlay는 destination read-back 필요. 낮은 alpha에서 시각 차이 미미
- Boids separation에서 `sqrt` 제거 → inverse-distSq 사용 시 가까울수록 강한 반발력이라 오히려 자연스러움

---

## 2026-03-10 — Usage API utilization 값 단위 불일치 수정

### 문제
LIMITS 게이지가 비정상 수치 표시. `extraUsageUtilization`이 84.47(%)인데 `* 100` → 8447%로 표시. Bridge `computeButtonState`에서도 `fiveHourPercent` 2(%)를 `* 100` → "200%" + 항상 빨간색(threshold `>= 0.9`).

### 해결
- `EinkStatusCompact.kt`: Extra 게이지 `extraPct * 100` → `extraPct` (이미 0-100 퍼센트)
- `bridge/index.ts` `computeButtonState`: `Math.round(pct * 100)` → `Math.round(pct)`, threshold `0.9/0.7` → `90/70`
- Plugin `usage-button.ts`는 원래 정상 (값을 직접 사용)

### 교훈 / 핵심 설계 결정
- **Anthropic OAuth Usage API `utilization` 필드는 0-100 퍼센트** (5h, 7d, extra 모두). 0-1 fraction이 아님
- **실제 API 응답을 확인하지 않고 코드 패턴만으로 단위를 추론하면 오류 발생** — bridge WS 캡처(`ws://127.0.0.1:{port}`)로 실측값 확인이 확실
- **`fiveHourPercent` 네이밍은 정확** — 이름대로 percent(0-100). `computeButtonState`가 이를 fraction(0-1)으로 잘못 취급한 것이 근본 원인

---

## 2026-03-09 — Daemon Usage Relay (429 rate limit 해소)

### 문제
Daemon + Bridge가 동시에 Anthropic OAuth Usage API를 호출하면서 429 rate limit 악순환. Android에서 rate limit 게이지 표시 불가.

### 해결
- Bridge `hook-server.ts`에 `GET /usage` 엔드포인트 추가 (no auth, local only) — `{ status, usage, fetchedAt }` 반환
- Bridge `index.ts`에서 `hookServer.onApiUsage(...)` 연결
- Daemon `daemon-server.ts`에 3-tier relay 구현:
  1. **HTTP**: sibling bridge `GET /usage` (2s timeout, 5분 freshness)
  2. **WS**: sibling bridge WS 연결 → `usage_update` 이벤트 수신 (3s timeout) — 이전 코드 bridge에서도 동작
  3. **Direct API**: sibling이 없을 때만 (단독 caller = 429 없음)
  - Sibling 있으면 직접 API 호출 안 함 → 429 방지
- mDNS "Service name already in use" 비동기 에러 → daemon 크래시 방지 (`uncaughtException` 핸들러에서 무시)

### 교훈 / 핵심 설계 결정
- **WS relay가 HTTP보다 범용적**: bridge가 이전 코드여도 WS `usage_update`는 항상 broadcast됨. HTTP `/usage`는 새 코드 필요
- **Sibling 있으면 직접 API 절대 안 치기**: bridge+daemon 동시 호출 = 429 확정. Sibling이 있으면 relay 실패해도 API 직접 호출 금지
- **mDNS는 non-critical**: `bonjour-service` publish 에러가 비동기 throw → uncaughtException → 프로세스 종료. mDNS 실패는 무시해야 함
- **Daemon 재시작 시 adb reverse 미설정**: Crema(WiFi 없음)는 수동 USB 연결 필요
- **Android `last_bridge_url` DataStore**: mDNS LAN IP 저장 → USB-only 디바이스 연결 실패 루프

### E-ink Status 리디자인
- Canvas 게이지바 → Unicode 블록 게이지(`█░`) — 순수 텍스트, e-ink 최적
- 1컬럼 스택 → 2컬럼 분할: LIMITS(30%) | MODELS(70%), 세로 구분선
- `Arrangement.Center` 수직 가운데 정렬, 섹션 헤더 11sp + 3dp bottom padding
- PROCESSING시 context 없으면(OpenClaw) split 안 함 → Status full-width

---

## 2026-03-08 — OpenClaw Timeline enrichment pipeline

### 문제
OpenClaw 타임라인이 `"Task started"` / `"Completed · Xs"` 만 표시. chat_response 0건, detail 0건, tool_exec/model_call 0건. 3가지 근본 원인:
1. Gateway `chat` delta payload에서 `payload.prompt` 조회 → 항상 null (프롬프트는 user role 메시지에 있고 delta는 assistant role만 포함)
2. 응답 텍스트가 `payload.message.content[].text` 구조인데 `payload.content`로 조회 → 미캡처
3. Plugin gateway-client가 자체 빈약한 timeline 생성 + bridge enriched timeline이 plugin에 미전달 (FORWARDED_EVENTS 누락)

### 해결
- `extractMessageText()` — Gateway `{ message: { content: [{ type: "text", text }] } }` 구조 인식
- `accumulatedResponse` — delta 스트리밍 텍스트 축적 → final에서 chat_response 생성
- `extractTopicHint()` — 프롬프트 없는 작업(cron/웹UI)에서 첫 응답 텍스트로 chat_start 업데이트
- `timeline-summarizer.ts` — MLX qwen (port 8800, `/no_think` suffix) → Ollama fallback → 한국어 1줄 요약
- ConnectionManager `FORWARDED_EVENTS`에 `timeline_event`/`timeline_history` 추가
- Plugin `receivingBridgeTimeline` flag — bridge 연결 시 gateway-client 로컬 생성 억제

### 교훈 / 핵심 설계 결정
- **Plugin과 Bridge 양쪽에 동일 enrichment 적용 필수**: Plugin이 Gateway에 직접 연결할 수 있어 bridge 경유 보장 불가
- **MLX serve URL**: `/v1/` prefix 없음 (FastAPI 기본 라우팅). 모델 이름은 `/models` endpoint로 확인
- **Qwen3.5 thinking mode**: `/no_think` suffix로 비활성화하지 않으면 thinking text가 output에 포함됨. `<think>` 태그 없이 plain text로 나올 수도 있어 multi-line 처리 필요
- **`enrichTimelineFromHistory()` 삭제**: Gateway가 `events.history` RPC 미지원 → 100% 실패하는 dead code였음
- **parseLogLine 에러 분류 순서**: error/fail 패턴을 model/memory/tool 패턴보다 **먼저** 검사해야 함. `"LLM request timed out"` → `\b(llm)\b.*\b(request)\b` 매칭 → model_call 오분류. `\bfail\b`은 `"failed"` 미매칭 → `fail(?:ed|ure)?`로 수정. 파일 경로 내 `/memory/`가 `\bmemory\b`에 매칭되어 ENOENT 에러가 memory_recall로 오분류
- **`extractReadableMessage()`**: 원본 로그의 JSON prefix, key=value 노이즈, `[subsystem]` prefix를 정리하고 ENOENT는 `파일 없음: dir/file.md`로 축약

---

## 2026-03-08 — E-ink frontlight 복구 불가 버그

### 문제
Mac 디스플레이 잠듦 → bridge가 `display_state(off)` 전송 → Android `dimEink()` sysfs `brightness=0` 기록 → bridge 연결 끊김 → `savedFrontlight` 메모리에만 있어 복구 불가. 앱 재시작해도 `isDimmed=false`로 시작하여 restore 호출 안 됨. 백라이트 영구적으로 꺼진 상태.

### 해결
1. **`AgentState.kt`**: Disconnect 시 `hostDisplayOn = true` 리셋 — 상태 불일치 방지
2. **`MonitorService.kt`**: Bridge 미연결 전환 시 이미 dimmed면 즉시 `restore()` 호출
3. **`BrightnessController.kt`**: `SharedPreferences`에 frontlight 값 영속. `init`에서 이전 crash/재시작으로 dimmed 상태가 남아있으면 sysfs 자동 복구. `dimEink()`에서 `current == 0`이면 저장 스킵 (이미 꺼진 값을 restore 대상으로 저장하지 않음)

### 교훈
- **sysfs 직접 제어 시 디스크 영속 필수**: 메모리 전용 상태는 crash/disconnect 시 유실 → 하드웨어가 비정상 상태로 고착
- **Settings.System.SCREEN_BRIGHTNESS는 Crema S frontlight에 무효**: sysfs와 Android Settings API가 별개 경로. frontlight 제어는 sysfs만 동작
- **`bl_power` 주의**: sysfs brightness=0 기록 시 드라이버가 `bl_power=0`(하드웨어 OFF)까지 연쇄 설정할 수 있음. brightness 복원만으로 bl_power가 자동 복구되는지는 디바이스마다 다름

---

## 2026-03-08 — Gateway 상태 boolean 고착 버그

### 문제
Android Dashboard에서 OpenClaw 가재가 한번 SICK 상태가 되면 gateway 복구 후에도 영구적으로 SICK 유지. `gatewayAvailable`도 동일하게 한번 `true`가 되면 gateway 종료 후에도 available로 인식.

### 해결
`bridge/src/index.ts`와 `bridge/src/daemon-server.ts`에서 `gatewayAvailable`/`gatewayHasError` 전송 시 `|| undefined` 패턴 사용이 원인. JS에서 `false || undefined` → `undefined`이므로 `false` 값이 전송되지 않고, Android 측 `?: current` Elvis 연산자가 null을 이전 값으로 대체하여 `true`가 고착됨. 4곳 모두 `|| undefined` 제거하여 boolean 값을 항상 명시적으로 전송하도록 수정.

### 교훈
- **boolean 필드에 `|| undefined` 금지**: `false`가 유의미한 값인 boolean에는 `??`를 쓰거나 항상 전송. `||`는 falsy(0, '', false, null, undefined)를 모두 탈락시킴
- **daemon-server.ts 동기화**: `index.ts`와 `daemon-server.ts`에 동일한 state broadcast 코드가 중복 존재 — 한쪽만 수정하면 다른 경로에서 재현됨

---

## 2026-03-07 — OpenClaw Timeline Detail Enrichment

### 문제
OpenClaw 자율 작업 시 Android Dashboard 타임라인에 "Prompt sent" / "Response received (3m 58s)" 같은 generic 메시지만 표시됨. 실제 어떤 행위를 하는지 (어떤 페이지를 읽고, 어떤 도구를 쓰고, 무슨 응답을 받았는지) 확인 불가.

### 해결
1. **Delta prompt 캡처**: Bridge OpenClaw adapter의 `delta` 핸들러에서 `payload.prompt` 캡처 (plugin gateway-client.ts와 동일 패턴). Gateway가 자율적으로 시작한 태스크의 실제 설명이 `chat_start`에 표시됨
2. **`detail` 필드 추가**: `shared/src/timeline.ts` `TimelineEntry`에 `detail?: string` 추가. 모든 레이어(shared→bridge→plugin→android) 관통
3. **Source-rich, Client-truncate 원칙**: Source에서 raw 최대 500자, detail 최대 1000자로 넉넉히 전달. 각 클라이언트가 자체 truncation (e-ink maxLines=1, tablet 2줄+detail 별도행, SD Plugin fisheye px 기반)
4. **`lastPrompt` 리셋**: chat 종료(final/aborted/error) 시 null로 초기화 → 다음 자율 chat에 이전 prompt 잔존 방지

### 핵심 설계 결정
- **Source-rich, Client-truncate**: 네트워크 상한(raw 500, detail 1000)은 대역폭 보호용. 디스플레이 truncation은 각 기기 책임. 기존의 source-side 150/200자 절삭은 e-ink/tablet/plugin 모두에 불필요한 정보 손실
- `detail`은 optional — backward-compatible, 기존 클라이언트는 무시

---

## 2026-03-07 — Gateway Health → Crayfish SICK State

### 문제
OpenClaw gateway에 에러(memory sync 404, 채널 경고 등)가 발생해도 AgentDeck 대시보드에서 시각적으로 알 수 없었음. 가재 캐릭터에는 DORMANT/SITTING/ROUTING/OBSERVING/WAITING만 있었고, "시스템에 문제가 있다"는 상태가 없었음.

### 해결
전체 파이프라인 구현: Bridge → shared protocol → Android.

1. **Bridge**: `gateway-probe.ts`에 `checkGatewayHealth()` 추가 — `openclaw doctor --json` 실행, warn/error issue 감지. 30초 간격 폴링 (gateway 미접속 시 스킵)
2. **Protocol**: `StateUpdateEvent`에 `gatewayHasError?: boolean` 필드 추가
3. **Android**: `CrayfishVisualState.SICK` 추가. `toTerrariumState()`에서 `gatewayHasError=true`이면 DORMANT 외 모든 상태를 SICK으로 오버라이드

SICK 시각 효과: 55% 탈색 바디, -12° 기울기, 집게 아래로 축 처짐, 눈 흐릿 깜박임 (alpha 0.35-0.55), 더듬이 처짐, 느린 호흡. E-ink: gray `0x66` (평소 `0x33` 대비 washed out), -10° 기울기.

### 핵심 설계 결정
- Doctor 폴링 30초 — TCP probe(800ms)보다 훨씬 느린 cadence. `execFile`이므로 매 호출마다 프로세스 생성 비용 있음
- Doctor 실행 자체가 실패하면 `hasError=true` (보수적 판단 — 차라리 경고가 나는 게 나음)
- Doctor JSON 파싱 실패 시에는 `false` (노이즈 방지)
- DORMANT(gateway 자체 미접속)일 때는 SICK으로 오버라이드하지 않음 — DORMANT이 더 심각한 상태

### 함께 수정: OpenClaw 임베딩 404
`~/.openclaw/openclaw.json`의 `memorySearch.remote.baseUrl`에서 `/v1` 제거. OpenAI SDK가 자동으로 `/v1/embeddings` 추가하므로 이중 경로(`/v1/v1/embeddings`) 발생하고 있었음.

---

## 2026-03-07 — E-ink Portrait Mode Rewrite

### 문제
Portrait 모드가 완전히 미구현 상태. `EinkPortraitLayout`이 스텁으로 남아서: agent panel 없음, EinkStatusCompact 미사용, EinkContextArea 미사용(AWAITING_PERMISSION 불가), refresh zone 없음, EinkFooterBar Row 클리핑 문제.

### 해결
1. **Portrait 레이아웃 전면 재작성**: landscape의 모든 컴포넌트(EinkAquariumFrame, EinkStatusCompact, EinkContextArea, EinkEventLog) 재사용. 세로 Column 배치 — Header(intrinsic) + Aquarium(35%) + Status(10%) + Context(15%, active시) + Timeline(40%).
2. **EinkPortraitHeader**: FlowRow 기반 적응형 에이전트 목록. 에이전트 수에 따라 폰트 축소(13→11→9sp) + `heightIn(max=80dp)` 상한. 프로젝트명 6자 절삭(9+개).
3. **EinkRefreshZone + 헤더 금지**: `AndroidView`가 `FrameLayout(MATCH_PARENT)` 생성 → Column 내 weight 없는 자식이 전체 높이를 소비하는 문제 발견. 헤더는 EinkRefreshZone 없이 직접 렌더링.
4. **Dialog immersive mode 복원**: `MainActivity.onWindowFocusChanged()` 오버라이드 — Settings Dialog 닫힌 후 시스템 바 자동 재숨김.
5. **EinkEventLog 텍스트 확대**: 10sp → 13sp.

### 교훈 / 핵심 설계 결정
- **EinkRefreshZone는 weight가 있는 자식에만 사용**: `AndroidView(MATCH_PARENT)` 특성상 Column 내 intrinsic height 자식을 래핑하면 전체 높이를 먹음. 반드시 weight modifier와 함께 사용하거나 직접 렌더링.
- **Dialog는 별도 Window 생성**: Android `Dialog`/`DialogProperties`는 새 Window를 만들어 기존 immersive mode 플래그를 리셋함. `onWindowFocusChanged`에서 포커스 복귀 시 재적용 필요.
- **적응형 FlowRow 패턴**: 에이전트 수에 따라 폰트/간격/이름길이를 단계적으로 축소하면 1~10+ 에이전트까지 동일 영역에 자연스럽게 수용 가능.

---

## 2026-03-06 — Claude Code Version Check & AgentDeck Self-Update

### 문제
AgentDeck은 Claude Code 터미널 출력을 regex로 파싱하므로, Claude Code 업데이트로 출력 형식이 바뀌면 파싱이 깨진다. 기존에는 `claude --version` 존재만 확인하고 버전 호환성은 검증하지 않았다.

### 해결
`sdc` 시작 시 버전 호환성 자동 체크 시스템 구현:
- `bridge/src/version-check.ts` — 핵심 모듈. `checkVersionCompatibility()` 오케스트레이터
- `check-deps.ts`에서 `claude --version` 출력 캡처하여 버전 전달
- `bridge/package.json`에 `compatibleClaudeCode` semver range 필드 추가
- npm registry 조회 (3s timeout) → GitHub raw `compatibility.json` fallback (3s)
- 비호환 감지 시 `npm install -g @agentdeck/bridge@latest` 자동 실행
- `~/.agentdeck/compatibility.json`으로 상태 캐시 (1시간 throttle)
- `setup/src/setup.ts`에 초기 상태 시딩 추가

### 핵심 설계 결정
- **Startup 절대 차단 안 함**: 모든 실패 케이스(오프라인, 파싱 실패, 설치 권한 오류)는 경고 후 진행
- **`satisfiesRange()` 자체 구현**: `semver` 패키지 의존 없이 `>=X.Y.Z <A.B.C` 형식 지원
- **2-tier fallback**: npm view → GitHub raw JSON. npm publish 없이도 `compatibility.json` 업데이트로 호환성 정보 갱신 가능
- **`--no-update-check` 플래그**: CI/스크립트 환경용 비활성화 옵션

---

## 2026-03-06 — OpenClaw Rich Timeline: Bridge → Android Relay

### 문제
Android Dashboard의 OpenClaw 타임라인이 `StateTimelineGenerator`의 단순 상태 전환 이벤트만 표시 ("Prompt sent" / "Response received (5m 32s)"). Plugin은 이미 `log-stream.ts` + `gateway-client.ts`에서 풍부한 데이터(프롬프트 텍스트, 모델명+토큰, tool command, 응답 스니펫)를 확보하고 있지만, Android로 전달하는 채널이 없음.

### 해결
`shared/src/timeline.ts`에 `TimelineEntry` 타입 + `parseLogLine()` 공유 함수 추출 (plugin에서 이동). Bridge OpenClaw 모드에서:
- `BridgeTimelineStore` (200-entry buffer) + `BridgeLogStream` (`openclaw logs --follow --json` 파서) 초기화
- OpenClaw adapter에 chat tracking 추가 (prompt/duration/tool count) → rich `chat_start`/`chat_end`/`tool_request`/`tool_resolved`/`chat_response`/`error` 이벤트 생성
- `timeline_event` (실시간) + `timeline_history` (클라이언트 연결 시 배치) BridgeEvent로 WS broadcast
- Android `StateTimelineGenerator`에 `receivingBridgeTimeline` 플래그 추가 — bridge timeline 수신 시 로컬 생성 억제, disconnect 시 자동 fallback

### 핵심 설계 결정
- **타입 공유**: `parseLogLine()`을 plugin→shared로 이동하여 bridge/plugin 양쪽에서 동일 파서 사용. Plugin의 `TimelineEntry`는 shared 타입 + `'now_marker'`(display-only) 확장
- **억제 패턴**: Android가 rich timeline 수신 시 로컬 StateTimelineGenerator를 완전 억제 (혼합하면 중복 발생). disconnect 시 자동 fallback으로 graceful degradation
- **3곳 dedup**: (1) adapter tool_request → logStream.trackToolRequest (2) logStream 내부 5s 윈도우 (3) Android TimelineStore distinctBy

---

## 2026-03-05 — Effort Level PTY regex E2E 검증 및 보정

### 문제
이전 세션에서 effortLevel 파이프라인 전체 구현 완료했으나, regex가 **추측 패턴**(`Effort: high`)으로 작성됨. 실제 Claude Code PTY 출력 미확인 상태.

### 해결
node-pty로 Claude Code를 스폰하여 `/model` → effort level 변경 시 실제 PTY 출력 캡처.

**실제 패턴 (예상과 완전히 다름):**
- 선택 중: `▌ High effort <- -> to adjust` (level이 "effort" **앞에** 위치)
- 확인 후: `with high effort` / `Opus 4.6 with high effort . Claude Max`
- 레벨: `high`, `medium`(default), `low` ("auto"는 존재하지 않음)

**수정:** `/\beffort\s*[:·]\s*(high|low|auto)\b/i` -> `/\b(high|medium|low)\s+effort\b/i`

### 교훈 / 핵심 설계 결정
- **PTY 패턴은 반드시 E2E 검증 필요** — Claude Code TUI는 ANSI 시퀀스 + block characters(`▌`) + 독자적 레이아웃 사용. 추측으로 regex 작성하면 100% 미매칭
- **"medium"은 기본값이므로 UI에서 숨김** — high/low만 모델명 옆에 표시 (Session 버튼, Android 세션 목록, E-ink 에이전트 블록 모두 동일 로직)
- **E2E 테스트 방법**: `node-pty`로 Claude CLI 스폰 → trust dialog 자동 수락 → `/model` 입력(2초 후 Enter 분리 전송) → arrow key로 effort 순환 → 출력 캡처. Command palette autocomplete 때문에 `/model\r` 동시 전송 시 실행 안 됨

---

## 2026-03-03 — E-ink 수조 애니메이션 EPD 리프레시 누락 수정

### 문제
E-ink 수조 영역의 `EinkRefreshZone`이 `triggerKey` 변경 시 1회만 EPD 리프레시. 이후 600ms 간격 내부 애니메이션 프레임은 비트맵만 갱신되고 EPD 컨트롤러에 도달하지 않았다. `EinkTerrariumView`의 내부 `animFrame` 루프와 외부 `EinkRefreshZone`의 `triggerKey` 사이에 동기화가 없었기 때문.

### 해결
Callback 기반 EPD 리프레시: `EinkTerrariumView`에 `onFrameRendered: ((isAnimationFrame: Boolean) -> Unit)?` 콜백 추가. 새 `EinkAnimatedRefreshZone` composable이 콜백을 받아 animation frame → `requestAnimationRefresh()` (GC16 partial, 플래시 없음), state transition → `requestFullRefresh()` (FULL GC16) 호출. 기존 `EinkRefreshZone`은 수정하지 않음 (다른 영역에서 정상 동작).

### 핵심 설계 결정
- **기존 zone 미수정**: `EinkRefreshZone`은 triggerKey 기반으로 다른 영역(agent panel, status, timeline)에서 잘 동작. 애니메이션 전용 신규 zone 분리
- **GC16 partial vs FULL**: animation frame에 `sendOneFullFrame=false`로 16-level 그레이스케일 유지하면서 전체 화면 플래시 방지. 상태 전환 시에만 FULL로 고스팅 클리어
- **null 기본값**: `onFrameRendered = null` → 태블릿 등 non-e-ink 호출 코드 변경 불필요

---

## 2026-03-02 — E-ink & 태블릿 디스플레이 통합 + OpenClaw 애니메이션

### 문제
1. **태블릿 멀티세션**: `LaunchedEffect(state.agents.size)`가 에이전트 수 변경 시에만 재실행 — 세션 교체/이름 변경/상태 변경 반영 안 됨
2. **E-ink 말풍선/이름태그**: WORKING 상태에서 말풍선이 캔버스 상단 밖으로 나갈 수 있음
3. **올라마 상태 간헐적**: `ollamaStatus`가 `state_update`에만 포함되어 5초 polling에도 `usage_update`에는 누락
4. **OpenClaw 애니메이션**: PROCESSING 시 가재만 ROUTING, 물고기(테트라)는 CIRCLING 유지 — `hasTool` 항상 false (OpenClaw adapter가 `currentTool` 미설정)
5. **가재-물고기 상호작용 없음**: food crumb이 WORKING 옥토퍼스에서만 산란, OpenClaw primary면 옥토퍼스 없어서 물고기에 먹이 공급 안 됨

### 해결
- **`LaunchedEffect(state.agents)`**: 리스트 참조 변경 시마다 트리거 — add/remove + 전체 creature homePosition/state/mark/displayName 갱신
- **Y 클램프**: `bubbleY.coerceAtLeast(bubbleR + 2f)`, `tagTop.coerceAtLeast(2f)` — 캔버스 밖 방지
- **이름태그 가시성**: 폰트 `0.018f→0.024f`, 태그 너비 `0.14f→0.16f*1.8f`, 1px GRAY_OCTO_LIMB 테두리
- **올라마 piggyback**: `buildUsageEvent()`에 `ollamaStatus` 파라미터 추가 → 모든 `usage_update`에 포함
- **TankStatusPanel → DashboardState**: 5개 개별 파라미터 → 단일 DashboardState (e-ink 패턴 통일)
- **E-ink Status 2-section**: TOKENS & COST 제거 → Rate Limits + Models 2-column Row
- **OpenClaw 테트라 STREAMING**: `crayfishRouting` flag 도입 — 가재 ROUTING 시 IDLE/PROCESSING 모두 → STREAMING
- **가재 heartbeat**: SITTING 상태에 4초 주기 더블펄스 teal glow 추가 — 생존 신호
- **가재 위치 추적**: `CrayfishCreature.currentPosition()` + `isRouting()` API 추가
- **DataParticleSystem 가재 인식**: `setCrayfishState(position, routing)` — ROUTING 가재에서 food crumb 산란 + school center 30% 인력
- **E-ink 테트라 가재 타겟**: 옥토퍼스 없을 때 가재 위치(0.75, 0.55)로 STREAMING pull + 데이터 파티클 orbit

### 교훈 / 핵심 설계 결정
- **이벤트 piggyback 패턴**: 정기 폴링 데이터(ollamaStatus)는 별도 이벤트보다 기존 주기적 이벤트(usage_update)에 piggyback하는 것이 효율적 + 클라이언트 코드 단순
- **크리처 간 상호작용**: 가재-물고기처럼 서로 다른 크리처 시스템 간 연동은 중간 데이터 계층(DataParticleSystem)에 위치/상태를 주입하는 pull 모델이 깔끔 — 각 크리처는 자신의 렌더링만 책임, 상호작용은 데이터 계층이 조율
- **LaunchedEffect 키 선택**: `.size`가 아닌 리스트 자체를 키로 — data class 기반 리스트는 내용 변경 시 참조가 바뀌므로 정확하게 트리거

---

## 2026-03-02 — E-ink Tank Status 뷰 재설계

### 문제
`EinkStatusCompact`가 3줄 monospace 텍스트로 모든 정보를 표시:
1. `OAuth✓ ●Bridge UP:0:03` — Bridge 연결/업타임은 불필요한 정보
2. `Olla✓` — 말줄임으로 가독성 저하
3. Unicode 게이지 바 (`██░░`) — e-ink 16-level 그레이에서 채움/빈칸 구분 어려움
4. 토큰 수/비용 미표시, `modelCatalog` 미활용
5. 정보 위계 없음 (모두 동일 monoStyle)

### 해결
- **3-section 분리**: Rate Limits + Tokens & Cost + Models — 시각적 섹션 헤더(Bold, letterSpacing 1sp)
- **Compose Box 게이지바**: `EinkGaugeBar` — black fill + white empty + black `border(1.dp)`. Unicode 문자 대비 e-ink 대비 극대화, 디더링 아티팩트 0
- **`BoxWithConstraints` 적응 레이아웃**: >700dp = 3-column (IDLE 전체 너비), ≤700dp = 세로 스택 (ACTIVE 좁은 영역)
- **`modelCatalog` 활용**: OAuth 연결 + 사용 가능 모델 전체 목록 표시 (말줄임 없음)
- **billingType 분기**: API 사용자는 Rate Limits 숨기고 "API Key" 표시
- **ACTIVE 모드 weight 균등화**: context/status 55%/45% → 50%/50%
- **Refresh trigger 확장**: `usage`만 → `usage + oauthConnected + ollamaStatus + modelCatalog`

### 교훈 / 핵심 설계 결정
- **E-ink 게이지 = Compose Box**: Unicode block 문자는 e-ink EPD에서 그레이레벨 차이가 미미하여 사실상 구분 불가. 순수 흑백 Compose Box가 최적
- **적응 레이아웃 기준**: 700dp는 Crema S 1072dp landscape의 78%(우측 컬럼) ≈ 836dp → wide, ACTIVE 45% ≈ 376dp → narrow

---

## 2026-03-02 — Dashboard ghost creature + Stream Deck daemon port collision

### 문제
1. **Ghost creature**: daemon만 실행 중 (sdc 세션 없음) Android Dashboard에 SLEEPING 옥토퍼스 1마리 표시. `TerrariumState`가 DISCONNECTED에서도 `agentType`이 null이면 primary agent를 추가, `MonitorScreen`의 `coerceAtLeast(1)` + `CreatureLayout`의 빈 리스트 fallback이 최소 1마리 강제
2. **SD+ 버튼 지연**: daemon 도입 후 버튼이 첫 번째 누름에 반응 안 함. `findLatestSessionPort()`가 daemon 세션을 필터링하지 않아 plugin이 daemon 포트로 연결 → daemon의 `onCommand()`가 대부분의 명령을 무시

### 해결
- **TerrariumState.kt**: `agentState != AgentState.DISCONNECTED` 가드 추가 — DISCONNECTED시 primary agent 목록 제외
- **MonitorScreen.kt**: `coerceAtLeast(1)` 제거 → agents 0이면 octopuses 0
- **CreatureLayout.kt**: `layoutOctopusesByProject()` 빈 agents → `emptyList()` 반환 (기존: 기본 슬롯 1개)
- **EinkRenderer.kt**: `agents.isEmpty()` 분기 추가로 octopus 그리기 스킵
- **plugin.ts**: `findLatestSessionPort()`에 `agentType !== 'daemon'` 필터 추가

### 교훈
- Daemon은 인프라 프로세스이지 코딩 에이전트가 아님 — `sessions.json`에 등록되더라도 플러그인/UI에서 interactive session으로 취급하면 안 됨
- "최소 1" 보장 로직은 크리처 시스템의 여러 레이어에 분산되어 있었음 (TerrariumState, MonitorScreen, CreatureLayout) → 한 곳만 고치면 다른 곳에서 다시 1마리가 생성됨. 전체 경로 추적 필요

---

## 2026-03-02 — Android Deck UI 개선: bridge-driven button_state + compact layout

### 문제
1. Android Deck 탭 버튼이 `aspectRatio(1f)` 정사각형으로 10" 태블릿에서 ~260dp 차지, Context Area 부족
2. 버튼 내용이 Android 로컬 하드코딩 — SD+ 플러그인 PI 커스텀 설정과 불일치
3. AWAITING 상태에서 MORE 눌러야 전체 옵션 표시, PROCESSING시 진행 표시 부족

### 해결
- **`button_state` 프로토콜 신설**: Bridge `computeButtonState()` → 8개 슬롯 상태 계산 + WS broadcast. `ButtonSlotState` 타입 (shared/protocol.ts), Android `parseBridgeMessage()` 파싱, `DashboardState.buttonStates` 필드 추가
- **Bridge-driven 우선, 로컬 fallback**: `computeDeckLayout()`이 `buttonStates.isNotEmpty()` 체크 → bridge 데이터 사용, 미연결시 기존 로컬 로직 유지
- **PI 설정 반영**: `cachedSlotMap`에서 `response-button` 슬롯의 PI settings(label/action) 추출하여 IDLE 버튼에 적용
- **CompactStatusBar(36dp)**: 프로젝트명 + 상태칩(colored dot) + 모델명 + usage% pill 배지
- **직사각형 버튼(80dp)**: `aspectRatio(1f)` 제거 → ~84dp 추가 Context Area 확보
- **터치 피드백**: scale(0.95) + alpha(0.85) 애니메이션, icon/badge 렌더링
- **Context Area 개선**: AWAITING시 전체 옵션 LazyColumn 항상 표시 (cursor highlight + shortcut badge), PROCESSING시 LinearProgressIndicator + ProcessingDots, IDLE시 suggestedPrompt AssistChip
- **Action dispatch 이중 경로**: bridge-driven `actionString` 직접 실행 + 로컬 `DeckAction` sealed class fallback

### 핵심 설계 결정
- `computeButtonState()`는 `computeEncoderState()`와 동일 패턴 — state_changed/connect/slot_map 3곳 broadcast
- `colorForOption` 로직이 plugin/bridge/android 3곳에 중복 — 향후 shared util 추출 고려
- DIM 버튼은 `{ ...DIM, slot: N }` spread override 패턴 사용

---

## 2026-03-02 — 네온테트라 2개 무리 + E-ink 수조 자연화

### 문제
1. 네온테트라 7마리 1개 무리로 단조로움. 실제 수족관처럼 두 무리가 만남/흩어짐 반복 필요
2. E-ink 물고기가 V-대형으로 좌↔우 기계적 순찰, 크기도 큼(0.018f)
3. E-ink 옥토퍼스 WORKING 상태에서 고정 위치, 데이터 파티클 없음

### 해결

**태블릿 (DataParticleSystem.kt)**:
- SCHOOL_SIZE 7→14, `schoolId: Int` (0/1) 추가, 무리당 7마리
- Lissajous school centers: 서로 다른 sin/cos 주기로 ~20-30초마다 자연스러운 합류/분리
- Boids 수정: cohesion/alignment = 같은 schoolId만, separation = 전체
- `SCHOOL_ATTRACTOR_WEIGHT=0.4` — 먹이 없을 때만 활성, 먹이 있으면 두 무리 뒤섞임

**E-ink (EinkRenderer.kt)**:
- `drawEinkDataParticles()` 전면 교체: 12마리 2무리(6+6), Lissajous 경로
- 물고기 크기 `0.018f→0.013f` (72%), 그리드 스냅 제거 → 부드러운 이동
- `einkPrevFishX` 배열로 프레임간 heading 추적 (V-대형 고정 → 개별 자유 이동)
- STREAMING: school centers가 에이전트로 30% 보간 + 데이터 파티클 4개 orbit
- HOVERING: 8마리 옵션 근처 + 4마리 먼 거리 배회
- 옥토퍼스 WORKING bob: `0.02f * sin(animFrame * PI/8)` 미세 상하 흔들림

### 핵심 설계 결정
- **Lissajous curve 선택 이유**: 주기성이 있되 비정수 주기 비율로 경로가 정확히 반복되지 않음 → 장시간 봐도 패턴이 느껴지지 않음
- **schoolId 기반 boids 분리**: separation만 전체 적용하면 두 무리가 겹칠 때 자연스러운 충돌 회피 발생, cohesion/alignment은 같은 무리끼리만 → 합류 후 다시 분리되는 행동
- **E-ink heading 추적**: `prevFishX` float array 캐시가 file-level private이므로 frame 간 상태 유지 가능. animFrame 기반 sin/cos 위치에서 이전 프레임과 비교하면 실제 이동 방향 반영

---

## 2026-03-02 — 네온테트라 전체 수조 유영 + 자연스러운 크리처 배치 + E-ink 가시성 개선

### 문제
1. **테트라 활동 범위 제한**: 문어와 동일한 SWIM 경계(0.08~0.68)로 수조 좌측~중앙만 커버
2. **태블릿 멀티세션 배치 부자연**: FLOATING/ASKING 시 모든 문어가 동일한 Y=0.66에 일렬 정렬
3. **문어가 HUD 패널과 겹침**: SWIM_MIN_X=0.08이 좌측 HUD(~19%)보다 좌측
4. **E-ink 물고기/환경 가시성 저조**: 작은 다이아몬드 물고기, 얇은 해초/바위, 바닥 구분 없음

### 해결

**테트라 경계 분리** (TerrariumConfig + DataParticleSystem):
- `TETRA_SWIM_*` 신규: X `0.03~0.92`, Y `0.08~0.68` — 수조 전체 자유 유영
- 기존 `SWIM_*`는 문어 전용 유지. 벽 반발 `0.05→0.08`, 최대속도 `0.15→0.20` 배수
- HOVERING 어트랙터 수조 중앙(0.50, 0.35)으로 이동

**자연스러운 배치** (OctopusCreature + CreatureLayout):
- `standingJitter`: per-instance ±0.02 랜덤 Y 오프셋
- X-correlated depth: `(homeX - 0.4) * 0.12` — X 위치에 따라 Y 자연 변동
- `SWIM_MIN_X`: 0.08→0.20 (좌측 HUD 패널 회피)
- `areaMinX`: 0.15→0.22 (멀티세션 홈 위치도 HUD 밖)

**E-ink 가시성** (EinkRenderer):
- **물고기 리디자인**: 50% 확대, 비대칭 물방울형 몸체, 어두운 `GRAY_FISH_BODY(0x55)` + 밝은 `GRAY_FISH_STRIPE(0xBB)`, 윤곽선, 포크형 꼬리, 흰눈+동공
- **모래 바닥**: `GRAY_SAND(0xCC)` — 수면 아래 바닥 영역 구분
- **바위 윤곽선**: fill 후 `GRAY_CREATURE` stroke 추가로 형태 뚜렷
- **해초**: 1.2px→2.0px, 자갈 1.5배, 조약돌 1.5배, 거품 filled+outline
- **멀티세션 Y stagger**: `standingOffset = (centerXFraction - 0.38) * 0.10`

### 교훈 / 핵심 설계 결정
- **경계 분리 원칙**: 크리처별 활동 영역은 독립 상수 (SWIM vs TETRA_SWIM). 공유 경계는 변경 시 의도치 않은 영향
- **자연스러운 배치 = jitter + correlation**: 순수 랜덤보다 position-correlated offset이 시각적으로 더 자연스럽고 재현 가능
- **E-ink 가시성 3원칙**: (1) 충분한 크기, (2) 배경과 최소 2 gray level 차이, (3) fill + outline 겸용

---

## 2026-03-02 — Android 에이전트 상태 업데이트 지연 + E-ink 크리처 개선

### 문제
1. **세션 추가/종료 시 Android 반영 최대 30초 지연**: Bridge `sessions_list` 30초 폴링만 사용
2. **E-ink 크리처 반영 안됨**: RefreshZone triggerKey가 `siblingSessions.size`만 감시 — 상태 변경 무시
3. **E-ink 크리처 위치 비정상**: IDLE octopus가 0.42f(수중)에 떠있음 — 바닥에 있어야 함
4. **E-ink 크리처 흑백만 표시**: 모든 부위가 `GRAY_CREATURE=0x222222` 단일 색상

### 해결

**Bridge (sessions_list 즉시성)**:
- `state_changed` 이벤트 시 `sessions_list`도 2초 debounce로 즉시 broadcast
- 폴링 주기 30초 → 10초 단축
- **TDZ 함정**: `let` 변수를 `state_changed` 핸들러보다 뒤에 선언하면 핸들러 실행 시 `ReferenceError`. `let`의 Temporal Dead Zone은 `var`와 달리 선언 전 접근 불가

**Android (E-ink 리프레시)**:
- Agent panel triggerKey: `siblingSessions.size` → `sessionsKey` (id:state join 문자열)
- Aquarium triggerKey: `agentState` → `Pair(agentState, sessionsKey)`
- EinkTerrariumView LaunchedEffect: `agents.size` → `agentsKey` (visualState 리스트)
- `toTerrariumState()` → `derivedStateOf` 적용 (불필요한 recomposition 방지)

**E-ink 크리처 Y-position** (color renderer 일치):
- Octopus: SLEEPING=0.78(바닥), FLOATING=0.66(모래 위), WORKING=0.42(수영), ASKING=0.60
- Crayfish: DORMANT=0.82, SITTING=0.72(바위 위), ROUTING=0.55(떠오름), OBSERVING=0.62

**E-ink 그레이스케일**:
- 부위별 분리: body(0x44), limb/claw(0x33), eyes(black/white)
- SLEEPING 감쇠: body→seaweed(0x55), limb→gravel(0x66)
- WORKING starburst: 8방사 그레이(0x99) 글로우
- Crayfish 분리: body(0x44), claw(0x33, 더 진함)

### 교훈 / 핵심 설계 결정
- `let`/`const` TDZ: 이벤트 핸들러에서 참조하는 변수는 반드시 핸들러 등록 전에 선언
- E-ink RefreshZone triggerKey는 **내용 기반 키**(상태 문자열 join)를 사용해야 실제 변경 감지 가능
- E-ink 크리처 Y-position은 color renderer와 동일한 "바닥=대기, 부상=활동" 패턴 유지

---

## 2026-03-02 — SD 세션 전환 + OpenClaw 연결 데드스테이트

### 문제
SD 세션 버튼에서 OpenClaw 전환 시 3가지 결함:
1. **`activateGateway()` 데드스테이트**: activeLink를 즉시 gateway로 전환하지만, WS 연결 실패 시 bridge 이벤트도 끊기고 gateway 이벤트도 없는 교착 상태. 복구 불가
2. **`resume()` 인증 누락**: `connect()`만 `loadDeviceIdentity()` 호출. `resume()`은 identity 없이 연결 시도 → Ed25519 핸드셰이크 실패 → 무한 재연결 루프
3. **`cycleSession()` daemon-proxied OC 오판**: `getActiveAgentType()`이 daemon 경유 OC에서 `'claude-code'` 반환 (activeLink=bridge이므로)

### 해결
1. **5초 타임아웃 폴백**: `activateGateway()`에서 즉시 UI 전환 + 5초 내 미연결 시 `userSelection='auto'`로 리셋, gateway pause, bridge 복귀
2. **`resume()` identity 로드**: `if (!this.deviceIdentity) this.loadDeviceIdentity()` 추가
3. **`getUserSelection()` 기반 판단**: `getActiveAgentType()` 대신 `getUserSelection() === 'gateway'`로 OC 위치/렌더링 판단. daemon이 `agentType: 'openclaw'` 보고해도 영향 없음

### 교훈 / 핵심 설계 결정
- **activeLink 전환 시 반드시 타임아웃**: 즉시 전환은 UI 반응성을 위해 필요하지만, 연결 실패 시 복구 경로가 없으면 데드스테이트 진입
- **`userSelection` vs `activeAgentType` 구분**: daemon proxy 환경에서 `activeAgentType`은 연결 경로에 의존 (bridge→CC, gateway→OC). 유저 의도는 `userSelection`으로만 정확히 판단 가능
- **`resume()`과 `connect()` 초기화 대칭**: lifecycle 메서드 간 전제조건(identity 로드 등)이 비대칭이면 특정 경로에서만 실패하는 간헐적 버그 발생

---

## 2026-03-02 — Daemon/OpenClaw primary 세션 카운트 불일치

### 문제
실제 coding agent 3개 실행 중인데 크레마(e-ink)에서 1개, 태블릿에서 4개 표시. 원인 2가지:

1. **Daemon self-filter 실패**: Daemon의 `sessions_list`에서 자신을 제거하지만, `connection` 이벤트의 daemon UUID가 siblings에 없어 클라이언트 self-filter 불가 → primary(daemon) 1 + siblings 3 = 4개
2. **Daemon agentType 변동**: `daemon-server.ts`가 OpenClaw gateway alive 시 `agentType: 'openclaw'`로 보고 → `!= "daemon"` 체크 통과 → openclaw primary가 octopus creature로 렌더링

### 해결
**클라이언트(Android) 3곳에서 필터링**:
- `EinkAgentColumn.kt`, `SessionListPanel.kt`: primary `agentType == "daemon"` → 스킵. Sibling `agentType == "daemon"` → 스킵. OpenClaw는 🦞 아이콘으로 정상 표시
- `TerrariumState.kt`: primary/sibling `"daemon"` 또는 `"openclaw"` → octopus 목록에서 제외 (crayfish가 별도 처리)

### 교훈 / 핵심 설계 결정
- **Daemon agentType 변동 주의**: `daemon-server.ts`가 gateway 상태에 따라 `agentType`을 `"daemon"` ↔ `"openclaw"`로 전환. 클라이언트에서 `"daemon"` 하나만 체크하면 gateway alive 시 필터 실패
- **Session list vs Terrarium 분리**: 에이전트 목록에는 OpenClaw 표시 (🦞), terrarium에서는 crayfish로 표현 → 두 레이어의 필터링 규칙이 다름
- **Primary vs Sibling 필터 차이**: Primary는 bridge가 자신을 보고하는 것 (daemon/openclaw 스킵). Sibling은 sessions_list에서 오는 것 (daemon만 스킵, openclaw는 표시)

---

## 2026-03-02 — E-ink 네이티브 그레이스케일 복원

### 문제
Crema 디바이스가 16레벨 그레이를 네이티브 지원(시스템 앱 아이콘이 회색 표시)하나, 앱에서 그레이가 전혀 표시되지 않았음. 두 가지 근본 원인:

1. **잘못된 EPD API**: `com.crema.ink.EinkDisplay` 클래스는 Crema에 존재하지 않음. 모든 reflection 호출이 silent fail → `view.invalidate()` 폴백 → 시스템 기본 EPD 모드(DU/binary) 사용 → 그레이 전부 흑백 변환
2. **1-bit 디더링**: `DitherEngine.floydSteinberg()`가 모든 픽셀을 0 or 255로 강제 변환

### 해결
1. **Rockchip EinkManager API 발견**: KOReader의 `RK35xxEPDController` 참고. Crema(RK3566)는 `android.os.EinkManager` 시스템 서비스 사용:
   - `context.getSystemService("eink")` → EinkManager 인스턴스
   - `setMode("2")` = EPD_FULL_GC16 (16레벨 그레이), `"12"` = A2, `"14"` = DU
   - `sendOneFullFrame()` = GC16 전체 화면 강제 리프레시
2. **`snapToNearestGray()`**: 에러 디퓨전 없이 가장 가까운 N-level gray로 직접 스냅 (하드웨어가 네이티브로 표시하므로 도트 패턴 불필요)
3. **LAYER_TYPE_SOFTWARE**: EinkRefreshZone의 FrameLayout에 소프트웨어 렌더링 강제 — GPU 하드웨어 레이어가 EPD 그레이스케일 경로를 우회할 수 있음
4. **내부 수조 테두리 제거**: `drawRoundRect` 제거, Compose `clip(RoundedCornerShape)` 만으로 수조 경계

### 핵심 설계 결정
- **EPD 벤더 우선순위**: Rockchip EinkManager → Onyx BaseDevice → fallback invalidate (기존 `com.crema.ink.EinkDisplay` 제거)
- **그레이 팔레트**: 하드웨어 16레벨에 정확히 매핑 — GRAY_CREATURE(0x22) ~ GRAY_AIR(0xEE) 11단계, 넓게 분포
- **리서치 소스**: KOReader `android-luajit-launcher` → `device/epd/rockchip/RK35xxEPDController.kt`, Pine64 RK3566 EBC 역공학 wiki

---

## 2026-03-02 — macOS Display Sleep → Android 백라이트 완전 동기화

### 문제
Cmd+Shift+Power로 Mac 화면을 끄면 Android 디스플레이 백라이트가 제대로 꺼지지 않음:
1. Bridge가 10초마다 `execFile('python3')`으로 `CGDisplayIsAsleep` 체크 — 최대 10초 지연
2. LCD에서 `SCREEN_BRIGHTNESS=0`만 설정 — 최소 밝기일 뿐 백라이트 미해제, auto-brightness 모드에서는 무시됨
3. E-ink `SCREEN_OFF_TIMEOUT` 15초 — 너무 느림

### 해결
1. **Persistent python3 process**: `execFile` → `spawn` + `readline`. Python 스크립트가 2초마다 루프하며 상태 변경 시에만 stdout 출력. 비정상 종료 시 5초 후 재시작 (최대 3회)
2. **LCD 3단계 dim**: `SCREEN_BRIGHTNESS_MODE` 강제 manual → brightness 0 → `SCREEN_OFF_TIMEOUT` 2s (백라이트 완전 해제). Restore 순서: timeout 복원 → WAKEUP → brightness → mode
3. **E-ink timeout**: 15s → 3s

### 교훈
- `SCREEN_BRIGHTNESS=0`은 "최소 밝기"이지 "백라이트 off"가 아님. 실제 꺼짐은 `SCREEN_OFF_TIMEOUT` 만료 후 시스템이 처리
- Auto-brightness 모드에서는 `SCREEN_BRIGHTNESS` 설정이 무시될 수 있으므로 반드시 manual 모드로 전환 필요
- 매번 프로세스 spawn하는 폴링은 persistent process + readline으로 대체하면 지연과 오버헤드 모두 개선

---

## 2026-03-02 — 문어 상태 장식 단순화 + 이름 모자 + 개별 타이밍

### 문제
문어 캐릭터의 상태별 장식(키보드, 체크/X마크, 옵션 카드, 문서 리뷰)이 과하고 직관적이지 않았음. 7가지 시각 상태가 불필요하게 세분화.

### 해결
- `OctopusVisualState` enum 7→4개로 축소: `SLEEPING`, `FLOATING`, `WORKING`(스타버스트), `ASKING`(말풍선 "?")
- 복잡한 장식 3개 삭제 (`drawHolographicKeyboard`, `drawOptionCards`, `drawReviewDocs`)
- WORKING: 기존 THINKING 스타버스트 애니메이션 재활용 (tool 유무 무관)
- ASKING: 새 `drawSpeechBubble()` — 우상단 펄싱 말풍선 + "?" + 꼬리 삼각형
- 멀티세션 개별 타이밍: `phaseOffset` 파라미터 (index * 1.7f) → `time` 초기값으로 설정
- 이름 모자: `displayName`으로 projectName 표시 (멀티세션 2+ 시만, 단일 세션은 숨김)
- E-ink도 동일 패턴 적용 (장식 제거 + 말풍선 추가)
- `DataParticleSystem.kt` — TYPING/THINKING → WORKING 참조 업데이트

### 핵심 설계 결정
- "활동 중"은 tool 유무 관계없이 모두 WORKING(스타버스트) 하나로 통합 — 사용자가 processing 세부 구분을 시각적으로 필요로 하지 않음
- 모든 awaiting_* 상태는 ASKING 하나로 통합 — "유저에게 뭔가 물어보는 중"이라는 하나의 의미
- 개별 타이밍 구현은 `time` 초기값만 달리하는 가장 단순한 방식 선택

---

## 2026-03-02 — EinkRefreshZone stale content 버그 수정

### 문제
E-ink 좌측 에이전트 패널에 새 세션이 추가되어도 UI가 업데이트되지 않음. 데이터 파이프라인(Bridge → WS → DashboardState)은 정상이나, `EinkRefreshZone`의 inner `ComposeView`가 stale content를 표시.

### 해결
`EinkRefreshZone.kt`에서 `AndroidView.factory` 안의 `ComposeView.setContent { content() }`가 factory 생성 시점의 `content` 람다를 캡처하여 고정되는 것이 원인. `rememberUpdatedState(content)`로 snapshot-backed State를 만들어 inner ComposeView가 항상 최신 content를 읽도록 수정.

### 교훈 / 핵심 설계 결정
- **AndroidView.factory + ComposeView 패턴**: factory는 1회 실행이므로 캡처한 람다가 고정됨. Compose state를 전달하려면 `rememberUpdatedState`로 간접 참조해야 inner composition도 recompose됨
- Compose snapshot system은 global — 별도 ComposeView의 composition도 같은 State 객체의 변경을 감지

---

## 2026-03-02 — mDNS 광고를 daemon 전용으로 제한

### 문제
`sdc -d`로 같은 프로젝트에서 두 번째 세션을 시작하면 mDNS 서비스 이름 충돌 에러 발생. 개별 bridge마다 `advertiseBridge()`를 호출하여 동일 서비스명으로 중복 광고.

### 해결
`bridge/src/index.ts`에서 `advertiseBridge` import, 호출, shutdown cleanup 제거. `daemon-server.ts`만 유일한 mDNS 광고 주체로 유지. Android는 daemon에 연결하고 session-aggregator를 통해 모든 활성 세션 정보를 수집·중계하는 구조이므로 개별 bridge의 mDNS 불필요.

### 교훈 / 핵심 설계 결정
- **LAN 디스커버리는 단일 진입점(daemon)만 광고**: 개별 세션(bridge)은 USB/수동 URL로 접근 가능하므로 mDNS 불필요. daemon이 aggregator 역할까지 겸하므로 클라이언트는 daemon 하나만 발견하면 됨

---

## 2026-03-02 — Daemon 프록시 시 OpenClaw 스타일 미적용

### 문제
Daemon이 Gateway를 프록시할 때 Plugin은 bridge로 연결됨. `connMgr.getActiveAgentType()`은 bridge 연결이면 항상 `'claude-code'` 반환. daemon이 `state_update.agentType: 'openclaw'`을 보내지만 plugin이 이 값을 무시하여 모든 UI가 Claude Code 녹색 스타일로 표시. 추가로 Usage 버튼의 `currentCapabilities`도 올바른 값으로 설정되지 않아 OpenClaw model catalog/usage 페이지 미표시.

### 해결
`plugin.ts`에 `proxiedAgentType` 변수 도입. `state_update` 핸들러에서 `ev.agentType`을 저장하고, `broadcastStateUpdate()`에서 `proxiedAgentType ?? connMgr.getActiveAgentType()`으로 실제 에이전트 타입 결정. capabilities도 `proxiedAgentType === 'openclaw'`이면 `OPENCLAW_CAPABILITIES` 직접 적용 (daemon은 `agentCapabilities` 미전송).

Usage 버튼: `state_update`에서 `ev.agentCapabilities` 없고 `proxiedAgentType === 'openclaw'`이면 `setUsageCapabilities(OPENCLAW_CAPABILITIES)` fallback 호출 추가. 이로써 model catalog poll + OC usage poll 시작.

**근본 수정** (`daemon-server.ts`): daemon `state_update`에 `agentCapabilities: OPENCLAW_CAPABILITIES` + `modelCatalog` 추가. adapter `metadata` → `model_catalog` 이벤트 캐싱 + 즉시 broadcast. Gateway disconnect 시 `cachedModelCatalog = null` 초기화. Plugin fallback은 defense-in-depth로 유지.

### 교훈 / 핵심 설계 결정
- **프록시 계층은 원본 에이전트 정보를 투명하게 전달해야 함**: connection-level 감지(`getActiveAgentType()`)와 protocol-level 정보(`state_update.agentType`)가 불일치할 때, protocol-level이 우선해야 함
- **독립 상태를 가진 컴포넌트는 명시적 setter 호출 필요**: `broadcastStateUpdate()`에서 caps를 올바르게 계산해도, Usage 버튼처럼 자체 `currentCapabilities` 상태를 가진 컴포넌트는 `setUsageCapabilities()` 명시 호출 없이는 반영 안 됨. 파생 값 전파 누락 주의
- **daemon은 bridge와 동일한 프로토콜 계약 준수 필요**: `agentCapabilities`, `modelCatalog` 등 bridge가 보내는 필드를 daemon도 보내야 함. 누락 시 소비자(plugin/android)가 개별 fallback 필요 — 양쪽 수정(daemon 근본 + plugin defense-in-depth) 병행이 안전

---

## 2026-03-02 — OpenClaw ↔ NO SESSION 토글 + START 버튼

### 문제
CC 세션 없이 OpenClaw Gateway만 연결된 상태에서 Session 버튼을 누르면 아무 일도 안 됨 (cycle list에 OpenClaw 1개만 있어서 early return). 또한 NO SESSION 전환 시 Usage 버튼과 E2/E3 타임라인이 여전히 OpenClaw 모드로 남아있는 문제.

### 해결
**가상 `cc-nosession` CycleEntry 추가** (`session-button.ts`): Gateway 연결 + CC 세션 0개 → cycle list에 `cc-nosession` 가상 엔트리 삽입. OpenClaw ↔ NO SESSION 토글 가능. NO SESSION에서 response-button의 기존 START→picker→`sdc` 인프라 재활용.

**`setNoSessionMode()` 헬퍼**: 진입/탈출 시 `setCcNoSessionMode` (response-button), `setUsageCapabilities(null/caps)`, `updateOptionDialState(caps: null/caps)`, `updateItermDialState(caps: null/caps)` 일괄 호출. capabilities null → usage는 CC 기본 페이지(5h/7d), E2/E3는 기본 동작(prompts/iTerm)으로 복귀.

**자동 전환**: file watcher가 새 CC 세션 감지 시 NO SESSION 모드 자동 해제 + `resetToAuto()`. `updateSessionButton`에서 CC agentType 도착 시에도 해제.

### 교훈 / 핵심 설계 결정
- **가상 상태는 모든 컴포넌트에 전파해야 함**: session/response 버튼만 플래그를 알고 다른 컴포넌트(usage, encoder dial)는 여전히 gateway capabilities를 보면 UI 불일치. `setNoSessionMode()` 같은 일괄 전파 헬퍼가 필수
- **"OC" 약자 사용 금지**: Opencode, Codex CLI 등 추가 예정으로 "OC"가 모호해짐. 코드/코멘트에서 풀네임(OpenClaw, Opencode 등) 사용

---

## 2026-03-01 — E3 인코더 OC 모드 혼합 표시 + standby 개념 제거

### 문제
1. **E3 혼합 표시**: Bridge 미연결 + Gateway 연결 시 E2(option-dial)는 OC 타임라인 LEFT 패널 정상 표시, E3(iterm-dial)는 "iTERM No sessions" 표시. `option-dial.ts`에는 모든 렌더링 경로에 capabilities 가드가 있지만 `iterm-dial.ts`에는 누락
2. **standby 개념 불필요**: `isStandby()` (auto + !bridge + gateway) 상태에서 gateway가 이미 activeLink로 활성화되어 있음에도 별도 "standby" UI를 표시. 실제로는 정상 OC 모드와 동일한 상태

### 해결
**iterm-dial.ts 3중 가드 추가**: (1) `refreshItermDials()`에 `!hasTerminal` 체크 → 타임라인 RIGHT 패널 리디렉트 (2) `onWillAppear`에 OC 가드 → async 레이스 원천 차단 (syncFromSystem 200-500ms await 후 startPolling 재시작 방지) (3) `syncFromSystem()` 초입에 OC 가드 → 불필요한 osascript 호출 차단. 데드코드 `renderItermDisabledForOc()` 삭제.

**standby 완전 제거** (6파일): `ConnectionManager.isStandby()` 삭제, `session-button`/`response-button`/`stop-button`/`plugin.ts`에서 standby 변수·파라미터·분기 전부 제거. Auto+!bridge+gateway 시 일반 OpenClaw UI(프리셋 버튼, 세션 표시 등) 표시.

### 교훈 / 핵심 설계 결정
- **인코더 capabilities 가드 패턴**: OC 타임라인처럼 두 인코더(E2+E3)가 합체 렌더링하는 경우, 양쪽 다이얼 모두 `refreshXxxDials()` 진입점에서 `!hasTerminal` 가드 필수. 한쪽만 가드하면 async 타이밍에 따라 혼합 표시 발생
- **ConnectionManager에 UI 상태 없어야 함**: gateway가 activeLink로 활성화된 상태를 별도 "standby"로 분류하는 것은 불필요한 복잡성. activeLink/agentType만으로 모든 UI 분기 가능

---

## 2026-03-01 — Terrarium 크리처 브랜딩 + 멀티세션 크리처 버그 수정

### 문제
1. **크리처 비주얼**: 테라리움의 Claude Code 크리처(문어)와 OpenClaw 크리처(옆모습 가재)가 공식 브랜드 이미지와 불일치
2. **멀티세션 버그**: 두 번째 Claude Code 세션 시작 시 테라리움에 크리처가 추가되지 않음
3. **가재 떠다님**: OpenClaw 크리처가 대기 상태(SITTING)에서도 물에 떠다니는 bob 애니메이션 — 바위 위에 앉아있어야 함

### 해결
**Claude Code 픽셀 마스코트** (`OctopusCreature.kt`): 타원 문어 → 공식 픽셀 아트 기반 10×7 그리드 캐릭터. 6가지 셀 타입 (투명/몸체/눈/왼팔/오른팔/왼다리/오른다리)으로 부위별 독립 애니메이션. 자연 이족보행 gait (왼팔↔오른다리 동기). THINKING 상태에 Anthropic 스타버스트(10팔 회전) 추가. 색상 `#C07058` (머티드 테라코타).

**OpenClaw 정면 로브스터** (`CrayfishCreature.kt`): 옆모습 segmented 가재 → SVG Path 기반 정면 로브스터. `PathParser.createPathFromPathData()` → `asComposePath()`. Gradient body, 회전 집게(pivot 기반), 더듬이 wiggle. SITTING=완전 정지, ROUTING만 풀 애니메이션.

**멀티세션 버그** (`bridge/src/index.ts`): (1) `connection` 이벤트에 `sessionId` 누락 → Android가 자기 세션 식별 불가 → self-skip 로직 실패. (2) `sessions_list`가 30초 주기 broadcast만 — 클라이언트 첫 연결 시 미전송. 두 가지 모두 수정.

### 교훈 / 핵심 설계 결정
- **셀 타입 태깅으로 부위별 애니메이션**: 픽셀 그리드에 숫자 태그(3=왼팔, 4=오른팔 등)로 렌더링 시 독립 Y-offset 적용. 별도 좌표 관리 없이 그리드 데이터만으로 애니메이션 가능
- **대기 vs 활동 시각 구분 원칙**: SITTING/DORMANT는 완전 정지 (bob 없음), ROUTING만 움직임. "가만히 있음=대기, 움직임=활동"으로 사용자가 즉시 상태 판별 가능
- **초기 연결 시 전체 상태 전송**: Bridge `onClientConnect`에서 `state_update`, `usage`, `connection`, `sessions_list`, `encoder_state`, `slot_map` 등 모든 이벤트를 즉시 전송해야 Android가 첫 렌더에서 완전한 상태 표시 가능. 주기적 polling만으로는 부족

---

## 2026-03-01 — Android Deck: Full SD+ Encoder Mirroring + Voice + Utility Proxy

### 문제
Android Deck 탭이 8개 버튼만 표시하고 SD+의 핵심인 4개 인코더(다이얼+LCD)가 빠져 있었음. 또한 버튼 슬롯 배치가 하드코딩되어 SD+ 프로필 변경과 동기화되지 않음.

### 해결
**Protocol 확장** (`shared/src/protocol.ts`): `EncoderSlotState`, `EncoderStateEvent`, `DeckSlotMapEvent`, `UtilityCommand` 타입 추가. Bridge가 인코더 LCD 콘텐츠를 자체 계산하여 모든 클라이언트에 broadcast.

**Bridge 인프라**: (1) `utility-proxy.ts` — osascript로 macOS 볼륨/밝기/미디어 제어, 5초 폴링 (2) `computeEncoderState()` — E1~E4 상태 계산 + `state_changed` 이벤트마다 broadcast (3) `POST /voice/transcribe` — Android 음성 WAV 수신 → whisper 전사 (4) `deck_slot_map` 캐시 + 릴레이

**Plugin 슬롯 맵 보고**: `willAppear`에서 좌표 수집 → 디바운스 500ms → `deck_slot_map` WS 전송

**Android**: (1) `EncoderStrip.kt` + `EncoderPanel.kt` — 4패널 LCD 미러링, 수평 드래그/탭/롱프레스 제스처 (2) `VoiceRecorder.kt` — AudioRecord 16kHz PCM → WAV → HTTP 업로드 (3) `DeckScreen.kt` — 인코더 스트립 + 버튼 그리드 + 컨텍스트 영역 통합 (4) Dashboard 테라리움 축소 0.35→0.25, 인코더 미니 스트립 추가

### 교훈 / 핵심 설계 결정
- **Bridge-centric 인코더 상태**: 인코더 LCD 콘텐츠를 Bridge가 계산 (plugin이 아님). Plugin은 SD+ 하드웨어에 SVG 렌더링, Bridge는 JSON 상태를 Android/SSE 클라이언트에 broadcast. 동일 데이터의 렌더링만 표면별로 다름
- **슬롯 맵 릴레이 패턴**: Plugin이 실제 SD+ 프로필의 슬롯 배치를 보고 → Bridge 캐시 → Android 미러링. Plugin 미연결 시 기본 v3 레이아웃 폴백
- **Android 음성 경로**: 로컬 AudioRecord → WAV 빌드 → HTTP POST to Bridge → whisper. Plugin의 iTerm2/sox 경로와 달리 네트워크 전송 필요하므로 HTTP 엔드포인트 추가

---

## 2026-03-01 — Android 통합 Monitor 화면 (관제탑 리디자인)

### 문제
Android 앱이 테라리움(애니메이션)과 Dashboard(정보 카드)를 별도 탭으로 분리 — "Agent 전체 모습을 한눈에" 관제 역할 불충분. Terrarium Mode 토글로 어느 한쪽만 보여주는 구조.

### 해결
**Phase 1 — 내비게이션 통합**: `Screen.Terrarium` + `Screen.Dashboard` → `Screen.Monitor`. 3탭 구조 (Monitor/Deck/Settings). `terrariumEnabled` 분기 제거, `DisplayPreferences`에서 terrarium 토글 삭제, SettingsScreen에서 토글 UI 제거.

**Phase 2 — HUD 콕핏 (6 신규 파일)**: `ui/monitor/` 디렉토리. `MonitorScreen.kt`(Box: terrarium bg + HUD overlay), `MonitorTopBar.kt`(project+state+mode / model+agent), `ActivityPanel.kt`(tool+input+progress, suggestedPrompt, question), `EnginePanel.kt`(5h/7d gauge+tok+cost+msg+uptime), `MultiAgentPanel.kt`(siblingSessions+workers+OC status), `TimelineStrip.kt`(auto-scroll, typeColor prefix).

**Phase 3 — E-ink 정보량 동등화**: EinkAgentColumn(suggestedPrompt, siblingSessions, workers, sessionStatus), EinkActionColumn(toolInput), EinkEngineColumn(messageCount param), EinkFooterBar(messageCount). Portrait 레이아웃에 terrarium band (~15%) 추가.

**Phase 4 — E-ink 부분 갱신**: `EinkRefreshZone.kt` composable — AndroidView 브릿지로 View 참조 확보, debounced vendor API 호출. `EinkRefreshHelper`에 `requestA2Refresh()`/`requestDURefresh()` 추가 (Onyx BaseDevice + Crema EinkDisplay reflection). Landscape 컬럼별 존 래핑 (Agent=A2/200ms, Action=A2/300ms, Engine=DU/2000ms).

**Phase 5 — 정리**: `DashboardScreen.kt`, `TerrariumScreen.kt` 삭제.

### 교훈 / 핵심 설계 결정
- **ColorTerrariumView 추출**: TerrariumScreen의 60fps 애니메이션 로직을 MonitorScreen 내부 private composable로 이동 — 동일 코드, 새로운 컨텍스트
- **HUD 패널 독립**: 각 패널이 `TerrariumColors.HUDBg` (`0x80000000`) + `RoundedCornerShape(8.dp)` 통일 스타일, `Modifier.align()`으로 Box 내 절대 배치
- **EinkRefreshZone AndroidView 브릿지**: Compose에서는 View 참조를 얻을 수 없어 `AndroidView` > `FrameLayout` > `ComposeView` 래핑으로 해결. View 참조를 `remember`로 보관, `LaunchedEffect(triggerKey)`로 debounced 갱신

---

## 2026-02-28 — Option Synchronization Fix (커서 권한 + 의미적 idle + ANSI 재위치)

### 문제
StreamDeck 디스플레이가 Claude Code 터미널의 interactive 상태(option 선택, permission)와 빈번하게 비동기화됨. 5가지 근본 원인:
1. 터미널 키보드 방향키가 ink TUI 커서를 움직이지만, 파서가 `❯`가 청크에 포함된 경우만 감지 — ink의 ANSI-only 커서 재위치 누락
2. `chunk.replace(/\s/g, '').length < 2` 임계값이 "❯ No" 같은 짧은 옵션 커서 이동을 genuine idle로 오분류
3. StreamDeck 다이얼의 optimistic 커서 업데이트를 PTY의 지연된 확인이 덮어쓰는 레이스 컨디션
4. 고정 50ms `select_option` 딜레이가 다수 화살표 이동에 불충분
5. cursorIndex 브로드캐스트가 `navigable` 플래그에만 의존 — 상태 기반이어야 함

### 해결
- **A1 (output-parser.ts)**: `lastNavigableEmit` 상태에서 ❯ 없는 소규모 청크(0 < nonWs < 100)에 디바운스 버퍼 재파싱 추가
- **A2 (output-parser.ts)**: 의미적 idle 검사 — `nonWsContent === '❯' || nonWsContent === '>'`만 idle로 분류
- **A3 (state-machine.ts)**: 커서 권한 시스템 — `updateCursorIndex(idx, 'optimistic' | 'pty')`. Optimistic은 즉시 적용, 200ms 이내 PTY 값은 stale로 억제. AWAITING 상태 이탈 시 권한 리셋
- **A4 (index.ts)**: `50 + |delta| × 20`ms 비례 딜레이
- **A5 (index.ts)**: `AWAITING_OPTION/PERMISSION/DIFF` 상태 기반 cursorIndex 브로드캐스트

### 교훈 / 핵심 설계 결정
- **Optimistic UI 패턴**: StreamDeck 다이얼 입력은 즉시 반영하되, PTY 확인에 200ms 유예기간 부여. 이 패턴은 네트워크 UI의 optimistic update와 동일하지만 PTY 지연이 원인
- **의미적 vs 구문적 감지**: `length < N` 같은 구문 기반 임계값은 짧은 옵션 텍스트에서 깨짐. `nonWsContent === '❯'` 같은 의미적 검사가 edge case에 강건
- **ANSI cursor-move 청크**: ink는 최소 재그림 시 escape 시퀀스만으로 커서를 이동 — `❯` 문자가 청크에 없어도 커서 위치가 변경됨. 버퍼 재파싱으로 대응
- **리뷰 시 발견**: A1 블록에서 `resetIdleTimer()` 누락 — 기존 ❯-포함 블록은 idle+option 타이머 모두 리셋하는 패턴이므로 새 블록도 동일하게 적용 필요

## 2026-02-27 — Usage 버튼 QR 코드 표시 + Remote URL 자동 감지

### 문제
Stream Deck 버튼에서 QR 코드를 표시하여 휴대폰으로 스캔 → Claude Code remote-control URL이나 OpenClaw Gateway에 즉시 접속하고 싶음.

### 해결
1. `qrcode` 라이브러리의 `create()` API로 모듈 매트릭스 추출 → SVG `<path>` 직접 생성 (`plugin/src/renderers/qr-renderer.ts`)
2. Usage 버튼 페이지 사이클에 `'qr'` 페이지 추가. URL 소스: (1) `--remote` URL (PTY 자동감지) (2) OC Gateway
3. Bridge OutputParser에서 `remote_url` 이벤트 파이프라인: Parser → Adapter → StateMachine → WS → Plugin
4. QR 페이지에서 push → `pbcopy`로 URL 클립보드 복사

### 핵심 이슈: PTY cursor-forward 시퀀스가 URL을 파괴
Claude Code TUI는 문자 사이에 `\x1b[\d*C` (cursor forward) 시퀀스를 삽입. 기존 파서의 `processFeed()`가 이를 공백으로 치환하여 `https://claude .ai/code /...` 형태가 되어 URL 매칭 실패.

**해결**: `parseRemoteUrl()`을 raw ANSI 데이터에서 실행. cursor movement 시퀀스를 공백 없이 제거한 후 ANSI color strip → URL regex 매칭.

### 교훈
- 144×144 버튼에 QR Version 3 (29 modules) × 4px/module = 116px가 최적. 헤더 라벨 제거해야 충분한 크기 확보
- PTY 출력의 raw ANSI 데이터는 TUI 렌더링 시퀀스가 텍스트 사이에 삽입되어 있어, URL 등 구조화된 문자열 추출 시 cursor movement만 선택적으로 제거해야 함 (공백 치환 불가)
- `qrcode` 라이브러리의 `create()` API는 canvas/PNG 불필요 — 순수 모듈 매트릭스 반환으로 SVG 직접 생성 가능

---

## 2026-02-27 — Claude Code v2.1 훅 포맷 변경 대응

### 문제
Bash 커맨드 퍼미션 선택지가 스트림덱에 표시되지 않음. 브릿지 디버그 로그(`/tmp/sdc-debug.log`) 분석 결과, **PreToolUse 등 모든 훅 이벤트가 0건** — 훅이 실행 자체가 되지 않고 있었음.

### 원인
Claude Code v2.1+에서 hooks 설정 포맷이 변경됨:
- **구 포맷** (flat): `{ type: "command", command: "curl ..." }` → 자동 무시
- **신 포맷** (3-level nesting): `{ matcher: "", hooks: [{ type: "command", command: "curl ..." }] }`

`settings.local.json`에 구 포맷으로 설정되어 있어 Claude Code가 훅을 인식하지 못함.

### 해결
1. `~/.claude/settings.local.json` — 신 matcher-group 포맷으로 즉시 수정
2. `hooks/src/install.ts` — `buildHookEntry()`가 matcher-group 포맷 생성, install/uninstall 모두 양쪽 포맷 인식
3. `bridge/src/index.ts` — `migrateHooksIfNeeded()`에 flat→matcher 자동 마이그레이션 추가
4. 테스트 전면 업데이트 (382 tests pass)

### 교훈
- Claude Code의 hook 포맷은 외부 의존성 — 메이저 버전 업데이트 시 포맷 변경 가능
- 훅 실패는 `|| true`로 에러가 마스킹되어 문제 인지가 어려움. 브릿지 디버그 로그에서 hook event 카운트를 확인하는 것이 가장 빠른 진단법
- `migrateHooksIfNeeded()`로 하위 호환 자동 마이그레이션 확보

---

## 2026-02-25 — Permission 스크롤 시 UI 소멸 + 옵션 라벨 오염 수정

### 문제
`sdc -d` 디버그 세션에서 2가지 반복 버그 발견 (4회 재현):
1. **PERMISSION 스크롤 시 UI 소멸**: 3개 옵션 표시 상태에서 다이얼 스크롤(navigate_option)하면 permission 메뉴가 갑자기 사라짐 (`awaiting_permission → idle` 오전이)
2. **옵션 라벨 오염**: Bash permission의 "don't ask again for: file:*" 가 "file "/Users/..."/* 2>/dev/null" 로 표시

### 해결
**Bug 1**: `output-parser.ts` cursor-only redraw 분기의 `!hasIdlePrompt` 조건이 원인. `IDLE_PROMPT` (`/^[❯>][ \t\u00A0]/m`)이 스크롤 chunk의 `❯ Yes, allow...` 옵션 텍스트를 idle prompt로 오감지 → idle handler로 fall through. **수정**: `!hasIdlePrompt` 제거, 대신 chunk 크기 기반 판별 (`nonWs < 10` = genuine idle, 그 외 = scroll redraw). 진짜 idle(`❯ \n`)은 작은 chunk, 스크롤은 큰 chunk라는 특성 활용.

**Bug 2**: Claude Code ink TUI의 2-pass 렌더링이 원인. 첫 draw에서 full command 텍스트가 option 행에 렌더링되고, 16ms 후 CUP로 커서 되돌려 `:*`로 덮어씀. 터미널에선 정상이지만 linear buffer는 양쪽 모두 append → 오염. **수정**: `parseOptions()` 내 byIndex 완성 후, correction line 패턴 (`/^(:\S+)\s{5,}/`) 감지 → "don't ask again" 라벨의 오염된 command+args를 `command + correctionScope`로 교정.

### 교훈 / 핵심 설계 결정
- **IDLE_PROMPT 오매칭**: `❯ ` 패턴은 idle 전용이 아님 — navigable cursor 옵션 텍스트도 `❯ label`로 시작. Chunk 크기가 더 신뢰할 수 있는 판별자
- **TUI CUP 덮어쓰기**: ink 프레임워크는 성능상 incremental redraw를 사용하여 CUP로 부분 수정. Linear buffer에서는 이를 감지·보정해야 함
- **Linear buffer 한계**: CUP/HVP를 `\n`으로 치환하는 현재 방식의 근본적 한계. 향후 복잡한 TUI 렌더링 케이스가 더 발생할 수 있음

---

## 2026-02-24 — OpenClaw 시각화 3계층 구현

### 문제
타임라인이 Gateway WS 이벤트(chat state + exec.approval)만 사용하여 텍스트 모노톤(`#e2e8f0` 단색)으로 표시. 내부 동작(모델 호출, 메모리 검색, 도구 실행 상세)이 보이지 않고, 이벤트 활동 수준 파악 불가.

### 해결
**Layer 2 — 시각 개선**: `typeColor()` 함수로 이벤트 타입별 고유 색상 매핑 (chat_start=green, chat_end=blue, tool_request=amber/green/red by status, error=red, model_call/response=cyan, memory_recall=purple). `renderGroupLine()`의 하드코딩 2색 분기 제거. Fisheye 하단에 활동 밀도 바(최근 30초 이벤트 수 → opacity 0.05~0.5 보간).

**Layer 1 — 로그 스트림**: `log-stream.ts` 신규 파일 — `openclaw logs --follow --json` 스폰하여 구조화 로그를 TimelineEntry로 변환. 4개 신규 타입(model_call, model_response, memory_recall, tool_exec) + 전용 아이콘(◆◇⦻▸). WS tool_request와 5초 윈도우 dedup. Gateway connect/disconnect 시 자동 start/stop.

**Layer 3 — OC Usage**: Usage 버튼에 `oc-usage` 페이지 추가. `openclaw status --usage --json` 60초 폴링, 프로바이더별 수평 바 + 세션 토큰 표시. `hasModelCatalog` 캡빌리티 조건부 활성화.

### 교훈 / 핵심 설계 결정
- **방어적 파싱**: `openclaw logs --json` 실제 포맷 미확인 상태에서 플러그어블 `parseLogLine()` 설계 — 인식 불가 라인은 `null` 반환, 절대 크래시 안 함
- **Dedup 전략**: WS 이벤트와 로그 이벤트가 같은 도구를 보고할 수 있으므로 `trackToolRequest()` + 5초 윈도우로 중복 제거
- **조건부 UI**: oc-usage 페이지는 데이터 존재 시에만 표시 — CLI 미설치나 실패 시 graceful 스킵

---

## 2026-02-24 — 타임라인 텍스트 정보 부족 수정

### 문제
OC 타임라인에 "Completed"만 표시되고, 사용자 프롬프트/도구 이름/작업 내용이 안 나옴.
**근본 원인**: Gateway `chat` 이벤트의 `state: 'delta'`는 상태 신호만 보내고 실제 텍스트(`payload.delta`)를 포함하지 않음. `chatDeltaBuffer`는 항상 빈 문자열, `extractDeltaSnippet()`은 항상 null. 또한 `exec.approval.requested`는 수동 승인 도구만 발생 — 자동 승인 도구는 이벤트 없음.

### 해결
1. **죽은 코드 제거**: `chatDeltaBuffer`, `DELTA_BUF_MAX`, `extractDeltaSnippet()` — Gateway가 delta 텍스트를 보내지 않으므로 전부 무의미
2. **프롬프트 스니펫**: `chat_end`/`aborted` 엔트리에 `lastPrompt`(80자 truncate) 포함 → "Completed · 42s · fix the login bug"
3. **events.history 사후 보강**: `final` 후 `events.history` RPC로 해당 run의 도구 사용 내역 조회, `chat_end` raw를 `"Read(3), Bash(2), Edit(1)"` 형식으로 업데이트. Gateway 미지원 시 무시
4. **timeline-store 헬퍼**: `updateEntryRaw(index, newRaw)` + `findLastIndex(type)` 추가
5. **디버그 로깅**: chat 이벤트에 `state`/`keys` 로깅 추가 — 실제 payload 구조 검증용

### 교훈 / 핵심 설계 결정
- **Gateway chat delta는 상태 신호만**: `payload.delta`는 정의되지 않음. 텍스트 콘텐츠는 `events.history` 사후 조회로만 가능
- **사후 보강 패턴**: 즉시 표시 가능한 정보(프롬프트, 시간)로 먼저 엔트리 생성, 이후 비동기로 디테일(도구 목록) 보강 — UI 즉시 반영 + 점진적 개선

---

## 2026-02-24 — OpenClaw 모드 종합 점검: 음성/모델/타임라인

### 문제
OpenClaw 모드에서 3가지 문제:
1. **음성 커맨드 지연**: 전사 결과가 `smartPaste()`로 빠져 클립보드에 붙여넣기됨 (OC에는 터미널 없음). `currentSessionKey` null일 때 커맨드 사일런트 드롭
2. **모델 카탈로그 미표시**: `openclaw` CLI가 Stream Deck 프로세스의 최소 PATH에서 발견 안 됨. standalone poll도 bridge 연결 시 중단
3. **타임라인 패널 배경**: `#0f172a` 배경이 LCD에서 검은 직사각형으로 보여 시각적으로 어색

### 해결
**음성 (voice-dial.ts)**: `hasTerminal` 체크 분기 추가 — OC(`hasTerminal=false`)이면 상태 무관하게 `send_prompt` 직접 전송, Claude Code는 기존 IDLE-only 로직 유지

**세션 대기 큐 (gateway-client.ts)**: `waitForSession()` — `currentSessionKey` null이면 500ms 폴링(최대 10회=5초) 후 전송. 기존 사일런트 드롭 대신 큐잉

**모델 카탈로그 PATH (voice-paths.ts + gateway-client.ts + usage-button.ts)**:
- `augmentedPath()`에 `~/.cargo/bin`, `~/go/bin`, `~/.openclaw/bin`, `~/.bun/bin` 추가
- `resolveOpenClawBin()`: `OPENCLAW_CANDIDATES`에서 `existsSync`로 바이너리 직접 탐색 후 풀패스 사용 (PATH 의존 탈피)
- `fetchModelCatalog(retries=2)`: 실패 시 10초 후 재시도
- `setUsageCapabilities()`: OC `hasModelCatalog=true`면 독립 catalog poll 유지 (OAuth poll과 분리)

**타임라인 배경 (timeline-renderer.ts)**: 3곳 `fill="#0f172a"` → `fill="#000000"` — LCD 네이티브 블랙과 동일하여 투명 배경 효과

### 교훈 / 핵심 설계 결정
- **GUI 앱 자식 프로세스 PATH**: Stream Deck SDK가 스폰하는 플러그인은 최소 PATH만 상속. `augmentedPath()` 확장 + `OPENCLAW_CANDIDATES` 직접 탐색 이중 전략 필요
- **hasTerminal capability gate**: 에이전트별 I/O 차이는 capability 체크로 분기 — 하드코딩 에이전트 타입 비교 대신 `caps.hasTerminal` 사용
- **LCD 투명 효과**: encoder LCD 네이티브 배경 = `#000000`. 동일 색상 사용 시 pixmap 경계 비가시 → 텍스트 플로팅 효과

---

## 2026-02-23 — Ghost Text 오탐: UI 크롬(Tip/단축키)이 추천으로 표시

### 문제
E2 Response Dial에 실제 ghost text 추천("show me the current git diff") 대신 Claude Code UI 요소가 표시:
1. **"Tip: Did you know you..."** — Claude Code 팁 메시지가 ❯ 라인에서 회색으로 렌더 → ghost text로 오탐
2. **"(ctrl+o to expand)(1m..."** — 단축키 힌트 + 상태줄 파편이 회색 세그먼트로 감지

원인: `detectGhostText` Strategy 2가 ❯ 프롬프트 라인의 **모든** 회색 ANSI 세그먼트를 무조건 수집. Claude Code가 팁/힌트를 같은 라인에 회색으로 렌더하면 ghost text와 함께 수집됨. `scheduleSuggestion` 500ms 디바운스에서 후속 chunk의 UI 크롬이 올바른 추천을 덮어씀.

### 해결

**1. 세그먼트 레벨 UI 크롬 필터 (`isUiChrome` 함수)**
회색 ANSI 세그먼트 수집 시 알려진 UI 패턴을 즉시 제외:
- `Tip:`, `Did you know` — Claude Code 팁
- `ctrl+`, `ctrl-`, `shift+` — 단축키 힌트
- `(\d+[mhs]` — 상태줄 시간 파편
- `to expand`, `to cycle`, `to confirm`, `to exit`, `to edit in` — 동작 힌트
- `? for shortcuts` — 바로가기 안내

**2. `scheduleSuggestion` 방어 필터 보강**
세그먼트 필터링을 우회하는 엣지 케이스 대비 동일 패턴 이중 검증.

**3. Stacked ANSI 시퀀스 처리 (`ANSI_TEXT_RE` + `hasGrayForeground`)**
- `ANSI_SEGMENT_RE` → `ANSI_TEXT_RE`: 연속 SGR 이스케이프 처리 (예: `\x1b[38;2;r;g;bm\x1b[3m`)
- `isGrayForeground` → `hasGrayForeground`: 결합 SGR 파라미터 파싱 (예: `2;90` = dim+bright black)

**4. Cross-chunk 감지 (Strategy 3)**
❯ 프롬프트와 ghost text가 별도 PTY chunk로 도착하는 경우: 버퍼의 마지막 가시 라인이 ❯로 시작하면 후속 chunk의 회색 텍스트를 프롬프트 라인 연속으로 인식.

### 교훈
- **❯ 라인은 ghost text만 있지 않다**: Claude Code TUI는 프롬프트 라인에 추천 텍스트 + 팁 + 단축키 힌트를 모두 회색으로 렌더. 색상만으로 ghost text를 구분할 수 없으며 콘텐츠 기반 필터 필수
- **디바운스가 오탐을 악화**: 올바른 추천이 먼저 감지되어도, 500ms 이내 UI 크롬이 다시 감지되면 타이머가 리셋되어 잘못된 텍스트로 덮어씀. 세그먼트 레벨에서 UI 크롬을 사전 차단하는 것이 디바운스 로직 수정보다 효과적
- **회색 세그먼트 = 일급 파서 이벤트가 아님**: 회색이라고 무조건 ghost text가 아니라, "❯ 라인의 회색 + UI 크롬이 아닌 것"이 ghost text

---

## 2026-02-23 — Navigable Permission Prompt 다이얼 클릭 무반응

### 문제
Permission prompt에 `❯` 커서(navigable 모드)가 있을 때, 다이얼 회전(화살키)은 터미널에 반영되지만 다이얼 클릭(선택 확인)이 터미널에서 실행되지 않음. Stream Deck UI에서는 실행된 것으로 표시.

원인: `AWAITING_PERMISSION` 상태에서 다이얼 push → `respond` 커맨드로 shortcut 문자 전송 (e.g. `"y\r"`). Navigable TUI는 문자 입력을 받지 않고 Enter만 인식 → PTY가 `"y\r"` 무시. 하지만 브릿지 상태 머신은 `handleUserAction('respond')`로 즉시 PROCESSING 전환 → SD는 실행 완료로 표시 (상태 desync).

### 해결
Navigable permission/diff 프롬프트에서는 `respond`(shortcut 문자) 대신 `select_option`(화살키 + Enter) 사용:
1. **Plugin** (`option-dial.ts`): `handleTakeoverPush()` + `onDialDown()` — `navigable && AWAITING_PERMISSION/DIFF` 조건에서 `select_option` 전송
2. **Bridge** (`state-machine.ts`): `handleUserAction('select_option')` — AWAITING_PERMISSION/DIFF 상태도 처리
3. **Transitions** (`states.ts`): `user_selection` trigger에 AWAITING_PERMISSION/DIFF → PROCESSING 전이 추가

### 교훈
- **`respond` vs `select_option` 구분 기준**: 원래 permission=respond(shortcut), option=select_option(index)으로 구분했으나, 실제 구분 기준은 **navigable 여부**: navigable=select_option(Enter), non-navigable=respond(shortcut). Claude Code TUI가 `❯` 커서 모드를 더 넓은 범위의 프롬프트에 적용하면서 이 구분이 필요해짐
- **상태 desync 패턴**: PTY에 입력을 보내기 전에 상태 머신을 전환하면, PTY가 입력을 거부해도 UI는 이미 다음 상태. `respond`/`select_option` 모두 PTY write와 동시에 state transition하는 eager 패턴 — PTY 거부 시 stuck timeout이 복구 역할

---

## 2026-02-23 — Plan Approval Dialog 미감지 (chunk size guard 오필터링)

### 문제
Plan approval dialog이 터미널에 표시되지만 Stream Deck에 반영되지 않음. `output-parser.ts`의 chunk size guard(`chunkNonWs < 200`)가 plan approval dialog을 필터링.

이 guard는 Claude 응답 텍스트의 번호 목록(e.g. "1. First approach\n2. Second approach")이 interactive option으로 오탐되는 것을 방지하기 위해 도입됨. 하지만 실제 plan approval dialog의 non-ws 문자 수가 ~264자로 200을 초과:
- 옵션 1의 긴 레이블: `"Yes, clear context (33% used) and auto-accept edits (shift+tab)"`
- 하단 footer: `"ctrl-g to edit in VS Code · ~/.claude/plans/crystalline-moseying-raccoon.md"`

결과: `OPTION_NUMBERED` regex 매치 → `chunkNonWs < 200` 조건 실패 → option detection 완전 스킵.

### 해결
`❯` 커서(navigable cursor)가 번호 옵션 앞에 있으면 chunk size와 무관하게 bypass:
```typescript
const hasNavigableCursor = /^\s*❯\s*\d{1,2}[.)]/m.test(chunk);
if (... && (hasNavigableCursor || chunkNonWs < 200)) {
```
Claude 응답 텍스트에는 `❯ 1.` 패턴이 절대 나타나지 않으므로 false positive 위험 없음.

### 교훈
- **Chunk size guard 설계**: 크기 기반 필터는 불완전한 휴리스틱. 콘텐츠가 길어질 수 있는 정상 케이스를 고려해야 함. 확정적 TUI 마커(`❯` 커서)가 있으면 크기 조건을 우회하는 것이 더 안정적
- **테스트 데이터 현실성**: 기존 테스트의 짧은 옵션 레이블이 버그를 은폐함. 실제 데이터와 유사한 테스트 데이터 사용 중요

---

## 2026-02-23 — Usage Overwrite, Voice Crash, Hook Server Binding 수정

### 문제
피드백으로 보고된 3가지 이슈:
1. **Usage 덮어쓰기**: `setOutputTokens`가 PTY 상태줄 값을 직접 대입해 hook으로 누적된 세션 토큰 수를 덮어씀
2. **Voice error → 브릿지 크래시**: `VoiceManager.emit('error')`에 리스너 미등록 → Node.js EventEmitter가 uncaught exception throw → 프로세스 종료. 보고는 "UI 고정"이었으나 실제로는 크래시
3. **Hook server 0.0.0.0 바인딩**: `server.listen(port)` 기본값이 모든 인터페이스에 노출

### 해결
1. `usage-tracker.ts`: `this.outputTokens = tokens` → `Math.max(this.outputTokens, tokens)` — PTY 누적치면 동일, 턴별 값이면 regression 방지
2. `index.ts`: `voiceManager.on('error', ...)` 리스너 추가 — 에러 로깅 + `voice_state: error` broadcast
3. `hook-server.ts`: `server.listen(port, '127.0.0.1', ...)` — `session-registry.ts`와 동일 패턴

### 교훈
- **Node.js EventEmitter 'error' 이벤트**: 리스너 없으면 자동으로 uncaught exception throw → 프로세스 크래시. `emit('error')`를 사용하는 모든 EventEmitter에 반드시 error 리스너 등록 필요

---

## 2026-02-23 — Ghost Text 24-bit RGB ANSI 컬러 감지 수정

### 문제
Claude Code가 ghost text(추천 커맨드)의 ANSI 컬러를 SGR 90(`\x1b[90m`)에서 24-bit RGB(`\x1b[38;2;R;G;Bm`)로 변경. `GHOST_TEXT_RE` 정규식이 RGB 형식을 매칭하지 못해 E2 인코더에 추천 커맨드가 표시되지 않음. 디버그 로그: `ghostText: ❯-line found but no gray segments. raw=\e[38;2;153;153;153m❯ \e[39m...`

### 해결
`GHOST_TEXT_RE` 정규식을 `ANSI_SEGMENT_RE` + `isGrayForeground()` 함수 기반으로 교체:
- **`ANSI_SEGMENT_RE`**: 모든 SGR 세그먼트의 파라미터 문자열 + 텍스트를 캡처
- **`isGrayForeground(params)`**: SGR 90, 256-color grays (230-255), 24-bit RGB grays 판별
  - RGB 그레이 기준: `max - min ≤ 30` (저채도), `60 ≤ max ≤ 210` (중간 밝기)
  - `(153,153,153)` ghost text ✓, `(177,185,249)` blue ✗, `(80,80,80)` dark prompt char ✓ (but filtered by length)
- 테스트 3개 추가: 24-bit RGB gray 감지, non-gray 무시, 짧은 프롬프트 문자 필터링 (총 233 pass)

### 교훈
- 정규식 기반 ANSI 매칭은 새 컬러 형식 대응 불가 — R=G=B 산술 검증이 필요한 24-bit RGB는 함수 기반 판별 필수
- 그레이 판별 threshold(`max-min ≤ 30`, `60 ≤ max ≤ 210`)는 실제 PTY 로그의 색상값에서 도출: `(153,153,153)` ghost, `(136,136,136)` UI, `(80,80,80)` prompt char

---

## 2026-02-23 — False Idle from PTY Batch Echo & Permission Button Label Dedup

### 문제
1. **Permission 후 false idle**: Permission prompt(Yes/No/Always) 감지 직후, 같은 PTY batch의 후속 chunk에 user prompt echo(`❯ Review the commit log...`)가 포함. `IDLE_PROMPT` 매칭 → 300ms 후 idle 발출 → `AWAITING_PERMISSION` 상태가 즉시 `IDLE`로 복귀. 디버그 로그에서 3회 연속 재현 확인.
2. **Permission 버튼 라벨 중복**: `truncateLabel()`이 "Yes"와 "Yes, allow all edits during this session" 모두 `'YES'`로 축약 → 버튼에서 구분 불가.
3. **테스트 실패 + 누락**: idle이 option debounce를 취소하는 기존 테스트가 새 동작(idle 무시)과 불일치. Permission의 navigable/cursorIndex 전달 테스트 부재.

### 해결
1. **Interactive cooldown (200ms)**: `output-parser.ts`에 `interactiveCooldown` 타이머 추가. Permission/diff prompt emit 직후 시작, 200ms간 idle 억제. False idle은 같은 PTY batch에서 수 ms 내 도착하므로 실제 idle(사용자 응답 후)에 영향 없음.
2. **`truncateLabel` → `uppercaseShort`**: 모든 "Yes..." → "YES" 축약 제거. 12자 이하만 대문자화, 긴 라벨은 button-renderer의 기존 3-tier 파이프라인(font tier 28→16px + abbreviateLabel + Haiku 폴백) 활용.
3. **테스트 보강**: idle vs option debounce 테스트 수정, permission navigable/cursorIndex 테스트 3개, interactive cooldown 테스트 3개, state-machine permission navigable 테스트 1개 추가 (총 230 pass).

### 교훈
- PTY batch 내 prompt echo(`❯ text`)는 interactive prompt 직후 수 ms 내 도달 — 즉시 발출(no debounce) 프롬프트도 후속 chunk에 대한 cooldown 필요
- Permission 버튼도 option과 동일한 button-renderer 파이프라인을 통하면 라벨 다양성 자연 확보 — 별도 축약 로직은 정보 손실
- `idle` 억제 메커니즘 3종 정리: (1) optionTimer pending → idle 무시, (2) interactiveCooldown → idle 무시, (3) spinner 중 large chunk → idle 무시

---

## 2026-02-22 — Quick Action PI: Slot Dropdown 제거 & sdpi-components v2 API

### 문제
1. **PI ↔ 버튼 불일치**: PI의 Custom Label/Action 필드가 빈 값으로 표시되지만, 실제 버튼은 정상 동작. `onWillAppear`에서 `slotIndex`만 persist하고 `label`/`action`은 persist하지 않아, PI(sdpi-components 자동 바인딩)는 빈 설정을 보지만 버튼 렌더링은 코드 내 `effectiveSettings()` → `DEFAULT_IDLE_SETTINGS` 폴백으로 정상 표시.
2. **`$SD is not defined`**: sdpi-components v2에 `$SD` 전역 변수가 없음. `$SD.on('didReceiveSettings', ...)` 호출 시 ReferenceError.
3. **5번째+ 버튼 빈 표시**: `autoAssignSlot()`이 `actionSlots.size`(4+) 반환 → `DEFAULT_IDLE_SETTINGS[4]`가 undefined → 빈 버튼.

### 해결
1. **Defaults persist**: `onWillAppear`에서 `settings.label == null || settings.action == null`이면 슬롯 defaults를 실제 settings에 `setSettings()` — PI가 값을 직접 표시.
2. **sdpi-components v2 API**: `window.SDPIComponents.streamDeckClient.didReceiveSettings.subscribe(fn)` 사용. 콜백 파라미터는 `actionInfo` 전체 객체 (`jsn.payload.settings`로 접근).
3. **autoAssignSlot cap**: `return DEFAULT_IDLE_SETTINGS.length - 1` (마지막 슬롯 CLEAR로 캡).
4. **슬롯 드롭다운 제거**: PI에서 `<sdpi-select setting="slotIndex">` 제거, 읽기 전용 "Slot N" 표시로 대체.

### 교훈
- **sdpi-components v2 이벤트**: `$SD`는 v1 API. v2는 `SDPIComponents.streamDeckClient`가 클라이언트이며, `didReceiveSettings`/`didReceiveGlobalSettings`/`sendToPropertyInspector`/`message`는 `{ subscribe(), unsubscribe(), dispatch() }` 패턴의 이벤트 에미터. 초기 connect와 WS 메시지 모두 동일 에미터로 dispatch.
- **PI 필드 값 vs placeholder**: sdpi-components는 `setting` 속성으로 자동 바인딩 — persist된 값이 있으면 필드에 표시, 없으면 빈 칸(placeholder만 보임). 버튼 로직이 코드 내 defaults를 merge하더라도, PI는 persist된 settings만 봄. 불일치 방지를 위해 defaults를 settings에 실제 persist 필요.
- **autoAssignSlot 범위 초과**: slot >= N이면 `DEFAULT_IDLE_SETTINGS[slot]`이 undefined — 안전한 캡 필수.

---

## 2026-02-22 — PTY ANSI Chunk Splitting & False Option Detection

### 문제
1. **ANSI 시퀀스 분할**: PTY 청크가 `\x1b[38;2;177;185;249m` 같은 SGR 코드 중간에서 잘릴 때, `strip-ansi`가 불완전 시퀀스를 매치 못해 잔여 텍스트(`;2;177;185;249mYes`)가 옵션 라벨에 오염.
2. **응답 텍스트 오감지**: Claude 응답 본문의 번호 목록("1. First approach\n2. Second...")이 `OPTION_NUMBERED` 정규식에 매치되어 interactive option/diff prompt로 오분류.
3. **CJK 서제스트 차단**: `scheduleSuggestion`의 `\w{2,}` 필터가 ASCII만 매치 → 한글/일본어 ghost text 전부 무시.

### 해결
1. **`pendingAnsi` 버퍼링**: `feed()`에서 청크 끝 20자 내 불완전 ESC 시퀀스(CSI/OSC/bare ESC)를 `pendingAnsi`에 보류, 다음 청크 앞에 결합. `cleanOptionLabel`에도 `stripAnsi()` 이중 방어.
2. **대형 청크 가드**: `detectPatterns()`에서 `OPTION_NUMBERED`/`OPTION_BULLET` 매치 시 `chunkNonWs < 200` 조건 추가. 실제 TUI 옵션은 소형 청크, 응답 텍스트는 대형 청크.
3. **Unicode letter 매치**: `\w{2,}` → `\w{2,} || \p{L}{2,}` (ES2018 Unicode property escape).

### 교훈
- PTY는 ANSI 시퀀스 경계를 보장하지 않음 — 모든 raw 데이터 처리에 불완전 시퀀스 고려 필요
- 정규식 기반 TUI 파싱에서 **청크 크기**는 interactive vs. informational 텍스트 구분의 강력한 휴리스틱
- JavaScript `\w`는 ASCII 전용 — CJK 텍스트 처리 시 `\p{L}` 필수

---

## 2026-02-22 — Encoder Takeover Race on Rapid State Transitions

### 문제
Quick Action에서 옵션 선택 후 즉시 PERMISSION 프롬프트(Allow Bash 등)가 뜨면 다이얼이 응답하지 않음. AWAITING_OPTION → select_option → PROCESSING → AWAITING_PERMISSION 전환이 빠르게 연속 발생.

### 해결
`exitEncoderTakeover()`는 `active=false`를 동기로 설정하고 `setFeedbackLayout('voice-layout.json')`을 async로 실행. 곧바로 `enterEncoderTakeover()`가 `active=true` + `setFeedbackLayout('option-pixmap-layout.json')` 실행. exit의 `.then()` 콜백(다이얼 상태 복원)이 enter 이후에 resolve되면서 takeover 레이아웃을 voice 레이아웃으로 덮어씀.

`plugin.ts`에 `takeoverGeneration` 카운터를 도입하여 exit/enter `.then()` 콜백 실행 시 generation이 변경되었으면 콜백을 스킵.

### 교훈
async takeover 전환에서 `.then()` 콜백은 항상 generation guard 필요. `active` 플래그만으로는 비동기 완료 콜백의 순서를 보장할 수 없음.

---

## 2026-02-22 — Ghost Option from Stale Buffer Content

### 문제
Claude 응답에 번호 목록(예: 계획 단계 "3. ... 5. Deploy")이 포함된 후 4개 옵션 프롬프트가 바로 이어지면, `parseOptions(this.buffer.slice(-1000))`가 이전 응답의 "5."와 현재 옵션 1-4를 모두 파싱. contiguous 필터가 0-4를 유효로 판단하여 Stream Deck에 유령 5번째 옵션 표시.

### 해결
1. **Backward scan**: `parseOptions()`에서 정규화 후 역방향 스캔으로 마지막 연속 옵션 블록만 추출. 끝에서부터 footer 건너뛰고, 옵션 라인을 수집하되 비옵션·비공백 라인(질문 텍스트 등)에서 정지. 이전 응답의 번호 항목은 블록 경계 밖이라 자연 배제.
2. **Idle prompt guard (기존 버그 수정)**: cursor-only redraw 감지 조건에 `!hasIdlePrompt` 추가. 이전에는 `lastNavigableEmit=true` 상태에서 `❯ \n`(공백 포함 idle 프롬프트)도 커서 redraw로 오인하여 idle 전환 불가.

### 교훈
- PTY 버퍼 기반 파싱에서 "최근 N바이트"만 보는 방식은 이전 출력의 패턴 오염에 취약 — 구조적 경계(블록 분리)가 필수
- cursor-only redraw 감지는 `❯` 문자만으로 판단하면 idle prompt와 충돌 — idle prompt는 `❯` 뒤 공백 필수라는 차이점으로 구별

---

## 2026-02-22 — 옵션 목록 타임아웃 + 키보드 커서 동기화

### 문제
1. **옵션 목록 5분 타임아웃**: 터미널에 옵션이 표시되어 있어도 `STUCK_TIMEOUT_MS`(5분) 발동으로 IDLE 강제 전환
2. **키보드 커서 미동기**: 터미널에서 arrow key로 옵션 선택 변경 시 ink의 최소 redraw(❯ 문자만 이동)가 `OPTION_NUMBERED` 패턴에 매칭되지 않아 Stream Deck 미반영

### 해결
1. `StateMachine.onPtyActivity()` 추가 — interactive 상태에서 PTY 데이터 수신 시 stuck timer 리셋. `index.ts`의 PTY `data` 핸들러에서 호출
2. `OutputParser`에 cursor-only redraw 감지 — `lastNavigableEmit`/`lastCursorIndex` 필드 추적, `❯` 포함 chunk가 `OPTION_NUMBERED`에 매칭 안 될 때 buffer tail 재파싱하여 `cursor_update` 이벤트 emit

### 교훈
- ink TUI는 성능 최적화를 위해 변경된 문자만 redraw — 기존 패턴 매칭이 항상 동작한다고 가정하면 안 됨
- stuck timeout은 PTY 무응답(진짜 stuck) 감지용이므로, PTY 활동이 있으면 리셋하는 것이 올바른 설계

---

## 2026-02-22 — Quick Action 버튼 물리 위치 정렬

### 문제
Quick Action 버튼(슬롯 3-5)이 `onWillAppear` 호출 순서(비결정적)로 `actionIds` 배열에 추가되어, 물리적 버튼 위치와 슬롯 번호가 불일치. IDLE 기본 버튼, Permission YES/NO/ALWAYS, 프로젝트 피커 모두 영향. 추가로 `layout-manager.ts`에서 `opt.shortcut || 'y'` 폴백이 shortcut 없는 모든 옵션을 YES로 매핑하는 버그 발견.

### 해결
- `actionIds: string[]` → `actionCoords: Map<string, number>` (id → column)으로 변경
- `getSortedIds()` 헬퍼가 column 순 정렬된 ID 배열 반환
- shortcut 폴백: `opt.shortcut || opt.label.charAt(0).toLowerCase()` (diffButtons와 동일 패턴)

### 교훈 / 핵심 설계 결정
- **Stream Deck SDK `onWillAppear` 순서는 비결정적** — 항상 `ev.action.coordinates`로 물리 위치 판별 필요
- 배열 인덱스 기반 슬롯 매핑은 도착 순서 의존성 → Map + 정렬 패턴이 안전

---

## 2026-02-22 — Permission 옵션 파싱: 유령 옵션 필터링

### 문제
Plan approval 프롬프트 (4개 옵션)가 6개로 파싱됨. `this.buffer.slice(-1000)`에 이전 응답의 번호 패턴(`98.` 등)이 포함되어 `OPTION_NUMBERED` 정규식이 잘못 매칭.

### 해결
`parseOptions()` 끝에서 연속 인덱스 필터 추가 — index 0부터 연속인 그룹만 유지, `idx=98`, `idx=-1` 같은 이상치 제거. 2개 미만이면 폴백.

### 교훈
- PTY 버퍼 기반 파싱은 항상 stale content 오염 가능성 있음. 정규식 매칭 후 결과 검증 단계 필요
- Map 키 충돌로 일부 덮어쓰기되지만 범위 밖 인덱스는 살아남음

---

## 2026-02-22 — Encoder Takeover: Wide Canvas 옵션 목록 (E1 info + E2-E4 wide list)

### 문제
Encoder takeover 모드에서 4개 패널이 각각 독립 정보(context/focus/list/detail)를 보여주는 방식은 가독성이 낮음. Voice text의 wide canvas 기법이 훨씬 효과적.

### 해결
- `renderWideOptionList()` 추가: `panelCount * 200`px 단일 캔버스에 옵션을 세로 나열, `translate(-i*200,0)` 슬라이싱으로 패널별 SVG 분리
- `encoder-takeover.ts` 렌더 구조를 E1=context + E2-E4=wide list로 변경
- `autoScrollToIndex()`: 선택 항목이 visible area 밖이면 scrollY 자동 조정
- 기존 4-panel 할당 로직(`getPanelAssignment`) 제거, 단순화

### 교훈 / 핵심 설계 결정
- Wide canvas 슬라이싱 패턴은 voice text에서 검증됨 → 옵션 목록에도 동일 기법 재사용
- `option-dial.ts`는 수정 불필요 — 기존 `handleTakeoverRotate()` → `refreshEncoderTakeover()` → `autoScrollToIndex()` 체인으로 자동 연동
- 1그룹만 활성 시 focus panel 폴백 유지

---

## 2026-02-22 — Option Dial: Navigable 모드 경계 스크롤 시 인덱스 desync 수정

### 문제
옵션 리스트(navigable 모드)에서 끝까지 스크롤한 뒤 방향을 반전하면 디스플레이 인덱스와 PTY 커서가 어긋남. 원인: `selectedIndex`가 `Math.min/max`로 clamp되어 변하지 않는데도 `navigate_option` 메시지를 브릿지에 무조건 전송 → PTY 커서만 계속 이동.

### 해결
`onDialRotate`와 `handleTakeoverRotate` 양쪽에서 `prevIndex`를 저장하고, `selectedIndex !== prevIndex`일 때만 `navigate_option`을 전송하도록 guard 추가.

### 교훈
- Clamp 로직과 side-effect(메시지 전송)를 분리할 때, "값이 실제로 변했는가"를 반드시 검증해야 함

---

## 2026-02-22 — iTerm Dial: Detached Tmux 고스트 세션 버그 수정

### 문제
iTerm 다이얼(E3)에 실제 터미널 창보다 많은 세션이 표시됨. Bridge crash 후 sessions.json에 남은 stale 엔트리가 🔌 detached 항목으로 잘못 생성되고, tmux -CC 모드에서 TTY 매칭 실패로 attached 세션이 detached로 오판됨.

### 해결
3중 검증 추가:
1. **PID 검증** — `loadAgentDeckSessions()`에서 `process.kill(pid, 0)`으로 죽은 프로세스 필터링
2. **tmux 세션 실존 검증** — `getLiveTmuxSessionNames()` (`tmux list-sessions`)로 죽은 tmux 세션 제외
3. **tmux client 매칭** — `getTmuxSessionMap()`의 client TTY를 iTerm TTY와 교차 검증하여 attached 상태 정확히 판별

리뷰 후 `syncFromSystem()`에서 `getTmuxSessionMap`, `loadAgentDeckSessions`의 중복 호출 제거 — `appendDetachedTmux`를 순수 함수로 변경하고 상위에서 한 번만 fetch하여 context로 주입.

### 교훈
- Plugin 측에서도 sessions.json의 PID liveness를 검증해야 함 (bridge 측 pruning에만 의존 불가)
- 2초 폴링 함수에서 shell exec 중복은 누적 비용이 크므로 데이터를 한 번 fetch → 여러 곳에서 재사용하는 패턴 적용

### 후속: Ghost 세션 감지 및 re-attach (047a51d)
브릿지 종료 후 tmux 세션이 살아있으면 iTerm -CC 윈도우가 고스트로 잔류. `syncFromSystem()`에서 `bridgedTmuxNames`(살아있는 브릿지의 tmux 이름)와 비교하여 ghost 마킹(`⚠` prefix + `isGhost`/`tmuxName` 필드). Push 시 `attachTmuxInIterm()`으로 새 윈도우에서 re-attach.

---

## 2026-02-22 — Voice 붙여넣기: 앱별 분기 전략

### 문제

Voice 전사 결과를 `pasteText()`로 전달할 때:
1. **iTerm2**: `System Events` `keystroke "v" using command down` → Advanced Paste 다이얼로그 발생
2. **Safari 등**: `keystroke` 자체가 보안 제한으로 동작하지 않음 (Accessibility 권한 불안정)
3. 두 번의 osascript 호출(frontApp 감지 → 붙여넣기) 사이 포커스 전환 문제

### 해결

단일 osascript 호출로 frontApp 판별 + 전달을 원자적으로 처리:
- **iTerm2 최전면** → `write text` API 직접 사용 (Advanced Paste 회피)
- **기타 앱** → `set the clipboard to` + `display notification` (사용자가 ⌘V)
- `System Events` `keystroke`는 앱별 동작이 불안정하므로 포기

### 교훈 / 핵심 설계 결정

- macOS `System Events` `keystroke`는 호출 프로세스의 Accessibility 권한에 의존하며, 앱마다 동작이 다름 — 범용 자동 붙여넣기에 신뢰할 수 없음
- iTerm2는 자체 AppleScript API(`write text`)가 가장 안정적
- 클립보드 복사 + 알림이 가장 안전한 범용 전달 방식
- osascript를 여러 번 호출하면 호출 사이에 앱 포커스가 바뀔 수 있음 — 단일 호출로 원자적 처리 필수

---

## 2026-02-22 — Security Guide 커서선택 UI 오분류 수정

### 문제

`sdc`로 새 프로젝트 진입 시 Security Guide("Yes, I trust this folder" / "No, exit")가 `permission_prompt`로 분류되어 `y\r`을 전송. 하지만 이 프롬프트는 커서 선택 UI(`Enter to confirm`)이므로 Enter 키만 필요.

### 해결

`isCursorSelectionUI()` 메서드 추가 — buffer에서 `Enter to confirm` 패턴 감지 시 `option_prompt`(navigable)로 분류하여 arrow key + Enter로 선택.

### 교훈

**ANSI 커서 제어로 공백이 제거되는 현상**: PTY 출력을 `stripAnsi()` 처리하면 ANSI cursor positioning(`\x1b[nC` 등)이 제거되면서 단어 사이 공백도 사라짐. 예: `"Enter to confirm"` → `"Entertoconfirm"`. output-parser에서 텍스트 패턴 매칭 시 **`\s+` 대신 `\s*`를 사용**해야 안전함. 이는 Claude Code TUI가 cursor positioning으로 텍스트를 배치하기 때문에 발생하는 구조적 특성.

---

## 2026-02-22 — Ghost Text 자동완성 제안 안정성 강화

### 문제

Response Dial의 suggested prompt 기능이 엉뚱한 텍스트를 표시하는 오탐 발생:
1. `"try 'edit command-dial.ts to...'"` — `\x1b[2m` (dim) ANSI 코드가 Claude 응답 텍스트에도 쓰여 ghost text로 오인
2. `"65"` — diff 출력의 라인 번호가 `\x1b[90m` (gray)으로 렌더되어 캡처됨
3. 텍스트 잘림 (`"시 시도해봐"`) — `.match()` (첫 매칭만)으로 멀티 ANSI 세그먼트 일부 누락

### 초기 접근

rawData 전체에서 gray ANSI escape 코드(`\x1b[2m`, `\x1b[90m`, `38;5;240-255`)를 스캔.

### 최종 해결

**2단계 전략 + 보수적 필터:**

1. **Strategy 1 (고신뢰)**: clean text에서 `❯ Try "..."` 패턴 직접 파싱.
   - ANSI 파싱 완전 우회 → 오탐 없음
   - Claude Code v2.1.49+ 기준 가장 흔한 ghost text 형식

2. **Strategy 2 (ANSI 보조)**: `❯`가 포함된 라인에서만 gray 세그먼트 수집.
   - rawData 전체 스캔 → `❯` 라인 스코프 제한으로 diff/상태바 배제
   - `matchAll` + join으로 멀티 세그먼트 연결

3. **`scheduleSuggestion` 검증 레이어**:
   - `^\d+$` — 순수 숫자 거부 (diff 라인 번호)
   - `\w{2,}` — 실제 단어 없으면 거부
   - 길이 3~200자

4. **`\x1b[2m` (dim) 제거**: UI 전반(상태바, 힌트, 인용)에 쓰이므로 ghost text 기준 부적합.

### 설계 원칙

오탐(엉뚱한 텍스트 표시) > 미탐(suggestion 놓침). 가끔 suggestion을 놓치더라도 잘못된 텍스트를 표시하지 않는 것이 UX상 우선.

---

## 2026-02-22 — whisper-server 통합으로 음성 전사 지연 해소

### 문제

음성 전사 호출마다 `whisper-cli`가 1.5GB `large-v3-turbo` 모델을 GPU 메모리에 로드→추론→언로드. 모델 로드/언로드 오버헤드가 추론보다 큰 병목 (호출당 ~5-10초).

### 해결

`whisper-server` (whisper.cpp 내장 HTTP 서버)를 브릿지 수명 주기에 통합하여 모델 상주:

- **서버 수명 관리**: `VoiceManager.startServer()` / `stopServer()` — 브릿지 시작 시 비동기 스폰, 종료 시 SIGTERM+3s SIGKILL
- **포트 할당**: `bridgePort + 10` (9120→9130) — 브릿지 포트 범위(9120-9129)와 겹치지 않음
- **HTTP 전사**: `POST /inference` multipart form-data (외부 의존성 없이 수동 boundary 구성)
- **라우팅**: `useServer && whisperServerReady` → 서버 모드, 실패 시 자동 CLI 폴백
- **리샘플 스킵**: 서버 모드에서 sox 리샘플 생략 (`--convert` 플래그로 서버가 자체 변환) → ~100-300ms 추가 절감
- **Readiness 폴링**: 500ms 간격 최대 30초, 모델 로드 완료 후 서버가 listen 시작하므로 아무 HTTP 응답 = ready
- **크래시 복구**: 서버 프로세스 `exit` 이벤트에서 `useServer=false` 설정 → 다음 호출부터 CLI 폴백

### 결과

- 예상 지연: ~5-10s → <2s (모델 상주 + 리샘플 생략)
- `whisper-server` 미설치 시 기존 `whisper-cli` 경로 100% 유지 (무손실 폴백)
- `check-deps.ts`에 선택적 의존성 추가 (설치 안내만, 필수 아님)

---

## 2026-02-22 — Voice Text Wide Canvas + Encoder LCD 디자인 일관성 정비

### 문제

1. **전사 텍스트 가독성**: VT(Voice Text Takeover)가 패널별 독립 SVG → 텍스트가 패널 경계에서 끊김, 짧은 텍스트가 좁은 1패널에 갇힘
2. **인코더 디자인 불일치**: 4개 다이얼(VOL, PROMPT, TERM, VOICE)의 헤더 정렬·폰트·바 높이·아이콘 크기가 제각각
3. **Utility 모드 타이틀에 emoji 혼재**: "🔊 Vol", "☀️ Bright" 등 타이틀에 emoji가 포함되어 디자인 일관성 저해

### 해결

#### Voice Text Wide Canvas

전체 인코더(최대 4패널 × 200px = 800px)를 하나의 와이드 캔버스로 렌더링:

- **translate 슬라이싱**: `<g transform="translate(${-i*W},0)">` — SD의 viewBox offset 미지원 우회
- **clipPath 스크롤**: 텍스트 영역 y=22..80 클리핑, `translate(0,${-scrollY})` 픽셀 스크롤
- **적응형 폰트 5단계**: 48→36→24→18→16px, 짧은 텍스트는 크게, 긴 텍스트는 작게
- **가운데 정렬**: 가로 `text-anchor="middle"`, 세로 자동 중앙 배치
- **hint pills**: `tap ✓` / `hold ✕` (50×16, 56×16, 13px bold)
- **VT 잔상 제거**: exit 시 blank SVG로 모든 패널 원자적 초기화, interactive 상태 진입 시 선제적 VT 종료

#### 인코더 LCD 디자인 일관성

**통일 규칙 확정**:

| 요소 | 규격 |
|------|------|
| Header | 14px bold, `#94a3b8`, `text-anchor="middle" x="100"` |
| Counter | 11px `#475569`, `text-anchor="end" x="190"` |
| Icon (active) | 28px, accent color |
| Icon (disabled) | 22px, `#475569` opacity=0.5 |
| Bar (data) | `x=10 w=180 h=2 rx=1`, track `#1e293b` + fill |
| Bar (decorative) | `x=60 w=80 h=2 rx=1`, accent opacity=0.2 |

**수정 사항**:
- Voice/Response/iTerm: 헤더 LEFT→CENTER 정렬 통일
- iTerm Panel: y=14/11px/#06b6d4 → y=18/14px/#94a3b8
- Response Interactive: bar h=3→2, counter #64748b→#475569
- Response Disabled: icon 28→22px

#### Utility 모드 Icon+Value 분리

**이전**: 타이틀에 emoji 포함 ("🔊 Vol"), value만 독립 표시
**이후**: 깔끔한 영문 타이틀 ("VOL") + icon+value 가운데 그룹 렌더링

| Mode | title | icon | value |
|------|-------|------|-------|
| Volume | VOL | 🔊/🔇 | 50% / Muted |
| Mic | MIC | 🎙 | 80% / Muted |
| Brightness | BRT | ☀️ | 50% |
| Timer | TIMER | ⏱️ | 05:00 |
| Dark Mode | THEME | 🌙/☀️ | Dark / Light |
| Media | MEDIA | ▶/⏸ | (track name) |

Icon+Value 그룹 가운데 정렬:
```typescript
const groupX = Math.round(100 - (iconPx + gap + valPx) / 2);
```

### 핵심 설계 결정

- **translate > viewBox**: SD SVG 렌더러가 non-origin viewBox offset 무시 → translate로 우회
- **헤더 항상 가운데**: 모든 상태·모든 다이얼에서 일관된 시각적 무게중심
- **Icon+Value 그룹 정렬**: 폭 추정(emoji=1em, char≈0.55em) 기반 동적 offset → 자연스러운 간격
- **Space width 보정**: Arial space ≈ 0.28em (기존 0.55em 오류 수정) → 정확한 줄바꿈

### Files

| File | Action |
|------|--------|
| `plugin/src/renderers/voice-renderer.ts` | Modified — wide canvas, adaptive font, center align |
| `plugin/src/renderers/utility-renderer.ts` | Modified — icon+value group, center header, media icon |
| `plugin/src/renderers/response-renderer.ts` | Modified — center header, bar h=2, disabled icon 22px |
| `plugin/src/renderers/iterm-renderer.ts` | Modified — center header, panel header 14px/#94a3b8 |
| `plugin/src/actions/voice-dial.ts` | Modified — pixel scroll, wide canvas VT, atomic exit |
| `plugin/src/actions/utility-dial.ts` | Modified — pass icon field |
| `plugin/src/plugin.ts` | Modified — VT exit before takeover |
| `plugin/src/utility-modes/volume.ts` | Modified — title/icon 분리 |
| `plugin/src/utility-modes/mic.ts` | Modified — title/icon 분리 |
| `plugin/src/utility-modes/brightness.ts` | Modified — title/icon 분리 |
| `plugin/src/utility-modes/timer.ts` | Modified — title/icon 분리 |
| `plugin/src/utility-modes/darkmode.ts` | Modified — title/icon 분리 |
| `plugin/src/utility-modes/media.ts` | Modified — title/icon 분리 |

---

## 2026-02-21 — Encoder LCD 디자인 통일 (SVG Pixmap)

### 문제

Response Dial과 Utility Dial이 JSON layout 기반 렌더링 → Voice Dial의 SVG pixmap 렌더링과 시각적 불일치. JSON layout은 그라데이션, 아이콘 크기, 타이포그래피 제어에 한계가 있어 인코더 간 디자인 일체감이 부족.

### 해결

#### 통일된 디자인 언어

Voice Dial의 SVG pixmap 패턴을 모든 인코더에 적용:
- 배경: `#0f172a` (Deep Navy)
- 헤더: 11px bold `#94a3b8` (기능 라벨)
- 중앙: 주요 콘텐츠 (아이콘 or 값, accent color)
- 하단: 2px accent bar

#### SVG Renderer 분리

| Renderer | File | 용도 |
|----------|------|------|
| response-renderer.ts | `renderers/` | IDLE(prompt), PROCESSING, DISCONNECTED, interactive fallback |
| utility-renderer.ts | `renderers/` | generic mode (vol/mic/timer/brt), media mode (track/artist) |
| voice-renderer.ts | `renderers/` | 원형(reference) — Ready, Recording, Transcribing, Error |
| option-renderer.ts | `renderers/` | Encoder Takeover 패널 (Context/Focus/List) |

#### 공용 Pixmap Layout

모든 인코더가 `voice-layout.json` (200x100 pixmap) 사용 — JSON text/bar 레이아웃 폐기.
Manifest, encoder-takeover exit, voice text takeover exit 모두 통일.

### 핵심 설계 결정

- **JSON layout → SVG pixmap**: 그라데이션, 커스텀 폰트, 아이콘 크기, opacity 제어 가능
- **단일 pixmap layout**: `voice-layout.json` 하나로 모든 인코더 통일 (레이아웃 전환 불필요)
- **Renderer 패턴**: 순수 함수 → SVG 문자열 → `svgToDataUrl()` → `setFeedback({ canvas })`
- **디자인 가이드**: `memory/encoder-lcd-design.md`에 토큰/색상/패턴 문서화

### Files

| File | Action |
|------|--------|
| `plugin/src/renderers/response-renderer.ts` | New |
| `plugin/src/renderers/utility-renderer.ts` | New |
| `plugin/src/actions/option-dial.ts` | Modified (JSON → SVG) |
| `plugin/src/actions/utility-dial.ts` | Modified (JSON → SVG) |
| `plugin/src/encoder-takeover.ts` | Modified (exit restore) |
| `plugin/src/actions/voice-dial.ts` | Modified (vt exit restore) |
| `plugin/bound.../manifest.json` | Modified (layout refs) |

---

## 2026-02-21 — Usage Dashboard 개선 (독립 조회 · 수위 게이지 · 테두리 애니메이션)

### 문제

1. **billingType 미감지로 OAuth 조회 스킵**: billingType은 PTY 세션 배너에서만 감지 → 세션 시작 전엔 'unknown'이라 5h/7d 데이터 없음
2. **슬립/웨이크 후 stale 캐시**: 브릿지가 살아있어도 60초 캐시가 구형 resets_at 시각을 계속 보여줌
3. **세션 없을 때 사용량 미표시**: 브릿지(=claude 세션)가 없으면 플러그인이 아무것도 표시 못함
4. **구독자 Session 페이지**: 0.0K만 보이는 무의미한 페이지
5. **0.2fps 애니메이션**: 브릿지 업데이트 주기(5s)에 묶여 테두리 애니메이션이 뚝뚝 끊김

### 해결책

**브릿지 (`bridge/src/`)**
- `usage-api.ts`: OAuth 응답에서 `inferredBillingType` 추론 — 5h/7d 필드 존재 시 `subscription`, 없으면 `api`
- `state-machine.ts`: `inferBillingType()` 메서드 추가 — PTY 배너 전에도 API 응답으로 billingType 설정 가능
- `index.ts`: billingType 조건 제거(항상 OAuth fetch), `lastApiFetchTime` 추적으로 5분 초과 시 강제 재조회, 60초 주기 갱신 시 실제 broadcast 추가

**플러그인 (`plugin/src/`)**
- `plugin.ts`: 브릿지 `connected` 이벤트 시 즉시 `query_usage` 전송(슬립/웨이크 복구)
- `actions/usage-button.ts`:
  - `fetchStandaloneUsage()` — 브릿지 없이 플러그인이 직접 macOS 키체인 + Anthropic OAuth API 조회 (60초 poll)
  - 구독자 Session 페이지 제거 (`5h → 7d → extra` 만)
  - **수위 게이지 SVG**: 사용률만큼 물이 차오르는 시각적 디스플레이 + 2겹 파도
  - **독립 8fps 애니메이션 타이머**: `setInterval(125ms)` — 데이터 업데이트와 완전히 분리
  - **테두리 스핀**: `State.PROCESSING`일 때만 활성화 — Claude 처리 중에만 테두리가 빠르게 회전 + 글로우
  - 폰트: title 15→18px, sub 13→18px, opacity 강화
  - 레이아웃: 리셋까지 남은 시간을 메인 값으로, `X% · +Y.YK` (처리 중) / `X% · Z.ZK` (누적) / `X% used` (세션 없음) subtitle

### 핵심 설계 결정

- **isActive 감지**: `tokenDelta > 500` (불안정) → `currentState === State.PROCESSING` (정확)
- **독립 렌더 루프**: 8fps 타이머가 `borderFrame` / `waveFrameFine` 전진 → 데이터와 애니메이션 완전 분리
- **수위 의미**: 사용률 높을수록 물 차오름 (위험 시 꽉 참), 색상 green→yellow→red 연동

### Commits

| Hash | Message |
|------|---------|
| `db1153e` | feat: encoder takeover, option navigation, utility dial modes, usage overhaul |

---

## 2026-02-21 — Utility Dial (Multi-Mode Encoder for E1)

### 문제

E1 슬롯이 다른 플러그인(시스템 볼륨 등)으로 점유되어 있으면 AgentDeck의 encoder takeover 시 접근 불가. 자체 Utility Dial 액션을 만들어 E1을 AgentDeck 소속으로 가져와야 함.

### 해결

#### UtilityMode 인터페이스 패턴

- `plugin/src/utility-modes/types.ts`에 공통 인터페이스 정의
- 각 모드는 `id`, `label`, `onRotate`, `onPush`, `getFeedback`, 선택적 `onActivate`/`onDeactivate` 구현
- `plugin/src/utility-modes/index.ts`에서 factory (`createModes()`) + 레지스트리

#### macOS 시스템 API (osascript 래퍼)

- `plugin/src/utility-modes/macos.ts` — `execFile('osascript', ['-e', script])` (no shell)
- 채널별 debounce (`debouncedExec(key, script, delayMs)`) — 빠른 다이얼 회전 시 과다 호출 방지
- Volume/Mic: `get volume settings` 파싱, `set volume output/input volume N`
- Brightness: System Events `key code 144/145` — debounce 미적용 (개별 step)
- Media: Spotify/Music 자동 감지 (`getRunningPlayer()`), playpause/next/previous/track info
- Dark Mode: appearance preferences get/toggle
- Notification: `display notification` with sound

#### 6개 모드 구현

| Mode | File | Rotate | Push |
|------|------|--------|------|
| Volume | volume.ts | 출력 볼륨 ±5 | 음소거 토글 |
| Brightness | brightness.ts | 밝기 ±1 step | 최소 밝기 토글 |
| Mic | mic.ts | 입력 볼륨 ±5 | 마이크 음소거 |
| Media | media.ts | 볼륨 ±5 | 재생/일시정지 |
| Timer | timer.ts | 시간 ±5분 | 시작/일시정지/리셋 |
| Dark Mode | darkmode.ts | 없음 | 다크모드 토글 |

#### 모드 라이프사이클: onPause / onResume

모드 전환 시 비활성 모드의 타이머/폴링이 계속 돌아가는 리소스 낭비 문제를 해결하기 위해 `onPause`/`onResume` 훅을 도입.

| 훅 | 호출 시점 | 목적 |
|---|---|---|
| `onActivate` | 최초 진입 (rebuildModes) | 초기 상태 로드 + 타이머 시작 |
| `onPause` | 다른 모드로 전환 (onTouchTap) | 타이머/폴링 중지, 상태 보존 |
| `onResume` | 이 모드로 복귀 (onTouchTap) | 상태 재조회 + 타이머 재시작 |
| `onDeactivate` | 완전 정리 (rebuildModes, onWillDisappear) | 전부 해제, 상태 초기화 |

`onTouchTap` 흐름: `prev.onPause()` → `activeIndex++` → `next.onResume() ?? next.onActivate()`

#### 시스템 볼륨/마이크 동기화 (osascript 폴링)

외부에서 시스템 볼륨/마이크를 변경했을 때 Stream Deck에 반영되지 않는 문제.
macOS Core Audio 이벤트 구독은 네이티브 애드온 필요 → 배포 복잡도 증가로 기각.

**구현 (volume.ts, mic.ts)**:
- 2초 간격 `osascript "get volume settings"` 폴링 (활성 모드일 때만)
- `polling` 가드 — async 중첩 방지 (osascript 지연 시 동시 실행 차단)
- `startPolling()` — 항상 기존 타이머 제거 후 새로 생성 (타이머 누적 방지)
- `lastActionAt` + `SKIP_AFTER_ACTION(3s)` — 사용자 다이얼 조작 직후 폴링 스킵 (자기 변경 덮어쓰기 방지)
- 값 변경 감지 시에만 `refresh()` 호출 (불필요한 LCD 갱신 방지)

**시스템 부담**: 2초당 1회 execFile('osascript') — CPU 0.1% 미만, 일시 메모리 ~2MB (즉시 해제). 메모리 누수 없음.

#### 4-Encoder Takeover 모드

- `encoder-takeover.ts` 전면 재작성
- `has4Encoders()`: utilityIds 존재 여부로 3/4-encoder 모드 분기
- 4-enc: E1(utility)→Context, E2(option)→Focus, E3(command)→List p1, E4(voice)→List p2
- 3-enc: 기존 동작 유지 (backward compatible)

#### Property Inspector

- `utility-dial-pi.html`: enabledModes 체크박스, timerMinutes, volumeStep 설정
- PI 설정값은 문자열로 도착 → `numSetting()` 파서로 안전 변환

### 디버깅: Layout Overlap 무성 실패

- **증상**: E1 터치/회전/푸시 시 아무 반응 없음. 플러그인 로그도 없음.
- **원인**: `utility-layout.json`의 `title` rect [4,2,140,18]과 `mode-dots` rect [120,2,76,18]이 x=120-144에서 겹침
- **Stream Deck SDK 동작**: 레이아웃 요소가 겹치면 **전체 레이아웃 인스턴스화 거부** → 이벤트 라우팅도 차단. 플러그인 코드에 에러 없음.
- **진단 경로**: SDK 타입 확인 → 빌드 출력 확인 → `~/Library/Logs/ElgatoStreamDeck/StreamDeck.1.json` 시스템 로그에서 발견
- **교훈**: SD SDK 레이아웃은 요소 간 rect 겹침이 절대 불가. 시스템 로그(`StreamDeck.*.json`)가 유일한 진단 경로.
- **수정**: title=[8,0,120,18], mode-dots=[130,2,62,16]로 간격 확보

### Files

| File | Action |
|------|--------|
| `plugin/src/utility-modes/*.ts` (8 files) | New |
| `plugin/src/actions/utility-dial.ts` | New |
| `plugin/bound.../layouts/utility-layout.json` | New |
| `plugin/bound.../ui/utility-dial-pi.html` | New |
| `plugin/bound.../manifest.json` | Modified |
| `plugin/src/encoder-registry.ts` | Modified |
| `plugin/src/encoder-takeover.ts` | Rewritten |
| `plugin/src/plugin.ts` | Modified |

### Commits

| Hash | Message |
|------|---------|
| (unstaged) | feat: utility dial — multi-mode encoder with 6 macOS utility modes |

---

## 2026-02-22 — iTerm Dial "No sessions" 순간 깜빡임 수정

### 문제

가끔 "No sessions"가 순간적으로 표시됨. 두 가지 원인:

1. **`updateItermDialState`가 매 state 업데이트마다 `currentLayout = ''` 리셋**
   → `ensurePixmapLayout()`이 항상 `setFeedbackLayout` 호출
   → SD 하드웨어가 레이아웃 전환 중 순간 클리어 → 빈 화면/No sessions 플래시

2. **`onWillAppear`에서 sessions 없는 상태로 즉시 render**
   → "No sessions" 첫 프레임 표시 후 fetch 완료 시 업데이트

### 수정

- `updateItermDialState`에서 `currentLayout = ''` 제거 — state 변경이 레이아웃을 바꾸지 않음
- `resetItermLayout()` 함수 추가 — encoder takeover exit 시에만 명시적 호출
- `encoder-takeover.ts` exit에서 `resetItermLayout()` 연결 (`resetEncoderLayouts()` 직후)
- `onWillAppear`: sessions 캐시 있으면 즉시 표시, 없으면 fetch 완료 후에만 render

### 핵심 패턴

레이아웃 리셋은 실제로 레이아웃이 변경되는 시점(takeover enter/exit)에만 수행해야 함. 일반 state 업데이트에서 레이아웃을 리셋하면 SD 하드웨어가 불필요한 레이아웃 전환을 수행해 깜빡임 발생.

### Files

| File | Action |
|------|--------|
| `plugin/src/actions/iterm-dial.ts` | Modified — currentLayout 리셋 제거, resetItermLayout 추가, onWillAppear 플래시 수정 |
| `plugin/src/encoder-takeover.ts` | Modified — resetItermLayout 연결 |

---

## 2026-02-22 — iTerm Dial 버그 수정 (세션 목록 · 이름 개선 · 탭 전환)

### 문제 1: No sessions — AppleScript `index of t` 에러

`index of t` (탭 속성 직접 조회)가 iTerm2에서 `-1728` 에러를 던짐 → `catch` 블록이 빈 배열 반환 → "No sessions" 표시.

**수정**: 루프 내 수동 카운터 `ti`로 교체.

### 문제 2: tmux 세션명 미표시 — PATH 제한

플러그인은 제한된 PATH로 실행 → `execFile('tmux', ...)` 가 바이너리를 못 찾아 `catch` → tmuxMap 빈 상태 → "tmux (tmux)" 원본 표시.

**수정**: 절대경로 폴백 리스트 `['/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/bin/tmux']` 순서로 시도.

### 문제 3: `tty of s` → `missing value` 문자열 연결 에러

일부 세션(node 프로세스 등)에서 `tty of s`가 `missing value` 반환 → 문자열 concatenation 실패 → 전체 AppleScript 에러.

**수정**: `try/on error` 블록으로 tty 안전 추출, 실패 시 빈 문자열 사용.

### 문제 4: `set current tab of w` — `-10000` 에러

탭 전환 AppleScript에서 `set current tab of w to item N of tabs of w`가 AppleEvent 구조 실패.

**수정**: `select item N of tabs of w` 로 변경 (직접 동작 확인).

### 세션 이름 개선

iTerm2 세션 이름이 길고 난잡한 문제 (e.g. `✳ Task Failure Analysis (sourcekit-lsp)`):

| 이름 유형 | 변환 결과 |
|-----------|-----------|
| tmux 탭 (tty 매칭) | tmux 세션명 (e.g. `ViewLingo`) |
| `✳ Task Failure Analysis (sourcekit-lsp)` | `Task Failure Analysis` |
| `..thub/AgentDeck (-zsh)` | `AgentDeck` |

**로직**: tty → tmuxMap 매칭 → 실패 시 앞 이모지 제거 + `(process)` 제거 + 경로면 마지막 폴더명 추출.

### 세션 이름 멀티라인 렌더링

긴 이름을 잘라내는 대신 2~3줄로 표시:
- 14자 이하: 16px 1줄
- 15~40자: 14px 2줄
- 41자+: 14px 3줄 (단어 단위 줄바꿈, 초과 시 강제 분리)
- 줄 수에 따라 수직 중앙 정렬 자동 계산

### 기타: VT_COMPACT_FONT_SIZE / VT_COMPACT_LINE_HEIGHT 누락 상수 추가

`voice-renderer.ts`에서 사용하되 선언되지 않은 상수 추가 → 빌드 경고 제거.

### Files

| File | Action |
|------|--------|
| `plugin/src/utility-modes/macos.ts` | Modified — tty 안전 추출, tmux 절대경로 폴백, 이름 파싱, 탭 전환 fix |
| `plugin/src/renderers/iterm-renderer.ts` | Modified — 멀티라인 wrapText, 수직 중앙 정렬 |
| `plugin/src/renderers/voice-renderer.ts` | Modified — VT_COMPACT_FONT_SIZE / VT_COMPACT_LINE_HEIGHT 추가 |

### 핵심 설계 결정

- **tmux 절대경로**: Stream Deck 플러그인 환경에서 PATH가 제한됨 → 시스템 바이너리는 절대경로 사용 필수
- **tty 매핑**: iTerm2 세션 tty ↔ `tmux list-clients` tty로 tmux 세션명 해결
- **SVG 멀티라인**: `<text>` 요소 복수 배치로 구현 (SVG `textLength`/`foreignObject` 불사용)

---

## 2026-02-22 — Response Dial 통합 (Option Selector + Quick Prompt → 단일 인코더)

### 문제

E2(Option Selector)는 선택지가 없는 IDLE 상태에서 "Ready"만 표시 — 슬롯 낭비. E3(Quick Prompt)는 IDLE에서 프롬프트 전송 + 선택지 있을 때 takeover List 뷰 표시. 두 다이얼이 rotate=탐색/push=확정이라는 동일 UX 패턴을 상황에 따라 다르게 쓸 뿐이라 인코더 슬롯 낭비.

### 해결

**Response Dial** (`option-dial` UUID 유지):
- IDLE: rotate → 프롬프트 목록 순환, push → 선택된 프롬프트 전송
- Interactive (AWAITING_OPTION/PERMISSION/DIFF): rotate → 옵션 스크롤, push → 선택 확정
- PI 설정(`response-dial-pi.html`)으로 커스텀 프롬프트 목록 지원

**Takeover 패널 재편** (E3 슬롯 해제):

| 슬롯 | 평소 | Takeover 중 |
|------|------|-------------|
| E1 (Utility) | Utility | Context (상태·툴·질문) |
| E2 (Response Dial) | Prompt 목록 | Focus (선택 옵션, 대형 폰트) |
| E4 (Voice) | Voice | List (옵션 목록, 스크롤) |

voiceIds가 기존 Detail 패널 역할 대신 List 패널을 담당 → 3패널 경험 유지.

**렌더링 개선** (option-renderer.ts):
- Focus 패널: 옵션 이름 24px (기존 16-20px), sub 13px, position counter 제거
- List 패널: 행 폰트 15px, 행 높이 22px, 배지 제거 (색상으로만 구분)
- Context 패널: 툴 라벨 18px bold, 질문 텍스트 13px, hint 텍스트 제거

### 핵심 설계 결정

- **UUID 유지**: `bound.serendipity.agentdeck.option-dial` — 배포 후 변경 불가, 기능만 확장
- **단일 다이얼 이중 모드**: `isInteractive()` 분기로 IDLE/interactive 동작 전환
- **voiceIds → List**: Detail 패널 폐기, List가 더 유용 (전체 옵션 목록 스크롤)
- **배지 제거 from List**: Focus에만 유지, List는 row 배경색으로 구분

### Files

| File | Action |
|------|--------|
| `plugin/src/actions/option-dial.ts` | Modified — IDLE prompt 순환·전송 추가, class → ResponseDialAction |
| `plugin/src/actions/command-dial.ts` | **Deleted** |
| `plugin/src/encoder-registry.ts` | Modified — commandIds 제거 |
| `plugin/src/encoder-takeover.ts` | Modified — voiceIds → List 패널, commandIds 참조 제거 |
| `plugin/src/plugin.ts` | Modified — CommandDialAction 제거 |
| `plugin/src/renderers/option-renderer.ts` | Modified — 폰트 증가, hint 제거, List 배지 제거 |
| `plugin/bound.../manifest.json` | Modified — "Quick Prompt" 제거, "Response Dial" 이름 변경 |
| `plugin/bound.../ui/response-dial-pi.html` | New |
| `plugin/bound.../ui/command-dial-pi.html` | **Deleted** |

---

## 2026-02-21 — Mode Detection, STOP/ESC Split, Parser Robustness

### 문제

1. **DEFAULT 모드 미감지**: Mode 버튼으로 Accept → Default 전환 시 Claude Code가 `? for shortcuts` 배너를 출력하지만, 파서가 이를 감지하지 못해 디스플레이가 ACCEPT에 머물러 PLAN ↔ ACCEPT만 순환
2. **800ms 디바운스 과도**: 빠른 버튼 입력이 드롭됨
3. **MODEL_INFO 미감지**: ANSI 스트립 후 `Opus4.6·ClaudeMax`처럼 공백 없이 합쳐져 정규식 매칭 실패
4. **STOP 버튼 AWAITING 상태 비활성화**: IDLE → AWAITING_* 전환 규칙 미정의로 상태 전환 블록
5. **`/model` 옵션 목록 미감지**: ANSI 스트립 후 `2.Sonnet`, `❯3.Haiku`처럼 공백 소실로 OPTION_NUMBERED 매칭 실패

### 해결

#### DEFAULT 모드 감지 (output-parser.ts)
- `MODE_DEFAULT = /\?\s*for\s*shortcuts/` 패턴 추가
- `parseModeSwitchLine()`에서 `pendingModeSwitch && MODE_DEFAULT` 시 즉시 `mode_change: default` emit
- 타임아웃 fallback: 2초 내 배너 미감지 시에도 default emit

#### 디바운스 축소 (index.ts)
- 800ms → 100ms (PTY 응답 ~10ms이므로 충분)

#### ANSI 스트립 공백 소실 대응 (output-parser.ts)
- `MODEL_INFO`: `\s+` → `\s*` (모델명 매칭)
- `OPTION_NUMBERED`: `\s+` → `\s*` (옵션 목록 매칭)
- `parseOptions()`: 동일하게 `\s*` 적용

#### STOP/ESC 분리 (stop-button.ts, protocol.ts, index.ts)
- `EscapeCommand` 프로토콜 타입 추가
- PROCESSING → 빨간 STOP (Ctrl+C), AWAITING_* → 주황 ESC (Esc 키)
- Bridge에서 `escape` 커맨드 → PTY에 `\x1b` 전송

#### IDLE → AWAITING_* 전환 허용 (states.ts)
- spinner 없이 바로 permission/option/diff prompt가 오는 경우 대응
- 테스트 업데이트: `IDLE → AWAITING_PERMISSION` 허용으로 변경

#### Mode 아이콘 교체 (generate-icons.mjs)
- gear(⚙️) → cycle arrows(🔄) — "모드 순환" 의미 전달

### 커밋

| Hash | Message |
|------|---------|
| `8e16a22` | fix: detect DEFAULT mode banner and reduce mode switch debounce |
| `234b356` | fix: MODEL_INFO regex tolerates stripped spaces in startup banner |
| (unstaged) | feat: STOP/ESC split, IDLE→AWAITING transitions, option detection fix |

---

## 2026-02-21 — Billing-Aware Usage Display

### 문제

Usage 정보 체계가 subscription(Claude Max)과 API(pay-per-use) 사용자를 구분하지 않음:
- **Subscription**: OAuth API로 5h/7d rate limit 조회 가능. 토큰 단위 과금 없음.
- **API**: OAuth 토큰 없음 → 5h/7d 페이지가 항상 "--". PTY에서 파싱한 session 데이터만 유의미.
- `/cost` 명령어는 Claude Code에 존재하지 않아 실행 시 오류 발생.

### 해결

#### billingType 프로토콜 추가

- `BillingType = 'subscription' | 'api' | 'unknown'` 타입 신규 정의
- `StateUpdateEvent`, `StateSnapshot`에 `billingType` 필드 추가
- **Files**: `shared/src/protocol.ts`, `shared/src/states.ts`

#### Bridge — billingType 감지 및 전파

- `StateMachine`이 `model_info` 파서 이벤트의 `plan` 값으로 판별:
  - `plan`에 "Max" 포함 → `'subscription'`
  - `plan`에 "api" 포함 → `'api'`
  - 그 외 → `'unknown'` (기본값)
- state broadcast, 클라이언트 초기 연결, 스냅샷 모두에 billingType 포함
- `billingType === 'api'`이면 OAuth `fetchUsageFromApi()` 호출 전면 스킵 (on-demand, on-connect, 주기적 refresh)
- **Files**: `bridge/src/state-machine.ts`, `bridge/src/index.ts`, `bridge/src/types.ts`

#### Plugin — 조건부 페이지 표시

- `getPages()`가 billingType 기반 분기:
  - `'api'`: `['session']`만 (5h/7d/extra 무의미)
  - `'subscription'` / `'unknown'`: 기존대로 5h → 7d → extra → session
- **Files**: `plugin/src/plugin.ts`, `plugin/src/actions/usage-button.ts`

#### Quick Command 수정

- `/cost` → `/usage` 교체 (존재하지 않는 명령 제거)
- **File**: `plugin/src/actions/command-dial.ts`

### 테스트

- billingType 감지 테스트 9건 추가 (64 tests / 3 suites)
  - default unknown, subscription 감지 (case-insensitive), api 감지 (case-insensitive)
  - 미인식 plan, plan 미제공, 후속 model_info에서 billingType 유지, state_changed 이벤트 포함 확인
- **File**: `bridge/src/__tests__/state-machine.test.ts`

### Commits

| Hash | Message |
|------|---------|
| `29480bf` | feat: billing-aware usage display and /cost → /usage fix |
| `df12264` | test: add billingType detection tests for state machine |

---

## 2026-02-21 — 초기 코드 리뷰 및 버그 수정

### SDK 레퍼런스 정리

- Elgato Stream Deck SDK v2 공식 문서(docs.elgato.com)와 plugin-samples(GitHub) 전수 학습
- 핵심 내용을 `memory/streamdeck-sdk.md`에 정리 (manifest 스키마, 6개 built-in 레이아웃, 레이아웃 아이템 타입, API 메서드)
- `CLAUDE.md`에 References 섹션 추가

### 버그 수정 (5건)

#### 🔴 `response-button.ts` — `onWillDisappear` arguments 버그
- **Problem**: `onWillDisappear()` 파라미터 없이 `arguments[0]?.action?.id` 접근 → 항상 `undefined`
- **Effect**: 버튼이 사라져도 `contexts` 배열에서 제거 안 됨 → stale 항목 누적, ghost 렌더 시도
- **Fix**: `onWillDisappear(ev: WillDisappearEvent)` 파라미터 추가, `ev.action.id` 사용
- **Why**: TypeScript class method는 `arguments` 객체를 가지지 않음 (strict mode에서 undefined)

#### 🟡 `session-button.ts` — IDLE 상태 렌더마다 동기 파일 I/O
- **Problem**: `renderSessionSvg()`의 `IDLE` case에서 `readFileSync`로 sessions.json 읽음
  - `updateSessionButton()`이 호출될 때마다 (5초 usage 틱 포함) 파일 I/O 발생
- **Fix**: `updateSessionButton()`에서 IDLE 상태 전환 시(`!wasIdle`) 1회만 로드
- **Why**: 세션 목록은 cycle/reconnect 시점에만 바뀜. 렌더마다 읽을 필요 없음

#### 🟡 `pty-manager.ts` — `write()` throw → 브리지 crash 가능
- **Problem**: PTY 종료 후 플러그인 명령 도착 시 `throw new Error` → 브리지 프로세스 crash
- **Fix**: `debug log + return` (graceful drop)
- **Why**: PTY exit과 WS message 수신 사이 race condition은 정상적으로 발생 가능

#### 🟠 `output-parser.ts` — SPINNER_CHARS에 브라유 점자 포함
- **Problem**: `/[✢✳✶✻✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/` — 브라유 10자는 npm/yarn 등 다른 CLI 스피너
  - Claude Code 스피너는 `✢✳✶✻✽` 5자만 사용 (PTY 디버그 출력으로 확인)
- **Fix**: 브라유 제거, Claude Code 전용 5자만 유지
- **Why**: 잘못된 chars가 매칭되면 실제로 오동작하지 않지만, 의미상 오류이며 미래 혼동 방지

#### ⚪ `layout-manager.ts` — `STOP_BUTTON`/`STOP_DIM` 데드코드
- **Problem**: v2에서 넘어온 상수 — v3에서 STOP은 독립 `stop-button.ts`가 담당
- **Fix**: 두 상수 삭제

---

## 2026-02-21 — 프로젝트 리브랜딩 (AgentDeck)

### 앱 이름 확정: AgentDeck

- **Decision**: 프로젝트명 `StreamDeck-Claude` → `AgentDeck`
- **Why**: 마켓플레이스 배포를 고려했을 때 Anthropic 공식 앱처럼 보이지 않아야 함. AgentDeck은 독자적 제품명.
- **Scope**: 폴더명, GitHub 레포, package.json 이름, README/CLAUDE.md, 스크립트 출력 문자열

### Plugin UUID 확정: `bound.serendipity.agentdeck`

- **Initial**: `com.anthropic.claude-code` → (1차) `bound.serendipity.claude-code` → (최종) `bound.serendipity.agentdeck`
- **Why**: UUID는 Stream Deck 생태계의 영구 식별자. 공개 배포 전에 제품명과 일치시키는 것이 필수. 이후 변경 불가(기존 유저 프로필 파손).
- **Scope**: `manifest.json`, 8개 action `@action({ UUID })`, `rollup.config.mjs`, `tsconfig.json`, `scripts/`, sdPlugin 디렉터리명

### pnpm 패키지 스코프 확정: `@agentdeck/`

- **Initial**: `@streamdeck-claude/shared`, `@streamdeck-claude/bridge` 등
- **Final**: `@agentdeck/shared`, `@agentdeck/bridge`, `@agentdeck/plugin`, `@agentdeck/hooks`
- **Why**: 패키지명이 앱명과 일치해야 빌드 출력과 로그가 명확해짐
- **Scope**: 5개 `package.json`, 모든 TS import 경로, `pnpm-lock.yaml` 재생성

### 사용자 데이터 디렉터리

- **Initial**: `~/.streamdeck-claude/sessions.json`
- **Final**: `~/.agentdeck/sessions.json`
- **Files**: `bridge/src/session-registry.ts`, `plugin/src/actions/session-button.ts`

### GitHub 레포 생성

- URL: https://github.com/puritysb/AgentDeck
- 로컬 폴더: `/Users/puritysb/github/AgentDeck`

---

## 2026-02-21 — Hook 포트 동적 해석 + 연결 안정성 강화

### 🔴 Hook 포트 하드코딩 버그 수정 (Critical)

- **Problem**: Claude Code hooks가 `localhost:9120`으로 하드코딩됨. 2개 이상 세션 동시 실행 시 2번째 세션의 hooks가 잘못된 브리지(9120)로 POST → 상태 추적 완전히 깨짐
- **Fix**: hook 명령을 `localhost:${AGENTDECK_PORT:-9120}`으로 변경. 브리지가 Claude 프로세스 spawn 시 `AGENTDECK_PORT` 환경변수 주입
- **Files**: `hooks/src/install.ts`, `bridge/src/pty-manager.ts` (extraEnv 파라미터), `bridge/src/index.ts` (env 전달)
- **Migration**: install/uninstall 필터가 old(`localhost:9120`)와 new(`AGENTDECK_PORT`) 패턴 모두 매칭

### Hook 자동 마이그레이션

- **Problem**: 기존 사용자가 `git pull && pnpm build` 후 hooks를 수동 재설치해야 하는 상황
- **Fix**: 브리지 시작 시 `settings.local.json`을 읽어 old-format hooks 감지 → 자동으로 env var 포맷으로 in-place 마이그레이션
- **Files**: `bridge/src/index.ts` (`migrateHooksIfNeeded()`)

### TCP 포트 프로브

- **Problem**: `findAvailablePort()`가 `sessions.json` 레지스트리만 확인. 외부 프로세스가 포트 점유 시 충돌
- **Fix**: `net.createServer()`로 실제 TCP 바인드 시도하여 포트 가용성 검증. 함수를 async로 변환
- **Files**: `bridge/src/session-registry.ts` (`isPortFree()`, `findAvailablePort()` async화), `bridge/src/index.ts` (await 추가)

### State Machine 안정성 강화

- **Stuck timeout**: PROCESSING, AWAITING_PERMISSION, AWAITING_OPTION, AWAITING_DIFF 상태에서 5분간 변화 없으면 자동으로 IDLE 복구
- **Strict transitions**: 유효하지 않은 전환은 log + skip (기존: log + 실행). `transitions` 테이블에 없는 전환 차단
- **Files**: `bridge/src/state-machine.ts`, `shared/src/states.ts` (stuck_timeout 전환 추가)

### Graceful Shutdown on Crash

- **Problem**: `uncaughtException`/`unhandledRejection` 시 세션이 `sessions.json`에 stale 잔류
- **Fix**: 두 핸들러에서 `shutdown()` 호출 → 세션 정상 해제
- **Files**: `bridge/src/index.ts`

### Session Registry 강화

- **24h TTL**: `pruneDeadSessions()`에서 PID alive 체크 외에 24시간 초과 세션도 제거 (PID 재사용 방어)
- **Atomic write**: `writeSessions()`가 임시 파일에 쓴 뒤 `renameSync()`로 원자적 교체. 동시 쓰기 시 파일 손상 방지
- **Files**: `bridge/src/session-registry.ts`

### 유닛 테스트 도입

- **Framework**: vitest (workspace root)
- **55 tests / 3 suites**:
  - `state-machine.test.ts` (30): 전환, strict validation, 모든 active 상태 stuck timeout, parser events, snapshot
  - `session-registry.test.ts` (11): pruning (dead PID, 24h TTL), port allocation, atomic write
  - `install.test.ts` (14): install/uninstall, 멱등성, old-format migration, non-AgentDeck hook 보존
- **Run**: `pnpm test`

### README 리브랜딩

- 한국어 → 영어 전면 재작성
- 브랜드 보이스 ("Stop Chatting. Start Steering."), 아키텍처 다이어그램, 기능 테이블, v3 레이아웃, 멀티에이전트 로드맵 섹션

### Commits

| Hash | Message |
|------|---------|
| `3a42ef0` | fix: dynamic hook port resolution for multi-session support |
| `1530ed9` | fix: auto-migrate old hooks + TCP port probe for findAvailablePort |
| `46fafcd` | docs: rewrite README for AgentDeck rebrand |
| `2e250a5` | fix: AWAITING_* stuck timeout + atomic sessions.json writes |
| `48aea1e` | test: add unit tests for state machine, session registry, and hooks |

## 2026-02-23 — File path patterns creating ghost options in permission parser

### 문제
`Read(/tmp/.../D_01.png)` 같은 파일 경로가 permission prompt에 포함될 때, normalization regex가 `_01.png)`를 `\n01.png)`로 분리하여 ghost option(index 0, label `png)`)을 생성. 이로 인해 실제 "Yes" 옵션이 덮어쓰여 `1. png)`, `2. No`만 표시되는 현상.

### 해결
1. **Normalization regex 강화**: `(?!\d)` → `(?![a-z\d])` — 소문자 파일 확장자 뒤에서 split 방지
2. **Extraction-level defense**: `^[a-z]{1,10}\)$` 패턴의 label(파일 확장자 아티팩트) skip

### 교훈
- 파서 regex는 "숫자+점" 패턴이 option 번호인지 파일 경로의 일부인지 구분해야 함
- 다층 방어(normalization + extraction)가 안전 — 한 계층이 놓치면 다른 계층이 잡음

## 2026-02-24 — Ghost text 감지 3중 버그 수정

### 문제
`sdc` 시작 시 초기 suggestion(`❯ Try "..."`)이 Stream Deck에 표시되지 않음. 또한 suggest 실행 → ESC 인터럽트 시 `Interrupted · What should Claude do instead?` 메시지가 suggest로 오인됨.

### 해결
**3가지 버그, 3가지 수정:**
1. **호출 순서**: `processFeed()`에서 `detectGhostText`를 `detectPatterns` 뒤로 이동 — `seenFirstIdle` 플래그 의존성 해결
2. **cursor-forward 처리**: Strategy 1의 `stripAnsi(rawData)`를 `stripAnsi(rawData.replace(/\x1b\[\d*C/g, ' '))`로 변경 — Claude TUI가 단어 사이에 cursor-forward를 사용하므로 공백 대체 필요 (`Try"how...` → `Try "how...`로 regex 매칭 가능)
3. **SGR 2 (dim) 인식**: `hasGrayForeground()`에 SGR 2 체크 추가 — Claude Code v2.1.50이 ghost text에 `\x1b[2m` (dim/faint) 사용
4. **인터럽트 오인 방지**: Strategy 3 cross-chunk에서 `⎿` (출력 fence) 포함 청크 제외 + `scheduleSuggestion`에 `Interrupted` 필터

### 교훈
- `detectGhostText`의 `clean = stripAnsi(rawData)`는 `processFeed`의 `clean = stripAnsi(spaced)`와 다르게 cursor-forward 처리 없이 쓰고 있었음 — 일관성 주의
- Claude Code TUI의 ANSI 렌더링은 버전마다 바뀔 수 있음 (SGR 90 → SGR 2). 감지 로직은 여러 SGR 변형을 허용해야
- cross-chunk 감지(Strategy 3)는 편의성 vs 오탐 트레이드오프 — `⎿` 같은 구조적 마커로 경계를 정확히 해야

## 2026-02-24 — OpenClaw 타임라인 패널 + 유틸리티 버튼

### 문제
OC 모드에서 E2(Option) = `['continue']`만, E3(iTerm) = Disabled, Response 버튼 4개 = DIM — 화면 자원 낭비.

### 해결
**Part A — 타임라인 패널 (E2+E3 합체)**:
1. `timeline-store.ts`: 싱글톤 이벤트 스토어. GroupedEntry(연속 중복 60s 내 병합), scheduled entries 지원, `~/.agentdeck/timeline.json` 디스크 영속 (lazy load + debounced save 500ms), `mergeHistory()` 오프라인 이벤트 복구
2. `timeline-renderer.ts`: 400px 와이드 SVG fisheye 렌더. font size lerp(15→10px), opacity lerp(1.0→0.3), `smartSummary()`로 경로 축약, detail mode word-wrap
3. `gateway-client.ts`: 이벤트 수집 (chat/exec.approval → timeline), `summarize()` RPC, `fetchHistory()` 재연결 시 오프라인 이벤트 복구, `fetchScheduled()` 미래 작업
4. `option-dial.ts` + `iterm-dial.ts`: OC 모드 분기 — timeline left/right 패널, scroll/push/detail 매핑

**Part B — Response 버튼 유틸리티 프리셋**: GATEWAY(`open:gateway_web` → 브라우저), GO ON(`command:continue`) + DIM×2

### 교훈 / 핵심 설계 결정
- **싱글톤 패턴**: timeline-store를 gateway-client(producer)와 dial actions(consumer)가 공유 — 순환 의존 방지
- **Grouped scroll**: 스크롤 인덱스를 raw entries가 아닌 GroupedEntry[] 위에서 운용 — 중복 이벤트 N개가 한 칸으로 보임
- **디스크 영속 + 히스토리 머지**: lazy load(`ensureLoaded`) + `mergeHistory`(ts:type:raw 복합키 dedup) — 플러그인 재시작/오프라인 복구
- **헤더 일관성**: 모든 encoder LCD 헤더는 `x=100, y=18, text-anchor=middle, 14px bold, #94a3b8` 준수 — 400px 와이드 캔버스에서도 E2 패널 내 가운데 정렬
- **Interactive 우선**: OC AWAITING_PERMISSION 등 interactive 상태에서는 타임라인이 아닌 기존 option/permission UI 표시

## 2026-03-19 — Daemon 모드 테트라/버블 미표시 버그 + SICK 상태 통일

### 문제
Daemon 모드에서 OpenClaw 비활성화 상태로 Claude Code 작업 시, 문어는 정상 수영하지만 네온테트라와 버블이 전혀 표시되지 않음 (Android 태블릿 + E-ink 모두).

### 원인
`toTerrariumState()`에서 `tetra`와 `environment`가 top-level `agentState`에만 의존. Daemon은 자체 PTY가 없어 StateMachine이 항상 `DISCONNECTED` → `tetra=ABSENT` (물고기 미표시), `environment=DARK` (버블 스폰 간격 MAX_VALUE). 반면 문어는 `sessions_list`의 sibling 개별 상태로 독립 렌더되어 정상.

### 해결
- Android/Apple `toTerrariumState()`: `isDaemonLike` 감지 후 `effectiveAgentState`를 sibling sessions 중 가장 활동적인 상태에서 도출 (fallback: IDLE)
- `mostActiveSessionState()` 헬퍼: sibling session state string → AgentState 매핑, ordinal/priority 비교

### 추가 수정 (SICK 상태 통일)
- Apple `lerpColor`: `return a // fallback` → `Color.resolve(in:)` 기반 실제 RGB 보간. `TerrariumConfig.lerpColor()` 공유 유틸리티
- TUI: crayfish SICK dim 색상 + `⚠` name tag, renderer에 gateway error 경고
- Plugin: OC 세션 버튼 `gatewayHasError` 시 빨간색 배경 + 경고 표시

### 교훈
- Daemon hub 아키텍처에서 daemon 자신의 state(`DISCONNECTED`)와 relay되는 session state는 완전히 다른 차원 — 환경/물고기 같은 "전체 분위기" 요소는 aggregate state에서 파생해야 함
- `isDaemonLike` 패턴 (CLAUDE.md에 이미 기술됨)은 렌더링뿐 아니라 상태 매핑에서도 일관되게 적용 필요

## 2026-03-23 — ESP32 USB 분리 시 Daemon 크래시 수정

### 문제
ESP32 USB 시리얼 기기를 물리적으로 분리하면 daemon이 즉시 크래시. `daemon-crash.log` 미생성, `daemon-stderr.log`에 에러 없음.

### 원인 (3가지 버그)
1. **reader.on('error')가 conn.connected = false 미설정** — USB 분리 후에도 heartbeat(5초)가 죽은 stream에 계속 write 시도
2. **reader.on('close')도 conn.connected 미설정** — reader만 null 처리, connection은 살아있다고 간주
3. **uncaughtException에서 ENXIO/EIO/EBADF 미면제** — macOS USB 분리 시 발생하는 전형적 에러 코드인데 daemon shutdown 트리거

### 해결
- `esp32-serial.ts`: reader error/close → `conn.connected = false` + 양방향 stream 정리
- `esp32-serial.ts`: `sendToConnection()`에 `stream.destroyed`/`writable` 가드 추가
- `bridge-core.ts`: uncaughtException 면제 목록에 `ENXIO`/`EIO`/`EBADF` 추가

### 교훈
- `createReadStream`/`createWriteStream`으로 디바이스 파일 열 때, read 에러가 먼저 발생하므로 reader 에러 핸들러에서 반드시 connection 상태를 false로 전환해야 heartbeat write 차단 가능
- Defense-in-depth: stream 레벨 가드 + uncaughtException 면제 — 어느 한쪽이 빠져도 daemon 생존

## 2026-03-19 — ESP32 3대 펌웨어 배포 및 시리얼 통신 복구

### 문제
ESP32 디바이스 3대(86 Box, IPS 3.5", Round AMOLED) 모두 "No WiFi" 표시. QSPI 보드 2대는 시리얼 응답 없음. platformio.ini 포트명이 실제 연결 포트와 불일치.

### 원인 (복합)
1. **포트명 변경**: USB 허브 재연결로 `cu.usbserial-20130` → `21130`, `cu.usbmodem83201` → `2111101`/`211201`
2. **QSPI 보드 펌웨어 미설치**: 이전에 플래시된 적 없거나 소실
3. **serial-module.ts 감지 버그**: `shouldActivate()`가 `tty.usbmodem`(ESP32-S3 Native USB) 미포함 — QSPI 보드 미감지
4. **JTAG 후 CDC stuck**: OpenOCD JTAG 플래시 후 macOS가 USB CDC를 재열거 못함 → open() 블로킹

### 해결
- `serial-module.ts`: `shouldActivate()`에 `tty.usbmodem` 패턴 추가
- JTAG 플래시: PlatformIO 내장 openocd + `adapter serial {MAC}`로 보드 특정. **bootloader + partitions + firmware 3파일 모두** 플래시
- USB 물리 리플러그: JTAG 후 CDC 복구 유일한 방법
- 포트 매핑 확정 및 memory 기록

### 교훈
- ESP32-S3 USB JTAG/CDC 복합 디바이스: JTAG 사용 후 CDC가 macOS에서 stuck → 물리 리플러그 필수
- JTAG으로 firmware만 올리고 bootloader/partitions 빠뜨리면 부팅 불가 (검은 화면, 시리얼 무출력)
- `serial-module.ts` auto-detect에 `tty.usbmodem` 없으면 Native USB 보드 완전 무시됨
- 포트 매핑 변경 시 memory 문서 먼저 확인 — 추측 스왑 금지
