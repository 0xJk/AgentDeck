#!/bin/bash
# copy-adb.sh — Copy adb binary into app bundle during Xcode build.
# Searches standard Android SDK paths and copies to Contents/Helpers/.
# The binary is then ad-hoc re-signed so App Sandbox allows execution.

set -euo pipefail

if [ -z "${BUILT_PRODUCTS_DIR:-}" ] || [ -z "${CONTENTS_FOLDER_PATH:-}" ]; then
    echo "note: skipping adb bundle outside Xcode build environment"
    exit 0
fi

HELPERS_DIR="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Helpers"
DEST="${HELPERS_DIR}/adb"
REPO_ROOT="${PROJECT_DIR}/.."

copy_adb() {
    local dest="$1"

    # Skip if already present (incremental builds)
    if [ -f "$dest" ]; then
        echo "note: adb already bundled at $dest"
        return 0
    fi

    # Search for adb in standard locations
    REAL_HOME="${HOME:-}"
    if [ -z "$REAL_HOME" ] && command -v dscl >/dev/null 2>&1; then
        REAL_HOME=$(dscl . -read "/Users/$(whoami)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
    fi
    if [ -z "$REAL_HOME" ]; then
        REAL_HOME="/Users/$(whoami)"
    fi

    CANDIDATES=(
        "${REAL_HOME}/Library/Android/sdk/platform-tools/adb"
        "${REAL_HOME}/Android/sdk/platform-tools/adb"
        "${REAL_HOME}/Library/Developer/Android/sdk/platform-tools/adb"
        "/opt/homebrew/bin/adb"
        "/usr/local/bin/adb"
    )

    ADB_SRC=""
    for candidate in "${CANDIDATES[@]}"; do
        if [ -x "$candidate" ]; then
            ADB_SRC="$candidate"
            break
        fi
    done

    if [ -z "$ADB_SRC" ]; then
        echo "warning: adb not found — Android device support will be unavailable"
        return 0
    fi

    mkdir -p "$HELPERS_DIR"
    cp "$ADB_SRC" "$dest"
    chmod 755 "$dest"

    if [ "${CODE_SIGNING_ALLOWED:-NO}" = "YES" ]; then
        SIGN_IDENTITY="${EXPANDED_CODE_SIGN_IDENTITY:-${CODE_SIGN_IDENTITY:--}}"
        codesign --force --sign "$SIGN_IDENTITY" --timestamp=none --generate-entitlement-der "$dest" 2>/dev/null || \
        codesign --force --sign - "$dest" 2>/dev/null || true
        echo "note: Bundled adb from $ADB_SRC → $dest (signed with: $SIGN_IDENTITY)"
    else
        echo "note: Bundled adb from $ADB_SRC → $dest (codesign skipped)"
    fi
}

bundle_d200h_helper() {
    local node_src launcher_src runtime_dir
    node_src="$(command -v node || true)"
    launcher_src="${PROJECT_DIR}/scripts/agentdeck-d200h-helper.sh"
    runtime_dir="${HELPERS_DIR}/agentdeck-runtime"

    if [ -z "$node_src" ] || [ ! -x "$node_src" ]; then
        echo "warning: node not found — bundled D200H helper will be unavailable"
        return 0
    fi
    if [ ! -f "$launcher_src" ]; then
        echo "warning: helper launcher script missing at $launcher_src"
        return 0
    fi
    if [ ! -f "${REPO_ROOT}/bridge/dist/cli.js" ]; then
        echo "warning: bridge/dist/cli.js missing — bundled D200H helper will be unavailable"
        return 0
    fi
    if [ ! -d "${REPO_ROOT}/node_modules" ]; then
        echo "warning: node_modules missing — bundled D200H helper will be unavailable"
        return 0
    fi

    mkdir -p "$HELPERS_DIR"
    cp "$node_src" "${HELPERS_DIR}/node"
    cp "$launcher_src" "${HELPERS_DIR}/agentdeck-d200h-helper"
    chmod 755 "${HELPERS_DIR}/node" "${HELPERS_DIR}/agentdeck-d200h-helper"

    rm -rf "$runtime_dir"
    mkdir -p "${runtime_dir}/bridge"
    cp -R "${REPO_ROOT}/bridge/dist" "${runtime_dir}/bridge/dist"
    rsync -aL --delete "${REPO_ROOT}/node_modules/" "${runtime_dir}/node_modules/"

    if [ "${CODE_SIGNING_ALLOWED:-NO}" = "YES" ]; then
        SIGN_IDENTITY="${EXPANDED_CODE_SIGN_IDENTITY:-${CODE_SIGN_IDENTITY:--}}"
        codesign --force --sign "$SIGN_IDENTITY" --timestamp=none --generate-entitlement-der "${HELPERS_DIR}/node" 2>/dev/null || \
        codesign --force --sign - "${HELPERS_DIR}/node" 2>/dev/null || true
        codesign --force --sign "$SIGN_IDENTITY" --timestamp=none --generate-entitlement-der "${HELPERS_DIR}/agentdeck-d200h-helper" 2>/dev/null || \
        codesign --force --sign - "${HELPERS_DIR}/agentdeck-d200h-helper" 2>/dev/null || true
        echo "note: Bundled D200H helper runtime using node from $node_src"
    else
        echo "note: Bundled D200H helper runtime using node from $node_src (codesign skipped)"
    fi
}

copy_adb "$DEST"
bundle_d200h_helper
