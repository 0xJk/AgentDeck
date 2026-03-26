# AgentDeck

Stream Deck+ controller for Claude Code CLI — a bidirectional local control system.

## Architecture

- **bridge/** — Node.js server: Daemon (sole hub for all clients, mDNS, device modules) + Session Bridge (PTY, hook HTTP, state machine). BridgeCore (shared infra), PtyAdapter hierarchy, output parser, WebSocket server, voice (whisper.cpp), usage API client, auth token, SSE broadcast, TUI dashboard (`tui/`)
- **plugin/** — Stream Deck SDK v2 plugin: actions for buttons/encoders, bridge WebSocket client
- **shared/** — TypeScript types and utilities shared between bridge and plugin (protocol, states, timeline, adapter interfaces, `format-utils` time/count/bytes formatters, `timeline-summarizer` extractTopicHint/cleanLLMOutput, `deduplicateEntry` pipeline)
- **hooks/** — Claude Code hook installer for `~/.claude/settings.local.json`
- **config/** — Default settings and prompt templates
- **setup/** — npm setup package: `npx @agentdeck/setup` one-command installer
- **android/** — Jetpack Compose launcher app: e-ink monitoring + interactive Deck control (CremaS, Onyx, Kobo, tablets)
- **apple/** — SwiftUI Multiplatform app: iPhone/iPad/macOS dashboard + Deck control (App Store distribution)
- **esp32/** — PlatformIO Arduino firmware: LVGL touch displays (ESP32-S3: 86Box 480×480, IPS 3.5" 480×320, Round AMOLED 360×360) + WS2812B LED matrix (ESP32 classic: Ulanzi TC001 8×32). Board-specific `#ifdef`, per-board partition tables, FastLED matrix renderer bypasses LVGL entirely

## Build

```bash
pnpm install
pnpm build                  # shared must build before bridge/plugin
pnpm generate-icons         # SVG → PNG icons (first build or after icon changes)
pnpm generate-protocol      # protocol.ts → JSON Schema → Swift/Kotlin types (generated/protocol/)
```

## Android Build

Requires JDK 17+ (`brew install openjdk@17`). Build script auto-detects Homebrew JDK.

```bash
bash scripts/build-android-release.sh   # local → dist/agentdeck-v{VERSION}.apk
```

**Signing**: `android/signing.properties` (gitignored) with `storeFile`, `keyAlias`, `keyPassword`, `storePassword`. CI uses env vars from GitHub Secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_STORE_PASSWORD`).

**Release**: `git tag android-v{VERSION} && git push origin android-v{VERSION}` → GitHub Actions builds + creates Release with APK.

## Android UI/UX Vision

두 디바이스에서 동일한 에이전트 정보를 시각화. 정보 구성은 일관, 표현 방식만 다름.

### 표시 정보 (공통)
- **Agent Identity**: 에이전트 타입, 세션명, 현재 모델, 상태 (IDLE/PROCESSING/AWAITING 등)
- **Event Log**: 에이전트 활동 이벤트 요약 (tool call, model call, state change)
- **Account/Connection**: OAuth 연동 상태 (connected/disconnected), billingType, bridge connection status
- **Usage Gauges**: 5h/7d rate limit % + 리셋까지 남은 시간, tokens, cost, uptime
- **Ollama Status**: ollama 프로세스 상태 (running/stopped) + 실행 중 모델 목록
- **Creature Animation**: 도트/픽셀 아트 형태의 에이전트 캐릭터 애니메이션

### E-ink (Crema) 레이아웃 — 좌측 에이전트 + 우측 아쿠아리움 중심

Row(fillMaxSize): 좌측 에이전트 패널 | 우측 아쿠아리움+정보

```
[AgentDeck 로고]          🐙        🦞
[claude-code]          (octopus)  (crayfish)
[  opus-4]           ∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿
[  ● PROCESSING]
[openclaw]           RATE LIMITS              MODELS
[  gpt-4o]           5h [████░░] 72% 1h      OAuth: opus-4, sonnet-4
[  ● ROUTING]        7d [██░░░░] 63% 2d      Ollama: qwen2.5:7b 4.5G
[Workers: 2]         10:32 [T] Read file_path.ts
⚙ Settings           10:33 [M] Model call opus-4
                     10:33 [S] IDLE → PROCESSING
```

- 좌측(22%): AgentDeck 로고 + 에이전트 목록 (primary + siblings + gateway-detected)
- 우측(78%): 아쿠아리움 수조(상단 40-50%) + context/status(중간, PROCESSING시만) + 타임라인(하단 35-38%)
- IDLE시 context 숨김 → 수조 50% + 상태바 13% + 타임라인 37%. PROCESSING시 context 없으면(OpenClaw 등) IDLE과 동일 레이아웃
- **Status 2-column**: LIMITS(30%, Unicode 블록 게이지 `█░`) | MODELS(70%, OAuth catalog + Ollama). 세로 구분선, `Arrangement.Center` 수직 가운데 정렬
- 수조: Compose `clip(RoundedCornerShape)` 둥근 모서리 (내부 테두리 없음), 수면 파도, 해초, 자갈, 거품 — 수족관 느낌
- **Multi-agent visibility**: Bridge `/health`에서 sibling state 조회, Gateway TCP probe로 OpenClaw 감지. Daemon primary는 agent list에서 제외 (coding agent 아님). OpenClaw primary는 목록에 🦞로 표시하되 terrarium octopus에서는 제외 (crayfish가 담당)
- **Crayfish 독립 상태**: sibling OpenClaw session의 state에서 ROUTING/SITTING 결정 (primary agentType 의존 제거)
- **Refresh zones**: 좌측 A2(200ms), 수조 `EinkAnimatedRefreshZone`(callback 기반), context+status A2(200ms), timeline A2(300ms), IDLE status DU(2000ms). `LAYER_TYPE_SOFTWARE` on wrapper FrameLayout for EPD grayscale. 수조 애니메이션: `EinkTerrariumView.onFrameRendered` 콜백 → animation frame=GC16 partial(플래시 없음), state transition=FULL GC16(고스팅 클리어)
- **EPD vendor API**: Rockchip RK3566 (Crema S) — `android.os.EinkManager` system service, `setMode("2"=GC16/"12"=A2/"14"=DU)` + `sendOneFullFrame()`. Onyx — `BaseDevice.setViewDefaultUpdateMode()`. KOReader `RK35xxEPDController` 참고
- **E-ink grayscale**: 네이티브 16-level 그레이, `DitherEngine.snapToNearestGray()` (에러 디퓨전 없음). 수조 내부 테두리 없음 — Compose `clip(RoundedCornerShape)` 만 사용. 크리처 부위별 그레이: body(0x44), limb/claw(0x33), starburst(0x99), sleeping=dimmed. 환경: sand(0xCC), fish body(0x55)+stripe(0xBB), rock outline(0x22), seaweed 2px. 멀티세션 Y stagger: `standingOffset = (centerXFraction - 0.38) * 0.10`
- **Color e-ink (Kaleido 3)**: MOAAN Pantone 6 등 컬러 e-ink 지원. `EinkDetector.isColorEink()` + `einkPick(gray, color)`. **테라리움은 정적 렌더** (애니메이션 비활성화) — Kaleido CFA가 매 프레임 색상 재계산하여 깜빡임 유발. 상태 변경 시만 컬러 프레임 1회 렌더. UI 텍스트(게이지/타임라인/라벨)는 컬러 적용 (갱신 빈도 낮음). 컬러 팔레트: octopus terracotta `#C07058`, crayfish red `#CC3333`, tetra blue `#3366AA`+cyan `#55CCEE`, seaweed green `#336633`, sand `#D4B896`, water `#C8DDE8`. `snapToNearestGray` 컬러 모드에서 스킵 (RGB 보존). `manufacturer="rockchip"` (not "moaan"), `model="Pantone6"`

### Tablet (Lenovo) Monitor 레이아웃 — 수족관 + HUD 오버레이
- 전체 화면: 컬러 수족관 배경 (60fps 애니메이션)
- 반투명 HUD 패널로 동일 정보 오버레이
- 상단: 프로젝트명, 상태, 모델
- 좌측: Activity(현재 작업) + Multi-Agent(세션 목록)
- 우측: Engine — rate limits + **reset times**, **OAuth**, **ollama**, tokens/cost
- 하단: Timeline strip (이벤트 로그)

### Creature Design — 도트 아트 통일
- **OctopusCreature** (Claude Code): 14×5 픽셀 그리드, terracotta, 셀 타입 태깅. Standing 상태: per-instance `standingJitter` + X-correlated depth offset로 자연스러운 멀티세션 배치. 수영(SWIM) 경계 `0.20~0.68` — HUD 패널과 겹치지 않음
- **CrayfishCreature** (OpenClaw): SVG Path 기반 front-facing 렌더링, red/teal gradient, `PathParser` + `withTransform` pivot rotation. SITTING: heartbeat glow (4초 주기 더블펄스), ROUTING: full animation (claw clap, signal waves, eye flash, glow pulse), SICK: 탈색+기울기+늘어진 집게+흐린 눈 (gateway 에러 시). `currentPosition()` + `isRouting()` — DataParticleSystem에 위치/상태 제공
- **Neon Tetra**: 14마리 2개 무리(schoolId 0/1, 7마리씩), Lissajous 경로 school centers로 만남/흩어짐 반복. Boids: cohesion/alignment=같은 무리만, separation=전체. `SCHOOL_ATTRACTOR_WEIGHT=0.4` (먹이 있으면 무효). `TETRA_SWIM` 경계 `0.03~0.92 X`, `0.08~0.68 Y`. E-ink: 12마리 2무리(6+6), size `0.013f`, `einkPrevFishX` heading 추적, STREAMING시 에이전트 인력 30% + 데이터 파티클 4개. **가재 반응**: ROUTING 가재도 food crumb 산란 + school center 30% 인력 → 옥토퍼스 없을 때(OpenClaw primary) 가재가 물고기 유도
- 독립 애니메이션 가능한 부위별 셀 타입 분리 (눈, 팔/집게, 다리 등)
- 상태 애니메이션: 셀 좌표 오프셋, 색상 lerp, pivot 기반 회전 (SVG transform 아님)

## Setup & Distribution

```bash
npx @agentdeck/setup        # npm one-command install (published packages)
pnpm setup                  # dev install from source (deps, build, icons, hooks, link)
pnpm package                # create dist/bound.serendipity.agentdeck.streamDeckPlugin
bash scripts/uninstall.sh   # remove hooks, unlink CLI and plugin
```

### Apple Release (TestFlight)

```bash
bash scripts/build-apple-release.sh --ios     # local iOS build
bash scripts/build-apple-release.sh --macos   # local macOS build
bash scripts/build-apple-release.sh --all     # both + TestFlight upload
git tag apple-v1.0.0 && git push origin apple-v1.0.0  # CI → TestFlight
```

- **Apple Bundle ID**: `bound.serendipity.agentdeck.dashboard` (App Store Connect 앱명: "AgentDeck Dashboard")
- **CI**: `.github/workflows/apple-release.yml` — `apple-v*` 태그 → macOS-15 runner → archive → TestFlight 업로드
- **Secrets**: `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `ASC_API_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_KEY_BASE64`
- **Note**: `bound.serendipity.agentdeck` (without `.dashboard`) is reserved by Personal Team — cannot use for App Store

## Development

```bash
pnpm -r --parallel dev   # watch mode for all packages
pnpm test                # run unit tests (vitest, 646 tests)
pnpm vitest run --coverage  # coverage report + threshold check
pnpm test:report         # unified report (vitest + Android + Apple + Robot)
pnpm test:android        # Android JUnit tests only (82 tests)
cd plugin && streamdeck link   # link plugin to Stream Deck app
```

### Test Infrastructure

| Framework | Scope | Config |
|-----------|-------|--------|
| **Vitest** | bridge/plugin/shared/hooks | `vitest.config.ts` — coverage thresholds enforced |
| **JUnit + Robolectric** | Android (`android/app/src/test/`) | `build.gradle.kts` — `testDebugUnitTest` |
| **XCTest** | Apple (`apple/AgentDeckTests/`) | Xcode scheme |
| **Robot Framework** | ESP32 (`esp32/robot/`) | `run.sh {build\|hw\|protocol\|perf\|all}` — `perf` requires hardware |

Coverage thresholds (regression guard): lines ≥17%, functions ≥15%, branches ≥14%, statements ≥16%. CI runs `coverage check` step after tests.

### Test Report (GitHub Pages)

- **URL**: `https://puritysb.github.io/AgentDeck/` (landing) / `/reports/` (test report)
- **Workflow**: `.github/workflows/test-report.yml` — push to master → Vitest + Android JUnit + Robot Framework (no-hw) → HTML report → GitHub Pages deploy
- **Report generator**: `scripts/generate-html-report.py` — tab-based SPA dashboard. Sidebar nav: Overview + 10 test layers + Android + Robot + Scenarios + Coverage. Each layer tab shows purpose question, describe-block grouping, all test cases visible by default. Robot XML `</robot>` truncation defense built-in. Robot tab: suite→scenario→BDD steps (Given/When/Then color-coded)→board matrix (✓/✗ per board)→per-test elapsed time→performance table (board × metric: build time, FW size, latency, throughput). `[PERF]` log messages auto-extracted from output.xml. Metadata auto-reconciliation: stale `executed: false` overridden when actual data exists
- **Scenario matrix**: `scripts/scenario-matrix.json` — 10 user scenarios mapped to test files + assertion/case patterns with gap analysis
- **Landing page**: `scripts/pages-index.html` — product intro at Pages root

## CLI

The CLI command is `agentdeck` (`bridge/src/cli.ts`).

```bash
# Session commands (agent name = top-level command)
agentdeck claude             # Claude Code session (PTY + bridge)
agentdeck claude --local     # No device modules (WS only)
agentdeck codex              # Codex CLI session (PTY + bridge)
agentdeck monitor            # Hook-only bridge (no PTY — run `claude` separately)

# Daemon (singleton infrastructure)
agentdeck daemon start       # Start monitoring daemon (foreground)
agentdeck daemon stop        # Stop daemon
agentdeck daemon status      # Daemon status
agentdeck daemon install     # Register LaunchAgent
agentdeck daemon uninstall   # Remove LaunchAgent

# Session management
agentdeck status             # All sessions + daemon status
agentdeck stop               # Stop a session (-a for all, -p for specific port)

# Monitoring
agentdeck dashboard          # TUI monitoring dashboard with terrarium (alias: dash)

# Utilities
agentdeck devices            # Connected devices
agentdeck qr                 # Pairing QR code
agentdeck diag               # Diagnostic dump
agentdeck pixoo {scan|add|list|remove|test}
agentdeck wifi-setup         # ESP32 WiFi provisioning (--ssid, --password)
```

**Module flags**: `--local` (all off), `--no-mdns`, `--no-adb`, `--no-serial`, `--no-pixoo`

### ESP32 WiFi 독립 운용

ESP32 디스플레이는 **USB 시리얼** (기본) + **WiFi WebSocket** (독립 운용) 이중 경로 지원.

```bash
agentdeck wifi-setup --ssid "MyNetwork" --password "secret"
# → ~/.agentdeck/wifi-config.json 저장 (autoProvision: true)
# → daemon 재시작 시 ESP32에 자동 프로비저닝
```

**USB 연결 시**: daemon이 시리얼로 `wifi_provision` 전송 → ESP32 WiFi 자동 연결. **USB 분리 후**: ESP32가 저장된 자격증명으로 WiFi 재연결 → mDNS로 daemon 발견 → WebSocket 접속. WiFi 인터페이스 자동 감지 (`networksetup -listallhardwareports`), macOS Keychain 비밀번호 조회 지원. Daemon (`daemon-server.ts`)과 Session bridge (`index.ts`) 양쪽에서 auto-provisioning 동작

## Key Design Decisions

- **TUI Dashboard** (`bridge/src/tui/`): `agentdeck dashboard` — zero-dependency TUI monitoring via raw ANSI escape codes. WS client connects to running Daemon via `findDaemonPort()` (`daemon.json` → `sessions.json` fallback). Files: `ansi.ts` (ANSI helpers), `gauge.ts` (Unicode block gauge), `screen.ts` (alternate buffer, raw stdin), `terrarium.ts` (braille aquarium animation), `renderer.ts` (adaptive layout), `dashboard.ts` (WS client + state + render loop). Three responsive layouts: wide (120+), standard (80-119), narrow (60-79). Terrarium: 3-tier sprite scaling (small=1×/large=2×/xlarge=3× via `scaleGridN()`; thresholds: large 100×20, xlarge 160×35). Braille octopus (small 14×5→7×2, large 28×10→14×3, xlarge 42×15→21×4), crayfish (small 16×8→8×2, large 32×16→16×4, xlarge 48×24→24×6), neon tetra (small 3ch, large 5ch, xlarge 7ch). Crayfish ROUTING: signal wave rings (3 concentric `◦·∙` semicircles) + orbiting cyan `✦` dots. Octopus name tag + crayfish name tag directly above sprite (`oy-1`). Multi-session octopi matched by session `id` (not `name`) — same-project sessions numbered `#1 #2`. Jellyfish/Codex CLI (small 10×8→5×2, large 20×16→10×4, xlarge 30×24→15×6; 6-lobe cloud shape matching Codex icon, indigo #6366F1, glow #A5B4FC). Tetra attract: processing octopus > processing jellyfish > routing crayfish > none. Session list from daemon `sessions_list`; virtual OpenClaw entry when `gatewayAvailable`. Half-block pixel font logo (4×6→4×3). Status split: LIMITS|MODELS (E-ink style). Local timeline generation from `state_update` events (`receivingBridgeTimeline` flag for bridge event dedup). 10fps terrarium, 4fps panels
- **pnpm workspaces** for monorepo management
- **ES modules** throughout (type: "module")
- **Node16 module resolution** in TypeScript
- **BridgeCore** (`bridge/src/bridge-core.ts`): Shared infrastructure class used by both `startSession()` (index.ts) and `startDaemon()` (daemon-server.ts). Contains StateMachine, WsServer, UsageTracker, DisplayMonitor, OllamaProbe, state caches, and common event wiring. Eliminates ~600 lines of duplication
- **PtyAdapter hierarchy** (`bridge/src/adapters/pty-adapter.ts`): Abstract base class for PTY-based agents. Subclasses implement `getDefaultCommand()`, `wireOutputParser()`, `feedParser()`, `handleAgentCommand()`. `ClaudeCodeAdapter` extends PtyAdapter with OutputParser + Shift+Tab mode switching. `CodexCliAdapter` extends PtyAdapter with CodexOutputParser (Ink TUI `›` prompt, `Working(Ns •` spinner, no HTTP hooks). `MonitorAdapter` is hook-only (no PTY)
- **Device module system** (`bridge/src/modules/`): Pluggable `DeviceModule` interface with auto-detect. Modules: mdns/serial/pixoo (daemon-only), adb (`'auto'` — detect at startup). Session bridges never activate serial/pixoo — all dashboard devices connect via daemon only. CLI flags: `--local` (all off), `--no-{module}` (daemon)
- **node-pty optional**: `optionalDependencies` + dynamic `await import('node-pty')` in PtyManager. Daemon/monitor modes never load the native module. Setup forces source build (`npm_config_build_from_source=true`) to avoid prebuilt ABI mismatch across Node versions. PtyManager catches `posix_spawnp` errors with rebuild guidance
- **Daemon hub architecture**: Daemon owns port **9120** (default, fallback to 9121+ if occupied by non-daemon). All dashboard clients (Android, Apple, ESP32, TUI, Plugin) connect exclusively to daemon — session bridges never serve external devices. Session bridges use ports 9121–9139 for internal hook HTTP only (`AGENTDECK_PORT` env var injected into Claude process). `~/.agentdeck/daemon.json` stores `{ port, pid, startedAt }` for local client discovery (written on daemon bind, removed on shutdown). Remote clients discover via mDNS (daemon only advertises `_agentdeck._tcp`). **Daemon singleton guard**: `daemon.json` PID check → `sessions.json` fallback → `/health` HTTP probe. Port occupied by non-daemon → auto-fallback to next available port. **Shutdown timeout**: `httpServer.close()` + 5s `setTimeout(() => process.exit(0))` — CLOSE_WAIT connections from disconnected clients can block `close()` callback indefinitely, causing zombie daemons (session bridge has 3s failsafe in `index.ts`). **Whisper-server** uses fixed singleton port **9100** (`~/.agentdeck/whisper-server.json` info file for discovery, last session exit kills server). **Session timeline relay**: `SessionTimelineRelay` (`session-timeline-relay.ts`) — daemon subscribes to sibling session bridges' WS to relay `timeline_event`/`timeline_history` events + `state_update.modelCatalog` (Claude Code OAuth catalog → daemon `cachedModelCatalog`, merged with Gateway catalog by name dedup). 10s sync interval detects new/removed sessions. Eliminates client-side `StateTimelineGenerator` duplication (Android/Apple) — daemon provides unified timeline stream for all agent types
- **mDNS crash recovery + IP change detection**: `bonjour-service` multicast errors (`EADDRNOTAVAIL` on sleep/wake, WiFi reconnect, VPN toggle) are caught in `bridge-core.ts` `uncaughtException` handler. `invalidateMdnsInstance()` nulls the Bonjour instance, then `mdns.ts` recovery timer (30s interval) detects null + LAN IP available → re-publishes `_agentdeck._tcp` service automatically. Recovery timer also detects IP changes (DHCP renewal) and re-publishes with the new IP. Session bridges never advertise mDNS (`cli.ts` hardcodes `mdns: false`). **Apple discovery**: `BridgeDiscovery.swift` ignores TXT `ip` field (can be stale from Bonjour cache) and always uses `NWConnection` endpoint resolution for live IP. iOS waterfall: mDNS first → savedUrl fallback after 4s (same as macOS)
- **Shift+Tab** (`\x1b[Z`) for Claude Code mode switching (100ms debounce)
- **sox/rec** for audio capture, **whisper-server** for transcription (싱글톤 포트 9100, 세션 간 공유, `detached` 프로세스). 미설치 시 **whisper-cli** 폴백. GPU 메모리 ~1.8GB (세션 수 무관, 1 인스턴스)
- **Voice local recording**: 브리지 연결 상태와 무관하게 항상 로컬 녹음. iTerm2 `create window with default profile command`로 `rec` 실행 (iTerm2 마이크 권한 상속). `pkill -INT`로 녹음 중지. RMS 무음 감지 (threshold 0.001). 전사 결과 전달: iTerm2 최전면 → `write text`, 기타 앱 → 클립보드 복사 + 알림
- **Voice binary/model paths**: `shared/src/voice-paths.ts`에 `REC_CANDIDATES`, `WHISPER_CANDIDATES`, `MODEL_SEARCH_DIRS` 등 공유 상수 정의 — bridge/plugin 양쪽에서 import
- Hook scripts use `|| true` to avoid blocking Claude when bridge is down
- **Hook format**: Claude Code v2.1+ requires 3-level nesting: `{ matcher: "", hooks: [{ type: "command", command: "..." }] }`. Old flat format `{ type, command }` silently fails. `hooks/src/install.ts` exports pure logic (`applyHooks`, `removeHooks`, `migrateHooks`) + filesystem wrappers (`installHooks`, `uninstallHooks`, `migrateHooksIfNeeded`). Bridge imports `migrateHooksIfNeeded` from `@agentdeck/hooks` (no duplication)
- **Action ID pattern**: All SD actions store string IDs and use `getActionById()` — never store action object references
- **Plugin UUID**: `bound.serendipity.agentdeck` (확정 — 배포 후 변경 불가)
- **Package scope**: `@agentdeck/*` (shared, bridge, plugin, hooks, setup)
- **User data dir**: `~/.agentdeck/` — `daemon.json` (daemon port discovery), `sessions.json` (session registry), `auth-token`, `settings.json`, `timeline.json`
- **QR code display**: Usage 버튼 `qr` 페이지 — `qrcode` 라이브러리 → SVG path 렌더링 (144×144, Version 3 QR 29 modules × 4px = 116px). URL 우선순위: (1) `--remote` URL (PTY 자동감지) (2) OC Gateway `http://LAN:18789`. Bridge OutputParser가 raw ANSI에서 cursor-forward 시퀀스 제거 후 URL 추출. Push → 클립보드 복사 (`pbcopy`)
- **BillingType detection**: PTY `model_info` parser event의 `plan` 필드로 subscription/api/unknown 판별. API 사용자는 OAuth fetch 스킵 + session 페이지만 표시
- **Effort level detection**: PTY `/model` UI에서 `(high|medium|low) effort` 패턴 파싱. Levels: high/medium(default)/low. `"medium"`은 기본값이므로 UI 표시에서 제외 (high/low만 모델명 옆에 표시). Parser→SM→WS→Plugin/Android 전체 파이프라인
- **Encoder LCD design**: 모든 인코더 LCD는 SVG pixmap 렌더링 (`voice-layout.json` 공용). 배경 `#0f172a`, 14px 가운데 정렬 헤더, icon+value 가운데 그룹, 2px accent bar 패턴 통일. Renderer는 `plugin/src/renderers/{name}-renderer.ts` 순수 함수로 분리. Utility 모드는 clean 영문 title + emoji icon + value 구조 통일
- **Encoder takeover wide canvas**: Option/permission/diff 선택 시 E1=context 패널, E2-E4=600px wide canvas 옵션 목록 (voice text와 동일한 `translate(-i*200,0)` 슬라이싱). `renderWideOptionList()` 함수, `autoScrollToIndex()`로 선택 항목 자동 스크롤
- **OC Timeline panel**: OpenClaw 모드에서 E2+E3 합체 400px 와이드 캔버스로 이벤트 타임라인 표시. 배경 `#000000` (LCD 네이티브 블랙 — 투명 효과). Fisheye 렌더링 (font size 15→10px, opacity 1.0→0.3 보간), grouped entries (연속 중복 60s 윈도우 내 병합), detail mode (push 토글). `timeline-store.ts` 싱글톤, `timeline-renderer.ts` SVG 렌더러. 이벤트 `~/.agentdeck/timeline.json` 디스크 영속, 재연결 시 `events.history` RPC로 오프라인 이벤트 복구. OC Response 버튼: GATEWAY (웹 UI) + GO ON (continue) 프리셋. **시각 3계층**: (1) `typeColor()` 이벤트 타입별 컬러 코딩 (green/blue/amber/red/cyan/purple), 하단 2px 활동 밀도 바 (2) `bridge/src/log-stream.ts` — daemon에서 `openclaw logs --follow --json` 파싱으로 model_call/model_response/memory_recall/tool_exec 이벤트 추가, WS tool_request와 dedup (3) Usage 버튼 `oc-usage` 페이지 (`openclaw status --usage --json` 60s 폴링). **Bridge→Android relay**: `shared/src/timeline.ts`에 `TimelineEntry` 타입 + `parseLogLine()` 공유. Bridge OpenClaw 모드에서 `BridgeTimelineStore` + `BridgeLogStream` → `timeline_event`/`timeline_history` BridgeEvent로 WS broadcast. Adapter가 chat tracking (prompt/duration/tools) → rich `chat_start`/`chat_end`/`tool_request`/`chat_response` 이벤트 생성. Android `StateTimelineGenerator`는 bridge timeline 수신 시 로컬 생성 억제 (`receivingBridgeTimeline` 플래그). **Timeline enrichment pipeline**: (1) Gateway `chat` delta에서 `message.content[].text` 추출 (`extractMessageText()`) → `accumulatedResponse` 축적 (2) 20~200자 축적 시 `extractTopicHint()` → `chat_start` 업데이트 (프롬프트 없는 cron/웹 작업용) (3) Final에서 `chat_response` (응답 전문) + `chat_end` (도구/시간 요약) 생성 (4) async `summarizeResponse()` → MLX qwen (port 8800, `/no_think`) → Ollama fallback → 한국어 1줄 요약으로 `chat_end` enrichment. Bridge(daemon)에서만 요약 수행 — plugin은 daemon 경유 단일 경로. LLM 실패 시 60s TTL 후 재시도 (영구 disable 방지). ConnectionManager `FORWARDED_EVENTS`에 `timeline_event`/`timeline_history` 포함. **Claude Code LLM 요약**: OpenClaw과 동일하게 `Stop` hook에서 `summarizeResponse()` → `upsertEntry()`로 chat_end async enrichment. `extractTopicHint()` 개선 — code fence 내부 스킵, markdown decorator 제거. **Detail 클리닝**: `shared/src/timeline.ts`의 `cleanDetailText()` — markdown artifact(bold/heading/fence/link), JSON blob(connectionId 등 시스템 JSON 필터, error 추출), blank line 축소. OpenClaw adapter + Claude Code bridge에서 detail 저장 전 적용. **parseLogLine 필터 개선**: broad 키워드 필터(`/whatsapp/i`, `/WebSocket error/i`, `/network_error/i`) → subsystem/module 기반 필터(`isChannelInfra` 플래그)로 전환. 사용자가 WhatsApp API 작업 시 tool/error 로그가 필터되는 false-positive 방지. **Store-level repetitive dedup**: `isRepetitiveEntry()` (shared) — `extractSemanticCore()` (chat_end: 첫 ` · ` 이전) + `extractKeywords()` keyword bag 유사도 (60% overlap threshold). 일반 엔트리 1시간 윈도우, `automated: true` 엔트리 8시간 윈도우 (content 비교 없이 automated끼리 즉시 중복 판정). 반복 시 `repeatCount` 증가 + paired chat_start도 repetitive 검증 후 제거. `deduplicateEntry()` (shared) — 텍스트 정제 → exact dedup(5s) → semantic dedup 순서, Bridge + Plugin store 공용. **Automated tagging**: `TimelineEntry.automated?: boolean` — adapter에서 `!lastPrompt` (cron/web/channel 발 채팅)일 때 `true` 태깅. chat_start/chat_end/aborted/upsert 모두 전파. Gateway 프로토콜에 `trigger` 필드 없어 `lastPrompt` null 여부가 유일한 신호. **텍스트 정제**: `cleanRawText()` (inline **bold**/heading/link/backtick strip), `cleanNopMarkers()` (NOP/NOOP 제거). Store 입구에서 raw/detail 양쪽 일괄 적용. **폴백 라벨 개선**: cron/web 시작 `'Prompt sent'` → `'자동 작업'`, LLM 실패 시 `'Completed'` → `extractTopicHint(response)` 폴백 (응답 첫줄 topic 사용). **mergeHistory dedup**: plugin `mergeHistory()` (bridge 재연결 시 `timeline_history` 수신)에 `deduplicateEntry()` 적용 — 기존 exact `ts:type:raw` 매칭만으로는 semantic dedup 우회됨. **parseLogLine cron 요약**: cron list 테이블 행 (UUID 패턴)을 감지, error 상태만 `"Cron error: {name}"` 한 줄로 요약 표시 (ok/skipped는 스킵). `{"event":...}` JSON blob, 5자 미만 fragment도 필터
- **Encoder takeover race guard**: `takeoverGeneration` counter in `plugin.ts` — exit/enter `.then()` 콜백이 실행 시점에 이미 새 전환이 발생했으면 스킵. PROCESSING→PERMISSION 빠른 전환 시 exit 콜백이 enter 이후 layout을 덮어쓰는 레이스 방지
- **Button label intelligence**: 3-tier 라벨 축약 시스템 — (1) CJK-aware 픽셀 기반 줄바꿈 (`text-utils.ts`) (2) 로컬 휴리스틱 약어 (`abbreviateLabel`) (3) `claude -p --model haiku` CLI 폴백 (`label-summarizer.ts`). 1-2단계 즉시(0ms), 3단계 1-3초(캐시 200개). 약어된 버튼 우하단 `~` 표시. CJK 문자 1em, Latin 0.55em 폭 계산. Wide canvas는 충분한 가로폭이라 변경 불필요
- **Version compatibility check**: `agentdeck claude` 시작 시 Claude Code 버전 → npm registry (3s) → GitHub raw JSON fallback (3s) 순으로 호환성 조회. `bridge/package.json`의 `compatibleClaudeCode` semver range로 판정. 비호환 시 자동 `npm install -g @agentdeck/bridge@latest` + 재시작 안내. `~/.agentdeck/compatibility.json` 상태 캐시 (1시간 throttle). `--no-update-check`로 비활성화. **절대 startup을 block하지 않음** — 모든 실패 케이스는 경고 후 진행
- **npm packages**: `@agentdeck/shared`, `@agentdeck/bridge`, `@agentdeck/setup` — public npm packages (MIT license)
- **Gateway health check**: `checkGatewayHealth()` in `gateway-probe.ts` — `openclaw doctor --json` 30초 간격 폴링. warn/error 감지 시 `gatewayHasError: true`를 `state_update`에 포함. Android 가재가 SICK 상태로 전환 (탈색, 기울기, 늘어진 집게). Gateway 미접속 시 폴링 스킵. OpenClaw adapter도 Gateway WS `health` 이벤트를 `gateway_health` metadata로 emit → daemon이 실시간 반영 (폴링 대체)
- **Daemon Gateway connection 격리**: daemon이 Gateway adapter의 `connection` 이벤트를 WS 클라이언트에 포워딩하지 않음 — 클라이언트가 자신의 bridge 연결 끊김으로 오인하는 버그 방지. Gateway 상태는 `state_update.gatewayAvailable`과 `sessions_list`로 전달. `disconnectGatewayAdapter()`도 `connection:disconnected` 미전송
- **isDaemonLike 패턴**: 모든 클라이언트(TUI/Android/Apple)에서 세션 목록 렌더링 시 `agentType == 'daemon' || sessions.any { it.agentType == agentType }` 체크. daemon이 Gateway 연결 시 `agentType='openclaw'`로 브로드캐스트하므로 sessions_list에 동일 타입이 있으면 daemon 모드로 처리 (primary 스킵, sessions만 렌더). 이 없으면 session bridge 모드 (primary + siblings 렌더)
- **Daemon singleton guard**: 3단계 — (1) `readDaemonInfo()` from `~/.agentdeck/daemon.json` (PID alive 검증) (2) `findExistingDaemon()` from `sessions.json` fallback (3) `probeDaemonHealth()` HTTP `/health` probe (port에 응답하는 daemon 감지). `daemon-server.ts` + `cli.ts` + `daemon.ts`(legacy) 세 곳에서 체크. 기존 daemon 있으면 `process.exit(0)` (LaunchAgent KeepAlive 재시작 루프 방지). 이중 daemon으로 인한 Gateway 이벤트 중복 relay, mDNS 충돌, timeline 중복 방지
- **Daemon usage relay**: Daemon `fetchUsageRelayed()` — (1) sibling bridge `GET /usage` HTTP 중계 (2) WS 연결로 `usage_update` 이벤트 수신 (3) sibling 없을 때만 직접 API. Sibling 있으면 직접 API 호출 안 함 (429 방지). Bridge `hook-server.ts` `GET /usage` 엔드포인트 (no auth, local only)
- **Multi-surface monitoring**: Daemon is the **sole hub** for all dashboard clients — session bridges never advertise mDNS or serve external WS/SSE. mDNS (`_agentdeck._tcp`, daemon only), auth token (`~/.agentdeck/auth-token`), SSE (`/sse`), remote WS token validation. `0.0.0.0` binding for LAN access. `isLocalConnection()` recognizes localhost + machine's own IPs via `os.networkInterfaces()` — same-machine clients (macOS app, localhost) bypass token auth. **Client discovery**: Local clients (TUI, CLI, session bridge) read `~/.agentdeck/daemon.json` for port. Remote clients (Android, Apple) use mDNS — only daemon advertises, so no preference logic needed. **macOS App Sandbox**: `LocalSessionDiscovery` (sessions.json 직접 읽기) 불가 — sandbox가 `~/.agentdeck/` 접근 차단. macOS는 mDNS로 daemon 발견 (daemon만 광고하므로 단순). **Client count for polling**: `BridgeCore.hasClients()` = WS clients + external serial connections (`setExternalClientCountProvider`). All polling guards (sessions_list, usage, API) use `hasClients()` so ESP32 serial-only connections keep data flowing. **ESP32 daemon state**: `isDaemon = agentType == "daemon" || "openclaw"` — daemon sends "openclaw" when gateway alive, renderer maps per-session octopus states from `sessions_list`. Multi-octopus particles (round-robin spawn from octStates[]), bubbles (exhale from all), session name dedup (`#1`/`#2`)
- **Android launcher**: `android/` — Jetpack Compose, minSdk 29, CATEGORY_HOME, NSD mDNS discovery, QR pairing (CameraX + ML Kit), e-ink detection (Crema/Onyx/Kobo). **3-tab nav**: Dashboard (terrarium bg + HUD overlay panels, connection overlay when disconnected) / Deck (encoder strip + 2×4 button grid + context area) / Settings. MonitorService: CPU wake lock + system stay-on + screen wake on state change (e-ink). **Deck encoder strip**: 4-panel LCD mirroring (Utility/Action/Session/Voice), touch gestures (swipe=rotate, tap=push, long-press=record). **Deck button grid**: Bridge `button_state` 프로토콜 우선, 로컬 fallback. CompactStatusBar(36dp) 상단 + 직사각형 버튼(80dp) + 넓은 ContextArea. 터치 피드백(scale 0.95+alpha 0.85), AWAITING시 전체 옵션 리스트 항상 표시, PROCESSING시 LinearProgressIndicator, IDLE시 suggestedPrompt AssistChip. **Voice**: Android AudioRecord → WAV → HTTP POST `/voice/transcribe` → whisper. **Utility proxy**: `bridge/src/utility-proxy.ts` — osascript macOS volume/brightness/media control via Android remote. **Slot map**: Plugin reports SD+ profile layout → Bridge caches → Android mirrors dynamically
- **Display sleep/wake sync**: `DisplayMonitor` (python3 `CGDisplayIsAsleep()` 2s poll) → `display_state` BridgeEvent → all devices dim/restore. `DISPLAY_FORWARDED_EVENTS` includes `display_state` (auto-propagates to `SERIAL_FORWARDED_EVENTS`). **Pixoo**: `setBrightness(0)` + stream pause (saves HTTP), wake restores `dev.brightness`. **SD+ Plugin**: `displayDimmed` flag → black SVG on all buttons/LCDs, wake → `broadcastStateUpdate()` re-render, `broadcastStateUpdate()` guard skips while dimmed. **Apple iOS**: `DisplaySyncService` — `UIScreen.main.brightness` save/0/restore, background queuing, disconnect safety restore, Settings toggle. **Android**: `BrightnessController.dim()/restore()` — LCD: `WRITE_SETTINGS` 특수 권한 필수 (manifest 선언만으로 부족, `adb shell appops set dev.agentdeck WRITE_SETTINGS allow` 또는 Settings UI에서 "Modify system settings" 허용 필요, 앱 재설치 시 초기화됨), brightness→0 + SCREEN_OFF_TIMEOUT→2s. E-ink: sysfs `/sys/class/backlight/{device}/brightness` 동적 탐색 (`KNOWN_BACKLIGHT_DEVICES` probe) — Crema S(warm/white) 동작, **Pantone 6 sysfs는 SELinux 차단으로 dim 스킵** (proc `/proc/aw99703/led_*`도 앱 context에서 읽기/쓰기 불가, root 필요). **ESP32**: event delivered via serial, firmware handler TBD
- **Setup-required UI**: Plugin detects `agentdeck` not installed → INSTALL button → `npx @agentdeck/setup` via iTerm

