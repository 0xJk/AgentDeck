# AgentDeck

**Stop Chatting. Start Steering.**

AgentDeck turns your Elgato Stream Deck+ into a physical control surface for AI coding agents like Claude Code and OpenClaw.

> Control sessions. Interrupt runs. Switch modes. Monitor usage.
> Steer your AI — without leaving your keyboard flow.

```
┌──────────────────────┐   WebSocket (ws://localhost:9120)   ┌────────────────────┐
│  Stream Deck Plugin  │◄───────────────────────────────────►│   Bridge Server    │
│  (Node.js, SDK v2)   │   state updates ← / → commands     │   (Node.js)        │
│                      │                                     │                    │
│  8 Keys              │                                     │  ┌──────────────┐  │
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

## What is AgentDeck?

AgentDeck is not a chat app, a plugin, or a shortcut collection.

It's a **control surface** — like an audio mixing console or a video color panel, but for AI coding agents. It reads your agent's state in real-time and dynamically reconfigures buttons and encoders to match what's happening right now.

| What it does | How |
|---|---|
| **Respond instantly** to permission prompts | YES / NO / ALWAYS buttons appear when needed |
| **Interrupt** a runaway agent | STOP button sends Ctrl+C |
| **Switch modes** on the fly | Encoder cycles Plan / Accept Edits / Default |
| **Navigate options** physically | Encoder scrolls and selects multi-choice prompts |
| **Speak to your agent** | Push-to-talk voice → whisper.cpp transcription → auto-send |
| **Monitor usage** | Usage dashboard with 5h / 7d / extra / session pages |
| **Run quick commands** | Encoder cycles /compact /status /cost /clear /model |
| **Stay in flow** | Hardware augments your keyboard — never interrupts it |

The bridge stays transparent: if it's off, Claude Code works exactly as before.

### Supported Agents

| Agent | Status |
|-------|--------|
| **Claude Code** | Supported |
| **OpenClaw** | Planned |

---

## Prerequisites

| Item | Required | Install |
|------|----------|---------|
| **Node.js** >= 20 | Yes | `brew install node` |
| **pnpm** | Yes | `npm install -g pnpm` |
| **Elgato Stream Deck app** | Yes | [Elgato Downloads](https://www.elgato.com/downloads) |
| **Stream Deck+ hardware** | Yes | 8 keys + 4 encoders + LCD touch strip |
| **Claude Code CLI** | Yes | `npm install -g @anthropic-ai/claude-code` |
| **Stream Deck CLI** | Yes | `npm install -g @elgato/cli` |
| **sox** (audio capture) | For voice | `brew install sox` |
| **whisper.cpp** (transcription) | For voice | `brew install whisper-cpp` |

---

## Quick Start

```bash
cd AgentDeck
pnpm setup
```

This single command:
1. Checks required dependencies (Node.js 20+, pnpm, Claude CLI, Stream Deck app)
2. Installs `@elgato/cli` if missing
3. Runs `pnpm install` + `pnpm build`
4. Generates icon assets (16 PNGs)
5. Installs Claude Code hooks
6. Links the Stream Deck plugin
7. Links the `sdc` CLI globally
8. Checks optional dependencies (sox, whisper.cpp)

After setup, **restart the Stream Deck app**, then run:

```bash
sdc
```

You're steering.

---

## Manual Build & Install

### Build

```bash
cd AgentDeck
pnpm install
pnpm build            # shared → bridge, plugin, hooks
pnpm generate-icons   # SVG → PNG (required on first build)
```

Build output:
- `shared/dist/` — shared type definitions
- `bridge/dist/` — bridge server + `sdc` CLI
- `plugin/.sdPlugin/bin/plugin.js` — Stream Deck plugin bundle
- `hooks/dist/` — hook installer
- `plugin/.sdPlugin/static/imgs/` — icon assets (16 PNGs)

### 1. Install Claude Code Hooks

The bridge receives structured events (tool calls, session lifecycle, etc.) via hooks:

```bash
node hooks/dist/install.js
```

Registers 7 hooks in `~/.claude/settings.local.json`:
- `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `UserPromptSubmit`

