# AgentDeck — App Store vs CLI Feature Matrix

한 장 짜리 레퍼런스. 어떤 기능이 App Store build에서 바로 쓰이고, 어떤 기능이 App Store 밖의 터미널 companion 경로에만 남는지 구분한다.

> **원칙**: App Store build (`bound.serendipity.agentdeck.dashboard`) 는 Apple Review Guideline 2.5.2 (인터프리터 번들링 금지) 에 맞춰 `Process()` / `/bin/sh` / 번들된 Node·Python·sqlite3 바이너리를 전혀 싣지 않는다. 하드웨어 모니터링/통신은 sandbox entitlement 로 해결되므로 가능. 서브프로세스가 필요한 것만 CLI 로 밀려난다.

## Core dashboard

| Feature | App Store | CLI | 비고 |
|---|:---:|:---:|---|
| macOS Dashboard (`AgentDeck Dashboard.app`) | ✅ | ✅ | 단독 실행 가능 |
| iOS / iPadOS 컴패니언 | ✅ | ✅ | Bonjour + WS, same-LAN |
| Stream Deck+ 플러그인 연동 | ✅* | ✅ | *Elgato Stream Deck 앱 별도 설치 |
| Claude Code hook 설치 | ✅ | ✅ | NSOpenPanel 명시적 동의 |
| 음성 입력 (on-device SFSpeech) | ✅ | ✅ | 오디오 외부 송신 없음 |
| APME 평가 Layer 2 (LLM) | ✅ | ✅ | Apple Intelligence / MLX / Anthropic API |
| APME 평가 Layer 1 (deterministic) | ❌ | ✅ | `git` / `pnpm` 서브프로세스 필요 |

## Usage / cost 표시

| Feature | App Store | CLI | 비고 |
|---|:---:|:---:|---|
| Claude 구독 사용량 (5h / 7d %) | ⚠️ | ✅ | 외부 daemon 감지 시에만 RATE LIMITS 섹션 표시 (relay). 미감지 시 섹션 자체 숨김 — sandbox 안내 메시지 없이 완결성있게 보임 |
| Anthropic Admin API 사용량 | ✅ | ✅ | user 가 Console API key 수동 입력 |
| 토큰 / 비용 실시간 (PTY) | ⚠️ | ✅ | App Store 는 hook 기반만, PTY parsing 은 CLI |

## Downstream 하드웨어

| Device | App Store | CLI | 분류 | 비고 |
|---|:---:|:---:|---|---|
| **Ulanzi D200H Deck Dock** | ✅ | ✅ | Built-in USB | IOKit HID, `com.apple.security.device.usb` |
| **Divoom Pixoo64** | ✅ | ✅ | Network LED | HTTP, entitlement 불필요 |
| **ESP32 상태 디스플레이 (모니터링)** | ✅ | ✅ | ESP32 Display | `com.apple.security.device.serial`. 보드: `86box` / `round_amoled` / `ips_35` |
| **ESP32 Wi-Fi 프로비저닝** | ✅ | ✅ | ESP32 Display | 직접 serial write, subprocess 없음 |
| **ESP32 firmware flash** | ❌ | ✅ | ESP32 Display | `esptool.py` 필요 |
| **Ulanzi TC001** (8×32 LED wall clock) | ❌ | ✅ | USB-bridged LED | ADB reverse tunnel 필요 |
| **Android e-ink** (CremaS / Pantone / Kobo) | ❌ | ✅ | Android | ADB 필요 |
| **Android 태블릿** (Lenovo 등) | ❌ | ✅ | Android | ADB 필요 |

## 세션 실행 / agent 런칭

| Feature | App Store | CLI | 비고 |
|---|:---:|:---:|---|
| Claude Code 세션 모니터링 (hook 경유) | ✅ | ✅ | hook HTTP POST 수신 |
| Codex 세션 모니터링 (lifecycle hooks + fallback) | ✅ | ✅ | NSOpenPanel 명시 동의 후 `~/.codex/config.toml` 에 fenced TOML 블록만 편집. Codex lifecycle hooks → `/hooks/codex_*`, optional notify → `/hooks/codex_turn_complete`, optional OTel → `/otel/v1/traces` |
| 외부에서 이미 실행 중인 Claude/Codex 세션 passive discovery | ❌ | ✅ | `ps`/`lsof`/`/proc` + `~/.claude`/`~/.codex` transcript/rollout JSONL read 가 필요하므로 Node CLI daemon 전용. App Store 단독 앱은 hook/lifecycle 로 opt-in 된 세션만 표시하며 결함 안내 없이 완결 UI 유지 |
| OpenCode 세션 모니터링 | ❌ | ✅ | OpenCode 의 random-port 서버에 lock-file 이 없어 다중 인스턴스 discovery 불가. CLI/Node bridge 경로만 |
| Claude Code 세션 실행 (`Launch Session`) | ❌ | ✅ | App Store 는 Terminal 실행을 만들지 않고 hook 모니터링 안내만 표시 |
| Codex / OpenCode 세션 실행 | ❌ | ✅ | `agentdeck` CLI 가 PATH 에 있어야 함 |
| OpenClaw Gateway pairing (WS 모드) | ✅ | ✅ | `ws://127.0.0.1:18789` 클라이언트 |
| OpenClaw Gateway pairing (CLI 모드) | ❌ | ✅ | `openclaw` 바이너리 spawn 필요 |

## 인프라

