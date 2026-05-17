package dev.agentdeck.state

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

@Serializable
data class TimelineEntry(
    val timestamp: Long,
    val type: String,
    val summary: String,
    val detail: String? = null,
    val agentType: String? = null,
    val projectName: String? = null,
    val sessionId: String? = null,
    val runId: String? = null,
    val startedAt: Long? = null,
    val endedAt: Long? = null,
    val status: String? = null,
    /** APME task id. Set on task_start/task_end and on every turn entry inside the task scope. */
    val taskId: String? = null,
    /** Only on task_end. todo_complete | clear | session_end | manual | idle_gap. */
    val boundarySignal: String? = null,
    /** "llm" | "heuristic" | "none". Lets clients suppress the detail pane
     *  when the heuristic gave up and the body is just the raw response. */
    val summaryKind: String? = null,
    /**
     * Task-judge rollup, attached on the SECOND `task_end` emit the runner
     * fires once the LLM judge resolves (5–30 s after the boundary). Stores
     * upsert by (type, taskId) — see `upsertEntry`. Nil on the initial emit
     * and for non-task entries / pre-existing on-disk rows. Mirrors the four
     * task* fields on shared/src/timeline.ts::TimelineEntry.
     *   - `taskScore`    : 0..1 composite
     *   - `taskOutcome`  : "success" | "partial" | "fail" | "pending"
     *   - `taskCategory` : task_rollup category
     *   - `taskSummary`  : one-line judge summary
     */
    val taskScore: Double? = null,
    val taskOutcome: String? = null,
    val taskCategory: String? = null,
    val taskSummary: String? = null,
)

data class GroupedEntry(
    val entry: TimelineEntry,
    val count: Int = 1,
    val lastTs: Long = entry.timestamp,
)

/**
 * Group consecutive entries of the same type+summary within a time window.
 * - tool_request: 10s window, group by type only (summary varies)
 * - chat_end: group by type only, keep latest raw
 * - others: 60s window, same type+summary
 */
fun groupConsecutive(entries: List<TimelineEntry>): List<GroupedEntry> {
    if (entries.isEmpty()) return emptyList()
    val result = mutableListOf<GroupedEntry>()
    for (entry in entries) {
        val last = result.lastOrNull()
        if (last != null && canGroup(last, entry)) {
            result[result.lastIndex] = GroupedEntry(
                entry = entry, // keep latest entry
                count = last.count + 1,
                lastTs = entry.timestamp,
            )
        } else {
            result.add(GroupedEntry(entry))
        }
    }
    return result
}

private fun canGroup(group: GroupedEntry, entry: TimelineEntry): Boolean {
    val prev = group.entry
    if (prev.type != entry.type) return false
    // Task hierarchy markers never group — each task is a unique unit of work.
    if (entry.type == "task_start" || entry.type == "task_end") return false
    val window = when (entry.type) {
        "tool_request" -> 10_000L
        "chat_end" -> 60_000L
        else -> 60_000L
    }
    if (entry.timestamp - group.lastTs > window) return false
    if (!sameTimelineContext(prev, entry)) return false
    // chat_end: group by type only (keep latest summary)
    if (entry.type == "chat_end") return true
    // tool_request: group by type only
    if (entry.type == "tool_request") return true
    // others: same summary
    return prev.summary == entry.summary
}

class TimelineStore private constructor() {

    companion object {
        val instance: TimelineStore by lazy { TimelineStore() }
        private const val MAX_ENTRIES = 500
    }

    private val _entries = MutableStateFlow<List<TimelineEntry>>(emptyList())
    val entries: StateFlow<List<TimelineEntry>> = _entries.asStateFlow()

