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
    let name = "pixoo"
    private var devices: [PixooDevice] = []
    private var renderTask: Task<Void, Never>?
    private var lastFrame: Data?
    private let frameWidth = 64
    private let frameHeight = 64

    func start() async {
        devices = Self.loadDevices()
        guard !devices.isEmpty else {
            DaemonLogger.shared.debug("Pixoo", "No devices configured, skipping")
            return
        }

        DaemonLogger.shared.info("Pixoo module started with \(devices.count) device(s)")

        // Start render loop — push frames at ~3 FPS
        renderTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(333))
                await self?.pushFrame()
            }
        }
    }

    func stop() async {
        renderTask?.cancel()
    }

    // Cached state for rendering
    nonisolated(unsafe) private var cachedState: String = "disconnected"
    nonisolated(unsafe) private var cachedProject: String?
    nonisolated(unsafe) private var cachedModel: String?
    nonisolated(unsafe) private var cachedTool: String?
    nonisolated(unsafe) private var cachedSessions: [[String: Any]] = []
    nonisolated(unsafe) private var cached5h: Double?
    nonisolated(unsafe) private var cached7d: Double?

    /// Handle broadcast events — update cached state for next render
    func handleEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "state_update":
            cachedState = event["state"] as? String ?? "disconnected"
            cachedProject = event["projectName"] as? String
            cachedModel = event["modelName"] as? String
            cachedTool = event["currentTool"] as? String
        case "usage_update":
            cached5h = event["fiveHourPercent"] as? Double
            cached7d = event["sevenDayPercent"] as? Double
        case "sessions_list":
            cachedSessions = event["sessions"] as? [[String: Any]] ?? []
        default: break
        }

        // Render new frame
        lastFrame = PixooRenderer.render(
            state: cachedState, projectName: cachedProject,
            modelName: cachedModel, currentTool: cachedTool,
            sessions: cachedSessions,
            fiveHourPercent: cached5h, sevenDayPercent: cached7d
        )
    }

    /// Push current frame to all Pixoo devices via HTTP
    private func pushFrame() async {
        guard let frame = lastFrame, !devices.isEmpty else { return }

        for device in devices {
            await pushToDevice(device, frame: frame)
        }
    }

    private func pushToDevice(_ device: PixooDevice, frame: Data) async {
        let url = URL(string: "http://\(device.ip):80/post")!
        // Pixoo HTTP API: POST with command payload
        let picId = 1
        let payload: [String: Any] = [
            "Command": "Draw/SendHttpGif",
            "PicNum": 1,
            "PicWidth": frameWidth,
            "PicOffset": 0,
            "PicID": picId,
            "PicSpeed": 100,
            "PicData": frame.base64EncodedString(),
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        request.timeoutInterval = 2

        _ = try? await URLSession.shared.data(for: request)
    }

    /// Set brightness for all devices
    func setBrightness(_ level: Int) async {
        for device in devices {
            let url = URL(string: "http://\(device.ip):80/post")!
            let payload: [String: Any] = [
                "Command": "Channel/SetBrightness",
                "Brightness": max(0, min(100, level)),
            ]
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
            request.timeoutInterval = 2
            _ = try? await URLSession.shared.data(for: request)
        }
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
}
#endif
