#!/bin/bash
# Build AgentDeck D200H on-device agent
# Cross-compiles with zig for ARM Linux (SSD210)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

OUT="agentdeck-d200h"
SERIAL="0123456789ABCDEF"

echo "=== Building D200H agent ==="
# Static link to avoid glibc version mismatch (device has old glibc)
zig cc -target arm-linux-musleabihf \
  -O2 -std=c99 -static \
  -I src -I lib \
  src/main.c src/framebuffer.c src/dashboard.c src/ws_client.c src/protocol.c src/buttons.c lib/cJSON.c \
  -o "$OUT" \
  -lc -lm 2>&1

file "$OUT"
ls -la "$OUT"

echo ""
echo "=== Build complete: $OUT ==="

# Build probe tools (separate binaries for hardware discovery)
echo ""
echo "=== Building probe tools ==="
for tool in gpio_probe hid_sniff sysfs_probe uart_sniff; do
  out="${tool//_/-}"
  if [ -f "src/${tool}.c" ]; then
    zig cc -target arm-linux-musleabihf -O2 -std=c99 -static "src/${tool}.c" -o "$out" -lc 2>&1
    echo "  $out: $(ls -la "$out" | awk '{print $5}') bytes"
  fi
done
echo "=== Probe tools complete ==="

# Deploy if --deploy flag given
if [ "${1:-}" = "--deploy" ]; then
  echo "=== Locking USB sysfs ==="
  adb -s "$SERIAL" shell "chmod 444 /sys/class/zkswe_usb/zkswe0/functions /sys/class/zkswe_usb/zkswe0/enable" 2>&1 || true

  echo "=== Killing old agents ==="
  adb -s "$SERIAL" shell "for P in \$(ps | awk '/agentdeck/{print \$1}'); do kill \$P 2>/dev/null; done" 2>&1 || true

  echo "=== Deploying to D200H ==="
  adb -s "$SERIAL" push "$OUT" /data/agentdeck 2>&1
  adb -s "$SERIAL" shell "chmod +x /data/agentdeck && echo 'deployed'" 2>&1

  if [ "${2:-}" = "--run" ]; then
    echo "=== Running agent (WS mode) ==="
    adb -s "$SERIAL" shell "/data/agentdeck" 2>&1 &
    echo "Agent running in background (pid $!)"
  fi
fi
