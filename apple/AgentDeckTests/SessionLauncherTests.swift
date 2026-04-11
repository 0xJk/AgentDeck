import XCTest
#if os(macOS)
@testable import AgentDeck

final class SessionLauncherTests: XCTestCase {
    func testPrefersInstalledBridgeWhenAvailable() {
        let plan = SessionLauncher.resolveLaunchPlan(
            project: nil,
            daemonPort: 9120,
            installedBridgePath: "/opt/homebrew/bin/agentdeck",
            bundledBridgePath: "/Applications/AgentDeck.app/Contents/Resources/bridge/cli.js",
            bundledNodePath: "/Applications/AgentDeck.app/Contents/Resources/node",
            claudePath: "/opt/homebrew/bin/claude"
        )

        XCTAssertEqual(plan?.mode, .agentdeckCli)
        XCTAssertEqual(plan?.command, "AGENTDECK_PORT=9120 '/opt/homebrew/bin/agentdeck' claude")
    }

    func testFallsBackToBundledBridgeWhenInstalledBridgeMissing() {
        let plan = SessionLauncher.resolveLaunchPlan(
            project: nil,
            daemonPort: 9120,
            installedBridgePath: nil,
            bundledBridgePath: "/Applications/AgentDeck.app/Contents/Resources/bridge/cli.js",
            bundledNodePath: "/Applications/AgentDeck.app/Contents/Resources/node",
            claudePath: "/opt/homebrew/bin/claude"
        )

        XCTAssertEqual(plan?.mode, .bundledBridge)
        XCTAssertEqual(
            plan?.command,
            "AGENTDECK_PORT=9120 '/Applications/AgentDeck.app/Contents/Resources/node' '/Applications/AgentDeck.app/Contents/Resources/bridge/cli.js' claude"
        )
    }

    func testFallsBackToPlainClaudeAndPreservesProjectPath() {
        let plan = SessionLauncher.resolveLaunchPlan(
            project: "/tmp/My Project",
            daemonPort: 9133,
            installedBridgePath: nil,
            bundledBridgePath: nil,
            bundledNodePath: nil,
            claudePath: "/opt/homebrew/bin/claude"
        )

        XCTAssertEqual(plan?.mode, .plainClaude)
        XCTAssertEqual(
            plan?.command,
            "cd '/tmp/My Project' && AGENTDECK_PORT=9133 '/opt/homebrew/bin/claude'"
        )
    }

    func testReturnsNilWhenNothingCanBeLaunched() {
        let plan = SessionLauncher.resolveLaunchPlan(
            project: nil,
            daemonPort: nil,
            installedBridgePath: nil,
            bundledBridgePath: nil,
            bundledNodePath: nil,
            claudePath: nil
        )

        XCTAssertNil(plan)
    }

    func testDaemonPromotionUsesCurrentFallbackPort() {
        XCTAssertEqual(
            DaemonService.promotionTargetPort(currentPort: 9124, effectivePort: 9120),
            9124
        )
    }

    func testDaemonPromotionFallsBackToConfiguredPortWhenDisconnected() {
        XCTAssertEqual(
            DaemonService.promotionTargetPort(currentPort: 0, effectivePort: 9120),
            9120
        )
    }

    func testResolvedSessionOverrideTracksActualBoundPort() {
        XCTAssertEqual(
            DaemonService.resolvedSessionOverridePort(configuredPort: 9120, actualPort: 9124),
            9124
        )
        XCTAssertNil(
            DaemonService.resolvedSessionOverridePort(configuredPort: 9124, actualPort: 9124)
        )
    }
}
#endif
