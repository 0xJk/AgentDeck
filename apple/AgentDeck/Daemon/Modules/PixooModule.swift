#if os(macOS)
// PixooModule.swift — Pixoo64 LED matrix device support
// Ported from bridge/src/modules/pixoo-module.ts + pixoo-bridge.ts (core)

import Foundation

struct PixooDevice: Codable {
    let ip: String
    var name: String?
    var brightness: Int?
}

final class PixooModule: DeviceModule, @unchecked Sendable {
    private struct DeviceLogState: Sendable {
        var successCount = 0
        var consecutiveFailures = 0
        var lastSuccessLogAt: Date?
        var lastFailureMessage: String?
    }

    let name = "pixoo"
    private var devices: [PixooDevice] = []
    private var renderTask: Task<Void, Never>?
    private var lastFrame: Data?
    private var lastPushError: String?
    private var lastPushAt: Date?
    private var devicePicIds: [String: Int] = [:]
    private var deviceLogStates: [String: DeviceLogState] = [:]
    private let renderer = PixooRenderer()
    private let frameWidth = 64
    private let frameHeight = 64
    private let requestTimeout: TimeInterval = 2
    private let picIdResyncThreshold = 250
    private let successLogInterval = 30
    private let successLogMinInterval: TimeInterval = 30
    private static let gammaLUT: [UInt8] = (0..<256).map {
        UInt8(max(0, min(255, Int(round(pow(Double($0) / 255.0, 0.7) * 255.0)))))
    }

