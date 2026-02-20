#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
ok() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo ""
echo "========================================="
echo "  AgentDeck Installer"
echo "========================================="
echo ""

# --- Check required dependencies ---
MISSING_REQUIRED=0

# Node.js >= 20
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ]; then
    ok "Node.js $(node -v)"
  else
    fail "Node.js $(node -v) — version 20+ required"
    MISSING_REQUIRED=1
  fi
else
  fail "Node.js not found"
  MISSING_REQUIRED=1
fi

# pnpm
if command -v pnpm &>/dev/null; then
  ok "pnpm $(pnpm -v)"
else
  fail "pnpm not found — install with: npm install -g pnpm"
  MISSING_REQUIRED=1
fi

# Claude Code CLI
if command -v claude &>/dev/null; then
  ok "Claude Code CLI found"
else
  fail "Claude Code CLI not found — install with: npm install -g @anthropic-ai/claude-code"
  MISSING_REQUIRED=1
fi

# Stream Deck app
if [ -d "/Applications/Elgato Stream Deck.app" ] || [ -d "/Applications/Stream Deck.app" ]; then
  ok "Stream Deck app installed"
else
  fail "Stream Deck app not found — download from https://www.elgato.com/downloads"
  MISSING_REQUIRED=1
fi

if [ "$MISSING_REQUIRED" -ne 0 ]; then
  echo ""
  fail "Required dependencies missing. Please install them and re-run."
  exit 1
fi

echo ""

# --- Install @elgato/cli if missing ---
if ! command -v streamdeck &>/dev/null; then
  info "Installing Stream Deck CLI (@elgato/cli)..."
  npm install -g @elgato/cli
  ok "Stream Deck CLI installed"
else
  ok "Stream Deck CLI found"
fi

echo ""

# --- Build project ---
info "Installing dependencies..."
cd "$PROJECT_DIR"
pnpm install

info "Building project..."
pnpm build
ok "Build complete"

# Fix node-pty spawn-helper permissions (prebuild may lose +x)
SPAWN_HELPER="$PROJECT_DIR/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
if [ -f "$SPAWN_HELPER" ] && [ ! -x "$SPAWN_HELPER" ]; then
  chmod +x "$SPAWN_HELPER"
  ok "Fixed node-pty spawn-helper permissions"
fi

echo ""

# --- Generate icons if script exists ---
if [ -f "$PROJECT_DIR/scripts/generate-icons.mjs" ]; then
  info "Generating icon assets..."
  node "$PROJECT_DIR/scripts/generate-icons.mjs"
  ok "Icons generated"
fi

echo ""

# --- Install hooks ---
info "Installing Claude Code hooks..."
node "$PROJECT_DIR/hooks/dist/install.js"
ok "Hooks installed"

echo ""

# --- Link plugin ---
info "Linking plugin to Stream Deck..."
cd "$PROJECT_DIR/plugin"
streamdeck link bound.serendipity.agentdeck.sdPlugin 2>/dev/null || {
  warn "streamdeck link failed — you may need to link manually"
  warn "Run: cd plugin && streamdeck link .sdPlugin"
}
ok "Plugin linked"

echo ""

# --- Link CLI ---
info "Linking sdc CLI globally..."
cd "$PROJECT_DIR/bridge"
pnpm link --global 2>/dev/null || {
  warn "pnpm link failed — you may need to link manually"
  warn "Run: cd bridge && pnpm link --global"
}
ok "sdc CLI linked"

echo ""

# --- Check optional dependencies ---
echo "----- Optional Dependencies -----"

if command -v sox &>/dev/null || command -v rec &>/dev/null; then
  ok "sox installed (voice recording)"
else
  warn "sox not found — voice input won't work"
  echo "     Install with: brew install sox"
fi

if command -v whisper-cli &>/dev/null || command -v whisper &>/dev/null; then
  ok "whisper.cpp installed (voice transcription)"
else
  warn "whisper.cpp not found — voice transcription won't work"
  echo "     Install with: brew install whisper-cpp"
  echo "     Then download model: whisper-cli --download-model large-v3-turbo"
fi

echo ""
echo "========================================="
echo "  Installation Complete!"
echo "========================================="
echo ""
echo "  Next steps:"
echo "  1. Restart Stream Deck app"
echo "  2. Add 'Claude Code' actions to your Stream Deck profile"
echo "  3. Run 'sdc' in terminal to start the bridge"
echo ""
echo "  Usage:"
echo "    sdc              Start bridge + Claude"
echo "    sdc status       Check status"
echo "    sdc stop         Stop bridge"
echo ""
