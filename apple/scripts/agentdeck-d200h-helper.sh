#!/bin/bash
# agentdeck-d200h-helper.sh — launch bundled AgentDeck Node daemon runtime.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$(cd "${SCRIPT_DIR}/../Resources/agentdeck-runtime" && pwd)"
NODE_BIN="${SCRIPT_DIR}/node"
CLI_JS="${RUNTIME_DIR}/bridge/dist/cli.js"

if [ ! -x "$NODE_BIN" ]; then
    echo "AgentDeck D200H helper: bundled node missing at ${NODE_BIN}" >&2
    exit 1
fi

if [ ! -f "$CLI_JS" ]; then
    echo "AgentDeck D200H helper: bundled runtime missing at ${CLI_JS}" >&2
    exit 1
fi

cd "$RUNTIME_DIR"
exec "$NODE_BIN" "$CLI_JS" start "$@"
