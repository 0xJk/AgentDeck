#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLUGIN_DIR="$PROJECT_DIR/plugin/bound.serendipity.agentdeck.sdPlugin"
OUTPUT_DIR="$PROJECT_DIR/dist"
PLUGIN_ID="bound.serendipity.agentdeck"

# Build in production mode (strips debug logs from plugin)
echo "Building project (production)..."
cd "$PROJECT_DIR"
SDC_PROD=1 pnpm build

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Create .streamDeckPlugin file (it's just a zip)
cd "$PROJECT_DIR/plugin"
rm -f "$OUTPUT_DIR/$PLUGIN_ID.streamDeckPlugin"

# zip the .sdPlugin directory contents (NOT the .sdPlugin folder itself)
cd "$PLUGIN_ID.sdPlugin"
zip -r "$OUTPUT_DIR/$PLUGIN_ID.streamDeckPlugin" . \
  -x "*/node_modules/*" \
  -x "*/.DS_Store"

echo ""
echo "Package created: dist/$PLUGIN_ID.streamDeckPlugin"
echo "Size: $(du -h "$OUTPUT_DIR/$PLUGIN_ID.streamDeckPlugin" | cut -f1)"
