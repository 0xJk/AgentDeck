package dev.agentdeck.ui.eink

import dev.agentdeck.net.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Locks in the cross-platform sort contract used by Android, macOS/iOS, the
 * TUI, and the Stream Deck plugin. The same input must produce the same
 * ordering and the same #N suffix on every surface — otherwise the
 * dashboard left HUD shows different sessions in different positions for the
 * same daemon snapshot. Mirrors apple/AgentDeckTests/ProtocolTests.swift's
 * sortSessions tests and shared/src/__tests__/session-utils.test.ts.
 */
class SessionDisplayOrderingTest {

    private fun session(
        id: String,
        agentType: String? = "claude-code",
        projectName: String? = "AgentDeck",
        startedAt: String? = null,
        port: Int = 9120,
    ) = SessionInfo(
        id = id,
        port = port,
        projectName = projectName,
        agentType = agentType,
        alive = true,
        state = "idle",
        modelName = null,
        startedAt = startedAt,
    )

    @Test
    fun `agentTypeRank places openclaw first`() {
        assertEquals(0, agentTypeRank("openclaw"))
        assertEquals(1, agentTypeRank("claude-code"))
        assertEquals(2, agentTypeRank("codex-cli"))
        assertEquals(3, agentTypeRank("opencode"))
        assertEquals(4, agentTypeRank("unknown"))
        assertEquals(4, agentTypeRank(null))
    }

    @Test
    fun `naturalLabelCompare orders Agent 2 before Agent 10`() {
        assertTrue(naturalLabelCompare("Agent 2", "Agent 10") < 0)
        assertTrue(naturalLabelCompare("Agent 10", "Agent 2") > 0)
        assertEquals(0, naturalLabelCompare("Agent 2", "Agent 2"))
    }

    @Test
    fun `compareSessionsForDisplay sorts openclaw before claude-code regardless of project`() {
        val sorted = listOf(
            session(id = "claude", agentType = "claude-code", projectName = "Z", startedAt = "2026-05-11T10:00:00Z"),
            session(id = "oc", agentType = "openclaw", projectName = "A", startedAt = "2026-05-11T11:00:00Z"),
        ).sortedWith(::compareSessionsForDisplay)

        assertEquals(listOf("oc", "claude"), sorted.map { it.id })
    }

    @Test
    fun `compareSessionsForDisplay breaks ties on startedAt ascending (oldest first)`() {
        val sorted = listOf(
            session(id = "newer", startedAt = "2026-05-11T11:00:00Z"),
            session(id = "older", startedAt = "2026-05-11T10:00:00Z"),
        ).sortedWith(::compareSessionsForDisplay)

        assertEquals(listOf("older", "newer"), sorted.map { it.id })
    }

    @Test
    fun `compareSessionsForDisplay tie-breaks on natural id when startedAt is identical`() {
        // The iPad/iOS reproduction: two AgentDeck claude-code sessions start
        // in the same second. The natural-id tie-breaker decides, and must be
        // deterministic so the #N suffix order does not flip on re-sorts.
        val sameTs = "2026-05-11T10:00:00Z"
        val sorted = listOf(
            session(id = "session-10", startedAt = sameTs),
            session(id = "session-2", startedAt = sameTs),
        ).sortedWith(::compareSessionsForDisplay)

        assertEquals(listOf("session-2", "session-10"), sorted.map { it.id })
    }

    @Test
    fun `compareSessionsForDisplay is stable across re-sorts of any input order`() {
        val sessions = listOf(
            session(id = "session-10", startedAt = "2026-05-11T10:00:00Z"),
            session(id = "session-2", startedAt = "2026-05-11T10:00:00Z"),
            session(id = "oc", agentType = "openclaw", startedAt = "2026-05-11T09:00:00Z"),
        )
        val a = sessions.sortedWith(::compareSessionsForDisplay)
        val b = sessions.reversed().sortedWith(::compareSessionsForDisplay)

        assertEquals(a.map { it.id }, b.map { it.id })
        assertEquals(listOf("oc", "session-2", "session-10"), a.map { it.id })
    }
}
