#if os(macOS)
// SessionRegistry.swift — daemon.json / sessions.json management
// Ported from bridge/src/session-registry.ts

import Foundation

struct DaemonInfo: Codable, Sendable {
    let port: Int
    let pid: Int
    let startedAt: String
    let httpPort: Int?    // HTTP server port (may differ from WS port)
}

struct DaemonSessionEntry: Codable, Sendable, Identifiable {
    let id: String
    let port: Int
    let pid: Int
    let projectName: String
    var agentType: String?
    var tmuxSession: String?
    var tty: String?
    var parentTty: String?
    var startedAt: String?
}

final class SessionRegistry: Sendable {
    static let shared = SessionRegistry()
    static let defaultPort = 9120
    static let basePort = 9120
    static let maxPort = 9139

    private var dataDir: URL {
        if let env = ProcessInfo.processInfo.environment["AGENTDECK_DATA_DIR"] {
            return URL(fileURLWithPath: env)
        }
        return AuthManager.agentDeckDir
    }

    private var sessionsFile: URL { dataDir.appendingPathComponent("sessions.json") }
    private var daemonFile: URL { dataDir.appendingPathComponent("daemon.json") }

    // MARK: - Sessions

    func readSessions() -> [DaemonSessionEntry] {
        guard let data = try? Data(contentsOf: sessionsFile),
              let sessions = try? JSONDecoder().decode([DaemonSessionEntry].self, from: data) else {
            return []
        }
        return sessions
    }

    private func writeSessions(_ sessions: [DaemonSessionEntry]) {
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let tmpFile = dataDir.appendingPathComponent(".sessions.\(UUID().uuidString).tmp")
        if let data = try? JSONEncoder.pretty.encode(sessions) {
            try? data.write(to: tmpFile)
            try? FileManager.default.moveItem(at: tmpFile, to: sessionsFile)
        }
    }

    func register(_ entry: DaemonSessionEntry) {
        var sessions = pruneDeadSessions(readSessions())
        sessions.removeAll { $0.id == entry.id }
        sessions.append(entry)
        writeSessions(sessions)
        DaemonLogger.shared.debug("SessionRegistry", "Registered \(entry.id) on port \(entry.port)")
    }

    func deregister(_ id: String) {
        var sessions = readSessions()
        sessions.removeAll { $0.id == id }
        writeSessions(sessions)
    }

    func listActive() -> [DaemonSessionEntry] {
        let sessions = readSessions()
        let alive = pruneDeadSessions(sessions)
        if alive.count != sessions.count { writeSessions(alive) }
        return alive
    }

    func findExistingDaemon() -> DaemonSessionEntry? {
        listActive().first { $0.agentType == "daemon" }
    }

    // MARK: - Daemon Info

    func writeDaemonInfo(_ info: DaemonInfo) {
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let tmpFile = dataDir.appendingPathComponent(".daemon.\(UUID().uuidString).tmp")
        if let data = try? JSONEncoder.pretty.encode(info) {
            try? data.write(to: tmpFile)
            try? FileManager.default.moveItem(at: tmpFile, to: daemonFile)
        }
        DaemonLogger.shared.debug("SessionRegistry", "Wrote daemon.json: port=\(info.port)")
    }

    func removeDaemonInfo() {
        try? FileManager.default.removeItem(at: daemonFile)
    }

    func readDaemonInfo() -> DaemonInfo? {
        guard let data = try? Data(contentsOf: daemonFile),
              let info = try? JSONDecoder().decode(DaemonInfo.self, from: data) else {
            return nil
        }
        if isProcessAlive(info.pid) { return info }
        removeDaemonInfo()
        return nil
    }

    func findDaemonPort() -> Int? {
        if let info = readDaemonInfo() { return info.port }
        if let daemon = findExistingDaemon() { return daemon.port }
        return nil
    }

    // MARK: - Port Allocation

    func findAvailablePort() async -> Int? {
        let sessions = listActive()
        let usedPorts = Set(sessions.map(\.port))
        for port in Self.basePort...Self.maxPort {
            if !usedPorts.contains(port), await isPortFree(port) {
                return port
            }
        }
        return nil
    }

    // MARK: - Health Probe

    func probeDaemonHealth(port: Int) async -> [String: Any]? {
        let url = URL(string: "http://127.0.0.1:\(port)/health")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch {
            return nil
        }
    }

    // MARK: - Helpers

    private func pruneDeadSessions(_ sessions: [DaemonSessionEntry]) -> [DaemonSessionEntry] {
        sessions.filter { isProcessAlive($0.pid) }
    }

    private func isProcessAlive(_ pid: Int) -> Bool {
        kill(Int32(pid), 0) == 0
    }

    private func isPortFree(_ port: Int) async -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        var reuseAddr: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuseAddr, socklen_t(MemoryLayout<Int32>.size))

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }
}

// MARK: - JSONEncoder convenience

extension JSONEncoder {
    static let pretty: JSONEncoder = {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        return enc
    }()
}
#endif
