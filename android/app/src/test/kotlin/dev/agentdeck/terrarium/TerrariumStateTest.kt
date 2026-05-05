package dev.agentdeck.terrarium

import dev.agentdeck.net.AgentState
import dev.agentdeck.net.SessionInfo
import dev.agentdeck.state.DashboardState
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TerrariumStateTest {

    @Test
    fun `reachable gateway without auth hides OpenClaw and workers`() {
        val terrarium = DashboardState(
            agentState = AgentState.IDLE,
            agentType = "daemon",
            gatewayAvailable = true,
            gatewayConnected = false,
            gatewayHasError = false,
            workerSessionCount = 3,
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.DORMANT, terrarium.crayfish)
        assertEquals(0, terrarium.workerCrayfishCount)
    }

    @Test
    fun `authenticated gateway shows OpenClaw at rest`() {
        val terrarium = DashboardState(
            agentState = AgentState.IDLE,
            agentType = "daemon",
            gatewayAvailable = true,
            gatewayConnected = true,
            gatewayHasError = false,
            workerSessionCount = 2,
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.SITTING, terrarium.crayfish)
        assertEquals(2, terrarium.workerCrayfishCount)
    }

    @Test
    fun `gateway error surfaces sick OpenClaw`() {
        val terrarium = DashboardState(
            agentState = AgentState.IDLE,
            agentType = "daemon",
            gatewayAvailable = true,
            gatewayConnected = false,
            gatewayHasError = true,
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.SICK, terrarium.crayfish)
    }

    @Test
    fun `stale gateway error is ignored when gateway is unavailable`() {
        val terrarium = DashboardState(
            agentState = AgentState.IDLE,
            agentType = "daemon",
            gatewayAvailable = false,
            gatewayConnected = false,
            gatewayHasError = true,
            workerSessionCount = 2,
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.DORMANT, terrarium.crayfish)
        assertEquals(0, terrarium.workerCrayfishCount)
    }

    /**
     * Regression: when only Claude is processing on an OpenClaw aggregate
     * primary, the OpenClaw crayfish must NOT animate as ROUTING — it
     * should track its own sibling state. Previously the dashboard's
     * `agentState` was overwritten with Claude's PROCESSING (via the
     * keep-aggregate-identity path) and the crayfish branch read it as
     * the OpenClaw state.
     */
    @Test
    fun `claude processing does not bleed into OpenClaw crayfish on aggregate view`() {
        val terrarium = DashboardState(
            agentState = AgentState.IDLE,
            agentType = "openclaw",
            gatewayAvailable = true,
            gatewayConnected = true,
            siblingSessions = listOf(
                SessionInfo(id = "oc-1", port = 9120, agentType = "openclaw", alive = true, state = "idle"),
                SessionInfo(id = "cc-1", port = 9121, agentType = "claude-code", alive = true, state = "processing"),
            ),
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.SITTING, terrarium.crayfish)
        // Aggregate scene mood still reflects sibling activity.
        assertEquals(OctopusVisualState.WORKING, terrarium.octopus)
        assertEquals(EnvironmentVisualState.ACTIVE, terrarium.environment)
    }

    @Test
    fun `OpenClaw processing routes its own crayfish`() {
        val terrarium = DashboardState(
            agentState = AgentState.PROCESSING,
            agentType = "openclaw",
            gatewayAvailable = true,
            gatewayConnected = true,
            siblingSessions = listOf(
                SessionInfo(id = "oc-1", port = 9120, agentType = "openclaw", alive = true, state = "processing"),
            ),
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.ROUTING, terrarium.crayfish)
    }

    /**
     * Regression: on the daemon aggregate view (daemon's own state is
     * permanently DISCONNECTED), an idle OpenClaw sibling must keep the
     * crayfish at SITTING even when a Claude sibling is processing.
     */
    @Test
    fun `daemon aggregate keeps OpenClaw crayfish calm while claude works`() {
        val terrarium = DashboardState(
            agentState = AgentState.DISCONNECTED,
            agentType = "daemon",
            gatewayAvailable = true,
            gatewayConnected = true,
            siblingSessions = listOf(
                SessionInfo(id = "oc-1", port = 9120, agentType = "openclaw", alive = true, state = "idle"),
                SessionInfo(id = "cc-1", port = 9121, agentType = "claude-code", alive = true, state = "processing"),
            ),
        ).toTerrariumState()

        assertEquals(CrayfishVisualState.SITTING, terrarium.crayfish)
        assertEquals(EnvironmentVisualState.ACTIVE, terrarium.environment)
    }
}