Each hook POSTs JSON to the bridge's HTTP server. If the bridge is down, `|| true` ensures Claude is unaffected.

To remove hooks:
```bash
node hooks/dist/install.js uninstall
```

### 2. Link Stream Deck Plugin

```bash
cd plugin
streamdeck link .sdPlugin
```

Creates a symlink in `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`. **Restart the Stream Deck app** to load the plugin.

### 3. Link `sdc` CLI

```bash
cd bridge
pnpm link --global
```

The `sdc` command is now available globally.

### 4. Voice Setup (Optional)

```bash
brew install sox
brew install whisper-cpp
whisper-cli --download-model large-v3-turbo   # ~1.5GB, high-quality Korean/English
```

`large-v3-turbo` delivers large-v3 quality at faster speed, with Apple Neural Engine acceleration on Apple Silicon.

---

## Usage

### Start

```bash
sdc
```

This starts the bridge on port 9120 (HTTP + WebSocket), spawns Claude Code inside a PTY, and proxies your terminal transparently. Use Claude exactly as before — the Stream Deck adds a parallel control channel.

### CLI Commands

```bash
sdc status           # check bridge/session state
sdc stop             # end session
sdc --port 9200      # custom port
sdc --command 'claude --model opus'  # custom Claude command
```

---

## Stream Deck+ Layout (v3)

### Keypad — 7 Actions

```
┌────────┬──────────────────┬─────────┬───────────┐
│  MODE  │ SESSION & STATUS │  USAGE  │ DYNAMIC 1 │
├────────┼──────────────────┼─────────┼───────────┤
│ DYN 2  │    DYNAMIC 3     │  STOP   │           │
└────────┴──────────────────┴─────────┴───────────┘
```

| Slot | Action | Description |
|------|--------|-------------|
| 0 | **MODE** | Toggle Default / Plan / Accept Edits |
| 1 | **SESSION & STATUS** | Project name + state + session switch |
| 2 | **USAGE** | Usage dashboard (5h / 7d / extra / session pages) |
| 3–5 | **DYNAMIC ×3** | TPL1 / TPL2 / COMPACT when idle — YES / NO / ALWAYS on permission prompt |
| 6 | **STOP** | Interrupt (Ctrl+C) |

### Encoders — 4 Slots

| Encoder | Action | Rotate | Push |
|---------|--------|--------|------|
| E1 | **Option Selector** | Scroll options | Select |
| E2 | **Voice Input** | Scroll transcription | Hold = record, tap (<500ms) = cancel |
| E3 | **Quick Command** | Cycle /compact /status /cost /clear /model | Execute |
| E4 | *(empty)* | — | — |

### Dynamic Button States

The keypad reconfigures automatically based on agent state:

**IDLE** — waiting for input:
```
[ MODE  ] [ PROJ  ] [ USAGE ] [ TPL1  ]
[ TPL2  ] [COMPACT] [ STOP  ] [       ]
```

**PROCESSING** — agent working:
```
[  dim  ] [  dim  ] [  dim  ] [  dim  ]
[  dim  ] [  dim  ] [ STOP  ] [       ]     ← only STOP active
```

**AWAITING PERMISSION** — Yes/No/Always:
```
[ MODE  ] [ STATE ] [ USAGE ] [  YES  ]
[  NO   ] [ALWAYS ] [ STOP  ] [       ]
```

**AWAITING OPTION** — multi-choice:
```
[ MODE  ] [ STATE ] [ USAGE ] [ OPT 1 ]
[ OPT 2 ] [ OPT 3 ] [ STOP  ] [       ]
```

**DISCONNECTED** — no session:
```
[  dim  ] [  dim  ] [  dim  ] [  dim  ]
[  dim  ] [  dim  ] [  dim  ] [       ]     ← all disabled
```

