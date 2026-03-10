package dev.agentdeck.terrarium.environment

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import dev.agentdeck.terrarium.EnvironmentVisualState
import dev.agentdeck.terrarium.creature.Creature
import kotlin.math.PI
import kotlin.math.sin
import kotlin.random.Random

/**
 * Floating plankton micro-particles drifting through the water.
 * 80 pre-allocated particles in a ring buffer, split into back/front layers.
 * Provides the most noticeable "living water" ambiance.
 */
class PlanktonSystem : Creature {

    private data class Particle(
        var x: Float = 0f,
        var y: Float = 0f,
        var size: Float = 0f,
        var alpha: Float = 0f,
        var baseAlpha: Float = 0f,
        var driftAngle: Float = 0f,
        var speed: Float = 0f,
        var flickerPhase: Float = 0f,
        var phase: Float = 0f,
        var zLayer: Int = 0, // 0=back, 1=front
    )

    private val particles = Array(MAX_PARTICLES) { i ->
        Particle(
            x = Random.nextFloat(),
            y = Random.nextFloat() * 0.85f + 0.05f, // avoid top 5% and sand
            size = Random.nextFloat() * 0.002f + 0.001f,
            baseAlpha = Random.nextFloat() * 0.10f + 0.05f,
            alpha = Random.nextFloat() * 0.10f + 0.05f,
            driftAngle = Random.nextFloat() * 2f * PI.toFloat(),
            speed = Random.nextFloat() * 0.008f + 0.004f,
            flickerPhase = Random.nextFloat() * 2f * PI.toFloat(),
            phase = Random.nextFloat() * 2f * PI.toFloat(),
            zLayer = if (i < MAX_PARTICLES / 2) 0 else 1,
        )
    }

    private var time by mutableFloatStateOf(0f)
    private var envState by mutableStateOf(EnvironmentVisualState.CALM)

    fun setState(state: EnvironmentVisualState) {
        envState = state
    }

    override fun update(dt: Float) {
        time += dt

        val speedMultiplier = when (envState) {
            EnvironmentVisualState.DARK -> 0.3f
            EnvironmentVisualState.CALM -> 0.6f
            EnvironmentVisualState.ACTIVE -> 1.0f
            EnvironmentVisualState.ALERT -> 0.8f
        }

        val alphaMultiplier = when (envState) {
            EnvironmentVisualState.DARK -> 0.3f
            EnvironmentVisualState.CALM -> 0.6f
            EnvironmentVisualState.ACTIVE -> 1.0f
            EnvironmentVisualState.ALERT -> 0.8f
        }

        for (p in particles) {
            // Slow irregular drift
            p.driftAngle += sin(time * 0.3f + p.phase) * 0.5f * dt
            p.x += kotlin.math.cos(p.driftAngle) * p.speed * speedMultiplier * dt
            p.y += sin(p.driftAngle) * p.speed * speedMultiplier * dt * 0.7f // slower vertical

            // Flicker
            val flicker = sin(time * 1.5f + p.flickerPhase) * 0.03f
            p.alpha = (p.baseAlpha * alphaMultiplier + flicker).coerceIn(0.02f, 0.18f)

            // Wrap at boundaries
            if (p.x < -0.02f) p.x = 1.02f
            if (p.x > 1.02f) p.x = -0.02f
            if (p.y < 0.03f) p.y = 0.72f
            if (p.y > 0.73f) p.y = 0.03f
        }
    }

    override fun draw(scope: DrawScope) {
        // Not used — use drawBackLayer / drawFrontLayer
    }

    /** Draw back-layer plankton (behind creatures, Layer 2.7). */
    fun drawBackLayer(scope: DrawScope) {
        drawLayer(scope, zLayer = 0)
    }

    /** Draw front-layer plankton (in front of creatures, Layer 9.7). */
    fun drawFrontLayer(scope: DrawScope) {
        drawLayer(scope, zLayer = 1)
    }

    private fun drawLayer(scope: DrawScope, zLayer: Int) {
        val w = scope.size.width
        val h = scope.size.height

        val tintColor = when (envState) {
            EnvironmentVisualState.ACTIVE -> CYAN_TINT
            else -> Color.White
        }

        for (p in particles) {
            if (p.zLayer != zLayer) continue

            scope.drawCircle(
                color = tintColor,
                alpha = p.alpha,
                radius = p.size * w,
                center = Offset(p.x * w, p.y * h),
            )
        }
    }

    companion object {
        private const val MAX_PARTICLES = 80
        private val CYAN_TINT = Color(0xFFB0E5FF)
    }
}
