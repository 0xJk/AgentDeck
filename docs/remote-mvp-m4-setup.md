# M4 / M1 Daemon Setup — Remote Stream Deck MVP (plan 001)

> Install the **locally-modified** AgentDeck daemon (incl. the Lane A `focus_lost`
> changes) on the remote Mac(s) the MacBook Stream Deck will control. Do **not**
> use `npx @agentdeck/setup` — the published npm package does not contain the MVP
> changes (per-client focus relay + `focus_lost` push). Pull the feature branch
> instead.
>
> Scope on the remote machine: **daemon + Claude Code hooks only**. No Stream Deck
> plugin, no icon generation — the remote Mac never plugs in a Stream Deck.

## Topology recap

```
MacBook (Stream Deck+, remote control)
   │  ws://<M4-ip>:9120?token=...
   ▼
M4 / M1 — AgentDeck daemon (0.0.0.0:9120) + ~/.claude hooks + Claude Code CLI
```

The daemon already binds `0.0.0.0` ([bridge/src/daemon-server.ts](../bridge/src/daemon-server.ts) `httpServer.listen(port, '0.0.0.0', ...)`) and authenticates remote connections by `?token=` ([bridge/src/ws-server.ts](../bridge/src/ws-server.ts)). Local (loopback / same-machine) connections skip the token check.

---

## Prerequisites on M4 / M1

- **Node.js ≥ 22** (`node -v`) — Node 20 is EOL April 2026
- **pnpm** (`npm install -g pnpm`)
- **Claude Code CLI** (`npm install -g @anthropic-ai/claude-code`)
- **git**
- Same LAN as the MacBook, IP reachable (no mDNS required for the MVP)

You do **not** need: Stream Deck app, `@elgato/cli`, sox/whisper (voice runs on the MacBook side).

---

## Step 1 — Get the modified code onto M4

The MVP changes live on branch **`feat/remote-streamdeck-mvp`** (pushed from the MacBook).

First clone (if AgentDeck isn't on M4 yet):

```bash
git clone https://github.com/0xJk/AgentDeck.git
cd AgentDeck
git checkout feat/remote-streamdeck-mvp
```

Already have a clone on M4:

```bash
cd /path/to/AgentDeck
git fetch origin
git checkout feat/remote-streamdeck-mvp
git pull --ff-only origin feat/remote-streamdeck-mvp
```

## Step 2 — Build only what the daemon needs

`shared` must build before `bridge`. We skip the plugin entirely (it's MacBook-only):

```bash
pnpm install                                   # installs deps + builds native (node-pty)
pnpm --filter @agentdeck/shared build
pnpm --filter @agentdeck/bridge build
pnpm --filter @agentdeck/hooks  build
```

If `node-pty`'s spawn-helper lost its executable bit during install (Apple Silicon prebuild quirk):

```bash
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true
```

## Step 3 — Install Claude Code hooks

This writes the AgentDeck hooks into `~/.claude/settings.json` so Claude Code activity (permission prompts, tool use, stop) reaches the daemon. Claude Code v2.1+ watches that file live.

```bash
node hooks/dist/install.js
```

## Step 4 — Expose the `agentdeck` CLI

```bash
cd bridge && pnpm link --global && cd ..
agentdeck --help     # sanity check
```

## Step 5 — Start the daemon

```bash
agentdeck daemon start        # foreground; binds 0.0.0.0:9120
# or register a LaunchAgent so it survives logout/reboot:
#   agentdeck daemon install
agentdeck daemon status       # verify it's up
```

On first start the daemon creates `~/.agentdeck/auth-token`.

## Step 6 — Grab the token (paste into the MacBook PI later)

```bash
cat ~/.agentdeck/auth-token
```

## Step 7 — Find M4's LAN IP (the MacBook needs it)

```bash
ipconfig getifaddr en0 || ipconfig getifaddr en1
```

## Step 8 — Run Claude Code on M4

In your normal workspace terminal on M4:

```bash
claude          # the installed hooks relay state to the daemon automatically
```

(`agentdeck claude` also works and additionally wraps the session in a PTY bridge,
but plain `claude` is enough for the MVP — the hooks push to the daemon either way.)

---

## Hand-off back to the MacBook

On the MacBook Stream Deck, in the `bridge-connection` action's Property Inspector:

1. **+** → `{ id: "M4", host: <M4 LAN IP from Step 7>, port: 9120, token: <Step 6 token> }` → Save
2. **Set as active** → the key should flip to `connected`

Then the end-to-end checks from plan 001:

| Test | Do this | Expect |
|---|---|---|
| permission | trigger a permission prompt in M4's `claude` | press **Y** on Stream Deck → M4 receives `allow` |
| prompt/voice | Stream Deck voice → speak → transcribe | M4's `claude` receives the text |
| switch machine | add **M1** in PI → Set as active | reconnects to M1; timeline history does not bleed across machines |
| token rotation | on M4: `rm ~/.agentdeck/auth-token` then restart daemon | MacBook plugin drops to `pairing` automatically (4001) |
| focus_lost | ctrl+C M4's `claude`, then re-run `claude` | MacBook plugin shows focus lost → re-select the session |

---

## Repeat for M1

Same steps on M1; it gets its **own** `~/.agentdeck/auth-token`. Pair it in the PI
with `id: "M1"` and switch active bridges from the Stream Deck.

## Networking notes

- The MacBook must reach `M4:9120` over the LAN. If it can't, check the macOS
  firewall on M4 (System Settings → Network → Firewall) — allow incoming for
  the `node`/`agentdeck` process, or temporarily disable to confirm reachability.
- No mDNS is used in the MVP; only direct IP + token. If M4's DHCP lease changes
  its IP, update the host in the PI (or give M4 a static/reserved LAN IP).

## Uninstall (on M4)

```bash
agentdeck daemon stop
agentdeck daemon uninstall   # if you registered the LaunchAgent
bash scripts/uninstall.sh    # removes hooks + unlinks CLI
```