---

## State Machine

The bridge combines hook events and PTY output parsing to maintain 6 states:

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

| State | Description | Detection |
|-------|-------------|-----------|
| `DISCONNECTED` | No session | `SessionEnd` hook, PTY exit |
| `IDLE` | Waiting for prompt | `Stop` hook, idle pattern |
| `PROCESSING` | Agent working | `UserPromptSubmit` hook, spinner |
| `AWAITING_PERMISSION` | Yes/No response needed | Notification hook, `(y/n)` pattern |
| `AWAITING_OPTION` | Selection needed | Numbered list pattern |
| `AWAITING_DIFF` | Diff review | `(V)iew/(A)pply/(D)eny` pattern |

---

## WebSocket Protocol

Communication between the bridge (port 9120) and the Stream Deck plugin.

### Bridge → Plugin

```typescript
// State change
{ type: 'state_update', state: 'processing', permissionMode: 'default', currentTool: 'Read' }

// Prompt options
{ type: 'prompt_options', promptType: 'yes_no_always', options: [{ index: 0, label: 'Yes' }, ...] }

// Usage stats
{ type: 'usage_update', sessionDurationSec: 120, inputTokens: 5000, outputTokens: 3000, toolCalls: 7 }

// Connection status
{ type: 'connection', status: 'connected' }
```

### Plugin → Bridge

```typescript
{ type: 'respond', value: 'y' }              // Yes/No/Always response
{ type: 'select_option', index: 2 }          // Option selection (0-based)
{ type: 'send_prompt', text: 'fix the bug' } // Send prompt
{ type: 'switch_mode', mode: 'plan' }        // Mode switch (Shift+Tab)
{ type: 'interrupt' }                        // Ctrl+C
{ type: 'voice', action: 'start' }           // Voice record start/stop
```

---

## Project Structure

```
AgentDeck/
├── shared/                       # Shared type definitions
│   └── src/
│       ├── index.ts              # Re-exports
│       ├── states.ts             # State enum, transitions, StateSnapshot
│       └── protocol.ts           # WebSocket event/command types, constants
│
├── bridge/                       # Bridge server (PTY + Hook + WS + Voice)
│   └── src/
│       ├── index.ts              # sdc CLI entry (commander)
│       ├── pty-manager.ts        # node-pty wrapper: spawn, proxy, interrupt
│       ├── output-parser.ts      # ANSI parsing + pattern matching
│       ├── hook-server.ts        # HTTP POST receiver (Claude Code hooks)
│       ├── state-machine.ts      # Hook + PTY event → state management
│       ├── ws-server.ts          # WebSocket server (plugin comms)
│       ├── usage-tracker.ts      # Session usage tracking (tokens, cost)
│       ├── voice.ts              # sox capture + whisper.cpp transcription
│       ├── check-deps.ts         # Runtime dependency check
│       └── types.ts              # Bridge-local types + shared re-exports
│
├── plugin/                       # Stream Deck SDK v2 plugin
│   ├── src/
│   │   ├── plugin.ts             # SDK entry, action registration
│   │   ├── bridge-client.ts      # WebSocket client (auto-reconnect)
│   │   ├── layout-manager.ts     # State-driven button/encoder layout
│   │   ├── actions/
│   │   │   ├── response-button.ts    # Dynamic response button
│   │   │   ├── stop-button.ts        # Ctrl+C interrupt
│   │   │   ├── mode-dial.ts          # Mode encoder
│   │   │   ├── option-dial.ts        # Option scroll/select encoder
│   │   │   ├── history-dial.ts       # Prompt history encoder
│   │   │   └── voice-dial.ts         # Voice input encoder
│   │   └── renderers/
│   │       ├── button-renderer.ts    # SVG button image generation
│   │       └── lcd-renderer.ts       # LCD strip feedback
│   ├── .sdPlugin/
│   │   ├── manifest.json         # Stream Deck plugin manifest
│   │   ├── bin/                  # Build output (plugin.js)
│   │   └── static/imgs/         # Icon assets
│   └── rollup.config.mjs        # Bundle config
│
├── hooks/                        # Claude Code hook installer
│   └── src/
│       └── install.ts            # Register/unregister hooks in settings.local.json
│
├── config/
│   ├── prompt-templates.json     # Prompt templates (dynamic button labels)
│   └── default-settings.json     # Defaults (port, voice, timeouts)
│
├── scripts/
│   ├── install.sh                # One-click setup (pnpm setup)
│   ├── uninstall.sh              # Remove everything
│   ├── package-plugin.sh         # Build .streamDeckPlugin (pnpm package)
│   └── generate-icons.mjs        # SVG → PNG icon generation
│
├── package.json                  # pnpm workspaces root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── CLAUDE.md
└── README.md
```

