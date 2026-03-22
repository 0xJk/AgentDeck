#!/usr/bin/env python3
"""
AgentDeck Test Report — HTML Generator

Reads vitest JSON, Android JUnit XML, coverage-summary.json, scenario-matrix.json,
and produces a single self-contained HTML dashboard with:
  - Summary cards + history trend sparklines
  - Suite progress bars (Vitest, Android, Apple, Robot)
  - Scenario coverage matrix (user scenarios → test mapping)
  - Expandable test file tables with category tags
  - Coverage per-package gauges + file-level coverage table

Usage:
    python3 scripts/generate-html-report.py
    open coverage/test-report/index.html
"""

import json
import os
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT_DIR = ROOT / "coverage" / "test-report"
VITEST_JSON = REPORT_DIR / "vitest.json"
COVERAGE_JSON = ROOT / "coverage" / "coverage-summary.json"
ANDROID_XML_DIR = ROOT / "android" / "app" / "build" / "test-results" / "testDebugUnitTest"
SCENARIO_JSON = ROOT / "scripts" / "scenario-matrix.json"
ROBOT_XML = REPORT_DIR / "robot" / "output.xml"
HISTORY_JSON = REPORT_DIR / "history.json"
METADATA_JSON = REPORT_DIR / "run-metadata.json"
SUMMARY_JSON = REPORT_DIR / "summary.json"
OUTPUT_HTML = REPORT_DIR / "index.html"

# ===== Data collection =====

def load_vitest():
    if not VITEST_JSON.exists():
        return None
    with open(VITEST_JSON) as f:
        return json.load(f)

def load_coverage():
    if not COVERAGE_JSON.exists():
        return None
    with open(COVERAGE_JSON) as f:
        return json.load(f)

def load_android_xml():
    suites = []
    if not ANDROID_XML_DIR.exists():
        return suites
    for xml_file in sorted(ANDROID_XML_DIR.glob("TEST-*.xml")):
        tree = ET.parse(xml_file)
        root = tree.getroot()
        suite = {
            "name": root.get("name", xml_file.stem),
            "tests": int(root.get("tests", 0)),
            "failures": int(root.get("failures", 0)),
            "errors": int(root.get("errors", 0)),
            "skipped": int(root.get("skipped", 0)),
            "time": float(root.get("time", 0)),
            "cases": [],
        }
        for tc in root.findall("testcase"):
            failure = tc.find("failure")
            case = {
                "name": tc.get("name", ""),
                "classname": tc.get("classname", ""),
                "time": float(tc.get("time", 0)),
                "status": "failed" if failure is not None else "passed",
                "failure": failure.text if failure is not None else None,
            }
            suite["cases"].append(case)
        suite["passed"] = suite["tests"] - suite["failures"] - suite["errors"] - suite["skipped"]
        suites.append(suite)
    return suites

def load_robot_xml():
    """Parse Robot Framework output.xml into suite/test structure."""
    if not ROBOT_XML.exists():
        return None
    try:
        tree = ET.parse(ROBOT_XML)
    except ET.ParseError:
        return None
    root = tree.getroot()

    # Parse statistics for summary
    stats_el = root.find('.//statistics/total/stat[@name="All Tests"]')
    if stats_el is None:
        # Robot 7+ uses different structure
        stats_el = root.find('.//statistics/total/stat')

    passed = int(stats_el.get('pass', 0)) if stats_el is not None else 0
    failed = int(stats_el.get('fail', 0)) if stats_el is not None else 0
    skipped = int(stats_el.get('skip', 0)) if stats_el is not None else 0

    # Parse individual test cases from <suite> elements
    cases = []
    for test_el in root.iter('test'):
        status_el = test_el.find('status')
        status = status_el.get('status', 'PASS').upper() if status_el is not None else 'PASS'
        # Robot status: PASS/FAIL/SKIP
        case_status = "passed" if status == "PASS" else ("skipped" if status == "SKIP" else "failed")
        msg = ""
        if status_el is not None and status_el.text:
            msg = status_el.text[:300]
        cases.append({
            "name": test_el.get("name", ""),
            "status": case_status,
            "message": msg,
        })

    return {
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "total": passed + failed + skipped,
        "cases": cases,
    }

def load_scenarios():
    if not SCENARIO_JSON.exists():
        return []
    with open(SCENARIO_JSON) as f:
        data = json.load(f)
    return data.get("scenarios", [])

def load_history():
    if not HISTORY_JSON.exists():
        return []
    try:
        with open(HISTORY_JSON) as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError):
        return []

def load_metadata():
    if not METADATA_JSON.exists():
        return {}
    try:
        with open(METADATA_JSON) as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError):
        return {}

def update_history(history, total_passed, total_failed, total_all, lines_pct, metadata):
    commit_sha = os.environ.get("GITHUB_SHA", "local")[:7]
    suites = metadata.get("suites", {}) if metadata else {}
    executed = sorted([name for name, suite in suites.items() if suite.get("executed")])
    history.append({
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
        "commit": commit_sha,
        "total": total_all,
        "passed": total_passed,
        "failed": total_failed,
        "coverage": round(lines_pct, 1),
        "run_profile": metadata.get("run_profile", "unknown") if metadata else "unknown",
        "executed_suites": executed,
    })
    # Keep last 50 entries
    history = history[-50:]
    HISTORY_JSON.write_text(json.dumps(history, indent=2), encoding="utf-8")
    return history

def extract_package_coverage(cov_data):
    """Group per-file coverage into packages."""
    packages = {}
    for filepath, metrics in cov_data.items():
        if filepath == "total":
            continue
        rel = filepath.replace(str(ROOT) + "/", "")
        parts = rel.split("/")
        if len(parts) >= 2 and parts[0] in ("bridge", "plugin", "shared", "hooks"):
            pkg = parts[0]
        else:
            pkg = "other"

        if pkg not in packages:
            packages[pkg] = {"lines": {"total": 0, "covered": 0}, "statements": {"total": 0, "covered": 0},
                             "functions": {"total": 0, "covered": 0}, "branches": {"total": 0, "covered": 0},
                             "files": []}

        for metric in ("lines", "statements", "functions", "branches"):
            m = metrics.get(metric, {})
            packages[pkg][metric]["total"] += m.get("total", 0)
            packages[pkg][metric]["covered"] += m.get("covered", 0)

        packages[pkg]["files"].append({
            "path": rel,
            "lines_pct": metrics.get("lines", {}).get("pct", 0),
            "stmts_pct": metrics.get("statements", {}).get("pct", 0),
            "funcs_pct": metrics.get("functions", {}).get("pct", 0),
            "branch_pct": metrics.get("branches", {}).get("pct", 0),
        })

    for pkg, data in packages.items():
        for metric in ("lines", "statements", "functions", "branches"):
            t = data[metric]["total"]
            c = data[metric]["covered"]
            data[metric]["pct"] = round(c / t * 100, 1) if t > 0 else 0

    return packages


