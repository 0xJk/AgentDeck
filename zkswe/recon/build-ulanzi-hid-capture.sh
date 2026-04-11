#!/bin/bash
# Build the macOS DYLD interposer used to capture UlanziStudio D200H HID writes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${SCRIPT_DIR}/ulanzi_hid_capture.c"
OUT="${SCRIPT_DIR}/ulanzi-hid-capture.dylib"

if [ ! -f "$SRC" ]; then
  echo "missing source: $SRC" >&2
  exit 1
fi

/usr/bin/clang \
  -dynamiclib \
  -framework CoreFoundation \
  -framework IOKit \
  -o "$OUT" \
  "$SRC"

echo "built: $OUT"
