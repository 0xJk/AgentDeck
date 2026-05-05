// Timeline.swift — Event timeline types
// Ported from shared/src/timeline.ts

import Foundation

// MARK: - Timeline Entry Type

enum TimelineEntryType: String, Codable, Sendable {
    case toolRequest = "tool_request"
    case toolResolved = "tool_resolved"
    case chatStart = "chat_start"
    case chatEnd = "chat_end"
    case chatResponse = "chat_response"
    case error
    case scheduled
    case userAction = "user_action"
    case modelCall = "model_call"
    case modelResponse = "model_response"
    case memoryRecall = "memory_recall"
    case toolExec = "tool_exec"
    case evalResult = "eval_result"
}

// MARK: - Timeline Entry

struct TimelineEntry: Codable, Sendable, Identifiable {
    let ts: Double  // milliseconds
    let type: TimelineEntryType
    let raw: String
    var detail: String?
    var approvalId: String?
    var status: String?  // pending | approved | denied
    var agentType: String?
    /// Project folder name of the session that produced this entry. Used as
    /// the row prefix so multi-session dashboards can tell "ViewTrans" apart
    /// from "AgentDeck" even when both are the same `agentType`. Nil for
    /// entries predating the multi-session attribution work.
    var projectName: String?
    /// Session id the entry belongs to. Populated from state_update events
    /// that carry the hook-attributing sessionId.
    var sessionId: String?
    /// Agent run id, when the upstream adapter exposes one. OpenClaw Gateway
    /// uses this to group tool/model rows belonging to the same generation.
    var runId: String?
    /// Lifecycle bounds for task/turn entries. `ts` remains the display/event
    /// timestamp; these fields let the detail pane show elapsed work clearly.
    var startedAt: Double?
    var endedAt: Double?

    var id: Double { ts }

    var date: Date {
        Date(timeIntervalSince1970: ts / 1000)
    }
}

// MARK: - Grouped Entry (for UI display)

struct GroupedEntry: Identifiable, Sendable {
    let entry: TimelineEntry
    var count: Int = 1
    /// Unique ID combining timestamp + type + count to avoid ForEach duplicate ID warnings
    var id: String { "\(entry.ts)-\(entry.type)-\(count)" }
}

// MARK: - Timeline Grouping

func groupConsecutive(_ entries: [TimelineEntry], windowSeconds: Double = 60) -> [GroupedEntry] {
    guard !entries.isEmpty else { return [] }

    var result: [GroupedEntry] = []
    var current = GroupedEntry(entry: entries[0])

    for i in 1..<entries.count {
        let entry = entries[i]
        let timeDiff = abs(entry.ts - current.entry.ts)

        if entry.type == current.entry.type &&
           entry.raw == current.entry.raw &&
           timeDiff <= windowSeconds * 1000 {
            current.count += 1
        } else {
            result.append(current)
            current = GroupedEntry(entry: entry)
        }
    }
    result.append(current)
    return result
}

// Type display functions moved to TimelineStripView.swift (timelineTypeIcon, timelineTypeColor)
