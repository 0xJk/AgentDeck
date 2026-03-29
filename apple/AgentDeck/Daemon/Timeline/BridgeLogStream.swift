#if os(macOS)
// BridgeLogStream.swift — OpenClaw log stream parser
// Ported from bridge/src/log-stream.ts

import Foundation

/// Spawns `openclaw logs --follow --json` and emits timeline entries.
actor BridgeLogStream {
    private var process: Process?
    private var running = false
    private var recentToolRequests: [String: Date] = [:]
    private var cleanupTask: Task<Void, Never>?

    var onEntry: ((DaemonTimelineEntry) -> Void)?

    func start() {
        guard !running else { return }

        let binPath = Self.resolveOpenClawBin()
        guard let binPath else {
            DaemonLogger.shared.debug("LogStream", "openclaw binary not found")
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binPath)
        proc.arguments = ["logs", "--follow", "--json"]
        proc.environment = ProcessInfo.processInfo.environment

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            self.process = proc
            self.running = true
            DaemonLogger.shared.debug("LogStream", "Started: \(binPath) logs --follow --json")

            // Read lines
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
                Task { await self?.handleLines(text) }
            }

            proc.terminationHandler = { [weak self] _ in
                Task { await self?.handleExit() }
            }

            // Periodic cleanup
            cleanupTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(10))
                    await self?.cleanupRecentRequests()
                }
            }
        } catch {
            DaemonLogger.shared.debug("LogStream", "Failed to spawn: \(error)")
        }
    }

    func stop() {
        process?.terminate()
        process = nil
        running = false
        cleanupTask?.cancel()
        recentToolRequests.removeAll()
    }

    var isRunning: Bool { running }

    func trackToolRequest(_ raw: String) {
        recentToolRequests[raw] = Date()
    }

    // MARK: - Line Parsing

    private var lineBuffer = ""

    private func handleLines(_ text: String) {
        lineBuffer += text
        while let idx = lineBuffer.firstIndex(of: "\n") {
            let line = String(lineBuffer[..<idx]).trimmingCharacters(in: .whitespaces)
            lineBuffer = String(lineBuffer[lineBuffer.index(after: idx)...])

            guard !line.isEmpty else { continue }
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) else { continue }

            if let entry = Self.parseLogLine(json) {
                // Dedup: skip tool_exec if matching tool_request seen recently
                if entry.type == "tool_exec", isDuplicateToolExec(entry.raw) { continue }
                onEntry?(entry)
            }
        }
    }

    private func isDuplicateToolExec(_ raw: String) -> Bool {
        guard let ts = recentToolRequests[raw] else { return false }
        if Date().timeIntervalSince(ts) < 5 { return true }
        recentToolRequests.removeValue(forKey: raw)
        return false
    }

    private func cleanupRecentRequests() {
        let cutoff = Date().addingTimeInterval(-10)
        recentToolRequests = recentToolRequests.filter { $0.value > cutoff }
    }

    private func handleExit() {
        DaemonLogger.shared.debug("LogStream", "Process exited")
        running = false
        process = nil
    }

    // MARK: - Log Line Parser

    static func parseLogLine(_ json: Any) -> DaemonTimelineEntry? {
        guard let obj = json as? [String: Any] else { return nil }

        let type = obj["type"] as? String
        let message = obj["message"] as? String ?? obj["raw"] as? String ?? ""
        let level = obj["level"] as? String

        guard !message.isEmpty, message.count >= 5 else { return nil }

        // Filter infrastructure noise
        let subsystem = obj["subsystem"] as? String ?? ""
        let module = obj["module"] as? String ?? ""
        if ["gateway", "websocket", "connection", "heartbeat"].contains(where: { subsystem.localizedCaseInsensitiveContains($0) || module.localizedCaseInsensitiveContains($0) }) {
            return nil
        }

        let entryType: String
        if let type, (type == "model_call" || type == "model_response") { entryType = type }
        else if type == "tool_exec" { entryType = "tool_exec" }
        else if type == "memory_recall" { entryType = "memory_recall" }
        else if level == "error" { entryType = "error" }
        else { return nil }

        return DaemonTimelineEntry(
            ts: Date().timeIntervalSince1970 * 1000,
            type: entryType,
            raw: String(message.prefix(200))
        )
    }

    // MARK: - Binary Resolution

    private static func resolveOpenClawBin() -> String? {
        let candidates = ["/usr/local/bin/openclaw", "/opt/homebrew/bin/openclaw"]
        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        // Try PATH
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["which", "openclaw"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
        let result = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return result?.isEmpty == false ? result : nil
    }
}
#endif
