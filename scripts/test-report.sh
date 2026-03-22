#!/bin/bash
# AgentDeck Unified Test Report
# Collects results from all test frameworks and generates a combined summary.
#
# Usage:
#   bash scripts/test-report.sh              # run all available tests + report
#   bash scripts/test-report.sh --report     # report only (no test execution)
#   bash scripts/test-report.sh --vitest     # vitest only
#   bash scripts/test-report.sh --android    # android only
#   bash scripts/test-report.sh --apple      # apple xctests only
#   bash scripts/test-report.sh --robot      # robot framework only

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT_DIR="$ROOT/coverage/test-report"
mkdir -p "$REPORT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# State tracking
declare -A SUITE_PASS
declare -A SUITE_FAIL
declare -A SUITE_SKIP
declare -A SUITE_STATUS  # pass/fail/skip
SUITES=()

MODE="${1:---all}"

write_metadata() {
    local metadata="$REPORT_DIR/run-metadata.json"
    python3 - <<PY
import json

suites = {}
for name in ("vitest", "android", "apple", "robot"):
    suites[name] = {"status": "not-run", "executed": False, "note": ""}

$(for suite in "${SUITES[@]}"; do
    note=""
    case "$suite" in
        vitest) note="Local vitest run" ;;
        android) note="Local Android JUnit run" ;;
        apple) note="Local Apple XCTest run" ;;
        robot) note="Local Robot Framework run" ;;
    esac
    echo "suites['$suite'] = {'status': '${SUITE_STATUS[$suite]:-skip}', 'executed': True, 'note': '$note'}"
done)

data = {
    "run_profile": "local",
    "suites": suites,
}
with open("$metadata", "w") as f:
    json.dump(data, f, indent=2)
PY
}

# ============================================================
# Vitest (bridge, plugin, shared, hooks)
# ============================================================
run_vitest() {
    echo -e "${CYAN}${BOLD}▶ Vitest${RESET} (bridge / plugin / shared / hooks)"

    local json_out="$REPORT_DIR/vitest.json"
    if cd "$ROOT" && npx vitest run --reporter=json --outputFile="$json_out" 2>/dev/null; then
        local passed failed
        passed=$(python3 -c "import json; d=json.load(open('$json_out')); print(d['numPassedTests'])" 2>/dev/null || echo 0)
        failed=$(python3 -c "import json; d=json.load(open('$json_out')); print(d['numFailedTests'])" 2>/dev/null || echo 0)

        SUITES+=("vitest")
        SUITE_PASS[vitest]=$passed
        SUITE_FAIL[vitest]=$failed
        SUITE_SKIP[vitest]=0
        if [ "$failed" -gt 0 ]; then
            SUITE_STATUS[vitest]="fail"
        else
            SUITE_STATUS[vitest]="pass"
        fi
    else
        # vitest ran but failed
        local passed failed
        passed=$(python3 -c "import json; d=json.load(open('$json_out')); print(d['numPassedTests'])" 2>/dev/null || echo 0)
        failed=$(python3 -c "import json; d=json.load(open('$json_out')); print(d['numFailedTests'])" 2>/dev/null || echo 0)

        SUITES+=("vitest")
        SUITE_PASS[vitest]=${passed:-0}
        SUITE_FAIL[vitest]=${failed:-0}
        SUITE_SKIP[vitest]=0
        SUITE_STATUS[vitest]="fail"
    fi
}

# ============================================================
# Android (Gradle + JUnit)
# ============================================================
run_android() {
    echo -e "${CYAN}${BOLD}▶ Android${RESET} (JUnit + Robolectric)"

    local android_dir="$ROOT/android"
    if [ ! -d "$android_dir" ]; then
        SUITES+=("android")
        SUITE_PASS[android]=0; SUITE_FAIL[android]=0; SUITE_SKIP[android]=0
        SUITE_STATUS[android]="skip"
        return
    fi

    # Find JAVA_HOME
    local java_home=""
    if [ -x "$(command -v brew)" ]; then
        local brew_jdk="$(brew --prefix openjdk@17 2>/dev/null)/libexec/openjdk.jdk/Contents/Home"
        [ -d "$brew_jdk" ] && java_home="$brew_jdk"
    fi
    [ -z "$java_home" ] && java_home="${JAVA_HOME:-}"

    if [ -z "$java_home" ] || [ ! -d "$java_home" ]; then
        echo -e "  ${YELLOW}⚠ JDK 17 not found — skipping Android tests${RESET}"
        SUITES+=("android")
        SUITE_PASS[android]=0; SUITE_FAIL[android]=0; SUITE_SKIP[android]=0
        SUITE_STATUS[android]="skip"
        return
    fi

    local xml_dir="$android_dir/app/build/test-results/testDebugUnitTest"

    if cd "$android_dir" && JAVA_HOME="$java_home" ./gradlew testDebugUnitTest 2>/dev/null; then
        parse_junit_xml "$xml_dir" "android"
        SUITE_STATUS[android]="pass"
    else
        parse_junit_xml "$xml_dir" "android"
        if [ "${SUITE_FAIL[android]:-0}" -gt 0 ]; then
            SUITE_STATUS[android]="fail"
        else
            SUITE_STATUS[android]="fail"
        fi
    fi
}

