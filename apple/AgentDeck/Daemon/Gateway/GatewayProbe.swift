#if os(macOS)
// GatewayProbe.swift — TCP health check for OpenClaw Gateway
// Ported from bridge/src/gateway-probe.ts

import Foundation
import Network

actor GatewayProbe {
    static let gatewayPort: UInt16 = 18789
    private var pollTask: Task<Void, Never>?
    private(set) var isAvailable = false
    private(set) var hasError = false
    var onStateChanged: ((Bool, Bool) -> Void)? // (available, hasError)

    func start() {
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await self?.probe()
            }
        }
    }

    func stop() {
        pollTask?.cancel()
    }

    private func probe() async {
        let available = await tcpProbe(port: Self.gatewayPort)
        let changed = available != isAvailable
        isAvailable = available

        if available {
            // Check health via openclaw doctor
            let health = await checkHealth()
            let errorChanged = health != hasError
            hasError = health
            if changed || errorChanged {
                onStateChanged?(available, hasError)
            }
        } else if changed {
            hasError = false
            onStateChanged?(false, false)
        }
    }

    private func tcpProbe(port: UInt16) async -> Bool {
        // Simple socket connect test — no NWConnection to avoid continuation races
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        // Non-blocking connect with 2s timeout
        var flags = fcntl(fd, F_GETFL, 0)
        flags |= O_NONBLOCK
        fcntl(fd, F_SETFL, flags)

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        if result == 0 { return true }
        guard errno == EINPROGRESS else { return false }

        // Wait for connect with poll()
        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        let pollResult = poll(&pfd, 1, 2000) // 2s timeout
        if pollResult <= 0 { return false }

        // Check if connect succeeded
        var error: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &len)
        return error == 0
    }

    private func checkHealth() async -> Bool {
        // Try `openclaw doctor --json`
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["openclaw", "doctor", "--json"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let checks = json["checks"] as? [[String: Any]] {
                return checks.contains { ($0["status"] as? String) == "error" || ($0["status"] as? String) == "warn" }
            }
        } catch {
            // openclaw not installed — not an error
        }
        return false
    }
}
#endif
