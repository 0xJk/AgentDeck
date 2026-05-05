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
    val window = when (entry.type) {
        "tool_request" -> 10_000L
        "chat_end" -> 60_000L
        else -> 60_000L
    }
    if (entry.timestamp - group.lastTs > window) return false
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

    /** Update existing entry with same ts+type (1s tolerance), or add new */
    fun upsertEntry(entry: TimelineEntry) {
        val list = _entries.value.toMutableList()
        val idx = list.indexOfLast { it.type == entry.type && kotlin.math.abs(it.timestamp - entry.timestamp) < 1000L }
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
            )
            _entries.value = list
        } else {
            addEntry(entry)
        }
    }

    fun addEntries(newEntries: List<TimelineEntry>) {
        _entries.value = (_entries.value + newEntries)
            .distinctBy { "${it.timestamp}-${it.type}-${it.summary}" }
            .sortedBy { it.timestamp }
            .takeLast(MAX_ENTRIES)
    }

    fun clear() {
        _entries.value = emptyList()
    }
}
