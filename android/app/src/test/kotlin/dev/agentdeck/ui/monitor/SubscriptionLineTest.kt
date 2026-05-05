package dev.agentdeck.ui.monitor

import dev.agentdeck.net.SubscriptionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

/**
 * Guards against the dashboard surfacing stale Codex subscription dates.
 * Bug context: when the user renews ChatGPT Plus but does not re-run
 * `codex login`, ~/.codex/auth.json keeps the previous JWT and the
 * `chatgpt_subscription_active_until` claim lags behind the real billing
 * state. Once that timestamp is in the past, the renderer must drop it
 * instead of showing "ChatGPT Plus · 2025-03-04" forever.
 */
class SubscriptionLineTest {

    private val now = Instant.parse("2026-05-06T00:00:00Z")

    @Test
    fun `future ISO8601 with offset renders date suffix`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "2026-12-31T00:00:00Z")
        assertEquals("ChatGPT Plus · 2026-12-31", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `future ISO8601 with fractional seconds renders date suffix`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "2026-09-15T12:34:56.789Z")
        assertEquals("ChatGPT Plus · 2026-09-15", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `past until drops date suffix`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "2025-03-04T00:00:00Z")
        assertEquals("ChatGPT Plus", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `null until renders name only`() {
        val sub = SubscriptionInfo(name = "Claude", until = null)
        assertEquals("Claude", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `malformed until renders name only`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "not-a-date")
        assertEquals("ChatGPT Plus", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `bare date string parses as UTC midnight`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "2026-12-31")
        assertEquals("ChatGPT Plus · 2026-12-31", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `bare date in past drops suffix`() {
        val sub = SubscriptionInfo(name = "ChatGPT Plus", until = "2024-01-01")
        assertEquals("ChatGPT Plus", formatSubscriptionLine(sub, now))
    }

    @Test
    fun `parseUntilInstant accepts blank as null`() {
        assertNull(parseUntilInstant(""))
        assertNull(parseUntilInstant("   "))
    }

    @Test
    fun `parseUntilInstant accepts ISO8601`() {
        assertNotNull(parseUntilInstant("2099-01-01T00:00:00Z"))
    }
}
