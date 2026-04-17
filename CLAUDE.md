# AgentDeck

Stream Deck+ controller for Claude Code CLI — a bidirectional local control system.

## Monorepo

- **bridge/** — Node.js server: Daemon hub + Session Bridge (PTY, hook HTTP, state machine). `src/apme/` — APME eval module (SQLite store, collector, deterministic+LLM judge runner, category-aware rubrics, turn-level mid-session eval, rubric auto-tuner, recommender, daemon HTTP API). See [docs/apme.md](docs/apme.md)
- **plugin/** — Stream Deck SDK v2 plugin
- **shared/** — TypeScript types/utils shared between bridge & plugin (protocol, states, timeline, adapter interfaces, session-utils)
- **hooks/** — Claude Code hook installer for `~/.claude/settings.local.json`
- **config/** — Default settings and prompt templates
- **setup/** — npm setup package (`npx @agentdeck/setup`)
- **android/** — Jetpack Compose launcher app (CremaS, Onyx, Kobo, tablets)
- **apple/** — SwiftUI Multiplatform app (iOS/iPadOS/macOS). macOS includes **in-process Swift daemon** (30 files ~5500 LOC, no Node.js dependency)
- **esp32/** — PlatformIO Arduino firmware (LVGL touch displays + WS2812B matrix)

See [docs/architecture.md](docs/architecture.md) for full architecture details (BridgeCore, PtyAdapter hierarchy, device modules, AgentAdapter abstraction, Gateway protocol, plugin connection model).

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

- **URL**: `https://puritysb.github.io/AgentDeck/` (landing) / `/reports/` (test report) / `/demo/` (creature-simulator)
- **Workflow**: `.github/workflows/test-report.yml` — push to master → Vitest + Android JUnit + Robot Framework (no-hw) + `pnpm run demo:build` → HTML report → GitHub Pages deploy
- **Report generator**: `scripts/generate-html-report.py` — tab-based SPA dashboard. Robot tab: suite→scenario→BDD steps→board matrix→per-test elapsed time→performance table. `[PERF]` log messages auto-extracted from output.xml
- **Scenario matrix**: `scripts/scenario-matrix.json` — 10 user scenarios mapped to test files + gap analysis
- **Landing page**: `scripts/pages-index.html`

See [docs/testing.md](docs/testing.md) for full testing reference.

## CLI

The CLI command is `agentdeck` (`bridge/src/cli.ts`).

```bash
# Session commands (agent name = top-level command)
agentdeck claude             # Claude Code session (PTY + bridge)
agentdeck claude --local     # No device modules (WS only)
agentdeck codex              # Codex CLI session (PTY + bridge)
agentdeck opencode           # OpenCode session (PTY + SSE bridge)
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

ESP32 WiFi provisioning + disconnect recovery details: see [docs/esp32.md](docs/esp32.md).

## Key Conventions

- **Hook format (CRITICAL)**: Claude Code v2.1+ requires 3-level nesting: `{ matcher: "", hooks: [{ type: "command", command: "..." }] }`. Old flat format silently fails. Bridge auto-migrates via `migrateHooksIfNeeded()` from `@agentdeck/hooks`. Scripts use `|| true` to avoid blocking when bridge is down
- **Plugin UUID**: `bound.serendipity.agentdeck` (immutable post-distribution)
- **Package scope**: `@agentdeck/*` (shared, bridge, plugin, hooks, setup)
- **User data dir**: `~/.agentdeck/` — `daemon.json`, `sessions.json`, `auth-token`, `settings.json`, `timeline.json`, `wifi-config.json`, `compatibility.json`, `apme.sqlite`
- **Daemon hub**: Port 9120, sole entry point for all dashboard clients. Session bridges serve internal hook HTTP only (9121-9139). Session bridges push state to daemon via internal WS (`daemon-ws-client.ts`); daemon falls back to HTTP `/health` polling when push is stale. See [docs/daemon.md](docs/daemon.md)
- **Action ID pattern**: SD actions store string IDs + `getActionById()` — never action object references
- **Shift+Tab** (`\x1b[Z`) for Claude Code mode switching (100ms debounce)
- **Version compatibility**: `agentdeck claude` checks Claude Code version via npm + GitHub on startup; never blocks startup

## Documentation Index

| Doc | Topic |
|---|---|
| [docs/why-apme.md](docs/why-apme.md) | **WHY** APME — 감 기반 라우팅 문제, 카테고리별 평가 전략, composite score, vibe labeling 우선 원칙 |
| [docs/apme.md](docs/apme.md) | APME eval module — schema, collector, deterministic+LLM judge, rubric tuner, daemon API, settings |
| [docs/apme-pipeline.md](docs/apme-pipeline.md) | APME 8-layer pipeline — ingestion (hook/timeline/PTY), collector→store, classifier, runner, tuner, HTTP/WS, device rendering |
| [docs/architecture.md](docs/architecture.md) | Monorepo layout, BridgeCore, PtyAdapter, AgentAdapter, Gateway protocol, plugin connection |
| [docs/daemon.md](docs/daemon.md) | Daemon hub, singleton guard, mDNS recovery, usage relay, Gateway isolation, multi-surface monitoring |
| [docs/plugin-conventions.md](docs/plugin-conventions.md) | Encoder LCD, wide canvas, button label, OC Timeline pipeline, D200H HID, display sleep/wake |
| [docs/v4-layout.md](docs/v4-layout.md) | v4 Session-Per-Button keypad + encoder mapping, v3→v4 changes |
| [docs/tui-dashboard.md](docs/tui-dashboard.md) | `agentdeck dashboard` — terrarium, sprites, adaptive layouts |
| [docs/esp32.md](docs/esp32.md) | Firmware boards, flash safety, WiFi provisioning, disconnect recovery |
| [docs/android.md](docs/android.md) | Android device support matrix, creature rendering |
| [docs/android-ui.md](docs/android-ui.md) | Android UI/UX Vision — e-ink + tablet layouts, creatures, refresh zones |
| [docs/voice-setup.md](docs/voice-setup.md) | sox/whisper install + bridge voice runtime |
| [docs/devices.md](docs/devices.md) | Device-specific details |
| [docs/protocol.md](docs/protocol.md) | Bridge ↔ plugin WebSocket protocol |
| [docs/testing.md](docs/testing.md) | Test infrastructure reference |
| [docs/wake-word.md](docs/wake-word.md) | Porcupine / microWakeWord |
| [docs/streamdeck-layout.md](docs/streamdeck-layout.md) | Stream Deck layout reference |

## References

- **SDK Docs**: https://docs.elgato.com/streamdeck/sdk
  - [Actions](https://docs.elgato.com/streamdeck/sdk/plugin-guides/actions) · [Keys](https://docs.elgato.com/streamdeck/sdk/plugin-guides/keys) · [Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/plugin-guides/dials-touch-strip)
  - [Manifest schema](https://docs.elgato.com/streamdeck/sdk/references/manifest) · [Touch Strip Layout](https://docs.elgato.com/streamdeck/sdk/references/touch-strip-layout) · [WebSocket API](https://docs.elgato.com/streamdeck/sdk/references/websocket-api)
- **Plugin Samples**: https://github.com/elgatosf/streamdeck-plugin-samples (layouts, cat-keys, hello-world, data-sources, lights-out)
- **Local SDK reference** (manifest schema, layout items, API methods): `memory/streamdeck-sdk.md`
