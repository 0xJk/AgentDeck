# AgentDeck

Stream Deck+ controller for Claude Code CLI — a bidirectional local control system.

## Architecture

- **bridge/** — Node.js server: PTY manager, output parser, hook HTTP server, state machine, WebSocket server, voice (whisper.cpp), usage API client
- **plugin/** — Stream Deck SDK v2 plugin: actions for buttons/encoders, bridge WebSocket client
- **shared/** — TypeScript types shared between bridge and plugin (protocol, states)
- **hooks/** — Claude Code hook installer for `~/.claude/settings.local.json`
- **config/** — Default settings and prompt templates

## Build

```bash
pnpm install
pnpm build                  # shared must build before bridge/plugin
pnpm generate-icons         # SVG → PNG icons (first build or after icon changes)
```

## Setup & Distribution

```bash
pnpm setup                  # one-click install (deps, build, icons, hooks, link)
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
- **Action ID pattern**: All SD actions store string IDs and use `getActionById()` — never store action object references
- **Plugin UUID**: `bound.serendipity.agentdeck` (확정 — 배포 후 변경 불가)
- **Package scope**: `@agentdeck/*` (shared, bridge, plugin, hooks)
- **User data dir**: `~/.agentdeck/sessions.json`
- **BillingType detection**: PTY `model_info` parser event의 `plan` 필드로 subscription/api/unknown 판별. API 사용자는 OAuth fetch 스킵 + session 페이지만 표시
- **Encoder LCD design**: 모든 인코더 LCD는 SVG pixmap 렌더링 (`voice-layout.json` 공용). 배경 `#0f172a`, 14px 가운데 정렬 헤더, icon+value 가운데 그룹, 2px accent bar 패턴 통일. Renderer는 `plugin/src/renderers/{name}-renderer.ts` 순수 함수로 분리. Utility 모드는 clean 영문 title + emoji icon + value 구조 통일
- **Encoder takeover wide canvas**: Option/permission/diff 선택 시 E1=context 패널, E2-E4=600px wide canvas 옵션 목록 (voice text와 동일한 `translate(-i*200,0)` 슬라이싱). `renderWideOptionList()` 함수, `autoScrollToIndex()`로 선택 항목 자동 스크롤
- **OC Timeline panel**: OpenClaw 모드에서 E2+E3 합체 400px 와이드 캔버스로 이벤트 타임라인 표시. 배경 `#000000` (LCD 네이티브 블랙 — 투명 효과). Fisheye 렌더링 (font size 15→10px, opacity 1.0→0.3 보간), grouped entries (연속 중복 60s 윈도우 내 병합), detail mode (push 토글). `timeline-store.ts` 싱글톤, `timeline-renderer.ts` SVG 렌더러. 이벤트 `~/.agentdeck/timeline.json` 디스크 영속, 재연결 시 `events.history` RPC로 오프라인 이벤트 복구. OC Response 버튼: GATEWAY (웹 UI) + GO ON (continue) 프리셋
- **Encoder takeover race guard**: `takeoverGeneration` counter in `plugin.ts` — exit/enter `.then()` 콜백이 실행 시점에 이미 새 전환이 발생했으면 스킵. PROCESSING→PERMISSION 빠른 전환 시 exit 콜백이 enter 이후 layout을 덮어쓰는 레이스 방지
- **Button label intelligence**: 3-tier 라벨 축약 시스템 — (1) CJK-aware 픽셀 기반 줄바꿈 (`text-utils.ts`) (2) 로컬 휴리스틱 약어 (`abbreviateLabel`) (3) `claude -p --model haiku` CLI 폴백 (`label-summarizer.ts`). 1-2단계 즉시(0ms), 3단계 1-3초(캐시 200개). 약어된 버튼 우하단 `~` 표시. CJK 문자 1em, Latin 0.55em 폭 계산. Wide canvas는 충분한 가로폭이라 변경 불필요

## v3 Layout (0.3.0)

**Keypad (8 actions):**

| Slot | Action | Description |
|------|--------|-------------|
| 0 | Mode | Mode toggle (Default/Plan/Accept) |
| 1 | Session | Project + state + session switch |
| 2 | Usage | Usage dashboard (5h/7d/extra/session pages) |
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
