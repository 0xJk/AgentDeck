#!/bin/bash
# Fix node-pty spawn-helper permissions (pnpm doesn't preserve execute bits from prebuilds)

find node_modules -path "*node-pty*/prebuilds/darwin-*/spawn-helper" 2>/dev/null | while read -r SPAWN_HELPER; do
  if [ -n "$SPAWN_HELPER" ] && [ ! -x "$SPAWN_HELPER" ]; then
    chmod +x "$SPAWN_HELPER"
    echo "[postinstall] Fixed spawn-helper permissions: $SPAWN_HELPER"
  fi
done
