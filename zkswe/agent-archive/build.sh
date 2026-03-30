#!/bin/bash
# Build AgentDeck D200H on-device agent
# Cross-compiles with zig for ARM Linux (SSD210)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

OUT_STATIC="agentdeck-d200h"
OUT_DYNAMIC="agentdeck-d200h-dyn"
SERIAL="0123456789ABCDEF"

echo "=== Building D200H agent (static musl + /dev/mem display) ==="
# Static link for portability. MI_GFX via dlopen won't work in static musl,
# but /dev/mem direct bus write is used as the primary display backend.
zig cc -target arm-linux-musleabihf \
  -O2 -std=c99 -static \
  -I src -I lib \
  src/main.c src/framebuffer.c src/dashboard.c src/ws_client.c src/protocol.c src/buttons.c lib/cJSON.c \
  -o "$OUT_STATIC" \
  -lc -lm 2>&1

file "$OUT_STATIC"
ls -la "$OUT_STATIC"

echo ""
echo "=== Building D200H agent (dynamic glibc + MI_GFX dlopen) ==="
zig cc -target arm-linux-gnueabihf.2.30 \
  -O2 -std=c99 \
  -I src -I lib \
  src/main.c src/framebuffer.c src/dashboard.c src/ws_client.c src/protocol.c src/buttons.c lib/cJSON.c \
  -o "$OUT_DYNAMIC" \
  -ldl -lc -lm -lpthread 2>&1

file "$OUT_DYNAMIC"
ls -la "$OUT_DYNAMIC"

echo ""
echo "=== Build complete: $OUT_STATIC, $OUT_DYNAMIC ==="

echo ""
echo "=== Building display probe ==="
zig cc -target arm-linux-gnueabihf.2.30 \
  -O2 -std=c99 \
  src/fb_test.c \
  -o fb-test \
  -ldl -lc 2>&1
echo "  fb-test: $(ls -la fb-test | awk '{print $5}') bytes"

# Build probe tools (separate binaries for hardware discovery)
echo ""
echo "=== Building probe tools ==="
for tool in gpio_probe hid_sniff sysfs_probe uart_sniff mem_flash; do
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
  adb -s "$SERIAL" push "$OUT_DYNAMIC" /data/agentdeck-dyn 2>&1
  adb -s "$SERIAL" shell "chmod +x /data/agentdeck-dyn && echo 'deployed'" 2>&1

  if [ "${2:-}" = "--run" ]; then
    echo "=== Running agent (WS mode) ==="
    adb -s "$SERIAL" shell "/data/agentdeck-dyn" 2>&1 &
    echo "Agent running in background (pid $!)"
  fi
fi