---

## Configuration

### Prompt Templates

Edit `config/prompt-templates.json` to customize the dynamic buttons shown during IDLE state:

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

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Plugin shows DISCONNECTED | Bridge not running | Run `sdc` |
| Plugin reconnects every 3s | Bridge crashed | Restart `sdc` |
| Bridge enters disconnected state | Claude process exited | Restart `sdc` |
| State tracking not working | Hook server unreachable | Verify `sdc` is running |
| Stream Deck buttons inactive | Hardware not connected | Reconnect + restart app |
| Stuck in PROCESSING > 5 min | Agent stalled | STOP button or Ctrl+C in terminal |
| "Is sox installed?" | sox missing | `brew install sox` |
| "Is whisper.cpp installed?" | whisper.cpp missing | `brew install whisper-cpp` |
| Plugin not in Stream Deck app | Plugin not linked | Restart app, re-run `streamdeck link` |

### tmux -CC Compatibility

When using iTerm2's `tmux -CC` (control mode): run `sdc` inside a tmux window. The bridge manages its own PTY, so there's no conflict.

Signal chain: `tmux → iTerm2 → sdc → bridge PTY → claude`

---

## Packaging & Distribution

Build a distributable `.streamDeckPlugin` file:

```bash
pnpm package
```

This builds the project, zips `plugin/.sdPlugin`, and outputs `dist/bound.serendipity.agentdeck.streamDeckPlugin`.

Recipients double-click the file to install in the Stream Deck app. The bridge (`sdc`) and Claude Code CLI must be installed separately.

> **Note:** Native binaries (sox, whisper.cpp) cannot be bundled in the plugin and must be installed by the user.

---

## Uninstall

```bash
bash scripts/uninstall.sh
```

Removes Claude Code hooks, unlinks `sdc` CLI, and removes the Stream Deck plugin symlink. **Restart the Stream Deck app** afterward.

---

## Development

```bash
pnpm -r --parallel dev    # Watch mode for all packages
cd plugin && pnpm build   # Rebuild plugin only
cd bridge && pnpm build   # Rebuild bridge only
pnpm -r typecheck         # Type check without building
```

### Debugging

Bridge logs print to the `sdc` terminal:
```
[sdc] Starting AgentDeck bridge on port 9120...
[sdc] Hook server listening on port 9120
[sdc] WebSocket server ready on port 9120
[sdc] Spawned: claude
[WsServer] Plugin connected
[StateMachine] DISCONNECTED -> idle (trigger: session_start, source: hook)
```

Stream Deck plugin logs: Stream Deck app → Settings → Logs.

---

## Roadmap

### Multi-Agent Support
- **OpenClaw** integration — state monitoring + controller
- Agent-agnostic bridge protocol for future agent backends

### Advanced Control Surface
- Dynamic Canvas-rendered button images
- LCD strip: current tool, progress indicators, token counters
- Project-specific layout presets

### Intelligence
- Smart prompt suggestions based on context
- Multi-session management
- Usage analytics and cost tracking

---

<p align="center">
<strong>AgentDeck</strong> — Physical Control Surface for AI Coding Agents
</p>
