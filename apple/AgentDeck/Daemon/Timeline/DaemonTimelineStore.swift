#if os(macOS)
// TimelineStore.swift — In-memory timeline event storage with disk persistence
// Ported from bridge/src/timeline-store.ts

import Foundation

struct DaemonTimelineEntry: Codable, Sendable {
    let ts: Double  // milliseconds
    let type: String
    let raw: String
    var detail: String?
    var approvalId: String?
    var status: String?
    var agentType: String?
    var repeatCount: Int?
    var automated: Bool?
    /// Project name + session id of the originating session. Mirrors the
    /// equivalent fields on `TimelineEntry` (UI-facing copy) so entries
    /// round-tripped through the on-disk timeline keep per-session
    /// attribution. Existing persisted entries without these keys decode
    /// to nil via Codable's default optional-missing-key behaviour.
    var projectName: String?
    var sessionId: String?
    /// OpenClaw Gateway runId — groups entries belonging to the same
    /// generation cycle so clients can cluster them into a single turn row.
    var runId: String?
}

actor DaemonTimelineStore {
    private var entries: [DaemonTimelineEntry] = []
    private let maxEntries = 200
    private let persistFile = AuthManager.agentDeckDir.appendingPathComponent("timeline.json")
    private var dirty = false
    // .userInteractive: DaemonServer.startServices calls start() →
    // loadFromDisk() from the main actor and sync-waits via DispatchSemaphore.
    // .userInitiated still leaves a one-step inversion (User-interactive →
    // User-initiated) that TPC flags. Single Data(contentsOf:) capped at
    // 700 ms — bounded enough to justify the elevated QoS on the main-actor
    // startup critical path.
    private static let ioQueue = DispatchQueue(label: "dev.agentdeck.timeline.io", qos: .userInteractive)

    init() {
        // loadFromDisk is called after actor init via start()
    }

    func start() {
        loadFromDisk()
    }

    func add(_ entry: DaemonTimelineEntry) {
        // Exact dedup: same ts + type + raw within 8s.
        // Window matches shared/src/timeline.ts deduplicateEntry — covers the
        // PTY-fallback / Stop-hook race that can leak two identical chat_response
        // entries when Claude Code's transcript flush lags spinner_stop by a few
        // seconds.
        let recentWindow = entry.ts - 8000
        if entries.last(where: { $0.ts > recentWindow && $0.type == entry.type && $0.raw == entry.raw }) != nil {
            return
        }

        entries.append(entry)
        if entries.count > maxEntries {
            entries.removeFirst(entries.count - maxEntries)
        }
        dirty = true
    }

    func upsert(_ entry: DaemonTimelineEntry) {
        if let idx = entries.lastIndex(where: { $0.ts == entry.ts && $0.type == entry.type }) {
            entries[idx] = entry
        } else {
            add(entry)
        }
        dirty = true
    }

    func getAll() -> [DaemonTimelineEntry] { entries }

    func getRecent(_ count: Int = 50) -> [DaemonTimelineEntry] {
        Array(entries.suffix(count))
    }

    /// Returns the last timeline entry matching the given type, or nil if none found.
    func getLastEntry(type: String) -> DaemonTimelineEntry? {
        entries.last(where: { $0.type == type })
    }

    func flush() {
        guard dirty else { return }
        if let data = try? JSONEncoder().encode(entries) {
            let persistFile = persistFile
            Self.ioQueue.async {
                try? data.write(to: persistFile)
            }
        }
        dirty = false
    }

    private func loadFromDisk() {
        let box = TimelineDataBox()
        let semaphore = DispatchSemaphore(value: 0)
        let persistFile = persistFile
        Self.ioQueue.async {
            box.set(try? Data(contentsOf: persistFile))
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + .milliseconds(700)) == .success,
              let data = box.get(),
              let loaded = try? JSONDecoder().decode([DaemonTimelineEntry].self, from: data) else { return }
        entries = Array(loaded.suffix(maxEntries))
    }
}

private final class TimelineDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Data?

    func set(_ value: Data?) {
        lock.lock()
        self.value = value
        lock.unlock()
    }

    func get() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
#endif
