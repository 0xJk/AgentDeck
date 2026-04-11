#!/bin/bash
# Launch a macOS app with the D200H HID capture interposer enabled.
#
# Usage:
#   bash zkswe/recon/run-ulanzi-hid-capture.sh /Applications/UlanziStudio.app
#   bash zkswe/recon/run-ulanzi-hid-capture.sh /Applications/UlanziStudio.app/Contents/MacOS/UlanziStudio
#
# Notes:
# - Hardened runtime / library validation may block DYLD interposition.
# - Captured raw reports are written under ~/.agentdeck/ulanzi-hid-capture/<timestamp>/raw

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <UlanziStudio.app|app-executable>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DYLIB="${SCRIPT_DIR}/ulanzi-hid-capture.dylib"
TARGET="$1"

if [ ! -f "$DYLIB" ]; then
  echo "capture dylib missing: $DYLIB" >&2
  echo "build it first: bash zkswe/recon/build-ulanzi-hid-capture.sh" >&2
  exit 1
fi

if [[ "$TARGET" == *.app ]]; then
  APP_NAME="$(basename "$TARGET" .app)"
  APP_BIN="${TARGET}/Contents/MacOS/${APP_NAME}"
else
  APP_BIN="$TARGET"
fi

if [ ! -x "$APP_BIN" ]; then
  echo "app executable not found or not executable: $APP_BIN" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
CAPTURE_ROOT="${HOME}/.agentdeck/ulanzi-hid-capture/${STAMP}"
RAW_DIR="${CAPTURE_ROOT}/raw"
mkdir -p "$RAW_DIR"

export AGENTDECK_D200H_CAPTURE_DIR="$RAW_DIR"
export DYLD_INSERT_LIBRARIES="$DYLIB"

echo "capture root: $CAPTURE_ROOT"
echo "launching: $APP_BIN"
echo "note: if the app uses hardened runtime, DYLD injection may be rejected."

exec "$APP_BIN"
