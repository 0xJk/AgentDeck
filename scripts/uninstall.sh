#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Uninstalling AgentDeck..."

# Remove hooks
node "$PROJECT_DIR/hooks/dist/install.js" uninstall 2>/dev/null || true

# Unlink CLI
cd "$PROJECT_DIR/bridge"
pnpm unlink --global 2>/dev/null || true

# Unlink plugin
PLUGIN_DIR="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/bound.serendipity.agentdeck.sdPlugin"
if [ -L "$PLUGIN_DIR" ]; then
  rm "$PLUGIN_DIR"
  echo "Plugin unlinked"
fi

echo "Uninstall complete. Restart Stream Deck app."
