#if os(macOS)
import XCTest
@testable import AgentDeck

final class CodexOtelParserTests: XCTestCase {

    // Real Codex thread ids are UUIDv7-shaped (≥12 chars, contain non-digits).
    // The test sentinels below mirror that shape so the parser's
    // `isDurableSessionId` guard accepts them — `t1`/`t2`/`t-tool`-style
    // shortcuts would now be rejected as phantom-prone, and rightly so.
    private let tid1 = "thread-test-01"
    private let tid2 = "thread-test-02"
    private let tid3 = "thread-test-03"
    private let tid4 = "thread-test-04"
    private let tid5 = "thread-test-05"
    private let tidLog = "thread-test-log"
    private let tidCurrent = "thread-test-current"
    private let tidStream = "thread-test-stream"
    private let tidTool = "thread-test-tool"

    func testTurnStartFromTopLevelTurn() {
        let json = otlp(spans: [
            ["name": "codex.turn", "attributes": attr(["codex.thread_id": tid1, "codex.turn_id": "u1", "cwd": "/repo"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: tid1, turnId: "u1", cwd: "/repo")]
        )
    }

    func testFullTurnSequence() {
        let json = otlp(spans: [
            ["name": "codex.turn.start", "attributes": attr(["codex.thread_id": tid2, "codex.turn_id": "u2"])],
            ["name": "codex.tool.call", "attributes": attr(["codex.thread_id": tid2, "codex.turn_id": "u2", "tool.name": "Read"])],
            ["name": "codex.tool.result", "attributes": attr(["codex.thread_id": tid2, "codex.turn_id": "u2"])],
            ["name": "codex.turn.end", "attributes": attr(["codex.thread_id": tid2, "codex.turn_id": "u2"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [
                .turnStart(threadId: tid2, turnId: "u2", cwd: nil),
                .toolCall(threadId: tid2, turnId: "u2", tool: "Read"),
                .toolResult(threadId: tid2, turnId: "u2"),
                .turnEnd(threadId: tid2, turnId: "u2"),
            ]
        )
    }

    func testObservedCodexNamesFromTuiLog() {
        let json = otlp(spans: [
            ["name": "op.dispatch.user_input_with_turn_context", "attributes": attr(["thread.id": tidLog, "turn.id": "u-log", "cwd": "/repo"])],
            ["name": "session_task.turn", "attributes": attr(["thread.id": tidLog, "turn.id": "u-log"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [
                .turnStart(threadId: tidLog, turnId: "u-log", cwd: "/repo"),
                .turnEnd(threadId: tidLog, turnId: "u-log"),
            ]
        )
    }

    func testSlashDelimitedTurnStartFromCurrentCodexOtel() {
        let json = otlp(spans: [
            ["name": "turn/start", "attributes": attr(["thread.id": tidCurrent, "turn.id": "u-current", "cwd": "/repo"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: tidCurrent, turnId: "u-current", cwd: "/repo")]
        )
    }

    func testCurrentCodexActivitySpansAreRecognized() {
        let json = otlp(spans: [
            ["name": "responses_websocket.stream_request", "attributes": attr(["thread.id": tidStream, "turn.id": "u-stream"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.activity(threadId: tidStream, turnId: "u-stream", name: "responses_websocket.stream_request")]
        )
    }

    func testExecCommandRecognizedAsToolCall() {
        let json = otlp(spans: [
            ["name": "exec_command", "attributes": attr(["thread.id": tidTool, "turn.id": "u-tool"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.toolCall(threadId: tidTool, turnId: "u-tool", tool: "exec")]
        )
    }

    func testNumericSessionIdDoesNotBecomeThreadId() {
        let json = otlp(spans: [
            ["name": "turn/start", "attributes": attr(["session_id": "8", "turn.id": "u-short"])]
        ])
        XCTAssertEqual(CodexTelemetryModule.parse(json), [])
    }

    /// Short / numeric thread-id attrs must be filtered before they reach
    /// the dispatch table — otherwise `handleCodexTrace.turnStart` would
    /// synthesize phantom `codex:11` rows from companion-task spans, the
    /// same pattern the hook path was hardened against on 2026-05-03.
    /// Covers every key alias `threadIdAttr` reads.
    func testShortNumericThreadIdAttrsAreFiltered() {
        for key in ["codex.thread_id", "codex.thread.id", "thread.id", "thread_id", "threadId"] {
            for badValue in ["11", "8", "12345", "12345678901234"] {
                let json = otlp(spans: [
                    ["name": "turn/start", "attributes": attr([key: badValue, "turn.id": "u-x", "cwd": "/repo"])]
                ])
                XCTAssertEqual(
                    CodexTelemetryModule.parse(json),
                    [],
                    "key=\(key) value=\(badValue) must not synthesize a thread"
                )
            }
        }
    }

    /// UUID-shaped thread-id attrs are the real-world case and must pass.
    func testUuidThreadIdAttrIsAccepted() {
        let uuid = "019dee40-c853-74e0-b46d-dae33eb1d02b"
        let json = otlp(spans: [
            ["name": "turn/start", "attributes": attr(["thread_id": uuid, "turn.id": "u-x", "cwd": "/repo"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: uuid, turnId: "u-x", cwd: "/repo")]
        )
    }

    /// Mixed-alias spans: when both a short companion-task id and the real
    /// thread UUID are emitted on the same span, the earlier alias must
    /// not short-circuit alias scanning. A naïve "first non-empty +
    /// isDurable guard" reads the short value, fails the guard, drops the
    /// span entirely — wasting the good UUID waiting in the next alias.
    /// Iterating every alias for the first durable match keeps these
    /// spans intact.
    func testAliasScanPicksDurableOverShortInSameSpan() {
        let uuid = "019dee40-c853-74e0-b46d-dae33eb1d02b"
        // codex.thread_id is scanned first (short, non-durable).
        // thread.id is scanned later (durable UUID — must win).
        let json = otlp(spans: [
            ["name": "turn/start", "attributes": attr([
                "codex.thread_id": "11",
                "thread.id": uuid,
                "turn.id": "u-mix",
                "cwd": "/repo",
            ])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: uuid, turnId: "u-mix", cwd: "/repo")],
            "Short thread_id alias must not poison scanning when a durable alias is present on the same span"
        )
    }

    /// `session_id` fallback also scans aliases; same trap applies if
    /// `session_id` is short but `session.id` is durable.
    func testAliasScanPicksDurableSessionIdFallback() {
        let uuid = "019dda49-2ce1-7a62-8fdc-4b7753b6bd0b"
        let json = otlp(spans: [
            ["name": "turn/start", "attributes": attr([
                "session_id": "8",
                "session.id": uuid,
                "turn.id": "u-sx",
                "cwd": "/repo",
            ])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: uuid, turnId: "u-sx", cwd: "/repo")],
            "Short session_id alias must not poison the fallback path either"
        )
    }

    func testIgnoresUnknownSpan() {
        let json = otlp(spans: [
            ["name": "codex.heartbeat", "attributes": attr(["codex.thread_id": tid3])]
        ])
        XCTAssertEqual(CodexTelemetryModule.parse(json), [])
    }

    func testMissingThreadIdSkips() {
        let json = otlp(spans: [
            ["name": "codex.turn", "attributes": attr(["cwd": "/repo"])]
        ])
        XCTAssertEqual(CodexTelemetryModule.parse(json), [])
    }

    func testUnderscoreVariantNormalizedToDot() {
        // `codex.tool_call` (underscored) and `tool` (vs `tool.name`) are
        // both legal — schema is not nailed down in Codex 1.x yet.
        let json = otlp(spans: [
            ["name": "codex.tool_call", "attributes": attr(["thread_id": tid4, "tool": "Bash"])]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.toolCall(threadId: tid4, turnId: "", tool: "Bash")]
        )
    }

    func testAttributeFromResourceFallsThrough() {
        // Resource-level attribute should populate threadId when the span
        // itself doesn't carry one (some exporters emit thread_id only on
        // the resource because it's batch-stable).
        let json: [String: Any] = [
            "resourceSpans": [[
                "resource": ["attributes": attr(["codex.thread_id": "from-resource"])],
                "scopeSpans": [["spans": [
                    ["name": "codex.turn.end", "attributes": attr([:])]
                ]]]
            ]]
        ]
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnEnd(threadId: "from-resource", turnId: "")]
        )
    }

    func testIntValueAttributeAccepted() {
        // OTLP ints arrive as either Int or stringified — we just need the
        // span name to dispatch correctly even when other attrs are int.
        let json = otlp(spans: [
            ["name": "codex.turn.start", "attributes": [
                ["key": "codex.thread_id", "value": ["stringValue": tid5]],
                ["key": "codex.turn_id", "value": ["intValue": "42"]],  // stringified int
            ]]
        ])
        XCTAssertEqual(
            CodexTelemetryModule.parse(json),
            [.turnStart(threadId: tid5, turnId: "42", cwd: nil)]
        )
    }

    func testSpanNameSummaryForDiagnostics() {
        let json = otlp(spans: [
            ["name": "unknown.one", "attributes": attr([:])],
            ["name": "unknown.two", "attributes": attr([:])]
        ])
        XCTAssertEqual(CodexTelemetryModule.spanNameSummary(json), "unknown.one,unknown.two")
    }

    func testEmptyResourceSpansReturnsEmpty() {
        XCTAssertEqual(CodexTelemetryModule.parse(["resourceSpans": []]), [])
        XCTAssertEqual(CodexTelemetryModule.parse([:]), [])
    }

    func testCodexHookIdentityPrefersThreadId() {
        let key = CodexHookIdentity.sessionKey(from: [
            "thread_id": "019dda47-b912-7ec3-b97b-2fefad9d4699",
            "session_id": "8",
        ])
        XCTAssertEqual(key, "codex:019dda47-b912-7ec3-b97b-2fefad9d4699")
    }

    func testCodexHookIdentityRejectsNumericSessionFallback() {
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["session_id": "8"]))
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["session_id": "1234567890"]))
    }

    func testCodexHookIdentityAcceptsDurableSessionFallback() {
        let key = CodexHookIdentity.sessionKey(from: [
            "session_id": "019dda49-2ce1-7a62-8fdc-4b7753b6bd0b",
        ])
        XCTAssertEqual(key, "codex:019dda49-2ce1-7a62-8fdc-4b7753b6bd0b")
    }

    func testPostTerminalCodexProgressPredicate() {
        XCTAssertTrue(DaemonServer.shouldIgnorePostTerminalCodexProgressForTest(event: "codex_tool_start"))
        XCTAssertTrue(DaemonServer.shouldIgnorePostTerminalCodexProgressForTest(event: "codex_tool_end"))
        XCTAssertFalse(DaemonServer.shouldIgnorePostTerminalCodexProgressForTest(event: "codex_user_prompt_submit"))
    }

    // MARK: - Helpers

    private func otlp(spans: [[String: Any]]) -> [String: Any] {
        return [
            "resourceSpans": [[
                "scopeSpans": [["spans": spans]]
            ]]
        ]
    }

    /// Wrap a flat dict into OTLP's `{key, value: {stringValue}}` array.
    /// String / int / bool dispatch automatically by Swift type.
    private func attr(_ dict: [String: Any]) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for (key, value) in dict {
            let wrap: [String: Any]
            if let s = value as? String { wrap = ["stringValue": s] }
            else if let i = value as? Int { wrap = ["intValue": i] }
            else if let b = value as? Bool { wrap = ["boolValue": b] }
            else { wrap = ["stringValue": String(describing: value)] }
            out.append(["key": key, "value": wrap])
        }
        return out
    }
}
#endif
