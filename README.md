# AgentDeck

Elgato Stream Deck+로 Claude Code CLI를 양방향 제어하는 로컬 컨트롤 시스템.

키보드 매크로가 아닌, **상태 인식 기반** "Claude Code Command Console". Claude의 현재 상태(대기/처리 중/권한 요청/옵션 선택)를 실시간으로 감지하여 Stream Deck 버튼과 인코더를 동적으로 변경합니다.

```
┌──────────────────────┐   WebSocket (ws://localhost:9120)   ┌────────────────────┐
│  Stream Deck Plugin  │◄───────────────────────────────────►│   Bridge Server    │
│  (Node.js, SDK v2)   │   state updates ← / → commands     │   (Node.js)        │
│                      │                                     │                    │
│  8 Buttons           │                                     │  ┌──────────────┐  │
│  4 Encoders + LCD    │                                     │  │ PTY Manager  │  │
└──────────────────────┘                                     │  │ (node-pty)   │  │
                                                             │  └──────┬───────┘  │
                                                             │         │          │
┌──────────────────────┐                                     │  ┌──────▼───────┐  │
│  User's Terminal     │◄──stdio proxy──────────────────────►│  │ claude CLI   │  │
│  (iTerm2)            │  user sees claude normally          │  └──────┬───────┘  │
└──────────────────────┘                                     │         │ output   │
                                                             │  ┌──────▼───────┐  │
┌──────────────────────┐   HTTP POST (hook JSON on stdin)    │  │ Output       │  │
│  Claude Code Hooks   │────────────────────────────────────►│  │ Parser       │  │
│  (settings.json)     │   structured events                 │  └──────┬───────┘  │
└──────────────────────┘                                     │         │          │
                                                             │  ┌──────▼───────┐  │
                                                             │  │ State        │  │
                                                             │  │ Machine      │  │
                                                             │  └──────┬───────┘  │
                                                             │         │          │
                                                             │  ┌──────▼───────┐  │
                                                             │  │ WS Server    │  │
                                                             │  │ :9120        │  │
                                                             │  └──────────────┘  │
                                                             │                    │
                                                             │  ┌──────────────┐  │
                                                             │  │ Voice        │  │
                                                             │  │ whisper.cpp  │  │
                                                             │  └──────────────┘  │
                                                             └────────────────────┘
```

---

## 주요 기능

- **Yes / No / Always** 버튼으로 권한 요청에 즉시 응답
- **STOP** 버튼으로 처리 중단 (Ctrl+C)
- **모드 전환** 인코더로 Plan / Accept Edits / Default 순환
- **옵션 선택** 인코더로 다중 선택지 스크롤 및 확정
- **프롬프트 히스토리** 인코더로 이전 프롬프트 재사용
- **음성 입력** 인코더로 Push-to-Talk 녹음 → whisper.cpp 전사 → 자동 전송
- 상태에 따라 버튼 레이아웃이 **자동 전환** (6가지 상태)
- Claude Code hooks 연동으로 **구조화된 이벤트** 수신
- Bridge가 꺼져 있어도 claude 단독 사용에 **영향 없음**

---

## 사전 요구사항

