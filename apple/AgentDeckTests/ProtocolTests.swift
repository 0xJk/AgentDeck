// ProtocolTests.swift — Protocol decoding tests

import XCTest
@testable import AgentDeck

final class ProtocolTests: XCTestCase {

    // MARK: - State Update Decoding

    func testDecodeStateUpdate() throws {
        let json = """
        {
            "type": "state_update",
            "state": "processing",
            "permissionMode": "default",
            "projectName": "my-project",
            "modelName": "opus-4",
            "currentTool": "Read",
            "toolInput": "src/main.ts",
            "gatewayAvailable": true,
            "gatewayConnected": false
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .stateUpdate(let e) = event else {
            XCTFail("Expected stateUpdate, got \(String(describing: event))")
            return
        }

        XCTAssertEqual(e.state, "processing")
        XCTAssertEqual(e.permissionMode, "default")
        XCTAssertEqual(e.projectName, "my-project")
        XCTAssertEqual(e.modelName, "opus-4")
        XCTAssertEqual(e.currentTool, "Read")
        XCTAssertEqual(e.toolInput, "src/main.ts")
        XCTAssertEqual(e.gatewayAvailable, true)
        XCTAssertEqual(e.gatewayConnected, false)
    }

    func testDecodeStateUpdateWithCapabilities() throws {
        let json = """
        {
            "type": "state_update",
            "state": "idle",
            "agentType": "claude-code",
            "agentCapabilities": {
                "type": "claude-code",
                "displayName": "Claude Code",
                "hasTerminal": true,
                "hasModeSwitching": true,
                "hasDiffReview": true,
                "hasOptionLists": true,
                "hasNavigablePrompts": true,
                "hasSuggestedPrompts": true,
                "hasApiUsage": true
            }
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .stateUpdate(let e) = event else {
            XCTFail("Expected stateUpdate")
            return
        }

        XCTAssertEqual(e.agentType, "claude-code")
        XCTAssertNotNil(e.agentCapabilities)
        XCTAssertEqual(e.agentCapabilities?.hasTerminal, true)
        XCTAssertEqual(e.agentCapabilities?.displayName, "Claude Code")
    }

    // MARK: - Usage Update

    func testDecodeUsageUpdate() throws {
        let json = """
        {
            "type": "usage_update",
            "sessionDurationSec": 3600,
            "inputTokens": 50000,
            "outputTokens": 25000,
            "toolCalls": 42,
            "fiveHourPercent": 72.5,
            "fiveHourResetsAt": "2026-03-12T18:00:00Z",
            "sevenDayPercent": 45.0,
            "oauthConnected": true
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .usageUpdate(let e) = event else {
            XCTFail("Expected usageUpdate")
            return
        }

        XCTAssertEqual(e.sessionDurationSec, 3600)
        XCTAssertEqual(e.inputTokens, 50000)
        XCTAssertEqual(e.outputTokens, 25000)
        XCTAssertEqual(e.toolCalls, 42)
        XCTAssertEqual(e.fiveHourPercent, 72.5)
        XCTAssertEqual(e.oauthConnected, true)
    }

    // MARK: - Connection Event

    func testDecodeConnectionEvent() throws {
        let json = """
        {"type": "connection", "status": "connected", "sessionId": "abc123"}
        """

        let event = BridgeEventParser.parse(json)
        guard case .connection(let e) = event else {
            XCTFail("Expected connection")
            return
        }

        XCTAssertEqual(e.status, "connected")
        XCTAssertEqual(e.sessionId, "abc123")
    }

    // MARK: - Sessions List

    func testDecodeSessionsList() throws {
        let json = """
        {
            "type": "sessions_list",
            "sessions": [
                {"id": "s1", "port": 9120, "projectName": "proj1", "agentType": "claude-code", "alive": true},
                {"id": "s2", "port": 9121, "projectName": "proj2", "alive": false}
            ]
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .sessionsList(let e) = event else {
            XCTFail("Expected sessionsList")
            return
        }

        XCTAssertEqual(e.sessions.count, 2)
        XCTAssertEqual(e.sessions[0].projectName, "proj1")
        XCTAssertEqual(e.sessions[0].agentType, "claude-code")
        XCTAssertEqual(e.sessions[1].alive, false)
    }

    // MARK: - Button State

    func testDecodeButtonState() throws {
        let json = """
        {
            "type": "button_state",
            "buttons": [
                {"slot": 0, "title": "DEFAULT", "bgColor": "#1e293b", "textColor": "#ffffff", "enabled": true, "action": "switch_mode"},
                {"slot": 7, "title": "STOP", "bgColor": "#991b1b", "textColor": "#ffffff", "enabled": true, "icon": "■", "action": "interrupt"}
            ]
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .buttonState(let e) = event else {
            XCTFail("Expected buttonState")
            return
        }

        XCTAssertEqual(e.buttons.count, 2)
        XCTAssertEqual(e.buttons[0].action, "switch_mode")
        XCTAssertEqual(e.buttons[1].icon, "■")
    }

    // MARK: - Encoder State

    func testDecodeEncoderState() throws {
        let json = """
        {
            "type": "encoder_state",
            "encoders": [
                {"slot": 0, "encoderType": "utility", "header": "VOLUME", "value": "65%", "icon": "🔊", "accentColor": "#22d3ee"},
                {"slot": 3, "encoderType": "voice", "header": "VOICE", "value": "Ready", "accentColor": "#a855f7", "voiceState": "idle"}
            ],
            "takeoverActive": false
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .encoderState(let e) = event else {
            XCTFail("Expected encoderState")
            return
        }

        XCTAssertEqual(e.encoders.count, 2)
        XCTAssertEqual(e.encoders[0].header, "VOLUME")
        XCTAssertEqual(e.encoders[1].voiceState, "idle")
        XCTAssertEqual(e.takeoverActive, false)
    }

    // MARK: - Unknown Event

    func testUnknownEventReturnsNil() {
        let json = """
        {"type": "future_event", "data": {}}
        """
        XCTAssertNil(BridgeEventParser.parse(json))
    }

    func testInvalidJsonReturnsNil() {
        XCTAssertNil(BridgeEventParser.parse("not json"))
        XCTAssertNil(BridgeEventParser.parse(""))
    }

    // MARK: - Plugin Command Encoding

    func testEncodeRespondCommand() throws {
        let cmd = PluginCommand.respond(value: "y")
        let data = try JSONEncoder().encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertEqual(json?["type"] as? String, "respond")
        XCTAssertEqual(json?["value"] as? String, "y")
    }

    func testEncodeSelectOptionCommand() throws {
        let cmd = PluginCommand.selectOption(index: 2)
        let data = try JSONEncoder().encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertEqual(json?["type"] as? String, "select_option")
        XCTAssertEqual(json?["index"] as? Int, 2)
    }

    func testEncodeSwitchModeCommand() throws {
        let cmd = PluginCommand.switchMode(mode: "plan")
        let data = try JSONEncoder().encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertEqual(json?["type"] as? String, "switch_mode")
        XCTAssertEqual(json?["mode"] as? String, "plan")
    }

    func testEncodeInterruptCommand() throws {
        let cmd = PluginCommand.interrupt
        let data = try JSONEncoder().encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertEqual(json?["type"] as? String, "interrupt")
    }

    func testStabilizeCodexAuthStatusPreservesChatGptPlanAcrossPartialRefresh() {
        let previous = CodexAuthStatus(
            authMode: "chatgpt",
            webAuthConnected: true,
            accessTokenPresent: true,
            planType: "plus",
            accountId: "acct_123",
            subscriptionActiveUntil: "2026-05-01",
            lastRefreshAt: "2026-04-09T00:00:00Z"
        )
        let current = CodexAuthStatus(
            authMode: nil,
            webAuthConnected: false,
            accessTokenPresent: true,
            planType: nil,
            accountId: nil,
            subscriptionActiveUntil: nil,
            lastRefreshAt: "2026-04-09T00:01:00Z"
        )

        let stabilized = UsageAPIClient.stabilizeCodexAuthStatus(previous: previous, current: current)

        XCTAssertEqual(stabilized?.authMode, "chatgpt")
        XCTAssertEqual(stabilized?.planType, "plus")
        XCTAssertEqual(stabilized?.accountId, "acct_123")
        XCTAssertEqual(stabilized?.subscriptionActiveUntil, "2026-05-01")
        XCTAssertEqual(stabilized?.lastRefreshAt, "2026-04-09T00:01:00Z")
    }

    func testStabilizeCodexAuthStatusDropsCachedChatGptPlanWhenAuthModeChanges() {
        let previous = CodexAuthStatus(
            authMode: "chatgpt",
            webAuthConnected: true,
            accessTokenPresent: true,
            planType: "plus",
            accountId: "acct_123",
            subscriptionActiveUntil: "2026-05-01",
            lastRefreshAt: nil
        )
        let current = CodexAuthStatus(
            authMode: "api",
            webAuthConnected: false,
            accessTokenPresent: false,
            planType: nil,
            accountId: nil,
            subscriptionActiveUntil: nil,
            lastRefreshAt: nil
        )

        let stabilized = UsageAPIClient.stabilizeCodexAuthStatus(previous: previous, current: current)

        XCTAssertEqual(stabilized?.authMode, "api")
        XCTAssertNil(stabilized?.planType)
    }

    func testMergedModelCatalogUpdatesExistingEntryWithoutDroppingOthers() {
        let existing: [[String: Any]] = [
            ["key": "gpt-4o", "name": "GPT 4o", "role": "configured", "available": true],
            ["key": "claude-4", "name": "Claude 4", "role": "configured", "available": true],
        ]
        let incoming: [[String: Any]] = [
            ["key": "gpt-4o", "name": "GPT 4o", "role": "default", "available": true],
        ]

        let merged = DashboardDataRules.mergedModelCatalog(existing: existing, incoming: incoming)

        XCTAssertEqual(merged.count, 2)
        XCTAssertEqual(merged.first?["key"] as? String, "gpt-4o")
        let updated = merged.first { ($0["key"] as? String) == "gpt-4o" }
        XCTAssertEqual(updated?["role"] as? String, "default")
    }

    func testSortSessionsUsesStableSharedOrdering() {
        let sessions = [
            SessionInfo(id: "2", port: 9122, projectName: "Beta", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: "2026-04-11T10:02:00Z"),
            SessionInfo(id: "1", port: 9121, projectName: "Alpha", agentType: "codex-cli", alive: true, state: "processing", modelName: nil, startedAt: "2026-04-11T10:00:00Z"),
            SessionInfo(id: "3", port: 9123, projectName: "Alpha", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: "2026-04-11T10:01:00Z"),
            SessionInfo(id: "4", port: 9124, projectName: "Gateway", agentType: "openclaw", alive: true, state: "idle", modelName: nil, startedAt: nil),
        ]

        let sorted = DashboardDataRules.sortSessions(sessions)

        XCTAssertEqual(sorted.map(\.id), ["4", "3", "2", "1"])
    }

    func testFoldCodexSessionPayloadsForDisplayCollapsesSameProject() {
        let folded = DashboardDataRules.foldCodexSessionPayloadsForDisplay([
            [
                "id": "codex:old",
                "port": 9120,
                "projectName": "AgentDeck",
                "agentType": "codex-cli",
                "alive": true,
                "state": "idle",
                "startedAt": "2026-04-11T10:00:00Z",
            ],
            [
                "id": "codex:new",
                "port": 9120,
                "projectName": "AgentDeck",
                "agentType": "codex-cli",
                "alive": true,
                "state": "processing",
                "currentTool": "exec",
                "startedAt": "2026-04-11T10:02:00Z",
            ],
            [
                "id": "codex:missing-start",
                "port": 9120,
                "projectName": "AgentDeck",
                "agentType": "codex-cli",
                "alive": true,
                "state": "processing",
                "currentTool": "stale",
            ],
            [
                "id": "claude:1",
                "port": 9121,
                "projectName": "AgentDeck",
                "agentType": "claude-code",
                "alive": true,
                "state": "idle",
            ],
        ])

        XCTAssertEqual(folded.count, 2)
        let codex = folded.first { ($0["agentType"] as? String) == "codex-cli" }
        XCTAssertEqual(codex?["id"] as? String, "codex:new")
        XCTAssertEqual(codex?["state"] as? String, "processing")
        XCTAssertEqual(codex?["currentTool"] as? String, "exec")
        XCTAssertEqual(codex?["groupSize"] as? Int, 3)
        XCTAssertEqual(codex?["foldedSessionIds"] as? [String], ["codex:old", "codex:new", "codex:missing-start"])
    }

    func testFoldCodexSessionPayloadsKeepsEmptyProjectSeparate() {
        let folded = DashboardDataRules.foldCodexSessionPayloadsForDisplay([
            ["id": "codex:a", "port": 9120, "projectName": "", "agentType": "codex-cli", "alive": true],
            ["id": "codex:b", "port": 9120, "projectName": "   ", "agentType": "codex-cli", "alive": true],
        ])

        XCTAssertEqual(folded.compactMap { $0["id"] as? String }, ["codex:a", "codex:b"])
        XCTAssertNil(folded.first?["groupSize"])
    }

    func testOpenClawDisplayLinesKeepDefaultFirstAndCompactFamilies() {
        let lines = DashboardDataRules.openClawDisplayLines([
            ModelCatalogEntry(key: "gpt-5.4", name: "GPT 5.4", role: "default", available: true),
            ModelCatalogEntry(key: "glm-4.5", name: "GLM-4.5", role: "configured", available: true),
            ModelCatalogEntry(key: "glm-4.5v", name: "GLM-4.5V", role: "configured", available: true),
            ModelCatalogEntry(key: "deepseek-r1", name: "DeepSeek R1", role: "configured", available: true),
        ])

        XCTAssertEqual(lines.first, "GPT 5.4")
        XCTAssertTrue(lines.contains("GLM-4.5, 4.5V"))
        XCTAssertTrue(lines.contains("DeepSeek R1"))
    }
}