    func start() async {
        devices = Self.loadDevices()
        guard !devices.isEmpty else {
            DaemonLogger.shared.debug("Pixoo", "No devices configured, skipping")
            return
        }

        DaemonLogger.shared.info("Pixoo module started with \(devices.count) device(s)")
        for device in devices {
            await prepareDevice(device)
        }

        // Start render loop — push frames at ~3 FPS
        renderTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(333))
                await self?.pushFrame()
            }
        }
    }

    func stop() async {
        // Cancel the render loop and wait for the in-flight iteration to finish
        // its current URLSession request. Without the await, stop() returns
        // immediately while pushFrame() is still blocked on a 2s HTTP timeout to
        // an unreachable Pixoo — the orphaned URL requests stretch shutdown past
        // the 10s semaphore and leave the process in `?E` state at exit.
        renderTask?.cancel()
        await renderTask?.value
        renderTask = nil
    }

    func handleWake() async {
        DaemonLogger.shared.info("Pixoo wake recovery — clearing PicID cache for \(devices.count) device(s)")
        devicePicIds.removeAll()
        deviceLogStates.removeAll()
        lastPushError = nil
        // Re-sync PicID from each device (may have rebooted during sleep)
        for device in devices {
            await prepareDevice(device)
        }
    }

    func statusSnapshot() -> [String: Any] {
        [
            "configuredDeviceCount": devices.count,
            "deviceIps": devices.map(\.ip),
            "hasFrame": lastFrame != nil,
            "displayDimmed": displayDimmed,
            "lastPushAtMs": lastPushAt.map { Int($0.timeIntervalSince1970 * 1000) } as Any,
            "lastPushError": lastPushError as Any,
        ]
    }

    func currentFrame() -> Data? {
        lastFrame
    }

    // Cached state for rendering
    nonisolated(unsafe) private var cachedState: String = "disconnected"
    nonisolated(unsafe) private var cachedProject: String?
    nonisolated(unsafe) private var cachedModel: String?
    nonisolated(unsafe) private var cachedTool: String?
    nonisolated(unsafe) private var cachedAgentType: String?
    nonisolated(unsafe) private var cachedSessions: [[String: Any]] = []
    nonisolated(unsafe) private var cached5h: Double?
    nonisolated(unsafe) private var cached7d: Double?
    nonisolated(unsafe) private var cached5hResetsAt: String?
    nonisolated(unsafe) private var cached7dResetsAt: String?
    nonisolated(unsafe) private var cachedGatewayAvailable = false
    nonisolated(unsafe) private var cachedGatewayHasError = false

    nonisolated(unsafe) private var displayDimmed = false

    /// Handle broadcast events — update cached state for next render
    func handleEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "state_update":
            let eventAgentType = event["agentType"] as? String
            // Only update primary state from creature agents — daemon/openclaw
            // events would otherwise overwrite the coding agent's PROCESSING state
            let creatureAgents: Set<String> = ["claude-code", "codex-cli", "opencode"]
            if let at = eventAgentType, creatureAgents.contains(at) {
                cachedState = event["state"] as? String ?? "disconnected"
                cachedProject = event["projectName"] as? String
                cachedModel = event["modelName"] as? String
                cachedTool = event["currentTool"] as? String
                cachedAgentType = eventAgentType
            } else if cachedAgentType == nil {
                // No creature agent seen yet — accept any state to avoid blank screen
                cachedState = event["state"] as? String ?? "disconnected"
                cachedAgentType = eventAgentType
            }
            // Gateway fields are always updated regardless of agent type
            cachedGatewayAvailable = event["gatewayAvailable"] as? Bool ?? cachedGatewayAvailable
            cachedGatewayHasError = event["gatewayHasError"] as? Bool ?? cachedGatewayHasError
        case "usage_update":
            cached5h = event["fiveHourPercent"] as? Double
            cached7d = event["sevenDayPercent"] as? Double
            cached5hResetsAt = event["fiveHourResetsAt"] as? String
            cached7dResetsAt = event["sevenDayResetsAt"] as? String
        case "sessions_list":
            cachedSessions = event["sessions"] as? [[String: Any]] ?? []
        case "display_state":
            let displayOn = event["displayOn"] as? Bool ?? true
            if !displayOn && !displayDimmed {
                displayDimmed = true
                Task { await dimPixoo() }
            } else if displayOn && displayDimmed {
                displayDimmed = false
                Task { await restorePixoo() }
            }
            return // Don't re-render on display_state
        default: break
        }
    }

    /// Push current frame to all Pixoo devices via HTTP
    private func pushFrame() async {
        guard !devices.isEmpty, !displayDimmed else { return }

        let frame = renderer.render(dashboardState: currentDashboardState())
        lastFrame = frame

        for device in devices {
            await pushToDevice(device, frame: frame)
        }
    }

    private func pushToDevice(_ device: PixooDevice, frame: Data) async {
        guard let picId = await nextPicId(for: device.ip) else {
            recordPushFailure(ip: device.ip, reason: "failed to acquire PicID")
            lastPushError = "failed to acquire PicID for \(device.ip)"
            return
        }

        let boosted = Data(frame.enumerated().map { Self.gammaLUT[Int($0.element)] })
        let payload: [String: Any] = [
            "Command": "Draw/SendHttpGif",
            "PicNum": 1,
            "PicWidth": frameWidth,
            "PicOffset": 0,
            "PicID": picId,
            "PicSpeed": 1000,
            "PicData": boosted.base64EncodedString(),
        ]

        if let response = await postCommand(device.ip, payload: payload, logFailures: false) {
            lastPushError = nil
            lastPushAt = Date()
            recordPushSuccess(ip: device.ip, picId: picId, response: response)
        } else {
            lastPushError = "push failed for \(device.ip)"
            recordPushFailure(ip: device.ip, reason: "push failed (picId=\(picId))")
        }
    }

    /// Set brightness for all devices
    func setBrightness(_ level: Int) async {
        for device in devices {
            let payload: [String: Any] = [
                "Command": "Channel/SetBrightness",
                "Brightness": max(0, min(100, level)),
            ]
            if await postCommand(device.ip, payload: payload) != nil {
                lastPushError = nil
            } else {
                lastPushError = "brightness failed for \(device.ip)"
            }
        }
    }

    // MARK: - Display Sleep

    private func dimPixoo() async {
        await setBrightness(0)
        DaemonLogger.shared.debug("Pixoo", "Display sleep → brightness 0")
    }

    private func restorePixoo() async {
        // Restore default brightness (or device-configured)
        let level = devices.first?.brightness ?? 80
        await setBrightness(level)
        DaemonLogger.shared.debug("Pixoo", "Display wake → brightness \(level)")
    }

    private func currentDashboardState() -> DashboardState {
        var state = DashboardState()
        state.bridgeConnected = cachedState != "disconnected"
        state.sessionId = firstAliveSession(in: cachedSessions)?["id"] as? String
        state.state = AgentConnectionState(rawValue: cachedState) ?? .idle
        state.agentType = cachedAgentType ?? firstAliveSession(in: cachedSessions)?["agentType"] as? String
        state.projectName = cachedProject ?? firstAliveSession(in: cachedSessions)?["projectName"] as? String
        state.modelName = cachedModel
        state.currentTool = cachedTool
        state.fiveHourPercent = cached5h
        state.sevenDayPercent = cached7d
        state.fiveHourResetsAt = cached5hResetsAt
        state.sevenDayResetsAt = cached7dResetsAt
        state.gatewayAvailable = cachedGatewayAvailable || cachedSessions.contains {
            ($0["agentType"] as? String) == "openclaw"
        }
        state.gatewayHasError = cachedGatewayHasError
        state.siblingSessions = cachedSessions.compactMap(Self.makeSessionInfo)
        return state
    }

    private func firstAliveSession(in sessions: [[String: Any]]) -> [String: Any]? {
        sessions.first { ($0["alive"] as? Bool) ?? true }
    }

    // MARK: - Settings

    private static let settingsFile = AuthManager.agentDeckDir.appendingPathComponent("settings.json")

    static func loadDevices() -> [PixooDevice] {
        guard let data = try? Data(contentsOf: settingsFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pixooArray = json["pixooDevices"] as? [[String: Any]] else { return [] }

        return pixooArray.compactMap { d in
            guard let ip = d["ip"] as? String else { return nil }
            return PixooDevice(ip: ip, name: d["name"] as? String, brightness: d["brightness"] as? Int)
        }
    }

    private func prepareDevice(_ device: PixooDevice) async {
        _ = await postCommand(device.ip, payload: [
            "Command": "Channel/SetIndex",
            "SelectIndex": 3,
        ])
        _ = await postCommand(device.ip, payload: [
            "Command": "Channel/SetBrightness",
            "Brightness": max(0, min(100, device.brightness ?? 100)),
        ])
        if let picId = await getHttpGifId(device.ip) {
            devicePicIds[device.ip] = picId
            DaemonLogger.shared.debug("Pixoo", "Synced PicID for \(device.ip): \(picId)")
        }
    }

    private func nextPicId(for ip: String) async -> Int? {
        var picId = devicePicIds[ip]
        if picId == nil {
            picId = await getHttpGifId(ip) ?? 0
        }
        guard var next = picId else { return nil }
        next += 1
        if next >= picIdResyncThreshold {
            _ = await postCommand(ip, payload: ["Command": "Draw/ResetHttpGifId"])
            next = 1
        }
        devicePicIds[ip] = next
        return next
    }

    private func getHttpGifId(_ ip: String) async -> Int? {
        guard let response = await postCommand(ip, payload: ["Command": "Draw/GetHttpGifId"]) else {
            return nil
        }
        if let picId = response["PicId"] as? Int { return picId }
        if let picId = response["PicID"] as? Int { return picId }
        if let number = response["PicId"] as? NSNumber { return number.intValue }
        if let number = response["PicID"] as? NSNumber { return number.intValue }
        return 0
    }

    private func postCommand(_ ip: String, payload: [String: Any], logFailures: Bool = true) async -> [String: Any]? {
        guard let url = URL(string: "http://\(ip):80/post") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("close", forHTTPHeaderField: "Connection")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        request.timeoutInterval = requestTimeout

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = requestTimeout
        config.timeoutIntervalForResource = requestTimeout
        config.httpShouldUsePipelining = false
        config.httpMaximumConnectionsPerHost = 1
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                if logFailures {
                    DaemonLogger.shared.debug("Pixoo", "No HTTP response from \(ip)")
                }
                return nil
            }
            guard (200..<300).contains(http.statusCode) else {
                let body = String(data: data, encoding: .utf8) ?? ""
                if logFailures {
                    DaemonLogger.shared.debug("Pixoo", "HTTP \(http.statusCode) from \(ip): \(body)")
                }
                return nil
            }
            if data.isEmpty { return [:] }
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return json
            }
            return [:]
        } catch {
            if logFailures {
                DaemonLogger.shared.debug("Pixoo", "Request failed to \(ip): \(error.localizedDescription)")
            }
            return nil
        }
    }

    private func recordPushSuccess(ip: String, picId: Int, response: [String: Any]) {
        var state = deviceLogStates[ip] ?? DeviceLogState()
        let now = Date()
        let recoveredFromFailures = state.consecutiveFailures > 0
        let failedCount = state.consecutiveFailures
        state.consecutiveFailures = 0
        state.lastFailureMessage = nil
        state.successCount += 1

        let shouldLogPeriodicSuccess: Bool
        if state.successCount == 1 {
            shouldLogPeriodicSuccess = true
        } else if state.successCount % successLogInterval == 0 {
            let enoughTimePassed = state.lastSuccessLogAt.map { now.timeIntervalSince($0) >= successLogMinInterval } ?? true
            shouldLogPeriodicSuccess = enoughTimePassed
        } else {
            shouldLogPeriodicSuccess = false
        }

        if recoveredFromFailures {
            DaemonLogger.shared.info("Pixoo recovered on \(ip) after \(failedCount) failed push(es); picId=\(picId)")
            state.lastSuccessLogAt = now
        } else if shouldLogPeriodicSuccess {
            let errorCode = (response["error_code"] as? Int) ?? (response["errorCode"] as? Int)
            if let errorCode {
                DaemonLogger.shared.debug("Pixoo", "Healthy → \(ip) pushes=\(state.successCount) picId=\(picId) error_code=\(errorCode)")
            } else {
                DaemonLogger.shared.debug("Pixoo", "Healthy → \(ip) pushes=\(state.successCount) picId=\(picId)")
            }
            state.lastSuccessLogAt = now
        }

        deviceLogStates[ip] = state
    }

    private func recordPushFailure(ip: String, reason: String) {
        var state = deviceLogStates[ip] ?? DeviceLogState()
        state.consecutiveFailures += 1
        let changedReason = state.lastFailureMessage != reason
        state.lastFailureMessage = reason

        if state.consecutiveFailures == 1 || state.consecutiveFailures == 5 || state.consecutiveFailures % 20 == 0 || changedReason {
            DaemonLogger.shared.error("Pixoo failure on \(ip): \(reason) [count=\(state.consecutiveFailures)]")
        }

        deviceLogStates[ip] = state
    }

    private static func makeSessionInfo(from raw: [String: Any]) -> SessionInfo? {
        guard let id = raw["id"] as? String else { return nil }

        let port: Int
        if let portValue = raw["port"] as? Int {
            port = portValue
        } else if let number = raw["port"] as? NSNumber {
            port = number.intValue
        } else {
            port = 0
        }

        return SessionInfo(
            id: id,
            port: port,
            projectName: raw["projectName"] as? String,
            agentType: raw["agentType"] as? String,
            alive: (raw["alive"] as? Bool) ?? true,
            state: raw["state"] as? String
        )
    }
}
#endif
