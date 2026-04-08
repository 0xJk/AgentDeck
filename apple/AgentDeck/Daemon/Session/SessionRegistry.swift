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
    // Enriched fields (from /health probe, not persisted to sessions.json)
    var state: String?
    var modelName: String?
    var currentTool: String?
    var options: [[String: AnyCodable]]?
    var navigable: Bool?
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
            replaceFile(at: sessionsFile, with: tmpFile)
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
            replaceFile(at: daemonFile, with: tmpFile)
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
        guard isProcessAlive(info.pid) else {
            removeDaemonInfo()
            return nil
        }
        // PID reuse guard: if startedAt is more than 24h ago, the PID likely
        // belongs to a different process that reused the same number.
        if let startedDate = ISO8601DateFormatter().date(from: info.startedAt) {
            let age = Date().timeIntervalSince(startedDate)
            if age > 24 * 60 * 60 {
                DaemonLogger.shared.debug("SessionRegistry", "Stale daemon.json (startedAt \(info.startedAt), age \(Int(age))s) — removing")
                removeDaemonInfo()
                return nil
            }
        }
        return info
    }

    func findDaemonPort() -> Int? {
        if let info = readDaemonInfo() { return info.port }
        if let daemon = findExistingDaemon() { return daemon.port }
        return nil
    }

    // MARK: - Port Allocation

    func findAvailablePort(excluding: Set<Int> = []) async -> Int? {
        let sessions = listActive()
        let usedPorts = Set(sessions.map(\.port)).union(excluding)
        for port in Self.basePort...Self.maxPort {
            if !usedPorts.contains(port), await isPortFree(port) {
                return port
            }
        }
        return nil
    }

    func isPortBindable(_ port: Int) async -> Bool {
        await isPortFree(port)
    }

    // MARK: - Health Probe

    func probeDaemonHealth(port: Int) async -> [String: Any]? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return nil }
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
        // kill(pid, 0) returns 0 even for zombies still in the kernel table,
        // so use sysctl to check the process state directly. Treat zombies
        // (SZOMB) and exiting processes (P_WEXIT flag) as dead — they will
        // never respond to WebSocket/HTTP probes.
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, Int32(pid)]
        let result = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        guard result == 0, size > 0 else { return false }
        if info.kp_proc.p_stat == 5 { return false }              // SZOMB
        if (Int32(info.kp_proc.p_flag) & 0x2000) != 0 { return false }  // P_WEXIT
        return true
    }

    private func isPortFree(_ port: Int) async -> Bool {
        // Test IPv6 wildcard (::) in dual-stack mode — matches what NWListener actually binds.
        // NWListener binds to "::.<port>" by default, so an IPv4-only 127.0.0.1 test can
        // succeed while the actual NWListener bind fails with EADDRINUSE.
        let fd = socket(AF_INET6, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        // SO_REUSEADDR to match NWParameters.allowLocalEndpointReuse
        var reuseAddr: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuseAddr, socklen_t(MemoryLayout<Int32>.size))

        // Dual-stack — accept both IPv4 and IPv6 on same socket
        var v6only: Int32 = 0
        setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &v6only, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in6()
        addr.sin6_family = sa_family_t(AF_INET6)
        addr.sin6_port = in_port_t(port).bigEndian
        addr.sin6_addr = in6addr_any  // :: wildcard

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.size))
            }
        }
        guard bindResult == 0 else { return false }

        // SO_REUSEADDR allows TWO sockets to bind() the same port, but only one
        // can listen(). Without this check, the probe can report "free" while
        // another REUSEADDR socket already owns the listen slot, then NWListener
        // loses the race and fails with EADDRINUSE.
        return listen(fd, 1) == 0
    }

    private func replaceFile(at destination: URL, with source: URL) {
        let fm = FileManager.default
        if fm.fileExists(atPath: destination.path) {
            _ = try? fm.replaceItemAt(destination, withItemAt: source)
        } else {
            try? fm.moveItem(at: source, to: destination)
        }
        if fm.fileExists(atPath: source.path) {
            try? fm.removeItem(at: source)
        }
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