    fun addEntry(entry: TimelineEntry) {
        // Drop codex:otel-active noise at the **storage** layer so it never
        // reaches consumers that bypass `timelineDisplayGroups` (raw
        // `entries` flow readers, persistence in future, etc.) and so the
        // MAX_ENTRIES buffer doesn't age out useful rows behind it.
        // Mirrors Apple `DaemonTimelineStore` add-path filter.
        if (isLowSignalEntry(entry)) return
        val list = _entries.value
        // 5s dedup — skip if same type+summary within window
        for (i in list.indices.reversed()) {
            val e = list[i]
            if (entry.timestamp - e.timestamp > 5000) break
            if (e.type == entry.type && e.summary == entry.summary) return
        }
        _entries.value = (list + entry).takeLast(MAX_ENTRIES)
    }

    /** Update the most recent entry matching [type] using [transform]. */
    fun updateLastOfType(type: String, transform: (TimelineEntry) -> TimelineEntry) {
        val list = _entries.value.toMutableList()
        val idx = list.indexOfLast { it.type == type }
        if (idx >= 0) {
            list[idx] = transform(list[idx])
            _entries.value = list
        }
    }

    /** Update existing entry with same ts+type (1s tolerance), or add new.
     *
     *  taskId / boundarySignal / summaryKind are progressive: a heuristic
     *  chat_end can later be upserted with summaryKind='llm' + the LLM
     *  summary. Without propagating these, the dashboard keeps showing the
     *  pre-LLM kind and (for 'none' rows) the detail pane stays suppressed
     *  even after the LLM rescues it. */
    fun upsertEntry(entry: TimelineEntry) {
        // Storage-layer guard mirrors addEntry — never let an OTel low-
        // signal row enter, even via the upsert path used for progressive
        // summaryKind enrichment.
        if (isLowSignalEntry(entry)) return
        val list = _entries.value.toMutableList()
        // Task-judge follow-up emits land 5–30 s after the initial boundary,
        // so the 1 s timestamp window won't match. For task_end rows, prefer
        // matching by (type, taskId) — that pair is stable across both emits
        // and lets the score-bearing update merge in place. Mirrors Apple
        // `DaemonTimelineStore::upsert`.
        val taskMatchIdx = if (entry.type == "task_end" && !entry.taskId.isNullOrEmpty()) {
            list.indexOfLast { it.type == "task_end" && it.taskId == entry.taskId }
        } else -1
        val idx = if (taskMatchIdx >= 0) taskMatchIdx else {
            list.indexOfLast { it.type == entry.type && kotlin.math.abs(it.timestamp - entry.timestamp) < 1000L }
        }
        if (idx >= 0) {
            list[idx] = list[idx].copy(
                summary = entry.summary,
                detail = entry.detail ?: list[idx].detail,
                agentType = entry.agentType ?: list[idx].agentType,
                projectName = entry.projectName ?: list[idx].projectName,
                sessionId = entry.sessionId ?: list[idx].sessionId,
                runId = entry.runId ?: list[idx].runId,
                startedAt = entry.startedAt ?: list[idx].startedAt,
                endedAt = entry.endedAt ?: list[idx].endedAt,
                status = entry.status ?: list[idx].status,
                taskId = entry.taskId ?: list[idx].taskId,
                boundarySignal = entry.boundarySignal ?: list[idx].boundarySignal,
                summaryKind = entry.summaryKind ?: list[idx].summaryKind,
                taskScore = entry.taskScore ?: list[idx].taskScore,
                taskOutcome = entry.taskOutcome ?: list[idx].taskOutcome,
                taskCategory = entry.taskCategory ?: list[idx].taskCategory,
                taskSummary = entry.taskSummary ?: list[idx].taskSummary,
            )
            _entries.value = list
        } else {
            addEntry(entry)
        }
    }

    fun addEntries(newEntries: List<TimelineEntry>) {
        // Same storage-layer guard as addEntry — bulk replay paths
        // (sessions_list snapshots, daemon resync) must not bypass the
        // OTel filter.
        val filtered = newEntries.filterNot { isLowSignalEntry(it) }
        _entries.value = (_entries.value + filtered)
            .distinctBy { "${it.timestamp}-${it.type}-${it.summary}" }
            .sortedBy { it.timestamp }
            .takeLast(MAX_ENTRIES)
    }

    fun clear() {
        _entries.value = emptyList()
    }
}
