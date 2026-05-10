package dev.agentdeck.state

/**
 * Dashboard-facing timeline projection.
 *
 * The raw timeline is intentionally low-level; this projection turns it into
 * meaningful lifecycle rows. An in-flight chat_start remains visible until a
 * same-session completion arrives. Once a chat_response/model_response/chat_end
 * arrives, the completion row becomes the user-visible unit.
 */
fun timelineDisplayGroups(groups: List<GroupedEntry>): List<GroupedEntry> =
    groups.filter { group ->
        val entry = group.entry
        when {
            // Task hierarchy markers are never elided — primary navigation handle.
            entry.type == "task_start" || entry.type == "task_end" -> true
            // Suppress codex:otel-active no-op tool noise (matches Apple).
            isLowSignalEntry(entry) -> false
            entry.type == "chat_start" ->
                if (!hasLaterCompletion(entry, groups)) true
                else isMeaningfulChatStart(entry)
            // chat_end carries useful info distinct from chat_response when it
            // has a real summary tag (LLM/heuristic). "none" sentinel and
            // null fall back to the legacy dedup-with-chat_response rule.
            entry.type == "chat_end" -> {
                val kind = entry.summaryKind
                if (kind != null && kind != "none") true
                else !hasPairedChatResponse(entry, groups)
            }
            else -> true
        }
    }

/**
 * True when the chat_start row has user-meaningful content (a real prompt) —
 * synthetic starters that the bridge inserts for lifecycle tracking are
 * dropped once a completion arrives. Mirrors `timelineIsMeaningfulChatStart`
 * in apple/AgentDeck/UI/Monitor/TimelineStripView.swift.
 */
private fun isMeaningfulChatStart(entry: TimelineEntry): Boolean {
    val raw = entry.summary.trim()
    if (raw.isEmpty()) return false
    val normalized = raw.lowercase()
    return normalized !in syntheticChatStarts
}

private val syntheticChatStarts = setOf(
    "prompt sent",
    "codex turn started",
    "starting chat",
    "connected",
    "resumed",
)

/**
 * Codex OTel low-signal entries — `codex:otel-active` session emits raw
 * "tool" / "exec" / "unknown" markers that have no user value next to the
 * adapter-generated rich rows. Mirrors `timelineIsLowSignalEntry` in
 * apple/AgentDeck/UI/Monitor/TimelineStripView.swift.
 *
 * Visible at package level so `TimelineStore` can drop these on the
 * **add** path too — Apple filters at storage AND display, so legacy
 * persisted entries never come back when timeline.json replays. Android
 * doesn't persist (in-memory store only) but the same guard keeps the
 * 500-entry buffer from aging out useful rows behind OTel noise.
 */
internal fun isLowSignalEntry(entry: TimelineEntry): Boolean {
    if (entry.agentType != "codex-cli") return false
    if (entry.sessionId != "codex:otel-active") return false
    if (entry.type !in lowSignalTypes) return false
    return entry.summary.trim().lowercase() in lowSignalRawSet
}

private val lowSignalTypes = setOf("tool_exec", "tool_request", "tool_resolved")
private val lowSignalRawSet = setOf(
    "tool",
    "tool completed",
    "unknown",
    "unknown completed",
    "exec",
    "exec completed",
)

fun isTimelineCompletionEntry(entry: TimelineEntry): Boolean =
    entry.type == "chat_response" || entry.type == "chat_end" || entry.type == "model_response"

fun sameTimelineContext(a: TimelineEntry, b: TimelineEntry): Boolean {
    // 1) taskId — strongest grouping key; same task is same context.
    val aTask = a.taskId?.takeIf { it.isNotBlank() }
    val bTask = b.taskId?.takeIf { it.isNotBlank() }
    if (aTask != null && bTask != null) return aTask == bTask

    // 2) runId — adapter-emitted generation id.
    val aRunId = a.runId?.takeIf { it.isNotBlank() }
    val bRunId = b.runId?.takeIf { it.isNotBlank() }
    if (aRunId != null && bRunId != null) return aRunId == bRunId

    // 3) sessionId — once either side has one, both must match. The earlier
    // (projectName, agentType) fallback collapsed two real sessions in the
    // same project into one timeline row.
    val aSessionId = a.sessionId?.takeIf { it.isNotBlank() }
    val bSessionId = b.sessionId?.takeIf { it.isNotBlank() }
    if (aSessionId != null || bSessionId != null) {
        return aSessionId != null && bSessionId != null && aSessionId == bSessionId
    }

    // 4) Both sessionless — fallback for legacy entries.
    if (a.projectName.hasText() && a.projectName == b.projectName && a.agentType == b.agentType) return true
    return !a.projectName.hasText() && !b.projectName.hasText() && a.agentType == b.agentType
}

fun pairedTimelineStart(entry: TimelineEntry, entries: List<TimelineEntry>): TimelineEntry? =
    entries.lastOrNull { candidate ->
        candidate.type == "chat_start" &&
            candidate.timestamp <= entry.timestamp &&
            entry.timestamp - candidate.timestamp <= 12 * 60 * 60 * 1000L &&
            sameTimelineContext(candidate, entry)
    }

fun timelineLifecycleBounds(entry: TimelineEntry, entries: List<TimelineEntry>): Pair<Long?, Long?> {
    val startedAt = entry.startedAt ?: pairedTimelineStart(entry, entries)?.timestamp
    val endedAt = entry.endedAt ?: if (isTimelineCompletionEntry(entry) || entry.type == "eval_result") {
        entry.timestamp
    } else {
        null
    }
    return startedAt to endedAt
}

private fun hasLaterCompletion(start: TimelineEntry, groups: List<GroupedEntry>): Boolean =
    groups.any { other ->
        isTimelineCompletionEntry(other.entry) &&
            other.entry.timestamp >= start.timestamp &&
            sameTimelineContext(start, other.entry)
    }

private fun hasPairedChatResponse(end: TimelineEntry, groups: List<GroupedEntry>): Boolean =
    groups.any { other ->
        if (other.entry.type != "chat_response") return@any false
        if (!sameTimelineContext(end, other.entry)) return@any false
        val endStartedAt = end.startedAt
        val responseStartedAt = other.entry.startedAt
        if (endStartedAt != null && responseStartedAt != null) {
            kotlin.math.abs(endStartedAt - responseStartedAt) < 1000L
        } else {
            kotlin.math.abs(end.timestamp - other.entry.timestamp) <= 10_000L
        }
    }

private fun String?.hasText(): Boolean = !isNullOrBlank()
