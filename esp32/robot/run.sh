#!/bin/bash
# AgentDeck ESP32 Robot Framework test runner (BDD)
#
# Usage:
#   ./run.sh                           # all tests (requires HW)
#   ./run.sh build                     # build verification only (no HW)
#   ./run.sh hw                        # hardware tests only
#   ./run.sh smoke                     # quick smoke tests
#   ./run.sh protocol                  # serial protocol tests only
#   ./run.sh flash                     # flash + boot tests only
#   ./run.sh protocol box_86           # protocol tests for specific board
#   ./run.sh hw ips_35                 # hw tests for specific board
#
# Environment:
#   BOARD=box_86 ./run.sh protocol     # alternative: set via env var
#
# Ansible pipeline (all devices):
#   cd ansible && ansible-playbook site.yaml -i inventory.yaml

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

# Board selection: 2nd argument or BOARD env var
BOARD_ARG="${2:-${BOARD:-}}"
BOARD_VAR=""
if [ -n "$BOARD_ARG" ]; then
    BOARD_VAR="--variable BOARD:${BOARD_ARG}"
    RESULTS_DIR="$RESULTS_DIR/$BOARD_ARG"
    mkdir -p "$RESULTS_DIR"
    echo "Board: $BOARD_ARG"
fi

case "${1:-all}" in
    build)
        echo "Running build verification tests (no hardware required)..."
        python3 -m robot --include no-hw --outputdir "$RESULTS_DIR" $BOARD_VAR tests/
        ;;
    hw)
        echo "Running hardware tests..."
        python3 -m robot --include hw --outputdir "$RESULTS_DIR" $BOARD_VAR tests/
        ;;
    smoke)
        echo "Running smoke tests..."
        python3 -m robot --include smoke --outputdir "$RESULTS_DIR" $BOARD_VAR tests/
        ;;
    protocol)
        echo "Running serial protocol tests..."
        python3 -m robot --include protocol --outputdir "$RESULTS_DIR" $BOARD_VAR tests/
        ;;
    flash)
        echo "Running flash and boot tests..."
        python3 -m robot --include flash --outputdir "$RESULTS_DIR" $BOARD_VAR tests/
        ;;
    all)
        echo "Running all tests..."
        python3 -m robot --outputdir "$RESULTS_DIR" $BOARD_VAR tests/
        ;;
    *)
        echo "Usage: $0 {build|hw|smoke|protocol|flash|all} [board]"
        echo ""
        echo "Boards: box_86, ips_35, round_amoled, ulanzi_tc001"
        echo ""
        echo "Examples:"
        echo "  $0 build              # build all boards (no HW)"
        echo "  $0 protocol box_86    # protocol tests for box_86"
        echo "  $0 hw                 # all HW tests, auto-detect device"
        echo ""
        echo "Ansible pipeline:"
        echo "  cd ansible && ansible-playbook site.yaml -i inventory.yaml"
        exit 1
        ;;
esac

echo ""
echo "Results: $RESULTS_DIR/report.html"
