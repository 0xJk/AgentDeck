#if os(macOS)
// SessionAggregator.swift — Discover sibling session bridges, enrich with state
// Ported from bridge/src/session-aggregator.ts

import Foundation

struct EnrichedSession: Sendable {
    let entry: DaemonSessionEntry
    var state: String?
    var projectName: String?
    var agentType: String?
    var modelName: String?
    var effortLevel: String?
    var alive: Bool
}

enum SessionAggregator {
    /// Build enriched sessions list by probing sibling /health endpoints
    static func buildEnrichedSessionsList(
        excludeId: String,
        sessions: [DaemonSessionEntry]
    ) async -> [EnrichedSession] {
        let siblings = sessions.filter { $0.id != excludeId }

        return await withTaskGroup(of: EnrichedSession.self) { group in
            for session in siblings {
                group.addTask {
                    await probeSession(session)
                }
            }
            var result: [EnrichedSession] = []
            for await enriched in group { result.append(enriched) }
            return result.sorted { $0.entry.port < $1.entry.port }
        }
    }

    private static func probeSession(_ session: DaemonSessionEntry) async -> EnrichedSession {
        guard let url = URL(string: "http://127.0.0.1:\(session.port)/health") else {
            return EnrichedSession(entry: session, alive: false)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return EnrichedSession(entry: session, alive: false)
            }
            return EnrichedSession(
                entry: session,
                state: json["state"] as? String,
                projectName: json["projectName"] as? String ?? session.projectName,
                agentType: json["agentType"] as? String ?? session.agentType,
                modelName: json["modelName"] as? String,
                effortLevel: json["effortLevel"] as? String,
                alive: true
            )
        } catch {
            return EnrichedSession(entry: session, alive: false)
        }
    }
}
#endif
