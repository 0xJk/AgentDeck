// ApmeParseJudgeTests.swift — parseJudgeJson parity tests.
//
// These fixtures mirror the TS test cases. `parseJudgeJson` is the one
// function in the APME pipeline where silent drift between Swift and TS
// causes data loss (the original whitelist bug dropped conversation/research
// rubric axes until commit e76325f7). Any change that fails this suite
// must be mirrored in bridge/src/apme/runner.ts and vice versa.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class ApmeParseJudgeTests: XCTestCase {

    // MARK: - Happy path

    func testValidCodeAxes() {
        let json = """
        {"task_completion":0.9,"code_quality":0.8,"efficiency":0.7,"overall":0.85,"reasoning":"Good"}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores["task_completion"], 0.9)
        XCTAssertEqual(parsed?.scores["code_quality"], 0.8)
        XCTAssertEqual(parsed?.scores["efficiency"], 0.7)
        XCTAssertEqual(parsed?.scores["overall"], 0.85)
        XCTAssertEqual(parsed?.reasoning, "Good")
    }

    func testConversationRubricAxesAccepted() {
        // This is the regression guard for commit e76325f7 — the old TS
        // parser had a hardcoded whitelist that silently dropped these
        // axes, leaving only `overall` in the evals table.
        let json = """
        {"accuracy":0.95,"helpfulness":0.85,"conciseness":0.9,"overall":0.9,"reasoning":"x"}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores.count, 4)
        XCTAssertEqual(parsed?.scores["accuracy"], 0.95)
        XCTAssertEqual(parsed?.scores["helpfulness"], 0.85)
        XCTAssertEqual(parsed?.scores["conciseness"], 0.9)
        XCTAssertEqual(parsed?.scores["overall"], 0.9)
    }

    func testResearchRubricAxesAccepted() {
        let json = """
        {"thoroughness":0.7,"relevance":0.9,"synthesis":0.75,"overall":0.78,"reasoning":"x"}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores["thoroughness"], 0.7)
        XCTAssertEqual(parsed?.scores["relevance"], 0.9)
        XCTAssertEqual(parsed?.scores["synthesis"], 0.75)
        XCTAssertEqual(parsed?.scores["overall"], 0.78)
    }

    // MARK: - Rescaling + clamping

    func testZeroToTenRescale() {
        // Models occasionally ignore the "float in [0,1]" instruction.
        // clamp01 must rescale values in (1, 10] by /10.
        let json = """
        {"task_completion":9,"code_quality":8,"overall":8.5,"reasoning":"x"}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores["task_completion"], 0.9)
        XCTAssertEqual(parsed?.scores["code_quality"], 0.8)
        XCTAssertEqual(parsed?.scores["overall"], 0.85)
    }

    func testClampAbove1RescaleBehavior() {
        // TS parity: clamp01 assumes any value > 1 and ≤ 10 was emitted on
        // a 0..10 scale and rescales by /10. So 1.5 → 0.15, not → 1.0.
        // This is arguably a quirk (slight rounding overshoot collapses to
        // a small score) but matches bridge/src/apme/runner.ts:601-606.
        let json = """
        {"overall":1.5}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertEqual(parsed?.scores["overall"], 0.15)
    }

    func testClampAbove10ClampsTo1() {
        // Values > 10 fall through to `v > 1 → v = 1`.
        let json = """
        {"overall":11}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertEqual(parsed?.scores["overall"], 1.0)
    }

    func testClampBelow0() {
        let json = """
        {"overall":-0.3}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertEqual(parsed?.scores["overall"], 0.0)
    }

    // MARK: - Wrapped JSON (code fences, prose prefixes)

    func testCodeFenceWrappedJson() {
        // Apple Foundation Models wraps JSON in ```json fences at
        // temperature=0. parseJudgeJson extracts the first `{...}` block.
        let text = """
        Here is the evaluation:

        ```json
        {"accuracy":0.9,"helpfulness":0.9,"conciseness":0.8,"overall":0.85,"reasoning":"Correct"}
        ```

        Let me know if you need more detail.
        """
        let parsed = ApmeRunner.parseJudgeJson(text)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores["overall"], 0.85)
        XCTAssertEqual(parsed?.scores["accuracy"], 0.9)
    }

    func testProseWrappedJson() {
        let text = """
        Based on the criteria, here is my judgment: {"overall":0.7,"intent":0.6,"reasoning":"Meh"}
        """
        let parsed = ApmeRunner.parseJudgeJson(text)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores["overall"], 0.7)
        XCTAssertEqual(parsed?.scores["intent"], 0.6)
    }

    // MARK: - Rejection cases

    func testMissingOverallReturnsNil() {
        // The TS contract requires `overall` — without it, the row is
        // considered unparseable and the whole eval is dropped.
        let json = """
        {"accuracy":0.9,"helpfulness":0.8}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNil(parsed)
    }

    func testNonNumericAxesIgnored() {
        let json = """
        {"accuracy":"high","overall":0.8,"notes":"some text"}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertNil(parsed?.scores["accuracy"])  // dropped — string
        XCTAssertNil(parsed?.scores["notes"])      // reserved + non-numeric
        XCTAssertEqual(parsed?.scores["overall"], 0.8)
    }

    func testReservedFieldsNeverCountAsAxes() {
        // Even if a model returns numeric values for reserved fields,
        // parseJudgeJson must not count them as axes.
        let json = """
        {"overall":0.9,"reasoning":0.5,"done":1,"missed":0,"notes":0.3}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        // Only `overall` should be in scores — reserved fields skipped.
        XCTAssertEqual(parsed?.scores.count, 1)
        XCTAssertEqual(parsed?.scores["overall"], 0.9)
    }

    func testEmptyInputReturnsNil() {
        XCTAssertNil(ApmeRunner.parseJudgeJson(""))
        XCTAssertNil(ApmeRunner.parseJudgeJson("no json here"))
    }

    // MARK: - done / missed arrays

    func testDoneMissedArraysParsed() {
        let json = """
        {"overall":0.8,"reasoning":"ok","done":["answered","verified"],"missed":["context"]}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.done, ["answered", "verified"])
        XCTAssertEqual(parsed?.missed, ["context"])
    }

    // MARK: - clamp01 unit tests

    func testClamp01ValidRange() {
        XCTAssertEqual(ApmeRunner.clamp01(0.0), 0.0)
        XCTAssertEqual(ApmeRunner.clamp01(0.5), 0.5)
        XCTAssertEqual(ApmeRunner.clamp01(1.0), 1.0)
    }

    func testClamp01Rescale10() {
        XCTAssertEqual(ApmeRunner.clamp01(5.0), 0.5)
        XCTAssertEqual(ApmeRunner.clamp01(10.0), 1.0)
    }

    func testClamp01ClampAbove10() {
        XCTAssertEqual(ApmeRunner.clamp01(15.0), 1.0)
    }

    func testClamp01ClampBelow0() {
        XCTAssertEqual(ApmeRunner.clamp01(-1.0), 0.0)
    }
}
#endif
