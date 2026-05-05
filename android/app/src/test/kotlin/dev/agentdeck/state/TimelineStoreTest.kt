package dev.agentdeck.state

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class TimelineStoreTest {

    // Use reflection to create fresh instances (singleton pattern)
    private lateinit var store: TimelineStore

    @Before
    fun setUp() {
        // Access the singleton and clear it
        store = TimelineStore.instance
        store.clear()
    }

    // --- addEntry ---

    @Test
    fun `addEntry stores entry`() {
        store.addEntry(entry(1000, "chat_start", "Hello"))
        assertEquals(1, store.entries.value.size)
        assertEquals("Hello", store.entries.value[0].summary)
    }

    @Test
    fun `addEntry deduplicates within 5s window`() {
        store.addEntry(entry(1000, "tool_request", "Read file.ts"))
        store.addEntry(entry(3000, "tool_request", "Read file.ts"))  // within 5s, same type+summary
        assertEquals(1, store.entries.value.size)
    }

    @Test
    fun `addEntry allows same type+summary after 5s`() {
        store.addEntry(entry(1000, "tool_request", "Read file.ts"))
        store.addEntry(entry(7000, "tool_request", "Read file.ts"))  // after 5s
        assertEquals(2, store.entries.value.size)
    }

    @Test
    fun `addEntry allows different type within 5s`() {
        store.addEntry(entry(1000, "tool_request", "Read file.ts"))
        store.addEntry(entry(2000, "chat_end", "Read file.ts"))  // different type
        assertEquals(2, store.entries.value.size)
    }

    @Test
    fun `addEntry allows different summary within 5s`() {
        store.addEntry(entry(1000, "tool_request", "Read a.ts"))
        store.addEntry(entry(2000, "tool_request", "Read b.ts"))  // different summary
        assertEquals(2, store.entries.value.size)
    }

    @Test
    fun `addEntry caps at MAX_ENTRIES`() {
        // Add 600 entries (MAX = 500)
        for (i in 1..600) {
            store.addEntry(entry(i * 10_000L, "chat_start", "Entry $i"))
        }
        assertEquals(500, store.entries.value.size)
        // First entries should be trimmed, last should remain
        assertEquals("Entry 600", store.entries.value.last().summary)
    }

    // --- upsertEntry ---

    @Test
    fun `upsertEntry updates existing entry within 1s tolerance`() {
        store.addEntry(entry(1000, "chat_end", "Original"))
        store.upsertEntry(entry(1500, "chat_end", "Updated"))  // within 1s
        assertEquals(1, store.entries.value.size)
        assertEquals("Updated", store.entries.value[0].summary)
    }

    @Test
    fun `upsertEntry adds new entry if no match`() {
        store.addEntry(entry(1000, "chat_end", "First"))
        store.upsertEntry(entry(5000, "chat_end", "Second"))  // >1s gap
        assertEquals(2, store.entries.value.size)
    }

    @Test
    fun `upsertEntry preserves existing detail if new detail is null`() {
        store.addEntry(TimelineEntry(1000, "chat_end", "Summary", detail = "Existing detail"))
        store.upsertEntry(entry(1000, "chat_end", "Updated summary"))  // null detail
        assertEquals("Existing detail", store.entries.value[0].detail)
        assertEquals("Updated summary", store.entries.value[0].summary)
    }

    @Test
    fun `upsertEntry preserves timeline attribution`() {
        store.addEntry(entry(1000, "chat_end", "Summary"))
        store.upsertEntry(
            TimelineEntry(
                timestamp = 1000,
                type = "chat_end",
                summary = "Updated summary",
                projectName = "AgentDeck",
                sessionId = "session-1",
            )
        )
        assertEquals("AgentDeck", store.entries.value[0].projectName)
        assertEquals("session-1", store.entries.value[0].sessionId)
    }

    // --- updateLastOfType ---

    @Test
    fun `updateLastOfType modifies the last matching entry`() {
        store.addEntry(entry(1000, "chat_start", "First"))
        store.addEntry(entry(10000, "chat_start", "Second"))
        store.addEntry(entry(20000, "tool_request", "Read"))

        store.updateLastOfType("chat_start") { it.copy(summary = "Modified") }
        val chatStarts = store.entries.value.filter { it.type == "chat_start" }
        assertEquals("First", chatStarts[0].summary)
        assertEquals("Modified", chatStarts[1].summary)
    }

    @Test
    fun `updateLastOfType no-op if type not found`() {
        store.addEntry(entry(1000, "chat_start", "Hello"))
        store.updateLastOfType("nonexistent") { it.copy(summary = "Modified") }
        assertEquals("Hello", store.entries.value[0].summary)
    }

    // --- addEntries ---

    @Test
    fun `addEntries merges and deduplicates`() {
        store.addEntry(entry(1000, "chat_start", "First"))
        store.addEntries(listOf(
            entry(1000, "chat_start", "First"),  // duplicate
            entry(2000, "chat_end", "Second"),
        ))
        assertEquals(2, store.entries.value.size)
    }

    @Test
    fun `addEntries sorts by timestamp`() {
        store.addEntries(listOf(
            entry(3000, "c", "Third"),
            entry(1000, "a", "First"),
            entry(2000, "b", "Second"),
        ))
        assertEquals(1000, store.entries.value[0].timestamp)
        assertEquals(2000, store.entries.value[1].timestamp)
        assertEquals(3000, store.entries.value[2].timestamp)
    }

    // --- groupConsecutive ---

    @Test
    fun `groupConsecutive empty list returns empty`() {
        assertEquals(emptyList<GroupedEntry>(), groupConsecutive(emptyList()))
    }

    @Test
    fun `groupConsecutive single entry`() {
        val result = groupConsecutive(listOf(entry(1000, "chat_start", "Hello")))
        assertEquals(1, result.size)
        assertEquals(1, result[0].count)
    }

    @Test
    fun `groupConsecutive groups tool_request within 10s`() {
        val entries = listOf(
            entry(1000, "tool_request", "Read a.ts"),
            entry(5000, "tool_request", "Write b.ts"),  // within 10s, same type
            entry(8000, "tool_request", "Edit c.ts"),   // within 10s of prev
        )
        val result = groupConsecutive(entries)
        assertEquals(1, result.size)
        assertEquals(3, result[0].count)
        assertEquals("Edit c.ts", result[0].entry.summary)  // latest kept
    }

    @Test
    fun `groupConsecutive splits tool_request after 10s gap`() {
        val entries = listOf(
            entry(1000, "tool_request", "Read a.ts"),
            entry(20000, "tool_request", "Read b.ts"),  // >10s gap
        )
        val result = groupConsecutive(entries)
        assertEquals(2, result.size)
    }

    @Test
    fun `groupConsecutive groups chat_end by type only within 60s`() {
        val entries = listOf(
            entry(1000, "chat_end", "Summary A"),
            entry(30000, "chat_end", "Summary B"),  // different summary, still groups
        )
        val result = groupConsecutive(entries)
        assertEquals(1, result.size)
        assertEquals(2, result[0].count)
        assertEquals("Summary B", result[0].entry.summary)  // latest kept
    }

    @Test
    fun `groupConsecutive requires same summary for other types`() {
        val entries = listOf(
            entry(1000, "chat_start", "Hello"),
            entry(5000, "chat_start", "World"),  // different summary
        )
        val result = groupConsecutive(entries)
        assertEquals(2, result.size)
    }

    @Test
    fun `groupConsecutive groups same summary within 60s`() {
        val entries = listOf(
            entry(1000, "error", "Connection lost"),
            entry(30000, "error", "Connection lost"),
        )
        val result = groupConsecutive(entries)
        assertEquals(1, result.size)
        assertEquals(2, result[0].count)
    }

    @Test
    fun `groupConsecutive splits different types`() {
        val entries = listOf(
            entry(1000, "chat_start", "Hello"),
            entry(2000, "tool_request", "Read"),
            entry(3000, "chat_end", "Done"),
        )
        val result = groupConsecutive(entries)
        assertEquals(3, result.size)
    }

    // --- clear ---

    @Test
    fun `clear empties the store`() {
        store.addEntry(entry(1000, "chat_start", "Hello"))
        store.clear()
        assertTrue(store.entries.value.isEmpty())
    }

    // --- helpers ---

    private fun entry(ts: Long, type: String, summary: String) =
        TimelineEntry(timestamp = ts, type = type, summary = summary)
}