# ===== Test categorization =====

def classify_test_file(filepath):
    """Classify test file as unit/integration/snapshot by name pattern."""
    name = filepath.lower()
    if "snapshot" in name:
        return "snapshot"
    if "integration" in name or "lifecycle" in name:
        return "integration"
    return "unit"

def category_badge_html(category):
    colors = {
        "unit": ("#38bdf8", "#38bdf822"),
        "integration": ("#a78bfa", "#a78bfa22"),
        "snapshot": ("#f472b6", "#f472b622"),
    }
    fg, bg = colors.get(category, ("#64748b", "#64748b22"))
    return f'<span style="font-size:0.65rem;font-weight:600;padding:1px 6px;border-radius:3px;background:{bg};color:{fg};margin-left:0.5rem">{category}</span>'

def suite_meta(metadata, name):
    suites = metadata.get("suites", {}) if metadata else {}
    meta = suites.get(name, {})
    executed = bool(meta.get("executed"))
    status = meta.get("status") or ("pass" if executed else "not-run")
    return {
        "status": status,
        "executed": executed,
        "note": meta.get("note", ""),
    }

def build_default_metadata(vitest, android, robot):
    return {
        "run_profile": "ad-hoc",
        "suites": {
            "vitest": {"status": "pass" if vitest else "not-run", "executed": bool(vitest), "note": ""},
            "android": {"status": "pass" if android else "not-run", "executed": bool(android), "note": ""},
            "apple": {"status": "not-run", "executed": False, "note": "No Apple result parser input"},
            "robot": {"status": "pass" if robot else "not-run", "executed": bool(robot), "note": ""},
        },
    }

def full_assertion_name(assertion):
    ancestors = assertion.get("ancestorTitles", [])
    title = assertion.get("title", "")
    return " > ".join([*ancestors, title]).strip().lower()

def pattern_matches(text, patterns):
    if not patterns or "*" in patterns:
        return True
    lowered = text.lower()
    return any(pattern.lower() in lowered for pattern in patterns)


# ===== Scenario matrix =====

def build_scenario_results(scenarios, vitest, android_suites, metadata):
    """Cross-reference scenario test mappings against actual test results."""
    suite_status = {
        "vitest": suite_meta(metadata, "vitest"),
        "android": suite_meta(metadata, "android"),
        "apple": suite_meta(metadata, "apple"),
        "robot": suite_meta(metadata, "robot"),
    }
    # Build lookup: relative file path -> {status, passed, failed, total}
    vt_lookup = {}
    if vitest:
        for result in vitest.get("testResults", []):
            rel = result["name"].replace(str(ROOT) + "/", "")
            assertions = result.get("assertionResults", [])
            p = sum(1 for a in assertions if a["status"] == "passed")
            f = sum(1 for a in assertions if a["status"] == "failed")
            vt_lookup[rel] = {"status": result["status"], "passed": p, "failed": f, "total": p + f, "assertions": assertions}

    and_lookup = {}
    for suite in android_suites:
        # Android test files use classname like dev.agentdeck.net.ProtocolTest
        and_lookup[suite["name"]] = {"status": "passed" if suite["failures"] == 0 else "failed",
                                     "passed": suite["passed"], "failed": suite["failures"], "total": suite["tests"],
                                     "cases": suite["cases"]}

    def resolve_entry(entry):
        fpath = entry["file"]
        patterns = entry.get("patterns", ["*"])

        if fpath.startswith("apple/"):
            return {"status": "not-run" if not suite_status["apple"]["executed"] else "missing", "passed": 0, "failed": 0}
        if fpath.startswith("esp32/robot/"):
            return {"status": "not-run" if not suite_status["robot"]["executed"] else "missing", "passed": 0, "failed": 0}

        found = vt_lookup.get(fpath)
        if not found:
            basename = Path(fpath).name
            for vpath, vdata in vt_lookup.items():
                if vpath.endswith(basename):
                    found = vdata
                    break
        if found:
            if not suite_status["vitest"]["executed"]:
                return {"status": "not-run", "passed": 0, "failed": 0}
            if "*" in patterns:
                return {"status": "fail" if found["failed"] else "pass", "passed": found["passed"], "failed": found["failed"]}
            matched = [a for a in found.get("assertions", []) if pattern_matches(full_assertion_name(a), patterns)]
            if not matched:
                return {"status": "missing", "passed": 0, "failed": 0}
            passed = sum(1 for a in matched if a["status"] == "passed")
            failed = sum(1 for a in matched if a["status"] == "failed")
            return {"status": "fail" if failed else "pass", "passed": passed, "failed": failed}

        found = None
        for aname, adata in and_lookup.items():
            fname = Path(fpath).stem.replace("Test", "")
            if fname.lower() in aname.lower():
                found = adata
                break
        if found:
            if not suite_status["android"]["executed"]:
                return {"status": "not-run", "passed": 0, "failed": 0}
            if "*" in patterns:
                return {"status": "fail" if found["failed"] else "pass", "passed": found["passed"], "failed": found["failed"]}
            matched = [c for c in found.get("cases", []) if pattern_matches(c.get("name", ""), patterns)]
            if not matched:
                return {"status": "missing", "passed": 0, "failed": 0}
            passed = sum(1 for c in matched if c["status"] == "passed")
            failed = sum(1 for c in matched if c["status"] == "failed")
            return {"status": "fail" if failed else "pass", "passed": passed, "failed": failed}

        if fpath.startswith("android/") and not suite_status["android"]["executed"]:
            return {"status": "not-run", "passed": 0, "failed": 0}
        if not suite_status["vitest"]["executed"]:
            return {"status": "not-run", "passed": 0, "failed": 0}
        return {"status": "missing", "passed": 0, "failed": 0}

    results = []
    for sc in scenarios:
        sc_result = {"id": sc["id"], "name": sc["name"], "description": sc["description"],
                     "priority": sc.get("priority", "medium"), "gaps": sc.get("gaps", []),
                     "categories": {}}

        for cat in ("unit", "integration", "platform", "e2e"):
            test_entries = sc.get("tests", {}).get(cat, [])
            cat_result = {"tests": [], "passed": 0, "failed": 0, "missing": 0, "not_run": 0, "total": len(test_entries)}

            for entry in test_entries:
                resolved = resolve_entry(entry)
                cat_result["tests"].append({"file": entry["file"], "status": resolved["status"],
                                            "passed": resolved["passed"], "failed": resolved["failed"]})
                if resolved["status"] == "fail":
                    cat_result["failed"] += 1
                elif resolved["status"] == "pass":
                    cat_result["passed"] += 1
                elif resolved["status"] == "not-run":
                    cat_result["not_run"] += 1
                else:
                    cat_result["missing"] += 1

            sc_result["categories"][cat] = cat_result

        results.append(sc_result)
    return results


