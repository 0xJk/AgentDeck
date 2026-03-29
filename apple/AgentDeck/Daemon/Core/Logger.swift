#if os(macOS)
// DaemonLogger.swift — Logging utility for daemon components

import Foundation
import os.log

final class DaemonLogger: Sendable {
    static let shared = DaemonLogger()

    nonisolated(unsafe) var isDebugEnabled = false

    private let osLog = os.Logger(subsystem: "dev.agentdeck.daemon", category: "daemon")

    func debug(_ category: String, _ message: String) {
        guard isDebugEnabled else { return }
        osLog.debug("[\(category)] \(message)")
    }

    func info(_ message: String) {
        osLog.info("\(message)")
    }

    func error(_ message: String) {
        osLog.error("\(message)")
    }
}
#endif
