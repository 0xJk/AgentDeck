#!/bin/bash
# D200H ADB device watcher — polls for device, triggers dump when found
# Usage: bash zkswe/recon/adb-watch.sh
#   Options:
#     --once    Run dump once and exit (default)
#     --loop    Keep watching after dump (for re-plug scenarios)
#     --serial  Custom serial (default: 0123456789ABCDEF)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="once"
SERIAL="0123456789ABCDEF"
POLL_INTERVAL=0.3

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once)  MODE="once"; shift ;;
    --loop)  MODE="loop"; shift ;;
    --serial) SERIAL="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== D200H ADB Watcher ==="
echo "Watching for device serial: $SERIAL"
echo "Mode: $MODE | Poll interval: ${POLL_INTERVAL}s"
echo "Waiting for device... (plug in D200H USB or reboot it)"
echo ""

detect_and_dump() {
  if adb devices 2>/dev/null | grep -q "$SERIAL"; then
    echo ""
    echo "$(date '+%H:%M:%S') >>> D200H detected! <<<"
    echo ""

    # Run the dump script
    bash "$SCRIPT_DIR/adb-dump.sh" "$SERIAL"

    # Verify ADB is still alive after dump
    echo ""
    echo "--- Verifying ADB persistence ---"
    sleep 3
    if adb -s "$SERIAL" shell "echo 'ADB alive after 3s'" 2>/dev/null; then
      echo "ADB still alive after 3 seconds"
      sleep 5
      if adb -s "$SERIAL" shell "echo 'ADB alive after 8s'" 2>/dev/null; then
        echo "ADB persisted past zkdaemon kill window! Keeper is working."
        echo ""
        echo "=== Running deep probe... ==="
        bash "$SCRIPT_DIR/adb-deep-probe.sh" "$SERIAL"
        echo ""
        echo "You can now use: adb -s $SERIAL shell"
      else
        echo "ADB died after ~8 seconds. Keeper may not have installed in time."
        echo "Try again — the script will be faster next time (/data/keep_adb.sh persists)."
      fi
    else
      echo "ADB died within 3 seconds. Device ADB window is very short."
      echo "Retrying on next detection..."
    fi

    return 0
  fi
  return 1
}

while true; do
  if detect_and_dump; then
    if [ "$MODE" = "once" ]; then
      echo ""
      echo "=== Done (--once mode). Run with --loop to keep watching. ==="
      exit 0
    else
      echo ""
      echo "=== Dump complete. Continuing to watch (--loop mode)... ==="
      echo "Waiting for device to disconnect and reconnect..."
      # Wait for device to disappear first
      while adb devices 2>/dev/null | grep -q "$SERIAL"; do
        sleep 1
      done
      echo "Device disconnected. Watching for reconnect..."
    fi
  fi
  sleep "$POLL_INTERVAL"
done