# ===== HTML generation =====

def pct_color(pct):
    if pct >= 80: return "#22c55e"
    if pct >= 50: return "#eab308"
    if pct >= 20: return "#f97316"
    return "#ef4444"

def gauge_svg(pct, size=48):
    color = pct_color(pct)
    r = size / 2 - 4
    circ = 2 * 3.14159 * r
    offset = circ * (1 - pct / 100)
    return f'''<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}">
      <circle cx="{size/2}" cy="{size/2}" r="{r}" fill="none" stroke="#1e293b" stroke-width="5"/>
      <circle cx="{size/2}" cy="{size/2}" r="{r}" fill="none" stroke="{color}" stroke-width="5"
        stroke-dasharray="{circ}" stroke-dashoffset="{offset}"
        transform="rotate(-90 {size/2} {size/2})" stroke-linecap="round"/>
      <text x="{size/2}" y="{size/2 + 4}" text-anchor="middle" fill="{color}" font-size="11" font-weight="700">{pct:.0f}%</text>
    </svg>'''

def status_badge(status):
    if status in ("passed", "pass"):
        return '<span class="badge pass">PASS</span>'
    elif status in ("failed", "fail", "error"):
        return '<span class="badge fail">FAIL</span>'
    elif status == "not-run":
        return '<span class="badge skip">NOT RUN</span>'
    return '<span class="badge skip">SKIP</span>'

def suite_progress_color(status):
    if status in ("failed", "fail", "error"):
        return "#ef4444"
    if status in ("passed", "pass"):
        return "#22c55e"
    return "#64748b"

def duration_fmt(ms):
    if ms < 1000:
        return f"{ms:.0f}ms"
    s = ms / 1000
    if s < 60:
        return f"{s:.1f}s"
    m = int(s // 60)
    return f"{m}m {s % 60:.0f}s"

def scenario_cell_html(cat_data):
    """Generate a colored cell for a scenario category."""
    t = cat_data["total"]
    if t == 0:
        return '<td class="sc-cell sc-none" title="No tests">—</td>'
    p = cat_data["passed"]
    f = cat_data["failed"]
    m = cat_data["missing"]
    nr = cat_data.get("not_run", 0)
    if f > 0:
        cls = "sc-fail"
        label = f"{p}/{t}"
    elif m > 0 or nr > 0:
        cls = "sc-warn"
        label = f"{p}/{t}"
    else:
        cls = "sc-pass"
        label = f"{p}/{t}"
    title_parts = []
    if p: title_parts.append(f"{p} passed")
    if f: title_parts.append(f"{f} failed")
    if m: title_parts.append(f"{m} not found in CI")
    if nr: title_parts.append(f"{nr} not executed in this report")
    return f'<td class="sc-cell {cls}" title="{", ".join(title_parts)}">{label}</td>'

def write_summary(metadata, total_passed, total_failed, total_all):
    suites_meta = metadata.get("suites", {}) if metadata else {}
    suites = []
    for name in ("vitest", "android", "apple", "robot"):
        meta = suites_meta.get(name, {})
        suites.append({
            "name": name,
            "status": meta.get("status", "not-run"),
            "executed": bool(meta.get("executed")),
            "note": meta.get("note", ""),
        })
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "run_profile": metadata.get("run_profile", "unknown") if metadata else "unknown",
        "suites": suites,
        "total": {
            "passed": total_passed,
            "failed": total_failed,
            "total": total_all,
        },
    }
    SUMMARY_JSON.write_text(json.dumps(report, indent=2), encoding="utf-8")

def sparkline_svg(history, key, color, label, w=200, h=40):
    """Generate an SVG sparkline for a history metric."""
    values = [entry.get(key, 0) for entry in history]
    if not values or len(values) < 2:
        return ""
    max_v = max(values) if max(values) > 0 else 1
    min_v = min(values)
    range_v = max_v - min_v if max_v != min_v else 1
    n = len(values)
    points = []
    for i, v in enumerate(values):
        x = (i / (n - 1)) * (w - 8) + 4
        y = h - 6 - ((v - min_v) / range_v) * (h - 12)
        points.append(f"{x:.1f},{y:.1f}")
    polyline = " ".join(points)
    last_v = values[-1]
    # Format display value
    if key == "coverage":
        display = f"{last_v:.1f}%"
    elif key == "total":
        display = str(last_v)
    else:
        display = f"{last_v / values[-1] * 100 if values[-1] else 0:.0f}%" if key == "passed" else str(last_v)
    # For pass rate, compute percentage
    if key == "passed":
        totals = [entry.get("total", 1) for entry in history]
        rate = last_v / totals[-1] * 100 if totals[-1] else 0
        display = f"{rate:.1f}%"

    return f'''<div class="sparkline-card">
      <div class="sparkline-label">{label}</div>
      <svg width="{w}" height="{h}" viewBox="0 0 {w} {h}">
        <polyline points="{polyline}" fill="none" stroke="{color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="{points[-1].split(',')[0]}" cy="{points[-1].split(',')[1]}" r="3" fill="{color}"/>
      </svg>
      <div class="sparkline-value" style="color:{color}">{display}</div>
    </div>'''


