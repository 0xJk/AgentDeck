#if os(macOS)
import XCTest
@testable import AgentDeck

/// Black-box verification of the TOML edits CodexConfigInstaller would
/// produce. We can't drive promptAndInstall() in a unit test (it shows an
/// NSAlert + NSOpenPanel), but the body it assembles + applyManagedBlock
/// is the entire on-disk effect, and that pipeline is testable.
final class CodexConfigInstallerTests: XCTestCase {

    /// Apply + remove must restore the user's original handcrafted file
    /// byte-for-byte. This is the load-bearing invariant — a regression
    /// here means we ate a user's `[profiles.work]` table or shuffled
    /// their key order.
    func testApplyRemoveRoundtripPreservesUserTOML() {
        let original = """
        # Codex config — handcrafted

        model = "gpt-5"
        approval_policy = "on-request"

        [profiles.work]
        provider = "openai"
        approval_policy = "never"

        [mcp_servers.foo]
        command = "/usr/local/bin/foo-server"
        args = ["--port", "9000"]

        [history]
        max_bytes = 10485760
        """

        let body = CodexConfigInstaller.managedBlockBody(
            includeNotify: true,
            includeOtel: true,
            otelEndpoint: "http://127.0.0.1:9120/otel/v1/traces"
        )
        let withFence = MiniToml.applyManagedBlock(in: original, body: body)
        let stripped = MiniToml.removeManagedBlock(in: withFence)

        XCTAssertEqual(stripped, original)
    }

    /// The fenced body must contain the official lifecycle hook path plus
    /// optional notify / OTel fallback channels.
    func testInstalledFenceMatchesCodexSchema() {
        let body = CodexConfigInstaller.managedBlockBody(
            includeNotify: true,
            includeOtel: true,
            otelEndpoint: "http://127.0.0.1:9120/otel/v1/traces"
        )
        let withFence = MiniToml.applyManagedBlock(in: "", body: body)
        XCTAssertTrue(withFence.contains("[features]"))
        XCTAssertTrue(withFence.contains("hooks = true"))
        XCTAssertTrue(withFence.contains("[[hooks.UserPromptSubmit]]"))
        XCTAssertTrue(withFence.contains("[[hooks.PreToolUse]]"))
        XCTAssertTrue(withFence.contains("[[hooks.PostToolUse]]"))
        XCTAssertTrue(withFence.contains("[[hooks.Stop]]"))
        XCTAssertTrue(withFence.contains("/hooks/codex_user_prompt_submit"))
        XCTAssertTrue(withFence.contains("/hooks/codex_tool_start"))
        XCTAssertTrue(withFence.contains("/hooks/codex_tool_end"))
        XCTAssertTrue(withFence.contains("/hooks/codex_stop"))
        XCTAssertTrue(withFence.contains("notify ="))
        XCTAssertTrue(withFence.contains("[otel.trace_exporter.otlp-http]"))
        XCTAssertTrue(withFence.contains("/otel/v1/traces"))
        XCTAssertTrue(withFence.contains("protocol = \"json\""))
        // Dummy 4th element is what makes the JSON payload land at $1
        // when Codex appends it. Lose this and every notify POST gets
        // an empty body.
        XCTAssertTrue(withFence.contains("\"agentdeck-notify\""))
    }

    func testManagedFenceCanOmitConflictingOptionalChannels() {
        let body = CodexConfigInstaller.managedBlockBody(
            includeNotify: false,
            includeOtel: false,
            otelEndpoint: "http://127.0.0.1:9120/otel/v1/traces"
        )
        XCTAssertTrue(body.contains("hooks = true"))
        XCTAssertTrue(body.contains("[[hooks.Stop]]"))
        XCTAssertFalse(body.contains("notify ="))
        XCTAssertFalse(body.contains("[otel.trace_exporter.otlp-http]"))
    }

    /// User-authored notify must be detected so installIfNeeded can omit
    /// the optional notify fallback instead of producing duplicate keys.
    func testUserNotifyConflictDetected() {
        let conflicting = """
        notify = ["python3", "/usr/local/bin/notify.py"]
        model = "gpt-5"
        """
        XCTAssertTrue(MiniToml.hasTopLevelKeyOutsideFence(in: conflicting, key: "notify"))
    }

    func testUserOtelTableConflictDetected() {
        let conflicting = """
        model = "gpt-5"

        [otel]
        exporter = "otlp-grpc"
        """
        XCTAssertTrue(MiniToml.hasTableOutsideFence(in: conflicting, table: "otel"))
    }

    func testUserLifecycleHookTableConflictsDetected() {
        XCTAssertTrue(MiniToml.hasTableOutsideFence(in: "[features]\nhooks = true", table: "features"))
        XCTAssertTrue(MiniToml.hasTableOutsideFence(in: "[hooks]\nmanaged_dir = \"/tmp/hooks\"", table: "hooks"))
        XCTAssertTrue(MiniToml.hasTableOutsideFence(in: "[[hooks.Stop]]\nmatcher = \"\"", table: "hooks"))
    }
}
#endif