## v3 Layout (0.3.0)

**Keypad (8 actions):**

| Slot | Action | Description |
|------|--------|-------------|
| 0 | Mode | Mode toggle (Default/Plan/Accept) |
| 1 | Session | Project + state + session switch |
| 2 | Usage | Usage dashboard (5h/7d/extra/session/models/oc-usage/qr pages) |
| 3-6 | Quick Action ×4 | GO ON/REVIEW/COMMIT/CLEAR (idle) or up to 4 options (permission/select). 5+ options → 3 + MORE ▼ |
| 7 | Stop | Interrupt (processing) or Escape (awaiting prompt) |

**Encoders (4 slots):**

| E# | Action | Rotate | Push | Touch |
|----|--------|--------|------|-------|
| E1 | Utility | Adjust value | Toggle/Action | Switch mode |
| E2 | Action | Scroll options / cycle prompts | Send prompt / Confirm | Same as push |
| E3 | Terminal | Switch session | Activate / Attach tmux | — |
| E4 | Voice | Scroll text | Hold=record, tap(<500ms)=cancel, VT push=send/paste | — |

## References

- **SDK Docs**: https://docs.elgato.com/streamdeck/sdk
  - [Actions](https://docs.elgato.com/streamdeck/sdk/plugin-guides/actions) · [Keys](https://docs.elgato.com/streamdeck/sdk/plugin-guides/keys) · [Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/plugin-guides/dials-touch-strip)
  - [Manifest schema](https://docs.elgato.com/streamdeck/sdk/references/manifest) · [Touch Strip Layout](https://docs.elgato.com/streamdeck/sdk/references/touch-strip-layout) · [WebSocket API](https://docs.elgato.com/streamdeck/sdk/references/websocket-api)
- **Plugin Samples**: https://github.com/elgatosf/streamdeck-plugin-samples (layouts, cat-keys, hello-world, data-sources, lights-out)
- **Local SDK reference** (manifest schema, layout items, API methods): `memory/streamdeck-sdk.md`

## v3 Changes from v2

- **Encoder LCD fix**: Stale action references → string ID + `getActionById()` pattern
- **Session**: One button shows project/mode/model (idle) or state labels (running/permission/etc)
- **SEND removed**: Replaced with /compact quick button
- **Extra Usage**: API usage page for pay-per-use billing (`extra_usage`)
- **Terminal dial**: iTerm session switcher on E3
- **Voice UX**: Min recording time, pulsing indicator bar, error clear, scroll transcription
- **Mode debounce**: 100ms bridge debounce + 2s parser timeout fallback for default mode detection
