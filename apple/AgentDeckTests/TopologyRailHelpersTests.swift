// TopologyRailHelpersTests.swift — guards against the dashboard surfacing
// stale Codex subscription dates. The bug: when the user renews ChatGPT
// Plus but does not re-run `codex login`, ~/.codex/auth.json keeps the
// previous JWT and `chatgpt_subscription_active_until` lags behind the
// real billing state. Once that timestamp is in the past, the renderer
// must drop it instead of showing "ChatGPT Plus · Mar 4" forever.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class TopologyRailHelpersTests: XCTestCase {
    func testParseFutureISO8601WithFractionalSeconds() {
        let parsed = TopologyRail.parseUntilDate("2099-12-31T23:59:59.999Z")
        XCTAssertNotNil(parsed)
        XCTAssertGreaterThan(parsed!, Date())
    }

    func testParsePlainISO8601() {
        let parsed = TopologyRail.parseUntilDate("2099-01-15T00:00:00Z")
        XCTAssertNotNil(parsed)
        XCTAssertGreaterThan(parsed!, Date())
    }

    func testParsePastDateReturnsDateInPast() {
        let parsed = TopologyRail.parseUntilDate("2020-06-01T00:00:00Z")
        XCTAssertNotNil(parsed)
        XCTAssertLessThan(parsed!, Date())
    }

    func testParseDateOnly() {
        let parsed = TopologyRail.parseUntilDate("2099-05-15")
        XCTAssertNotNil(parsed)
        XCTAssertGreaterThan(parsed!, Date())
    }

    func testParseEmptyReturnsNil() {
        XCTAssertNil(TopologyRail.parseUntilDate(""))
        XCTAssertNil(TopologyRail.parseUntilDate("   "))
    }

    func testParseMalformedReturnsNil() {
        XCTAssertNil(TopologyRail.parseUntilDate("not-a-date"))
        XCTAssertNil(TopologyRail.parseUntilDate("2026/05/06"))
        XCTAssertNil(TopologyRail.parseUntilDate("forever"))
    }
}
#endif
