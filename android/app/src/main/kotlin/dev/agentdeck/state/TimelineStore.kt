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
)

class TimelineStore private constructor() {

    companion object {
        val instance: TimelineStore by lazy { TimelineStore() }
        private const val MAX_ENTRIES = 500
    }

    private val _entries = MutableStateFlow<List<TimelineEntry>>(emptyList())
    val entries: StateFlow<List<TimelineEntry>> = _entries.asStateFlow()

    fun addEntry(entry: TimelineEntry) {
        _entries.value = (_entries.value + entry).takeLast(MAX_ENTRIES)
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
