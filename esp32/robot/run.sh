#!/bin/bash
# AgentDeck ESP32 Robot Framework test runner
#
# Usage:
#   ./run.sh              # all tests (requires HW)
#   ./run.sh build        # build verification only (no HW)
#   ./run.sh hw           # hardware tests only
#   ./run.sh smoke        # quick smoke tests
#   ./run.sh protocol     # serial protocol tests only
#   ./run.sh flash        # flash + boot tests only

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure dependencies
if ! python3 -c "import robot" 2>/dev/null; then
    echo "Installing Robot Framework dependencies..."
    pip3 install -r requirements.txt
fi

RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"

case "${1:-all}" in
    build)
        echo "Running build verification tests (no hardware required)..."
        python3 -m robot --include no-hw --outputdir "$RESULTS_DIR" tests/
        ;;
    hw)
        echo "Running hardware tests..."
        python3 -m robot --include hw --outputdir "$RESULTS_DIR" tests/
        ;;
    smoke)
        echo "Running smoke tests..."
        python3 -m robot --include smoke --outputdir "$RESULTS_DIR" tests/
        ;;
    protocol)
        echo "Running serial protocol tests..."
        python3 -m robot --include protocol --outputdir "$RESULTS_DIR" tests/
        ;;
    flash)
        echo "Running flash and boot tests..."
        python3 -m robot --include flash --outputdir "$RESULTS_DIR" tests/
        ;;
    all)
        echo "Running all tests..."
        python3 -m robot --outputdir "$RESULTS_DIR" tests/
        ;;
    *)
        echo "Usage: $0 {build|hw|smoke|protocol|flash|all}"
        exit 1
        ;;
esac

echo ""
echo "Results: $RESULTS_DIR/report.html"