| 항목 | 필수 여부 | 설치 방법 |
|------|----------|----------|
| **Node.js** >= 20 | 필수 | `brew install node` |
| **pnpm** | 필수 | `npm install -g pnpm` |
| **Elgato Stream Deck 앱** | 필수 | [Elgato 공식 다운로드](https://www.elgato.com/downloads) |
| **Stream Deck+ 하드웨어** | 필수 | 8 버튼 + 4 인코더 + LCD 터치스트립 |
| **Claude Code CLI** | 필수 | `npm install -g @anthropic-ai/claude-code` |
| **Stream Deck CLI** | 필수 | `npm install -g @elgato/cli` |
| **sox** (음성 녹음) | 음성 사용 시 | `brew install sox` |
| **whisper.cpp** (음성 전사) | 음성 사용 시 | `brew install whisper-cpp` |

---

## 빠른 설치 (원클릭)

```bash
cd AgentDeck
pnpm setup
```

이 명령은 다음을 자동으로 수행합니다:
1. 필수 의존성 확인 (Node.js 20+, pnpm, Claude CLI, Stream Deck 앱)
2. `@elgato/cli` 설치 (없는 경우)
3. `pnpm install` + `pnpm build`
4. 아이콘 에셋 생성 (16개 PNG)
5. Claude Code hooks 설치
6. Stream Deck 플러그인 링크
7. `sdc` CLI 글로벌 링크
8. 선택 의존성 확인 (sox, whisper.cpp)

설치 후 **Stream Deck 앱을 재시작**하고, `sdc`를 실행하면 바로 사용할 수 있습니다.

---

## 수동 빌드 및 설치

### 빌드

```bash
cd AgentDeck

# 의존성 설치
pnpm install

# 전체 빌드 (shared → bridge, plugin, hooks 순서)
pnpm build

# 아이콘 에셋 생성 (처음 빌드 시 필수)
pnpm generate-icons
```

빌드 결과:
- `shared/dist/` — 공유 타입 정의
- `bridge/dist/` — Bridge 서버 + `sdc` CLI
- `plugin/.sdPlugin/bin/plugin.js` — Stream Deck 플러그인 번들
- `hooks/dist/` — Hook 설치 스크립트
- `plugin/.sdPlugin/static/imgs/` — 아이콘 PNG 에셋 (16개)

### 1. Claude Code Hooks 설치

Bridge가 Claude Code의 이벤트(tool 실행, 세션 시작/종료 등)를 수신하기 위해 hooks를 등록합니다.

```bash
node hooks/dist/install.js
```

`~/.claude/settings.local.json`에 다음 7개 hook이 추가됩니다:
- `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `UserPromptSubmit`

각 hook은 `curl`로 Bridge HTTP 서버에 JSON을 POST하며, Bridge가 꺼져 있으면 `|| true`로 무시됩니다.

hook을 제거하려면:
```bash
node hooks/dist/install.js uninstall
```

### 2. Stream Deck 플러그인 링크

```bash
cd plugin
streamdeck link .sdPlugin
```

Stream Deck 앱의 플러그인 디렉터리(`~/Library/Application Support/com.elgato.StreamDeck/Plugins/`)에 심볼릭 링크가 생성됩니다. **Stream Deck 앱을 재시작**해야 플러그인이 인식됩니다.

### 3. `sdc` CLI 글로벌 링크

```bash
cd bridge
pnpm link --global
```

이후 터미널 어디서든 `sdc` 명령을 사용할 수 있습니다.

### 4. 음성 기능 설정 (선택)

```bash
# sox 설치 (오디오 캡처)
brew install sox

# whisper.cpp 설치 (Apple Silicon ANE 가속 지원)
brew install whisper-cpp

# large-v3-turbo 모델 다운로드 (~1.5GB, 고품질 한/영 인식)
whisper-cli --download-model large-v3-turbo
```

`large-v3-turbo`는 large-v3 수준의 인식 품질을 유지하면서 속도가 빠른 모델입니다. Apple Silicon의 ANE(Apple Neural Engine) 가속을 활용합니다.

---

## 실행

### Bridge 시작 (기본)

```bash
sdc
```

이 명령은 다음을 수행합니다:
1. HTTP + WebSocket 서버를 포트 9120에서 시작
2. `claude` CLI를 node-pty 내에서 스폰
3. 사용자의 stdin/stdout을 PTY에 프록시 (투명하게 claude를 사용)
4. PTY 출력을 파싱하면서 Stream Deck에 상태 전파

사용자는 claude를 **평소와 똑같이** 사용하면서, Stream Deck 버튼으로도 동시에 제어합니다.

### 기타 CLI 명령

```bash
sdc status           # Bridge/세션 상태 확인
sdc stop             # 세션 종료
sdc --port 9200      # 다른 포트로 시작
sdc --command 'claude --model opus'  # 커스텀 Claude 명령
```

---

## Stream Deck+ 레이아웃

### 버튼 배치 (8개)

Stream Deck 앱에서 "Claude Code" 카테고리의 **Response Button**을 8개 슬롯에 드래그하고, 각 버튼 설정에서 `slot` 값을 지정합니다:

```
상단 행:  slot 0 | slot 1 | slot 2 | slot 3
하단 행:  slot 4 | slot 5 | slot 6 | slot 7
```

**Stop / Interrupt** 버튼은 별도 액션으로, 원하는 위치에 배치 가능합니다. (slot 7 위치에 배치 권장)

### 인코더 배치 (4개)

왼쪽부터:

| 위치 | 액션 | 회전 | 누르기 | LCD |
|------|------|------|--------|-----|
| E1 | **Mode Selector** | 모드 순환 (Plan↔Accept↔Default) | 모드 확정 | `MODE: Plan` |
| E2 | **Option Scroll** | 옵션 스크롤 (5개 이상일 때) | 선택 확정 | `OPT 2/5: ...` |
| E3 | **Prompt History** | 히스토리 탐색 | 선택한 프롬프트 전송 | `HIST 3/10: ...` |
| E4 | **Voice Input** | — | 꾹 누르기=녹음, 놓기=전사+전송 | `VOICE: Ready` / `REC` |

### 상태별 버튼 변화

**IDLE** (대기 중) — 프롬프트 입력 대기:
```
[ PLAN  ] [ACCEPT ] [  TPL1 ] [  TPL2 ]
[  TPL3 ] [  TPL4 ] [ SEND  ] [ Ctrl+C]
```

**PROCESSING** (처리 중) — Claude가 작업 중:
```
[  dim  ] [  dim  ] [  dim  ] [  dim  ]
[  dim  ] [  dim  ] [  dim  ] [ STOP  ]     ← STOP만 활성 (빨간색)
```

**AWAITING_PERMISSION** (권한 요청) — Yes/No/Always 선택:
```
[  YES  ] [  NO   ] [ALWAYS ] [  dim  ]
[  dim  ] [  dim  ] [  dim  ] [ STOP  ]
```

**AWAITING_OPTION** (옵션 선택) — 다중 선택지:
```
[ OPT 1 ] [ OPT 2 ] [ OPT 3 ] [ OPT 4 ]
[  dim  ] [  dim  ] [  dim  ] [ STOP  ]
```

**AWAITING_DIFF** (Diff 리뷰):
```
[ APPLY ] [ DENY  ] [ VIEW  ] [MODIFY ]
[  dim  ] [  dim  ] [  dim  ] [ STOP  ]
```

**DISCONNECTED** (연결 없음):
```
[NO SESS] [  dim  ] [  dim  ] [  dim  ]
[  dim  ] [  dim  ] [  dim  ] [  dim  ]     ← 모든 버튼 비활성
```

---

## 상태 머신

Bridge는 Claude Code의 hooks와 PTY 출력 파싱을 결합하여 6가지 상태를 관리합니다:

```
                    ┌──────────────┐
         ┌─────────│ DISCONNECTED │◄──── SessionEnd hook / PTY closed
         │         └──────────────┘
         │ sdc start
         ▼
    ┌──────────┐  Stop hook / idle detected
    │   IDLE   │◄─────────────────────────────────┐
    └────┬─────┘                                  │
         │ UserPromptSubmit hook / spinner         │
         ▼                                        │
    ┌──────────────┐  permission prompt detected  │
    │  PROCESSING  │──────────────────────┐       │
    └──────┬───────┘                      │       │
           │                              ▼       │
           │                    ┌─────────────┐   │
           │                    │  AWAITING   │   │
           │                    │  PERMISSION │───┘ user responds (y/n/a)
           │                    └─────────────┘
           │ option UI detected
           ▼
    ┌──────────────┐
    │  AWAITING    │
    │  OPTION      │──────────────────────────────┘ user selects option
    └──────────────┘
```

| 상태 | 설명 | 감지 소스 |
|------|------|----------|
| `DISCONNECTED` | 세션 없음 | `SessionEnd` hook, PTY 종료 |
| `IDLE` | 프롬프트 대기 | `Stop` hook, idle 패턴 감지 |
| `PROCESSING` | Claude 작업 중 | `UserPromptSubmit` hook, spinner 감지 |
| `AWAITING_PERMISSION` | Yes/No 응답 대기 | Notification hook, `(y/n)` 패턴 |
| `AWAITING_OPTION` | 선택지 응답 대기 | 번호 목록 패턴 |
| `AWAITING_DIFF` | Diff 리뷰 대기 | `(V)iew/(A)pply/(D)eny` 패턴 |

---

## WebSocket 프로토콜

Bridge(포트 9120)와 Stream Deck Plugin 간 통신 프로토콜입니다.

### Bridge → Plugin

```typescript
// 상태 변경
{ type: 'state_update', state: 'processing', permissionMode: 'default', currentTool: 'Read' }

// 프롬프트 옵션
{ type: 'prompt_options', promptType: 'yes_no_always', options: [{ index: 0, label: 'Yes' }, ...] }

// 사용량
{ type: 'usage_update', sessionDurationSec: 120, inputTokens: 5000, outputTokens: 3000, toolCalls: 7 }

// 연결 상태
{ type: 'connection', status: 'connected' }
```

### Plugin → Bridge

```typescript
{ type: 'respond', value: 'y' }              // Yes/No/Always 응답
{ type: 'select_option', index: 2 }          // 옵션 선택 (0-based)
{ type: 'send_prompt', text: 'fix the bug' } // 프롬프트 전송
{ type: 'switch_mode', mode: 'plan' }        // 모드 전환 (Shift+Tab)
{ type: 'interrupt' }                        // Ctrl+C
{ type: 'voice', action: 'start' }           // 음성 녹음 시작/중지
```

---

## 프로젝트 구조

```
AgentDeck/
├── shared/                       # 공유 타입 정의
│   └── src/
│       ├── index.ts              # 모든 export 통합
│       ├── states.ts             # State enum, 전환 규칙, StateSnapshot
│       └── protocol.ts           # WebSocket 이벤트/명령 타입, 상수
│
├── bridge/                       # Bridge 서버 (PTY + Hook + WS + Voice)
│   └── src/
│       ├── index.ts              # sdc CLI 엔트리포인트 (commander)
│       ├── pty-manager.ts        # node-pty 래퍼: 스폰, 프록시, 인터럽트
│       ├── output-parser.ts      # ANSI 파싱 + 패턴 매칭 (spinner, y/n, 옵션)
│       ├── hook-server.ts        # HTTP POST 수신 (Claude Code hooks)
│       ├── state-machine.ts      # Hook + PTY 이벤트 통합 상태 관리
│       ├── ws-server.ts          # WebSocket 서버 (플러그인 통신)
│       ├── usage-tracker.ts      # 세션 사용량 추적 (토큰, 비용)
│       ├── voice.ts              # sox 녹음 + whisper.cpp 전사
│       ├── check-deps.ts        # 런타임 의존성 체크 (시작 시 실행)
│       └── types.ts              # Bridge 전용 타입 + shared 재수출
│
├── plugin/                       # Stream Deck SDK v2 플러그인
│   ├── src/
│   │   ├── plugin.ts             # SDK 진입점, 액션 등록
│   │   ├── bridge-client.ts      # WebSocket 클라이언트 (자동 재연결)
│   │   ├── layout-manager.ts     # 상태별 버튼/인코더 레이아웃
│   │   ├── actions/
│   │   │   ├── response-button.ts    # 동적 응답 버튼 (Yes/No/옵션/템플릿)
│   │   │   ├── stop-button.ts        # Ctrl+C 인터럽트 버튼
│   │   │   ├── mode-dial.ts          # 모드 전환 인코더
│   │   │   ├── option-dial.ts        # 옵션 스크롤/선택 인코더
│   │   │   ├── history-dial.ts       # 프롬프트 히스토리 인코더
│   │   │   └── voice-dial.ts         # 음성 입력 인코더
│   │   └── renderers/
│   │       ├── button-renderer.ts    # SVG 버튼 이미지 생성
│   │       └── lcd-renderer.ts       # LCD 스트립 피드백 생성
│   ├── .sdPlugin/
│   │   ├── manifest.json         # Stream Deck 플러그인 매니페스트
│   │   ├── bin/                  # 빌드 출력 (plugin.js)
│   │   └── static/imgs/         # 아이콘 에셋
│   └── rollup.config.mjs        # 번들링 설정
│
├── hooks/                        # Claude Code Hook 설치
│   └── src/
│       └── install.ts            # settings.local.json에 hook 등록/해제
│
├── config/
│   ├── prompt-templates.json     # 프롬프트 템플릿 (TPL 1~4 버튼용)
│   └── default-settings.json     # 기본 설정 (포트, 음성, 타임아웃)
│
├── scripts/
│   ├── install.sh                # 원클릭 설치 (pnpm setup)
│   ├── uninstall.sh              # 제거
│   ├── package-plugin.sh         # .streamDeckPlugin 패키징 (pnpm package)
│   └── generate-icons.mjs        # SVG → PNG 아이콘 생성 (pnpm generate-icons)
│
├── package.json                  # pnpm workspaces 루트
├── pnpm-workspace.yaml           # 워크스페이스 정의
├── tsconfig.base.json            # 공통 TypeScript 설정
├── CLAUDE.md                     # Claude Code 작업 컨텍스트
└── README.md                     # 이 문서
```

---

## 프롬프트 템플릿 커스터마이즈

`config/prompt-templates.json`을 수정하면 IDLE 상태의 TPL 1~4 버튼에 표시되는 프롬프트를 변경할 수 있습니다:

```json
{
  "templates": [
    { "label": "Fix Bug", "prompt": "Please fix the bug described above" },
    { "label": "Test", "prompt": "Write tests for the changes made" },
    { "label": "Review", "prompt": "Review the code for issues and suggest improvements" },
    { "label": "Explain", "prompt": "Explain how this code works step by step" }
  ]
}
```

---

## 장애 대응

| 상황 | 증상 | 대처 |
|------|------|------|
| Bridge 미실행 | 플러그인 DISCONNECTED 표시 | `sdc` 실행 |
| Bridge 크래시 | 플러그인 3초마다 재연결 시도 | `sdc` 재실행 |
| Claude 프로세스 종료 | Bridge가 disconnected 상태 전파 | `sdc` 재실행 |
| Hook 서버 불가 | Claude 정상 작동, 상태 추적 불가 | `sdc` 실행 확인 |
| Stream Deck 미연결 | Bridge 정상 동작, 플러그인만 비활성 | 하드웨어 연결 후 앱 재시작 |
| 5분 이상 PROCESSING | 처리 중 상태 지속 | STOP 버튼 또는 터미널에서 Ctrl+C |
| 음성 인식 실패 | "Is sox installed?" 에러 | `brew install sox` |
| 전사 실패 | "Is whisper.cpp installed?" 에러 | `brew install whisper-cpp` |
| 플러그인 미인식 | Stream Deck 앱 카테고리에 없음 | 앱 재시작, `streamdeck link` 재실행 |

---

## tmux -CC 호환성

iTerm2의 `tmux -CC` (control mode) 환경에서 작업 중이라면: `sdc`를 tmux 윈도우 안에서 실행하면 Bridge가 자체 PTY를 관리하므로 외부 tmux와 충돌 없이 정상 동작합니다.

Signal 전달 체인: `tmux → iTerm2 → sdc → bridge PTY → claude`

---

## 배포용 패키징

다른 사용자에게 배포할 수 있는 `.streamDeckPlugin` 파일을 생성합니다:

```bash
pnpm package
```

이 명령은:
1. 프로젝트를 빌드하고
2. `plugin/.sdPlugin` 디렉터리를 zip으로 패키징하여
3. `dist/bound.serendipity.agentdeck.streamDeckPlugin` 파일을 생성합니다.

배포받은 사용자는 `.streamDeckPlugin` 파일을 더블클릭하면 Stream Deck 앱에 자동 설치됩니다. 단, Bridge 서버(`sdc`)와 Claude Code CLI는 별도로 설치해야 합니다.

> **참고:** sox, whisper.cpp 등 brew 네이티브 바이너리는 `.streamDeckPlugin`에 포함할 수 없으며, 사용자가 직접 설치해야 합니다.

---

## 제거

```bash
bash scripts/uninstall.sh
```

다음을 수행합니다:
- Claude Code hooks 제거
- `sdc` CLI 글로벌 링크 해제
- Stream Deck 플러그인 심볼릭 링크 제거

제거 후 **Stream Deck 앱을 재시작**하세요.

---

## 개발

```bash
# 전체 watch 모드
pnpm -r --parallel dev

# 플러그인만 재빌드
cd plugin && pnpm build

# Bridge만 재빌드
cd bridge && pnpm build

# 타입 체크 (빌드 없이)
pnpm -r typecheck
```

### 디버깅

Bridge 로그는 `sdc` 실행 터미널에 출력됩니다:
```
[sdc] Starting AgentDeck bridge on port 9120...
[sdc] Hook server listening on port 9120
[sdc] WebSocket server ready on port 9120
[sdc] Spawned: claude
[WsServer] Plugin connected
[StateMachine] DISCONNECTED -> idle (trigger: session_start, source: hook)
```

Stream Deck 플러그인 로그: Stream Deck 앱 → 설정 → 로그에서 확인 가능합니다.

---

## 로드맵

### Phase 2 — 고급 인터랙션
- 동적 버튼 이미지 생성 (Canvas API)
- LCD 스트립 상세 표시 (현재 tool, 진행률)
- 사용량/쿼터 추적 (토큰 수, 비용 표시)

### Phase 3 — Intelligence & Multi-Session
- 스마트 프롬프트 제안
- 멀티 세션 관리
- 프로젝트별 버튼 레이아웃 프리셋