def generate_html(vitest, android_suites, cov_data, scenarios, scenario_results, history, metadata, robot=None):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    vitest_meta = suite_meta(metadata, "vitest")
    android_meta = suite_meta(metadata, "android")
    apple_meta = suite_meta(metadata, "apple")
    robot_meta = suite_meta(metadata, "robot")

    # --- Aggregate stats ---
    vt_passed = vitest["numPassedTests"] if vitest else 0
    vt_failed = vitest["numFailedTests"] if vitest else 0
    vt_total = vitest["numTotalTests"] if vitest else 0
    vt_suites = len(vitest.get("testResults", [])) if vitest else 0
    vt_duration = (vitest["testResults"][-1]["endTime"] - vitest["startTime"]) if vitest and vitest.get("testResults") else 0

    and_passed = sum(s["passed"] for s in android_suites)
    and_failed = sum(s["failures"] + s["errors"] for s in android_suites)
    and_total = sum(s["tests"] for s in android_suites)
    and_duration = sum(s["time"] for s in android_suites) * 1000

    rob_passed = robot["passed"] if robot else 0
    rob_failed = robot["failed"] if robot else 0
    rob_skipped = robot["skipped"] if robot else 0
    rob_total = robot["total"] if robot else 0

    total_passed = vt_passed + and_passed + rob_passed
    total_failed = vt_failed + and_failed + rob_failed
    total_all = vt_total + and_total + rob_total
    total_duration = vt_duration + and_duration

    # Coverage
    cov_total = cov_data.get("total", {}) if cov_data else {}
    lines_pct = cov_total.get("lines", {}).get("pct", 0)
    stmts_pct = cov_total.get("statements", {}).get("pct", 0)
    funcs_pct = cov_total.get("functions", {}).get("pct", 0)
    branch_pct = cov_total.get("branches", {}).get("pct", 0)

    pkg_cov = extract_package_coverage(cov_data) if cov_data else {}

    lines_covered = cov_total.get("lines", {}).get("covered", 0) if cov_total else 0
    lines_total_n = cov_total.get("lines", {}).get("total", 0) if cov_total else 0

    # --- Build vitest file rows (with category tags) ---
    vt_file_rows = ""
    if vitest:
        for result in vitest["testResults"]:
            name = result["name"].replace(str(ROOT) + "/", "")
            st = result["status"]
            assertions = result.get("assertionResults", [])
            passed = sum(1 for a in assertions if a["status"] == "passed")
            failed = sum(1 for a in assertions if a["status"] == "failed")
            dur = result["endTime"] - result["startTime"]
            color = "#22c55e" if st == "passed" else "#ef4444"
            icon = "✓" if st == "passed" else "✗"
            cat = classify_test_file(name)
            cat_badge = category_badge_html(cat)

            test_rows = ""
            for a in assertions:
                a_icon = "✓" if a["status"] == "passed" else "✗"
                a_color = "#22c55e" if a["status"] == "passed" else "#ef4444"
                ancestors = " › ".join(a.get("ancestorTitles", []))
                prefix = f'<span style="color:#64748b">{ancestors} › </span>' if ancestors else ""
                a_dur = f'{a.get("duration", 0)}ms' if a.get("duration") else ""
                fail_msg = ""
                if a.get("failureMessages"):
                    escaped = a["failureMessages"][0][:300].replace("<", "&lt;").replace(">", "&gt;")
                    fail_msg = f'<div class="fail-msg">{escaped}</div>'
                test_rows += f'''<tr class="test-row" style="display:none">
                    <td style="padding-left:2.5rem;color:{a_color}">{a_icon}</td>
                    <td colspan="3" style="font-size:0.8rem">{prefix}{a["title"]}{fail_msg}</td>
                    <td style="color:#64748b;font-size:0.75rem">{a_dur}</td>
                </tr>'''

            vt_file_rows += f'''<tr class="file-row" onclick="toggleTests(this)" style="cursor:pointer" data-category="{cat}">
                <td style="color:{color};font-weight:600">{icon}</td>
                <td class="file-path">{name}{cat_badge}</td>
                <td style="text-align:right"><span style="color:#22c55e">{passed}</span></td>
                <td style="text-align:right"><span style="color:{"#ef4444" if failed else "#64748b"}">{failed}</span></td>
                <td style="color:#64748b">{duration_fmt(dur)}</td>
            </tr>{test_rows}'''

    # --- Build android rows ---
    and_file_rows = ""
    for suite in android_suites:
        short_name = suite["name"].replace("dev.agentdeck.", "")
        color = "#22c55e" if suite["failures"] == 0 else "#ef4444"
        icon = "✓" if suite["failures"] == 0 else "✗"

        test_rows = ""
        for c in suite["cases"]:
            c_icon = "✓" if c["status"] == "passed" else "✗"
            c_color = "#22c55e" if c["status"] == "passed" else "#ef4444"
            c_dur = f'{c["time"]*1000:.0f}ms' if c["time"] > 0 else ""
            fail_msg = ""
            if c.get("failure"):
                escaped = c["failure"][:300].replace("<", "&lt;").replace(">", "&gt;")
                fail_msg = f'<div class="fail-msg">{escaped}</div>'
            test_rows += f'''<tr class="test-row" style="display:none">
                <td style="padding-left:2.5rem;color:{c_color}">{c_icon}</td>
                <td colspan="3" style="font-size:0.8rem">{c["name"]}{fail_msg}</td>
                <td style="color:#64748b;font-size:0.75rem">{c_dur}</td>
            </tr>'''

        and_file_rows += f'''<tr class="file-row" onclick="toggleTests(this)" style="cursor:pointer">
            <td style="color:{color};font-weight:600">{icon}</td>
            <td class="file-path">{short_name}</td>
            <td style="text-align:right"><span style="color:#22c55e">{suite["passed"]}</span></td>
            <td style="text-align:right"><span style="color:{"#ef4444" if suite["failures"] else "#64748b"}">{suite["failures"]}</span></td>
            <td style="color:#64748b">{duration_fmt(suite["time"]*1000)}</td>
        </tr>{test_rows}'''

    # --- Build coverage file rows ---
    cov_file_rows = ""
    for pkg_name in sorted(pkg_cov.keys()):
        pkg = pkg_cov[pkg_name]
        for f in sorted(pkg["files"], key=lambda x: x["lines_pct"]):
            bar_w = min(f["lines_pct"], 100)
            bar_color = pct_color(f["lines_pct"])
            cov_file_rows += f'''<tr>
                <td class="file-path">{f["path"]}</td>
                <td style="text-align:right;color:{pct_color(f["stmts_pct"])}">{f["stmts_pct"]:.0f}%</td>
                <td style="text-align:right;color:{pct_color(f["branch_pct"])}">{f["branch_pct"]:.0f}%</td>
                <td style="text-align:right;color:{pct_color(f["funcs_pct"])}">{f["funcs_pct"]:.0f}%</td>
                <td style="text-align:right;color:{pct_color(f["lines_pct"])}">{f["lines_pct"]:.0f}%</td>
                <td style="width:100px"><div class="cov-bar"><div class="cov-fill" style="width:{bar_w}%;background:{bar_color}"></div></div></td>
            </tr>'''

    # --- Package coverage cards ---
    pkg_cards = ""
    for pkg_name in ("bridge", "plugin", "shared", "hooks"):
        if pkg_name not in pkg_cov:
            continue
        pkg = pkg_cov[pkg_name]
        pkg_cards += f'''<div class="cov-card">
            <div class="cov-card-header">{pkg_name}</div>
            <div class="cov-card-gauges">
                <div class="gauge-item">{gauge_svg(pkg["lines"]["pct"])}<span>Lines</span></div>
                <div class="gauge-item">{gauge_svg(pkg["statements"]["pct"])}<span>Stmts</span></div>
                <div class="gauge-item">{gauge_svg(pkg["functions"]["pct"])}<span>Funcs</span></div>
                <div class="gauge-item">{gauge_svg(pkg["branches"]["pct"])}<span>Branch</span></div>
            </div>
            <div class="cov-card-detail">{pkg["lines"]["covered"]}/{pkg["lines"]["total"]} lines covered</div>
        </div>'''

    # --- Scenario matrix rows ---
    scenario_rows = ""
    scenario_detail_rows = ""
    for sc in scenario_results:
        priority_colors = {"critical": "#ef4444", "high": "#f97316", "medium": "#eab308", "low": "#64748b"}
        p_color = priority_colors.get(sc["priority"], "#64748b")
        unit_cell = scenario_cell_html(sc["categories"]["unit"])
        integ_cell = scenario_cell_html(sc["categories"]["integration"])
        plat_cell = scenario_cell_html(sc["categories"]["platform"])
        e2e_cell = scenario_cell_html(sc["categories"]["e2e"])

        # Overall score: all categories
        all_passed = sum(sc["categories"][c]["passed"] for c in ("unit", "integration", "platform", "e2e"))
        all_total = sum(sc["categories"][c]["total"] for c in ("unit", "integration", "platform", "e2e"))
        all_failed = sum(sc["categories"][c]["failed"] for c in ("unit", "integration", "platform", "e2e"))
        all_missing = sum(sc["categories"][c]["missing"] for c in ("unit", "integration", "platform", "e2e"))
        all_not_run = sum(sc["categories"][c].get("not_run", 0) for c in ("unit", "integration", "platform", "e2e"))

        if all_total == 0:
            score_cls = "sc-none"
        elif all_failed > 0:
            score_cls = "sc-fail"
        elif all_missing > 0 or all_not_run > 0:
            score_cls = "sc-warn"
        else:
            score_cls = "sc-pass"

        # Gaps list
        gaps_html = ""
        if sc["gaps"]:
            gaps_items = "".join(f"<li>{g}</li>" for g in sc["gaps"])
            gaps_html = f'<ul class="sc-gaps">{gaps_items}</ul>'

        # Detail rows (collapsed)
        detail_html = ""
        for cat in ("unit", "integration", "platform", "e2e"):
            for t in sc["categories"][cat]["tests"]:
                t_icon = "✓" if t["status"] == "pass" else ("✗" if t["status"] == "fail" else "○" if t["status"] == "not-run" else "?")
                t_color = "#22c55e" if t["status"] == "pass" else ("#ef4444" if t["status"] == "fail" else "#94a3b8" if t["status"] == "not-run" else "#64748b")
                detail_html += f'''<tr class="sc-detail-row" data-scenario="{sc["id"]}" style="display:none">
                    <td style="padding-left:2rem;color:{t_color}">{t_icon}</td>
                    <td class="file-path" style="font-size:0.75rem">{t["file"]}</td>
                    <td>{category_badge_html(cat)}</td>
                    <td style="text-align:right;color:#22c55e;font-size:0.8rem">{t["passed"]}</td>
                    <td style="text-align:right;color:{"#ef4444" if t["failed"] else "#64748b"};font-size:0.8rem">{t["failed"]}</td>
                    <td></td>
                </tr>'''

        scenario_rows += f'''<tr class="sc-row" onclick="toggleScenario('{sc["id"]}')" style="cursor:pointer">
            <td class="{score_cls}" style="font-weight:600;text-align:center">{all_passed}/{all_total}</td>
            <td>
                <div style="font-weight:500">{sc["name"]}</div>
                <div style="font-size:0.75rem;color:var(--dim)">{sc["description"]}</div>
                {gaps_html}
            </td>
            <td style="text-align:center"><span style="color:{p_color};font-size:0.75rem;font-weight:600;text-transform:uppercase">{sc["priority"]}</span></td>
            {unit_cell}{integ_cell}{plat_cell}{e2e_cell}
        </tr>{detail_html}'''

    # --- Scenario summary stats ---
    sc_total = len(scenario_results)
    sc_full = sum(1 for s in scenario_results
                  if all(s["categories"][c]["total"] == 0 or (s["categories"][c]["failed"] == 0 and s["categories"][c]["missing"] == 0 and s["categories"][c].get("not_run", 0) == 0)
                         for c in ("unit", "integration", "platform", "e2e"))
                  and any(s["categories"][c]["total"] > 0 for c in ("unit", "integration", "platform", "e2e")))
    sc_gaps = sum(1 for s in scenario_results if s["gaps"])

    # --- History sparklines ---
    sparklines_html = ""
    if len(history) >= 2:
        sparklines_html = f'''<div class="sparkline-row">
            {sparkline_svg(history, "total", "#38bdf8", "Total Tests")}
            {sparkline_svg(history, "passed", "#22c55e", "Pass Rate")}
            {sparkline_svg(history, "coverage", "#a78bfa", "Line Coverage")}
        </div>'''

    # --- Overall status ---
    overall_status = "PASS" if total_failed == 0 else "FAIL"
    overall_color = "#22c55e" if total_failed == 0 else "#ef4444"

    # --- Vitest category filter ---
    vt_categories = set()
    if vitest:
        for result in vitest["testResults"]:
            name = result["name"].replace(str(ROOT) + "/", "")
            vt_categories.add(classify_test_file(name))
    cat_filter_buttons = '<button class="active" onclick="filterVitestCat(\'all\',this)">All</button>'
    for c in sorted(vt_categories):
        cat_filter_buttons += f'<button onclick="filterVitestCat(\'{c}\',this)">{c}</button>'

    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AgentDeck Test Report</title>
