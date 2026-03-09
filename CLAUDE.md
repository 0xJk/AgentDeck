# AgentDeck

Stream Deck+ controller for Claude Code CLI — a bidirectional local control system.

## Architecture

- **bridge/** — Node.js server: PTY manager, output parser, hook HTTP server, state machine, WebSocket server, voice (whisper.cpp), usage API client, mDNS discovery, auth token, SSE broadcast
- **plugin/** — Stream Deck SDK v2 plugin: actions for buttons/encoders, bridge WebSocket client
- **shared/** — TypeScript types shared between bridge and plugin (protocol, states, timeline)
- **hooks/** — Claude Code hook installer for `~/.claude/settings.local.json`
- **config/** — Default settings and prompt templates
- **setup/** — npm setup package: `npx @agentdeck/setup` one-command installer
- **android/** — Jetpack Compose launcher app: e-ink monitoring + interactive Deck control (CremaS, Onyx, Kobo, tablets)

## Build

```bash
pnpm install
pnpm build                  # shared must build before bridge/plugin
pnpm generate-icons         # SVG → PNG icons (first build or after icon changes)
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

## Development

```bash
pnpm -r --parallel dev   # watch mode for all packages
pnpm test                # run unit tests (vitest)
cd plugin && streamdeck link   # link plugin to Stream Deck app
```

## Run

```bash
sdc                # start bridge + spawn claude + attach terminal
sdc status         # check bridge status
sdc stop           # stop bridge and session
```

## Key Design Decisions

- **pnpm workspaces** for monorepo management
- **ES modules** throughout (type: "module")
- **Node16 module resolution** in TypeScript
- **Port 9120–9139** for multi-session (base 9120, auto-increment, max 20). `AGENTDECK_PORT` env var injected into Claude process so hooks POST to correct bridge. **Whisper-server** uses fixed singleton port **9100** (`~/.agentdeck/whisper-server.json` info file for discovery, last session exit kills server)
- **Shift+Tab** (`\x1b[Z`) for Claude Code mode switching (100ms debounce)
- **sox/rec** for audio capture, **whisper-server** for transcription (싱글톤 포트 9100, 세션 간 공유, `detached` 프로세스). 미설치 시 **whisper-cli** 폴백. GPU 메모리 ~1.8GB (세션 수 무관, 1 인스턴스)
- **Voice local recording**: 브리지 연결 상태와 무관하게 항상 로컬 녹음. iTerm2 `create window with default profile command`로 `rec` 실행 (iTerm2 마이크 권한 상속). `pkill -INT`로 녹음 중지. RMS 무음 감지 (threshold 0.001). 전사 결과 전달: iTerm2 최전면 → `write text`, 기타 앱 → 클립보드 복사 + 알림
- **Voice binary/model paths**: `shared/src/voice-paths.ts`에 `REC_CANDIDATES`, `WHISPER_CANDIDATES`, `MODEL_SEARCH_DIRS` 등 공유 상수 정의 — bridge/plugin 양쪽에서 import
- Hook scripts use `|| true` to avoid blocking Claude when bridge is down
- **Hook format**: Claude Code v2.1+ requires 3-level nesting: `{ matcher: "", hooks: [{ type: "command", command: "..." }] }`. Old flat format `{ type, command }` silently fails. `migrateHooksIfNeeded()` auto-upgrades on bridge start
- **Action ID pattern**: All SD actions store string IDs and use `getActionById()` — never store action object references
- **Plugin UUID**: `bound.serendipity.agentdeck` (확정 — 배포 후 변경 불가)
- **Package scope**: `@agentdeck/*` (shared, bridge, plugin, hooks, setup)
- **User data dir**: `~/.agentdeck/sessions.json`
- **QR code display**: Usage 버튼 `qr` 페이지 — `qrcode` 라이브러리 → SVG path 렌더링 (144×144, Version 3 QR 29 modules × 4px = 116px). URL 우선순위: (1) `--remote` URL (PTY 자동감지) (2) OC Gateway `http://LAN:18789`. Bridge OutputParser가 raw ANSI에서 cursor-forward 시퀀스 제거 후 URL 추출. Push → 클립보드 복사 (`pbcopy`)
- **BillingType detection**: PTY `model_info` parser event의 `plan` 필드로 subscription/api/unknown 판별. API 사용자는 OAuth fetch 스킵 + session 페이지만 표시
- **Effort level detection**: PTY `/model` UI에서 `(high|medium|low) effort` 패턴 파싱. Levels: high/medium(default)/low. `"medium"`은 기본값이므로 UI 표시에서 제외 (high/low만 모델명 옆에 표시). Parser→SM→WS→Plugin/Android 전체 파이프라인
- **Encoder LCD design**: 모든 인코더 LCD는 SVG pixmap 렌더링 (`voice-layout.json` 공용). 배경 `#0f172a`, 14px 가운데 정렬 헤더, icon+value 가운데 그룹, 2px accent bar 패턴 통일. Renderer는 `plugin/src/renderers/{name}-renderer.ts` 순수 함수로 분리. Utility 모드는 clean 영문 title + emoji icon + value 구조 통일
- **Encoder takeover wide canvas**: Option/permission/diff 선택 시 E1=context 패널, E2-E4=600px wide canvas 옵션 목록 (voice text와 동일한 `translate(-i*200,0)` 슬라이싱). `renderWideOptionList()` 함수, `autoScrollToIndex()`로 선택 항목 자동 스크롤
- **OC Timeline panel**: OpenClaw 모드에서 E2+E3 합체 400px 와이드 캔버스로 이벤트 타임라인 표시. 배경 `#000000` (LCD 네이티브 블랙 — 투명 효과). Fisheye 렌더링 (font size 15→10px, opacity 1.0→0.3 보간), grouped entries (연속 중복 60s 윈도우 내 병합), detail mode (push 토글). `timeline-store.ts` 싱글톤, `timeline-renderer.ts` SVG 렌더러. 이벤트 `~/.agentdeck/timeline.json` 디스크 영속, 재연결 시 `events.history` RPC로 오프라인 이벤트 복구. OC Response 버튼: GATEWAY (웹 UI) + GO ON (continue) 프리셋. **시각 3계층**: (1) `typeColor()` 이벤트 타입별 컬러 코딩 (green/blue/amber/red/cyan/purple), 하단 2px 활동 밀도 바 (2) `log-stream.ts` — `openclaw logs --follow --json` 파싱으로 model_call/model_response/memory_recall/tool_exec 이벤트 추가, WS tool_request와 dedup (3) Usage 버튼 `oc-usage` 페이지 (`openclaw status --usage --json` 60s 폴링). **Bridge→Android relay**: `shared/src/timeline.ts`에 `TimelineEntry` 타입 + `parseLogLine()` 공유. Bridge OpenClaw 모드에서 `BridgeTimelineStore` + `BridgeLogStream` → `timeline_event`/`timeline_history` BridgeEvent로 WS broadcast. Adapter가 chat tracking (prompt/duration/tools) → rich `chat_start`/`chat_end`/`tool_request`/`chat_response` 이벤트 생성. Android `StateTimelineGenerator`는 bridge timeline 수신 시 로컬 생성 억제 (`receivingBridgeTimeline` 플래그). **Timeline enrichment pipeline**: (1) Gateway `chat` delta에서 `message.content[].text` 추출 (`extractMessageText()`) → `accumulatedResponse` 축적 (2) 20~200자 축적 시 `extractTopicHint()` → `chat_start` 업데이트 (프롬프트 없는 cron/웹 작업용) (3) Final에서 `chat_response` (응답 전문) + `chat_end` (도구/시간 요약) 생성 (4) Bridge는 async `summarizeResponse()` → MLX qwen (port 8800, `/no_think`) → Ollama fallback → 한국어 1줄 요약으로 `chat_end` enrichment. **Plugin `receivingBridgeTimeline`**: bridge 연결 시 plugin gateway-client 로컬 timeline 생성 억제, bridge 단절 시 자동 복구. ConnectionManager `FORWARDED_EVENTS`에 `timeline_event`/`timeline_history` 포함
- **Encoder takeover race guard**: `takeoverGeneration` counter in `plugin.ts` — exit/enter `.then()` 콜백이 실행 시점에 이미 새 전환이 발생했으면 스킵. PROCESSING→PERMISSION 빠른 전환 시 exit 콜백이 enter 이후 layout을 덮어쓰는 레이스 방지
- **Button label intelligence**: 3-tier 라벨 축약 시스템 — (1) CJK-aware 픽셀 기반 줄바꿈 (`text-utils.ts`) (2) 로컬 휴리스틱 약어 (`abbreviateLabel`) (3) `claude -p --model haiku` CLI 폴백 (`label-summarizer.ts`). 1-2단계 즉시(0ms), 3단계 1-3초(캐시 200개). 약어된 버튼 우하단 `~` 표시. CJK 문자 1em, Latin 0.55em 폭 계산. Wide canvas는 충분한 가로폭이라 변경 불필요
- **Version compatibility check**: `sdc` 시작 시 Claude Code 버전 → npm registry (3s) → GitHub raw JSON fallback (3s) 순으로 호환성 조회. `bridge/package.json`의 `compatibleClaudeCode` semver range로 판정. 비호환 시 자동 `npm install -g @agentdeck/bridge@latest` + 재시작 안내. `~/.agentdeck/compatibility.json` 상태 캐시 (1시간 throttle). `--no-update-check`로 비활성화. **절대 startup을 block하지 않음** — 모든 실패 케이스는 경고 후 진행
- **npm packages**: `@agentdeck/shared`, `@agentdeck/bridge`, `@agentdeck/setup` — public npm packages (MIT license)
- **Gateway health check**: `checkGatewayHealth()` in `gateway-probe.ts` — `openclaw doctor --json` 30초 간격 폴링. warn/error 감지 시 `gatewayHasError: true`를 `state_update`에 포함. Android 가재가 SICK 상태로 전환 (탈색, 기울기, 늘어진 집게). Gateway 미접속 시 폴링 스킵
- **Daemon usage relay**: Daemon `fetchUsageRelayed()` — (1) sibling bridge `GET /usage` HTTP 중계 (2) WS 연결로 `usage_update` 이벤트 수신 (3) sibling 없을 때만 직접 API. Sibling 있으면 직접 API 호출 안 함 (429 방지). Bridge `hook-server.ts` `GET /usage` 엔드포인트 (no auth, local only)
- **Multi-surface monitoring**: mDNS (`_agentdeck._tcp`), auth token (`~/.agentdeck/auth-token`), SSE (`/sse`), remote WS token validation. `0.0.0.0` binding for LAN access
- **Android launcher**: `android/` — Jetpack Compose, minSdk 29, CATEGORY_HOME, NSD mDNS discovery, QR pairing (CameraX + ML Kit), e-ink detection (Crema/Onyx/Kobo). **3-tab nav**: Dashboard (terrarium bg + HUD overlay panels, connection overlay when disconnected) / Deck (encoder strip + 2×4 button grid + context area) / Settings. MonitorService: CPU wake lock + system stay-on + screen wake on state change (e-ink). **Deck encoder strip**: 4-panel LCD mirroring (Utility/Action/Session/Voice), touch gestures (swipe=rotate, tap=push, long-press=record). **Deck button grid**: Bridge `button_state` 프로토콜 우선, 로컬 fallback. CompactStatusBar(36dp) 상단 + 직사각형 버튼(80dp) + 넓은 ContextArea. 터치 피드백(scale 0.95+alpha 0.85), AWAITING시 전체 옵션 리스트 항상 표시, PROCESSING시 LinearProgressIndicator, IDLE시 suggestedPrompt AssistChip. **Voice**: Android AudioRecord → WAV → HTTP POST `/voice/transcribe` → whisper. **Utility proxy**: `bridge/src/utility-proxy.ts` — osascript macOS volume/brightness/media control via Android remote. **Slot map**: Plugin reports SD+ profile layout → Bridge caches → Android mirrors dynamically
- **Setup-required UI**: Plugin detects `sdc` not installed → INSTALL button → `npx @agentdeck/setup` via iTerm

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