| Component | App Store | CLI |
|---|:---:|:---:|
| In-process Swift daemon (macOS) | ✅ | — |
| Node.js bridge process | — | ✅ |
| Data directory | `~/Library/Group Containers/group.bound.serendipity.agentdeck.dashboard/` | `~/.agentdeck/` |

## 요약

- **App Store 만 써도** 가능: Claude Code hook 모니터링, **Codex lifecycle hooks + notify/OTel fallback 모니터링**, Anthropic Admin API 사용량 조회, iPad 페어링, **D200H / Pixoo / ESP32** 하드웨어, 음성 입력, APME LLM 평가.
- **App Store 밖 companion 경로**: **Android 기기 전부** (e-ink + 태블릿 + TC001), ESP32 firmware flash, **OpenCode 모니터링**, Codex / OpenCode PTY 세션 실행, OpenClaw CLI 페어링, APME Layer 1 결정적 평가, Claude 구독 사용량 (5h/7d) gauge.

App Store 앱은 companion executable 설치/기동을 요구하지 않는다. 이미 사용자가 터미널에서 별도 daemon을 운영하는 경우에만 같은 포트/WS 프로토콜로 선택적으로 연결되며, 그 신호(`DaemonService.isUsingExternalDaemon`)가 true 일 때만 ADB-tier 디바이스 카드와 RATE LIMITS 섹션이 노출된다(progressive enhancement). 미감지 상태에서는 해당 섹션을 숨겨 단독 앱이 결함 없이 완결성있게 보이도록 한다.

## 유지 원칙 (신규 기능 추가 체크리스트)

이 매트릭스는 단발성 문서가 아니라 **App Store 분리를 지키는 계약**이다. 기능을 추가하거나 이동할 때 아래 순서를 지킨다.

1. **어느 tier 에 속하는지 먼저 결정** — 이 표에 행을 먼저 추가한 뒤 구현을 시작. App Store tier 에 들어간다면 subprocess/bundled interpreter 를 쓰지 않는 구현 경로가 있어야 한다.
2. **subprocess 를 쓰는 코드는 macOS 소스 트리에 들어오지 않는다** — `Process()`, `/bin/sh`, `osascript`, `.command` 스크립트 생성, 외부 CLI (`security`, `sqlite3`, `adb`, `openclaw`, `whisper-cli`) 전부. 비-AppStore macOS GUI 빌드는 더 이상 지원 제품이 아니며, 과거에 있던 `#if !AGENTDECK_APP_STORE` 분기는 2026-04-19 일괄 제거됐다. Swift 컴파일 조건으로 강제되지 않는 TypeScript/plugin 측은 "CLI only" 라는 문서 규칙으로만 분리된다.
3. **App Store 에서 보이는 UI 문구는 companion executable 설치/기동을 유도하지 않는다** — "Install the AgentDeck CLI", "Run `agentdeck daemon install`", "Open Terminal and…" 류 문구는 App Review 4.2.3 리스크. 메시지는 앱 내부 동작 (hook 활성화, Admin API key 붙여넣기) 또는 이미 해결된 상태를 서술한다.
4. **신규 서브프로세스 경로를 반드시 추가해야 한다면** — `apple/scripts/verify-appstore-archive.sh` 의 금지 문자열 목록이 해당 경로를 잡도록 업데이트하고, `apple/APP_REVIEW_NOTES.md` 의 "does not spawn any subprocess" 단락을 함께 수정. CI 가 통과하면 제거됐음이 기계적으로 보장된다.
5. **Release 빌드 + verifier 를 로컬에서 돌린다** —
   ```bash
   xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS \
     -configuration Release -destination 'platform=macOS' \
     -derivedDataPath /tmp/AgentDeckDerivedDataPreRelease build CODE_SIGNING_ALLOWED=NO
   bash apple/scripts/verify-appstore-archive.sh \
     /tmp/AgentDeckDerivedDataPreRelease/Build/Products/Release/AgentDeck.app
   ```
   두 단계 모두 성공해야 제출 준비 완료.
6. **문서를 같이 갱신** — 이 파일, [apple/APP_REVIEW_NOTES.md](../apple/APP_REVIEW_NOTES.md), [docs/appstore-metadata-draft.md](appstore-metadata-draft.md) 세 곳이 같은 이야기를 해야 한다. metadata 의 "Optional developer extensions" 섹션이 사실과 달라지면 review note 도 함께 수정.

## Anti-patterns (과거 후퇴했다가 복구한 경우)

이 패턴들이 다시 들어오면 App Review 에서 걸릴 가능성이 높다. 코드 리뷰 시 자동으로 주의:

- App Store 코드 경로에서 `Process()` / `NSAppleScript` / `.command` 파일 생성 (2026-04 복구; 2026-04-19 분기 자체 삭제)
- Setup card 문구에서 "Install AgentDeck CLI", "Run `agentdeck daemon install`" (2026-04 복구)
- Settings 에 "Switch D200H to Bundled Helper" 같은 companion binary 기동 버튼 (2026-04 가림; 2026-04-19 코드/UI 모두 제거)
- `openclaw devices approve` 같이 외부 CLI 사용 지시 문구 (2026-04 가림)
- `gatewayAvailable` 만으로 OpenClaw 연결 UI 를 "연결됨" 처럼 그리기 → 반드시 `gatewayConnected` (인증 완료) 기준
- Setup card / RATE LIMITS 섹션에서 "sandbox 안내" 메시지로 "결함" 인상 주기 → 외부 daemon 미감지 시 섹션 자체를 숨겨 단독 앱이 완결성있게 보이도록 한다 (2026-04-19)
