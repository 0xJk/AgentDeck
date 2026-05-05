package dev.agentdeck.terrarium.renderer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.hypot

class EinkAnimationTimingTest {

    @Test
    fun `color e-ink animation uses video-like cadence`() {
        assertEquals(400L, einkAnimationFrameIntervalMs(colorEink = false))
        assertEquals(100L, einkAnimationFrameIntervalMs(colorEink = true))
    }

    @Test
    fun `animation frame advance is elapsed-time based and bounded`() {
        assertEquals(0.25f, einkAnimationFrameAdvance(100L), 0.001f)
        assertEquals(1.0f, einkAnimationFrameAdvance(400L), 0.001f)
        assertEquals(1.5f, einkAnimationFrameAdvance(5_000L), 0.001f)
    }

    @Test
    fun `fish simulation scales movement for partial color frames`() {
        val fullStepSchool = EinkFishSchool()
        val partialStepSchool = EinkFishSchool()
        val initial = fullStepSchool.fish.map { it.x to it.y }

        fullStepSchool.update(
            streaming = false,
            agentSlots = emptyList(),
            crayfishRouting = false,
            stepScale = 1f,
        )
        partialStepSchool.update(
            streaming = false,
            agentSlots = emptyList(),
            crayfishRouting = false,
            stepScale = 0.25f,
        )

        val fullDistance = totalDistance(initial, fullStepSchool)
        val partialDistance = totalDistance(initial, partialStepSchool)

        assertTrue(fullDistance > 0f)
        assertTrue("partial frames should interpolate instead of sprinting", partialDistance < fullDistance * 0.5f)
    }

    private fun totalDistance(initial: List<Pair<Float, Float>>, school: EinkFishSchool): Float =
        school.fish.zip(initial).sumOf { (fish, start) ->
            hypot((fish.x - start.first).toDouble(), (fish.y - start.second).toDouble())
        }.toFloat()
}