<style>
:root {{ --bg: #0f172a; --surface: #1e293b; --surface2: #334155; --text: #e2e8f0; --dim: #64748b; --accent: #38bdf8; }}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', 'Inter', system-ui, sans-serif; line-height: 1.5; padding: 2rem; }}
.container {{ max-width: 1200px; margin: 0 auto; }}
h1 {{ font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }}
.subtitle {{ color: var(--dim); font-size: 0.85rem; margin-bottom: 2rem; }}

/* Summary cards */
.summary {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }}
.card {{ background: var(--surface); border-radius: 12px; padding: 1.25rem; }}
.card-label {{ color: var(--dim); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }}
.card-value {{ font-size: 2rem; font-weight: 700; }}
.card-sub {{ color: var(--dim); font-size: 0.8rem; margin-top: 0.25rem; }}

/* Sparkline row */
.sparkline-row {{ display: flex; gap: 1.5rem; margin-bottom: 2rem; padding: 0.75rem 1rem; background: var(--surface); border-radius: 12px; }}
.sparkline-card {{ flex: 1; text-align: center; }}
.sparkline-label {{ font-size: 0.7rem; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }}
.sparkline-value {{ font-size: 0.85rem; font-weight: 600; margin-top: 0.25rem; }}

/* Suite bars */
.suite-bars {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; margin-bottom: 2rem; }}
.suite-bar {{ background: var(--surface); border-radius: 12px; padding: 1rem 1.25rem; }}
.suite-bar-header {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }}
.suite-bar-header h3 {{ font-size: 0.95rem; font-weight: 600; }}
.badge {{ font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 4px; }}
.badge.pass {{ background: #16a34a22; color: #22c55e; }}
.badge.fail {{ background: #dc262622; color: #ef4444; }}
.badge.skip {{ background: #ca8a0422; color: #eab308; }}
.progress-bar {{ height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; }}
.progress-fill {{ height: 100%; border-radius: 3px; transition: width 0.5s; }}
.suite-stats {{ display: flex; gap: 1rem; margin-top: 0.5rem; font-size: 0.8rem; color: var(--dim); }}

/* Sections */
.section {{ margin-bottom: 2.5rem; }}
.section-title {{ font-size: 1.1rem; font-weight: 600; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }}
.section-title span {{ color: var(--dim); font-size: 0.85rem; font-weight: 400; }}

/* Tables */
table {{ width: 100%; border-collapse: collapse; }}
th {{ text-align: left; color: var(--dim); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--surface2); }}
td {{ padding: 0.5rem 0.75rem; border-bottom: 1px solid #1e293b; font-size: 0.85rem; }}
.file-row:hover {{ background: var(--surface); }}
.file-path {{ font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.8rem; }}
.test-row {{ background: #0f172a; }}
.test-row td {{ border-bottom: 1px solid #1a2332; }}
.fail-msg {{ color: #ef4444; font-size: 0.75rem; margin-top: 0.25rem; font-family: monospace; white-space: pre-wrap; max-height: 100px; overflow: auto; }}

/* Coverage cards */
.cov-cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }}
.cov-card {{ background: var(--surface); border-radius: 12px; padding: 1rem; }}
.cov-card-header {{ font-weight: 600; font-size: 0.95rem; margin-bottom: 0.75rem; }}
.cov-card-gauges {{ display: flex; justify-content: space-around; }}
.gauge-item {{ text-align: center; }}
.gauge-item span {{ display: block; font-size: 0.7rem; color: var(--dim); margin-top: 2px; }}
.cov-card-detail {{ text-align: center; color: var(--dim); font-size: 0.75rem; margin-top: 0.75rem; }}

/* Coverage bar in table */
.cov-bar {{ height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; }}
.cov-fill {{ height: 100%; border-radius: 3px; }}

/* Filter buttons (shared) */
.filter-bar {{ margin-bottom: 1rem; display: flex; gap: 0.5rem; }}
.filter-bar button {{ background: var(--surface); color: var(--text); border: 1px solid var(--surface2); padding: 4px 12px; border-radius: 6px; font-size: 0.8rem; cursor: pointer; }}
.filter-bar button.active {{ background: var(--accent); color: var(--bg); border-color: var(--accent); }}
.cov-filter {{ margin-bottom: 1rem; display: flex; gap: 0.5rem; }}
.cov-filter button {{ background: var(--surface); color: var(--text); border: 1px solid var(--surface2); padding: 4px 12px; border-radius: 6px; font-size: 0.8rem; cursor: pointer; }}
.cov-filter button.active {{ background: var(--accent); color: var(--bg); border-color: var(--accent); }}

/* Expand/collapse */
.expand-hint {{ color: var(--dim); font-size: 0.75rem; cursor: pointer; }}
.expand-hint:hover {{ color: var(--accent); }}

/* Threshold indicators */
.threshold {{ display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; background: var(--surface); padding: 4px 12px; border-radius: 6px; margin-right: 0.5rem; margin-bottom: 0.5rem; }}
.threshold .dot {{ width: 8px; height: 8px; border-radius: 50%; }}

/* Scenario matrix */
.sc-row:hover {{ background: var(--surface); }}
.sc-cell {{ text-align: center; font-size: 0.85rem; font-weight: 600; border-radius: 4px; }}
.sc-pass {{ color: #22c55e; }}
.sc-fail {{ color: #ef4444; }}
.sc-warn {{ color: #eab308; }}
.sc-none {{ color: var(--dim); }}
.sc-gaps {{ list-style: none; margin-top: 0.25rem; }}
.sc-gaps li {{ font-size: 0.7rem; color: #f97316; padding-left: 0.75rem; position: relative; }}
.sc-gaps li::before {{ content: "!"; position: absolute; left: 0; font-weight: 700; }}
.sc-detail-row {{ background: #0c1222; }}
.sc-detail-row td {{ border-bottom: 1px solid #1a2332; }}
.sc-summary-bar {{ display: flex; gap: 1.5rem; margin-bottom: 1rem; }}
.sc-summary-item {{ font-size: 0.85rem; }}

/* Responsive */
@media (max-width: 640px) {{
  body {{ padding: 1rem; }}
  .summary {{ grid-template-columns: repeat(2, 1fr); }}
  .sparkline-row {{ flex-direction: column; }}
}}
</style>
</head>
<body>
<div class="container">
  <h1>AgentDeck Test Report</h1>
  <p class="subtitle">Generated {now} &middot; {total_all} executed tests &middot; profile {metadata.get("run_profile", "unknown") if metadata else "unknown"}</p>

  <!-- Summary Cards -->
  <div class="summary">
    <div class="card">
      <div class="card-label">Status</div>
      <div class="card-value" style="color:{overall_color}">{overall_status}</div>
      <div class="card-sub">{total_all} executed tests</div>
    </div>
    <div class="card">
      <div class="card-label">Passed</div>
      <div class="card-value" style="color:#22c55e">{total_passed}</div>
      <div class="card-sub">{total_passed/total_all*100:.1f}% pass rate</div>
    </div>
    <div class="card">
      <div class="card-label">Failed</div>
      <div class="card-value" style="color:{"#ef4444" if total_failed else "#64748b"}">{total_failed}</div>
      <div class="card-sub">&nbsp;</div>
    </div>
    <div class="card">
      <div class="card-label">Duration</div>
      <div class="card-value" style="color:var(--accent)">{duration_fmt(total_duration)}</div>
      <div class="card-sub">{duration_fmt(vt_duration)} vitest + {duration_fmt(and_duration)} android</div>
    </div>
    <div class="card">
      <div class="card-label">TS Line Coverage</div>
      <div class="card-value" style="color:{pct_color(lines_pct)}">{lines_pct:.1f}%</div>
      <div class="card-sub">{lines_covered:,}/{lines_total_n:,} TypeScript lines</div>
    </div>
  </div>

  {sparklines_html}

  <!-- Suite Bars -->
  <div class="suite-bars">
    <div class="suite-bar">
      <div class="suite-bar-header">
        <h3>Vitest</h3>
        {status_badge(vitest_meta["status"])}
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:{vt_passed/vt_total*100 if vt_total else 0:.1f}%;background:{suite_progress_color(vitest_meta["status"])}"></div>
      </div>
      <div class="suite-stats">
        <span>Pass {vt_passed}</span>
        <span>Fail {vt_failed}</span>
        <span>{vt_suites} files</span>
        <span>{vitest_meta["note"] or duration_fmt(vt_duration)}</span>
      </div>
    </div>
    <div class="suite-bar">
      <div class="suite-bar-header">
        <h3>Android</h3>
        {status_badge(android_meta["status"])}
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:{and_passed/and_total*100 if and_total else 0:.1f}%;background:{suite_progress_color(android_meta["status"])}"></div>
      </div>
      <div class="suite-stats">
        <span>Pass {and_passed}</span>
        <span>Fail {and_failed}</span>
        <span>{len(android_suites)} files</span>
        <span>{android_meta["note"] or duration_fmt(and_duration)}</span>
      </div>
    </div>
    <div class="suite-bar">
      <div class="suite-bar-header">
        <h3>Apple (XCTest)</h3>
        {status_badge(apple_meta["status"])}
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:0;background:{suite_progress_color(apple_meta["status"])}"></div></div>
      <div class="suite-stats"><span style="color:var(--dim)">{apple_meta["note"] or "Requires macOS runner"}</span></div>
    </div>
    <div class="suite-bar">
      <div class="suite-bar-header">
        <h3>Robot Framework</h3>
        {status_badge(robot_meta["status"])}
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:{rob_passed/rob_total*100 if rob_total else 0:.1f}%;background:{suite_progress_color(robot_meta["status"])}"></div>
      </div>
      <div class="suite-stats">
        {f"<span>Pass {rob_passed}</span><span>Fail {rob_failed}</span><span>Skip {rob_skipped}</span>" if robot else f'<span style="color:var(--dim)">{robot_meta["note"] or "Not available"}</span>'}
      </div>
    </div>
  </div>

  <!-- Scenario Coverage Matrix -->
  {"" if not scenario_results else f"""<div class="section">
    <div class="section-title">Scenario Coverage Mapping <span>{sc_total} scenarios &middot; {sc_full} fully covered in this report &middot; {sc_gaps} with known gaps</span></div>

    <div class="sc-summary-bar">
      <span class="sc-summary-item"><span style="color:#22c55e;font-weight:600">{sc_full}</span> covered</span>
      <span class="sc-summary-item"><span style="color:#eab308;font-weight:600">{sc_total - sc_full}</span> partial/missing</span>
      <span class="sc-summary-item"><span style="color:#f97316;font-weight:600">{sc_gaps}</span> with identified gaps</span>
    </div>

    <table id="scenario-table">
      <thead><tr>
        <th style="width:60px;text-align:center">Score</th>
        <th>Scenario</th>
        <th style="width:70px;text-align:center">Priority</th>
        <th style="width:70px;text-align:center">Unit</th>
        <th style="width:70px;text-align:center">Integ.</th>
        <th style="width:70px;text-align:center">Platform</th>
        <th style="width:70px;text-align:center">E2E</th>
      </tr></thead>
      <tbody>{scenario_rows}</tbody>
    </table>
  </div>"""}

  <!-- Vitest Detail -->
  <div class="section">
    <div class="section-title">Vitest <span>bridge / plugin / shared / hooks &middot; {vt_suites} files &middot; {vt_total} tests</span>
      <span class="expand-hint" onclick="toggleAllTests('vitest-table')">[expand all]</span>
    </div>
    <div class="filter-bar" id="vitest-filter">
      {cat_filter_buttons}
    </div>
    <table id="vitest-table">
      <thead><tr>
        <th style="width:30px"></th>
        <th>File</th>
        <th style="text-align:right;width:60px">Pass</th>
        <th style="text-align:right;width:60px">Fail</th>
        <th style="width:80px">Time</th>
      </tr></thead>
      <tbody>{vt_file_rows}</tbody>
    </table>
  </div>

  <!-- Android Detail -->
  {"" if not android_suites else f"""<div class="section">
    <div class="section-title">Android <span>JUnit + Robolectric &middot; {len(android_suites)} files &middot; {and_total} tests</span>
      <span class="expand-hint" onclick="toggleAllTests('android-table')">[expand all]</span>
    </div>
    <table id="android-table">
      <thead><tr>
        <th style="width:30px"></th>
        <th>Suite</th>
        <th style="text-align:right;width:60px">Pass</th>
        <th style="text-align:right;width:60px">Fail</th>
        <th style="width:80px">Time</th>
      </tr></thead>
      <tbody>{and_file_rows}</tbody>
    </table>
  </div>"""}

  <!-- Robot Framework Detail -->
  {"" if not robot else f"""<div class="section">
    <div class="section-title">Robot Framework <span>ESP32 build verification &middot; {rob_total} tests (no-hw)</span></div>
    <table id="robot-table">
      <thead><tr>
        <th style="width:30px"></th>
        <th>Test Case</th>
        <th style="width:80px">Status</th>
      </tr></thead>
      <tbody>{"".join(
        f'<tr class="file-row"><td style="color:{"#22c55e" if c["status"]=="passed" else ("#64748b" if c["status"]=="skipped" else "#ef4444")};font-weight:600">{"✓" if c["status"]=="passed" else ("○" if c["status"]=="skipped" else "✗")}</td><td class="file-path">{c["name"]}</td><td>{status_badge(c["status"])}</td></tr>'
        + (f'<tr class="test-row"><td></td><td colspan="2" class="fail-msg">{c["message"]}</td></tr>' if c.get("message") and c["status"]=="failed" else "")
        for c in robot["cases"]
      )}</tbody>
    </table>
  </div>"""}

  <!-- Coverage Overview -->
  {"" if not cov_data else f"""<div class="section">
    <div class="section-title">Coverage <span>v8 provider &middot; {lines_total_n:,} lines tracked</span></div>

    <div style="margin-bottom:1rem">
      <div class="threshold"><div class="dot" style="background:{"#22c55e" if lines_pct >= 17 else "#ef4444"}"></div>Lines &ge;17%: {lines_pct:.1f}%</div>
      <div class="threshold"><div class="dot" style="background:{"#22c55e" if funcs_pct >= 15 else "#ef4444"}"></div>Functions &ge;15%: {funcs_pct:.1f}%</div>
      <div class="threshold"><div class="dot" style="background:{"#22c55e" if branch_pct >= 14 else "#ef4444"}"></div>Branches &ge;14%: {branch_pct:.1f}%</div>
      <div class="threshold"><div class="dot" style="background:{"#22c55e" if stmts_pct >= 16 else "#ef4444"}"></div>Statements &ge;16%: {stmts_pct:.1f}%</div>
    </div>

    <div class="cov-cards">{pkg_cards}</div>

    <div class="cov-filter">
      <button class="active" onclick="filterCov('all',this)">All</button>
      <button onclick="filterCov('bridge',this)">bridge</button>
      <button onclick="filterCov('plugin',this)">plugin</button>
      <button onclick="filterCov('shared',this)">shared</button>
      <button onclick="filterCov('uncovered',this)">0% only</button>
    </div>

    <table id="cov-table">
      <thead><tr>
        <th>File</th>
        <th style="text-align:right;width:70px">Stmts</th>
        <th style="text-align:right;width:70px">Branch</th>
        <th style="text-align:right;width:70px">Funcs</th>
        <th style="text-align:right;width:70px">Lines</th>
        <th style="width:110px"></th>
      </tr></thead>
      <tbody>{cov_file_rows}</tbody>
    </table>
  </div>"""}

</div>

<script>
function toggleTests(fileRow) {{
  let next = fileRow.nextElementSibling;
  while (next && next.classList.contains('test-row')) {{
    next.style.display = next.style.display === 'none' ? '' : 'none';
    next = next.nextElementSibling;
  }}
}}

function toggleAllTests(tableId) {{
  const table = document.getElementById(tableId);
  const rows = table.querySelectorAll('.test-row');
  const anyHidden = Array.from(rows).some(r => r.style.display === 'none');
  rows.forEach(r => r.style.display = anyHidden ? '' : 'none');
}}

function filterCov(pkg, btn) {{
  document.querySelectorAll('.cov-filter button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const rows = document.querySelectorAll('#cov-table tbody tr');
  rows.forEach(r => {{
    const path = r.querySelector('.file-path')?.textContent || '';
    const linesPct = parseFloat(r.querySelectorAll('td')[4]?.textContent) || 0;
    if (pkg === 'all') {{ r.style.display = ''; }}
    else if (pkg === 'uncovered') {{ r.style.display = linesPct === 0 ? '' : 'none'; }}
    else {{ r.style.display = path.startsWith(pkg + '/') ? '' : 'none'; }}
  }});
}}

function filterVitestCat(cat, btn) {{
  document.querySelectorAll('#vitest-filter button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const rows = document.querySelectorAll('#vitest-table tbody tr.file-row');
  rows.forEach(r => {{
    const show = cat === 'all' || r.dataset.category === cat;
    r.style.display = show ? '' : 'none';
    // Also hide associated test-rows when filtering
    let next = r.nextElementSibling;
    while (next && next.classList.contains('test-row')) {{
      next.style.display = 'none';
      next = next.nextElementSibling;
    }}
  }});
}}

function toggleScenario(id) {{
  const rows = document.querySelectorAll('.sc-detail-row[data-scenario="' + id + '"]');
  const anyHidden = Array.from(rows).some(r => r.style.display === 'none');
  rows.forEach(r => r.style.display = anyHidden ? '' : 'none');
}}
</script>
</body>
</html>'''
    return html


def main():
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    vitest = load_vitest()
    android = load_android_xml()
    cov = load_coverage()
    robot = load_robot_xml()
    scenarios = load_scenarios()
    history = load_history()
    metadata = load_metadata()
    if not metadata:
        metadata = build_default_metadata(vitest, android, robot)
        METADATA_JSON.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    if not vitest and not android and not robot:
        print("No test results found. Run 'pnpm test:report' first.")
        sys.exit(1)

    # Build scenario cross-reference
    scenario_results = build_scenario_results(scenarios, vitest, android, metadata) if scenarios else []

    # Compute stats for history
    vt_passed = vitest["numPassedTests"] if vitest else 0
    vt_failed = vitest["numFailedTests"] if vitest else 0
    vt_total = vitest["numTotalTests"] if vitest else 0
    and_passed = sum(s["passed"] for s in android)
    and_failed = sum(s["failures"] + s["errors"] for s in android)
    and_total = sum(s["tests"] for s in android)
    rob_passed = robot["passed"] if robot else 0
    rob_failed = robot["failed"] if robot else 0
    rob_total = robot["total"] if robot else 0
    total_passed = vt_passed + and_passed + rob_passed
    total_failed = vt_failed + and_failed + rob_failed
    total_all = vt_total + and_total + rob_total
    cov_total = cov.get("total", {}) if cov else {}
    lines_pct = cov_total.get("lines", {}).get("pct", 0)

    # Update history
    history = update_history(history, total_passed, total_failed, total_all, lines_pct, metadata)

    write_summary(metadata, total_passed, total_failed, total_all)
    html = generate_html(vitest, android, cov, scenarios, scenario_results, history, metadata, robot)
    OUTPUT_HTML.write_text(html, encoding="utf-8")
    print(f"HTML report: {OUTPUT_HTML}")


if __name__ == "__main__":
    main()
