# Architecture

Core bridge architecture, adapter hierarchy, and module system. See [daemon.md](daemon.md) for the daemon hub design and [plugin-conventions.md](plugin-conventions.md) for plugin internals.

## Monorepo layout

- **bridge/** — Node.js server: Daemon (sole hub for all clients, mDNS, device modules) + Session Bridge (PTY, hook HTTP, state machine). BridgeCore (shared infra), PtyAdapter hierarchy, output parser, WebSocket server, voice (whisper.cpp), usage API client, auth token, SSE broadcast, TUI dashboard (`tui/`)
- **plugin/** — Stream Deck SDK v2 plugin: actions for buttons/encoders, bridge WebSocket client
- **shared/** — TypeScript types and utilities shared between bridge and plugin (protocol, states, timeline, adapter interfaces, `format-utils` time/count/bytes formatters, `timeline-summarizer` extractTopicHint/cleanLLMOutput, `deduplicateEntry` pipeline, `session-utils` stateRank/sortSessions/assignDisplayNames — 세션 정렬/번호 공통 유틸리티, 6곳에서 import)
- **hooks/** — Claude Code hook installer for `~/.claude/settings.local.json`
- **config/** — Default settings and prompt templates
- **setup/** — npm setup package: `npx @agentdeck/setup` one-command installer
- **android/** — Jetpack Compose launcher app: e-ink monitoring + interactive Deck control (CremaS, Onyx, Kobo, tablets)
- **apple/** — SwiftUI Multiplatform app: iPhone/iPad/macOS dashboard + Deck control (App Store distribution). macOS includes **in-process Swift daemon** (`AgentDeck/Daemon/`, 30 files ~5500 LOC) — WS/HTTP server, mDNS, ESP32 serial, D200H HID (IOKit), Pixoo, OpenClaw Gateway WebSocket, voice assistant, hooks auto-installer. No Node.js dependency for daemon. ADB-tunneled Android/TC001 previews and PTY session launch are external Node CLI/daemon capabilities that the App Store app only visualizes when `DaemonService.isUsingExternalDaemon` is true. `DaemonService` starts daemon on app launch (SIGTERM handler for clean shutdown, `NWPathMonitor` for WiFi/VPN/IP change recovery). `MenuBarExtra` **AI Control Tower** (`.menuBarExtraStyle(.window)`, 340×450 panel): Attention/Active/Idle 3-tier session list with creature SF Symbol icons per agent type (water.waves/ladybug/cloud/terminal/server.rack), model name + relative time in subtitles, rate limit trend arrows (↑↓) with emphasized reset time when >70%, click-to-focus session rows, Models & Services (Claude OAuth + Gateway + Ollama + MLX + subscriptions + rate limits), device status. Dynamic `AgentStatusIcon` (SF Symbol only — MenuBarExtra label은 단순 Image만 지원). **Launch Session** is App Store-safe guidance only: the app does not create Terminal windows, `.command` files, AppleScript prompts, or child processes. `session_command` protocol remains available for commands routed through an already-running bridge. Dashboard keyboard shortcuts (`⌘Y/N/⏎/.`), creature tap → session focus, toast notifications on state change
- **esp32/** — PlatformIO Arduino firmware: LVGL touch displays (ESP32-S3: 86Box 480×480, IPS 3.5" 480×320 landscape / 320×480 portrait, Round AMOLED 360×360) + WS2812B LED matrix (ESP32 classic: Ulanzi TC001 8×32). Board-specific `#ifdef`, per-board partition tables, FastLED matrix renderer bypasses LVGL entirely. IPS 3.5" supports runtime portrait↔landscape switching via `set_orientation` protocol command or Settings toggle (NVS persistent, `g_screenW`/`g_screenH` runtime globals)

## Language/tooling

- **pnpm workspaces** for monorepo management
- **ES modules** throughout (type: "module")
- **Node16 module resolution** in TypeScript

## BridgeCore

`bridge/src/bridge-core.ts` — Shared infrastructure class used by both `startSession()` (index.ts) and `startDaemon()` (daemon-server.ts). Contains StateMachine, WsServer, UsageTracker, DisplayMonitor, OllamaProbe, state caches, and common event wiring. Eliminates ~600 lines of duplication.

## PtyAdapter hierarchy

`bridge/src/adapters/pty-adapter.ts` — Abstract base class for PTY-based agents. Subclasses implement `getDefaultCommand()`, `wireOutputParser()`, `feedParser()`, `handleAgentCommand()`.

- `ClaudeCodeAdapter` extends PtyAdapter with OutputParser + Shift+Tab mode switching
- `CodexCliAdapter` extends PtyAdapter with CodexOutputParser (Ink TUI `›` prompt, `Working(Ns •` spinner, no HTTP hooks)
- `OpenCodeAdapter` extends PtyAdapter + SSE overlay (spawns `opencode --port XXXX` TUI, connects to embedded HTTP server for structured events — no TUI parsing needed)
- `MonitorAdapter` is hook-only (no PTY)

## Device module system

`bridge/src/modules/` — Pluggable `DeviceModule` interface with auto-detect. Modules: mdns/serial/pixoo (daemon-only), adb (`'auto'` — detect at startup). D200H removed from Node.js bridge — **Swift daemon is sole D200H controller**. Session bridges never activate serial/pixoo — all dashboard devices connect via daemon only. CLI flags: `--local` (all off), `--no-{module}` (daemon).

## AgentAdapter abstraction (Phase 1-2 complete)

- `shared/src/adapter.ts` — `AgentAdapter` interface, `AgentCapabilities`, `AdapterEvent` types, `AgentType` union (`'claude-code' | 'openclaw' | 'codex-cli' | 'monitor'`), `MONITOR_CAPABILITIES`
- `bridge/src/adapters/pty-adapter.ts` — `PtyAdapter` abstract base (PtyManager + HookServer + common start/command handling)
- `bridge/src/adapters/claude-code.ts` — `ClaudeCodeAdapter extends PtyAdapter` (OutputParser + Shift+Tab mode switch). ~100줄 (was 227)
- `bridge/src/adapters/monitor.ts` — `MonitorAdapter` (hook-only, no PTY, `isAlive()` always true)
- `bridge/src/adapters/openclaw.ts` — `OpenClawAdapter` connecting to Gateway WebSocket
- `bridge/src/adapters/index.ts` — `createAdapter(type, gatewayUrl?)` factory (`'monitor'` → MonitorAdapter)
- Bridge `cli.ts` handles `--agent` + `--gateway` CLI flags; `index.ts` exports `startSession()`
- `StateUpdateEvent` includes `agentType` + `agentCapabilities` for plugin capability gating
- Adapter emits unified `AdapterEvent` (hook/parser/metadata/activity/connection)
- **Command routing split**: ClaudeCode defers `select_option`/`navigate_option`/`send_prompt` to bridge (PTY); OpenClaw handles all commands via RPC. Bridge updates StateMachine for adapter-handled commands.
- **OpenClaw capabilities**: `hasTerminal=false`, `hasModeSwitching=false`, `hasDiffReview=false`, `hasOptionLists=true`, `hasNavigablePrompts=false`, `hasSuggestedPrompts=false`, `hasApiUsage=false`

### OpenClaw Gateway protocol (v2 + v3, verified against OpenClaw 2026.4.14)

- Custom framing: `{ type: "req"/"res"/"event", ... }` (NOT JSON-RPC)
- Ed25519 device auth handshake: `connect.challenge` → `connect`
  - **v2 (Node CLI bridge)**: signed with `~/.openclaw/identity/` keypair (file-based)
  - **v3 (App Store macOS)**: self-generated Ed25519 keypair (no file I/O; private key in Keychain). `deviceId = sha256(raw pubkey)`, `token` issued by Gateway in `hello-ok.auth.deviceToken` on first pairing and reused on reconnect. Pairing requires manual approval via `openclaw devices approve <requestId>` or OpenClaw Web UI.
- Methods: `connect`, `health`, `models.list`, `logs.tail`, `sessions.list`, `sessions.subscribe`, `sessions.messages.subscribe`, `chat.send`, `chat.abort`, `exec.approval.resolve`, `system-presence`
- Events: `connect.challenge`, `health`, `sessions.changed`, `session.message`, `session.tool`, `chat` (delta/final/aborted/error), `exec.approval.requested/resolved`, `presence`, `tick`, `shutdown`
- Session tracking via `sessionKey` from `sessions.list` / `chat` events
- Default port 18789, auto-reconnect with exponential backoff; auth failures (`pairing_required`/`token_mismatch`/`device_auth_invalid`) surface to UI instead of looping. See [docs/gateway-protocol.md](gateway-protocol.md) for wire format.

## Plugin connection (daemon-only single path)

- `plugin/src/connection-manager.ts` — Bridge-only, no direct Gateway connection. `switchToOpenClaw()`/`switchToClaude()` send `switch_agent` WS command to daemon
- `plugin/src/agent-link.ts` — `AgentLink` interface (send/isConnected/getCapabilities/disconnect)
- Plugin connects to daemon or session bridge via BridgeClient only. All OpenClaw interaction proxied through daemon
- **Removed**: `gateway-client.ts`, `log-stream.ts`, `timeline-summarizer.ts` (plugin no longer connects to Gateway directly — daemon is sole Gateway connection point)

## Plugin capability gating (Phase 5 complete)

- `iterm-dial.ts`, `option-dial.ts` → `!hasTerminal`/`!hasSuggestedPrompts`
- `response-button.ts` → `!hasDiffReview`
- `plugin.ts` → 8곳 `caps` 전달

## node-pty optional

`optionalDependencies` + dynamic `await import('node-pty')` in PtyManager. Daemon/monitor modes never load the native module. Setup forces source build (`npm_config_build_from_source=true`) to avoid prebuilt ABI mismatch across Node versions. PtyManager catches `posix_spawnp` errors with rebuild guidance.