# ============================================================
# Apple (xcodebuild + XCTest)
# ============================================================
run_apple() {
    echo -e "${CYAN}${BOLD}▶ Apple${RESET} (XCTest)"

    local apple_dir="$ROOT/apple"
    if [ ! -d "$apple_dir" ]; then
        SUITES+=("apple")
        SUITE_PASS[apple]=0; SUITE_FAIL[apple]=0; SUITE_SKIP[apple]=0
        SUITE_STATUS[apple]="skip"
        return
    fi

    if ! command -v xcodebuild &>/dev/null; then
        echo -e "  ${YELLOW}⚠ xcodebuild not found — skipping Apple tests${RESET}"
        SUITES+=("apple")
        SUITE_PASS[apple]=0; SUITE_FAIL[apple]=0; SUITE_SKIP[apple]=0
        SUITE_STATUS[apple]="skip"
        return
    fi

    local xcresult="$REPORT_DIR/apple.xcresult"
    rm -rf "$xcresult"

    local scheme
    scheme=$(xcodebuild -list -json -project "$apple_dir/AgentDeck.xcodeproj" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
schemes=d.get('project',{}).get('schemes',[])
# Prefer macOS scheme for tests (iOS scheme may not support test action on macOS)
for s in schemes:
    if 'macOS' in s or 'macos' in s.lower():
        print(s); break
else:
    print(schemes[0] if schemes else '')
" 2>/dev/null || echo "")

    if [ -z "$scheme" ]; then
        echo -e "  ${YELLOW}⚠ No Xcode scheme found — skipping Apple tests${RESET}"
        SUITES+=("apple")
        SUITE_PASS[apple]=0; SUITE_FAIL[apple]=0; SUITE_SKIP[apple]=0
        SUITE_STATUS[apple]="skip"
        return
    fi

    local log_file="$REPORT_DIR/apple-xcodebuild.log"
    local xcode_ok=0
    if cd "$apple_dir" && xcodebuild test \
        -project AgentDeck.xcodeproj \
        -scheme "$scheme" \
        -destination 'platform=macOS' \
        -resultBundlePath "$xcresult" \
        2>&1 | tee "$log_file" | tail -5; then
        xcode_ok=1
    fi

    # Parse from xcodebuild output (grep -c returns 1 on no match, so use || true)
    local passed=0 failed=0
    if [ -f "$log_file" ]; then
        passed=$(grep -c "Test Case.*passed" "$log_file" || true)
        failed=$(grep -c "Test Case.*failed" "$log_file" || true)
    fi
    # Ensure numeric
    passed=$((passed + 0))
    failed=$((failed + 0))

    SUITES+=("apple")
    SUITE_PASS[apple]=$passed
    SUITE_FAIL[apple]=$failed
    SUITE_SKIP[apple]=0
    if [ "$xcode_ok" -eq 1 ] && [ "$failed" -eq 0 ]; then
        SUITE_STATUS[apple]="pass"
    elif [ "$passed" -eq 0 ] && [ "$failed" -eq 0 ]; then
        SUITE_STATUS[apple]="skip"
    else
        SUITE_STATUS[apple]="fail"
    fi
}

# ============================================================
# Robot Framework (ESP32)
# ============================================================
run_robot() {
    echo -e "${CYAN}${BOLD}▶ Robot Framework${RESET} (ESP32)"

    local robot_dir="$ROOT/esp32/robot"
    if [ ! -d "$robot_dir" ]; then
        SUITES+=("robot")
        SUITE_PASS[robot]=0; SUITE_FAIL[robot]=0; SUITE_SKIP[robot]=0
        SUITE_STATUS[robot]="skip"
        return
    fi

    if ! python3 -c "import robot" 2>/dev/null; then
        echo -e "  ${YELLOW}⚠ Robot Framework not installed — skipping ESP32 tests${RESET}"
        SUITES+=("robot")
        SUITE_PASS[robot]=0; SUITE_FAIL[robot]=0; SUITE_SKIP[robot]=0
        SUITE_STATUS[robot]="skip"
        return
    fi

    local results_dir="$REPORT_DIR/robot"
    mkdir -p "$results_dir"

    # Build-only tests (no hardware needed)
    if cd "$robot_dir" && python3 -m robot --include no-hw --outputdir "$results_dir" tests/ 2>/dev/null; then
        local xml="$results_dir/output.xml"
        if [ -f "$xml" ]; then
            local passed failed skipped
            passed=$(python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('$xml')
stats = tree.find('.//statistics/total/stat[@name=\"All Tests\"]')
print(stats.get('pass','0') if stats is not None else '0')
" 2>/dev/null || echo 0)
            failed=$(python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('$xml')
stats = tree.find('.//statistics/total/stat[@name=\"All Tests\"]')
print(stats.get('fail','0') if stats is not None else '0')
" 2>/dev/null || echo 0)
            skipped=$(python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('$xml')
stats = tree.find('.//statistics/total/stat[@name=\"All Tests\"]')
print(stats.get('skip','0') if stats is not None else '0')
" 2>/dev/null || echo 0)
            SUITES+=("robot")
            SUITE_PASS[robot]=$passed
            SUITE_FAIL[robot]=$failed
            SUITE_SKIP[robot]=$skipped
            SUITE_STATUS[robot]=$( [ "$failed" -gt 0 ] && echo "fail" || echo "pass" )
        else
            SUITES+=("robot")
            SUITE_PASS[robot]=0; SUITE_FAIL[robot]=0; SUITE_SKIP[robot]=0
            SUITE_STATUS[robot]="fail"
        fi
    else
        SUITES+=("robot")
        SUITE_PASS[robot]=0; SUITE_FAIL[robot]=0; SUITE_SKIP[robot]=0
        SUITE_STATUS[robot]="fail"
    fi
}

# ============================================================
# JUnit XML parser helper
# ============================================================
parse_junit_xml() {
    local dir="$1"
    local suite="$2"
    local total_pass=0 total_fail=0 total_skip=0

    if [ -d "$dir" ]; then
        for xml in "$dir"/*.xml; do
            [ -f "$xml" ] || continue
            local counts
            counts=$(python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('$xml')
root = tree.getroot()
tests = int(root.get('tests', 0))
failures = int(root.get('failures', 0))
errors = int(root.get('errors', 0))
skipped = int(root.get('skipped', 0))
passed = tests - failures - errors - skipped
print(f'{passed} {failures + errors} {skipped}')
" 2>/dev/null || echo "0 0 0")
            local p f s
            read -r p f s <<< "$counts"
            total_pass=$((total_pass + p))
            total_fail=$((total_fail + f))
            total_skip=$((total_skip + s))
        done
    fi

    SUITES+=("$suite")
    SUITE_PASS[$suite]=$total_pass
    SUITE_FAIL[$suite]=$total_fail
    SUITE_SKIP[$suite]=$total_skip
}

# ============================================================
# Report generation
# ============================================================
generate_report() {
    local total_pass=0 total_fail=0 total_skip=0
    local all_pass=true

    echo ""
    echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
    echo -e "${BOLD}  AgentDeck Test Report${RESET}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
    echo ""

    # Table header
    printf "  ${DIM}%-18s %6s %6s %6s %8s${RESET}\n" "Suite" "Pass" "Fail" "Skip" "Status"
    printf "  ${DIM}%-18s %6s %6s %6s %8s${RESET}\n" "──────────────────" "──────" "──────" "──────" "────────"

    for suite in "${SUITES[@]}"; do
        local p=${SUITE_PASS[$suite]:-0}
        local f=${SUITE_FAIL[$suite]:-0}
        local s=${SUITE_SKIP[$suite]:-0}
        local status=${SUITE_STATUS[$suite]:-skip}

        total_pass=$((total_pass + p))
        total_fail=$((total_fail + f))
        total_skip=$((total_skip + s))

        local status_str
        case "$status" in
            pass) status_str="${GREEN}✓ PASS${RESET}" ;;
            fail) status_str="${RED}✗ FAIL${RESET}"; all_pass=false ;;
            skip) status_str="${YELLOW}○ SKIP${RESET}" ;;
        esac

        printf "  %-18s %6d %6d %6d   %b\n" "$suite" "$p" "$f" "$s" "$status_str"
    done

    echo ""
    printf "  ${DIM}%-18s %6s %6s %6s %8s${RESET}\n" "──────────────────" "──────" "──────" "──────" "────────"
    local total=$((total_pass + total_fail + total_skip))
    local overall
    if $all_pass; then
        overall="${GREEN}${BOLD}✓ ALL PASS${RESET}"
    else
        overall="${RED}${BOLD}✗ FAILURES${RESET}"
    fi
    printf "  ${BOLD}%-18s %6d %6d %6d${RESET}   %b\n" "Total ($total)" "$total_pass" "$total_fail" "$total_skip" "$overall"
    echo ""

    # Write JSON report
    local json_report="$REPORT_DIR/summary.json"
    python3 -c "
import json, datetime
suites = []
$(for suite in "${SUITES[@]}"; do
    echo "suites.append({'name':'$suite','passed':${SUITE_PASS[$suite]:-0},'failed':${SUITE_FAIL[$suite]:-0},'skipped':${SUITE_SKIP[$suite]:-0},'status':'${SUITE_STATUS[$suite]:-skip}'})"
done)
report = {
    'timestamp': datetime.datetime.now().isoformat(),
    'suites': suites,
    'total': {
        'passed': $total_pass,
        'failed': $total_fail,
        'skipped': $total_skip,
        'total': $total,
    }
}
with open('$json_report', 'w') as f:
    json.dump(report, f, indent=2)
" 2>/dev/null

    echo -e "  ${DIM}JSON report: $json_report${RESET}"
    echo -e "  ${DIM}Vitest JSON: $REPORT_DIR/vitest.json${RESET}"
    [ -d "$REPORT_DIR/robot" ] && echo -e "  ${DIM}Robot HTML:  $REPORT_DIR/robot/report.html${RESET}"

    # Generate HTML dashboard
    write_metadata
    if python3 "$ROOT/scripts/generate-html-report.py" 2>/dev/null; then
        echo -e "  ${DIM}HTML report: $REPORT_DIR/index.html${RESET}"
    fi
    echo ""

    # Exit with failure if any suite failed
    $all_pass || return 1
}

# ============================================================
# Main
# ============================================================
case "$MODE" in
    --report)
        echo -e "${DIM}Report-only mode (no test execution)${RESET}"
        # Try to parse existing results
        [ -f "$REPORT_DIR/vitest.json" ] && {
            SUITES+=("vitest")
            SUITE_PASS[vitest]=$(python3 -c "import json; d=json.load(open('$REPORT_DIR/vitest.json')); print(d['numPassedTests'])" 2>/dev/null || echo 0)
            SUITE_FAIL[vitest]=$(python3 -c "import json; d=json.load(open('$REPORT_DIR/vitest.json')); print(d['numFailedTests'])" 2>/dev/null || echo 0)
            SUITE_SKIP[vitest]=0
            SUITE_STATUS[vitest]=$( [ "${SUITE_FAIL[vitest]}" -gt 0 ] && echo "fail" || echo "pass" )
        }
        [ -d "$ROOT/android/app/build/test-results/testDebugUnitTest" ] && {
            parse_junit_xml "$ROOT/android/app/build/test-results/testDebugUnitTest" "android"
            SUITE_STATUS[android]=$( [ "${SUITE_FAIL[android]:-0}" -gt 0 ] && echo "fail" || echo "pass" )
        }
        generate_report
        ;;
    --vitest)
        run_vitest
        generate_report
        ;;
    --android)
        run_android
        generate_report
        ;;
    --apple)
        run_apple
        generate_report
        ;;
    --robot)
        run_robot
        generate_report
        ;;
    --all|*)
        run_vitest
        run_android
        run_apple
        run_robot
        generate_report
        ;;
esac
