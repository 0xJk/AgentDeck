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
| **Manage terminal sessions** | iTerm dial switches sessions, auto-attaches detached tmux, auto-switches on tab focus |
| **Stay in flow** | Hardware augments your keyboard — never interrupts it |
| **Control from anywhere** | Commands work even when the terminal is in the background — no need to switch windows |

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
| **sox** (audio capture) | For voice | See [Voice Setup](#4-voice-setup-optional) |
| **whisper.cpp** (transcription) | For voice | See [Voice Setup](#4-voice-setup-optional) |

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

Voice input requires **sox** (audio capture) and **whisper.cpp** (local transcription).

#### Apple Silicon (M1/M2/M3/M4)

> **Important:** You must use **arm64 Homebrew** (`/opt/homebrew/`). The x86 Homebrew (`/usr/local/`) installs Intel binaries that run through Rosetta 2 without Metal GPU — transcription will be 10-20x slower.

```bash
# Check your Homebrew architecture
brew --prefix
# /opt/homebrew  → arm64 (correct)
# /usr/local     → x86 (need to install arm64 Homebrew)
```

If you only have x86 Homebrew:
```bash
# Install arm64 Homebrew (coexists with x86, doesn't affect it)
arch -arm64 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Add to your shell profile (~/.zshrc)
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Install with arm64 Homebrew:
```bash
/opt/homebrew/bin/brew install sox whisper-cpp
```

#### Intel Mac

```bash
brew install sox whisper-cpp
```

#### Download Whisper Model

```bash
whisper-cli --download-model large-v3-turbo   # ~1.5GB, best quality/speed balance
```

Models are saved to `~/.local/share/whisper-cpp/`. The bridge auto-selects the best available model:

| Model | Size | Speed (M1 Max, Metal) | Accuracy | Best for |
|-------|------|----------------------|----------|----------|
| `large-v3-turbo` | 1.5GB | ~3-5s for 10s audio | Excellent | Recommended for Apple Silicon |
| `small` | 466MB | ~2-3s | Good | Limited disk space |
| `base` | 148MB | ~1-2s | Fair | Fallback (auto-selected if no Metal) |

#### Verify Setup

```bash
# Check binary is arm64 with Metal (Apple Silicon)
file $(which whisper-cli)
# → Mach-O 64-bit executable arm64  ← correct

otool -L $(which whisper-cli) | grep metal
# → libggml-metal.0.dylib  ← Metal GPU enabled
```

The bridge auto-detects Metal support at startup and logs:
```
[Voice] whisper-cli: arm64=true, metal=true (/opt/homebrew/bin/whisper-cli)
[Voice] Selected whisper model: ~/.local/share/whisper-cpp/ggml-large-v3-turbo.bin
```

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
┌────────┬─────────┬─────────┬───────────┐
│  MODE  │ SESSION │  USAGE  │  ACTION 1 │
├────────┼─────────┼─────────┼───────────┤
│ ACT 2  │  ACT 3  │  STOP   │           │
└────────┴─────────┴─────────┴───────────┘
```

| Slot | Action | Description |
|------|--------|-------------|
| 0 | **Mode** | Toggle Default / Plan / Accept Edits |
| 1 | **Session** | Project name + state + session switch |
| 2 | **Usage** | Usage dashboard (5h / 7d / extra / session pages) |
| 3–5 | **Quick Action ×3** | TPL1 / TPL2 / COMPACT when idle — YES / NO / ALWAYS on permission prompt |
| 6 | **Stop** | Interrupt (Ctrl+C) |

### Encoders — 4 Slots

| Encoder | Action | Rotate | Push |
|---------|--------|--------|------|
| E1 | **Utility** | Adjust value | Toggle/Action |
| E2 | **Action** | Scroll options / cycle prompts | Send prompt / Confirm |
| E3 | **Terminal** | Switch session | Activate session / Attach tmux |
| E4 | **Voice** | Scroll text | Hold = record, tap (<500ms) = cancel |

### Dynamic Button States

The keypad reconfigures automatically based on agent state:

**IDLE** — waiting for input:
```
[ MODE  ] [ SESS  ] [ USAGE ] [ ACT 1 ]
[ ACT 2 ] [ ACT 3 ] [ STOP  ] [       ]
```

**PROCESSING** — agent working:
```
[  dim  ] [  dim  ] [  dim  ] [  dim  ]
[  dim  ] [  dim  ] [ STOP  ] [       ]     ← only STOP active
```

**AWAITING PERMISSION** — Yes/No/Always:
```
[ MODE  ] [ SESS  ] [ USAGE ] [  YES  ]
[  NO   ] [ALWAYS ] [ STOP  ] [       ]
```

**AWAITING OPTION** — multi-choice:
```
[ MODE  ] [ SESS  ] [ USAGE ] [ OPT 1 ]
[ OPT 2 ] [ OPT 3 ] [ STOP  ] [       ]
```

**DISCONNECTED** — no session:
```
[  dim  ] [  dim  ] [  dim  ] [  dim  ]
[  dim  ] [  dim  ] [  dim  ] [       ]     ← all disabled
```

### Terminal Dial (E3) — iTerm Session Manager

The Terminal encoder provides full iTerm2 session management:

| Action | Behavior |
|--------|----------|
| **Rotate** | Cycle through iTerm sessions + focus the selected window/tab |
| **Push** | Activate the selected session. If it's a detached tmux session, opens a new iTerm window and attaches |
| **Auto-switch** | When you focus an iTerm tab that belongs to an AgentDeck session, the bridge auto-switches to that session (2s polling) |

Detached tmux sessions from AgentDeck appear in the list with a 🔌 prefix (e.g. `🔌 ViewLingo`). Pushing on these opens a new iTerm window and runs `tmux attach`.

The **Session button** long press also focuses the terminal — if the tmux session is detached, it auto-attaches in a new iTerm window.

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
| "Is sox installed?" | sox missing | See [Voice Setup](#4-voice-setup-optional) |
| "Is whisper.cpp installed?" | whisper.cpp missing | See [Voice Setup](#4-voice-setup-optional) |
| Voice transcription very slow / timeout | x86 whisper-cli (no Metal GPU) | Install arm64 Homebrew + whisper-cpp. See [Voice Setup](#4-voice-setup-optional) |
| `whisper-cli: arm64=false, metal=false` | Using x86 binary through Rosetta | Install arm64 Homebrew at `/opt/homebrew/` |
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

## Button Label Intelligence

Permission and option labels can be long (e.g. "Yes, allow and don't ask again"). AgentDeck uses a 3-tier system to fit them on 144×144px buttons:

| Tier | Method | Latency | Example |
|------|--------|---------|---------|
| 1. **Pixel-aware wrap** | CJK-aware text measurement + multi-line wrap | Instant | "Yes, allow once" → fits as-is |
| 2. **Local abbreviation** | Pattern-based heuristic (known phrases) | Instant | "Yes, I trust this folder" → "Trust folder" |
| 3. **Haiku summarization** | `claude -p --model haiku` CLI fallback | ~1-3s | Unknown long label → AI-shortened version |

- **CJK support**: Korean, Chinese, and Japanese characters are measured at double-width (1em vs 0.55em for Latin), preventing overflow on CJK labels
- **Haiku fallback**: Only triggers when tiers 1-2 fail. First render shows ellipsis (`…`), then re-renders with the AI summary once it arrives. Results are cached (200 entries) so repeated labels are instant
- **Abbreviated indicator**: Buttons that were shortened show a subtle `~` mark at the bottom-right corner
- **Wide canvas unaffected**: Encoder LCD option lists (E2-E4) have enough horizontal space to display full labels without abbreviation

> **Requirement**: Tier 3 (Haiku) requires Claude Code CLI (`claude`) installed and authenticated. Subscription accounts work — no separate API key needed.

---

<p align="center">
<strong>AgentDeck</strong> — Physical Control Surface for AI Coding Agents
</p>
