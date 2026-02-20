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
pnpm package                # create dist/bound.serendipity.claude-code.streamDeckPlugin
bash scripts/uninstall.sh   # remove hooks, unlink CLI and plugin
```

## Development

```bash
pnpm -r --parallel dev   # watch mode for all packages
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
- **Port 9120** shared by HTTP (hooks) and WebSocket (plugin communication)
- **Shift+Tab** (`\x1b[Z`) for Claude Code mode switching (800ms debounce)
- **sox/rec** for audio capture, **whisper.cpp** for transcription
- Hook scripts use `|| true` to avoid blocking Claude when bridge is down
- **Action ID pattern**: All SD actions store string IDs and use `getActionById()` — never store action object references

## v3 Layout (0.3.0)

**Keypad (7 actions):**

| Slot | Action | Description |
|------|--------|-------------|
| 0 | MODE | Mode toggle (Default/Plan/Accept) |
| 1 | SESSION & STATUS | Project + state + session switch (merged from v2 Session + Status) |
| 2 | USAGE | Usage dashboard (5h/7d/extra/session pages) |
| 3-5 | DYNAMIC ×3 | TPL1/TPL2/COMPACT (idle) or YES/NO/ALWAYS (permission) |
| 6 | STOP | Interrupt |

**Encoders (4 slots):**

| E# | Action | Rotate | Push |
|----|--------|--------|------|
| E1 | Option Selector | Scroll options | Select |
| E2 | Voice Input | Scroll transcription | Hold=record, tap(<500ms)=cancel |
| E3 | Quick Command | Cycle /compact /status /cost /clear /model | Execute |
| E4 | (empty) | — | — |

## References

- **SDK Docs**: https://docs.elgato.com/streamdeck/sdk
  - [Actions](https://docs.elgato.com/streamdeck/sdk/plugin-guides/actions) · [Keys](https://docs.elgato.com/streamdeck/sdk/plugin-guides/keys) · [Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/plugin-guides/dials-touch-strip)
  - [Manifest schema](https://docs.elgato.com/streamdeck/sdk/references/manifest) · [Touch Strip Layout](https://docs.elgato.com/streamdeck/sdk/references/touch-strip-layout) · [WebSocket API](https://docs.elgato.com/streamdeck/sdk/references/websocket-api)
- **Plugin Samples**: https://github.com/elgatosf/streamdeck-plugin-samples (layouts, cat-keys, hello-world, data-sources, lights-out)
- **Local SDK reference** (manifest schema, layout items, API methods): `memory/streamdeck-sdk.md`

## v3 Changes from v2

- **Encoder LCD fix**: Stale action references → string ID + `getActionById()` pattern
- **Session & Status merged**: One button shows project/mode/model (idle) or state labels (running/permission/etc)
- **SEND removed**: Replaced with /compact quick button
- **Extra Usage**: API usage page for pay-per-use billing (`extra_usage`)
- **Quick Command dial**: New E3 encoder for slash commands
- **Voice UX**: Min recording time, pulsing indicator bar, error clear, scroll transcription
- **Mode debounce**: 800ms bridge debounce + 2s parser timeout prevents rapid-fire mode cycling
