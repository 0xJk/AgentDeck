package dev.agentdeck.terrarium.environment

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import dev.agentdeck.terrarium.EnvironmentVisualState
import dev.agentdeck.terrarium.creature.Creature
import kotlin.math.PI
import kotlin.math.sin
import kotlin.random.Random

/**
 * God rays — 5 shafts of light descending from the water surface.
 * Each ray is a trapezoid (narrow at top, wide at bottom) with a vertical
 * gradient fade. Extremely subtle (alpha 0.04-0.06) for underwater ambiance.
 */
class LightRaySystem : Creature {

    private data class LightRay(
        var x: Float = 0f,         // center X position (0..1 fraction)
        var topWidth: Float = 0f,  // width at surface (fraction)
        var bottomWidth: Float = 0f, // width at bottom (fraction)
        var length: Float = 0f,    // how far down it reaches (fraction of canvas)
        var alpha: Float = 0f,     // current opacity
        var maxAlpha: Float = 0f,  // target peak opacity
        var phase: Float = 0f,     // lifecycle phase
        var lifetime: Float = 0f,  // total lifetime (seconds)
        var age: Float = 0f,       // current age (seconds)
        var driftSpeed: Float = 0f, // horizontal drift speed
        var widthPhase: Float = 0f, // width pulsation phase offset
    )

    private var time by mutableFloatStateOf(0f)
    private var envState by mutableStateOf(EnvironmentVisualState.CALM)

    private val rays = Array(MAX_RAYS) { createRay() }
    // Pre-allocated Path objects
    private val rayPaths = Array(MAX_RAYS) { Path() }

    fun setState(state: EnvironmentVisualState) {
        envState = state
    }

    override fun update(dt: Float) {
        time += dt

        val activeCount = when (envState) {
            EnvironmentVisualState.DARK -> 0
            EnvironmentVisualState.CALM -> 3
            EnvironmentVisualState.ACTIVE -> 5
            EnvironmentVisualState.ALERT -> 4
        }

        for (i in rays.indices) {
            val ray = rays[i]
            ray.age += dt

            if (i >= activeCount) {
                // Fade out inactive rays
                ray.alpha = (ray.alpha - dt * 0.3f).coerceAtLeast(0f)
                continue
            }

            // Horizontal drift
            ray.x += ray.driftSpeed * dt

            // Width pulsation (10% variation)
            val widthPulse = 1f + sin(time + ray.widthPhase) * 0.1f

            // Lifecycle: 4s fade-in, hold, 4s fade-out, respawn
            val fadeInEnd = FADE_DURATION
            val fadeOutStart = ray.lifetime - FADE_DURATION
            ray.alpha = when {
                ray.age < fadeInEnd -> ray.maxAlpha * (ray.age / fadeInEnd)
                ray.age > fadeOutStart -> ray.maxAlpha * ((ray.lifetime - ray.age) / FADE_DURATION).coerceAtLeast(0f)
                else -> ray.maxAlpha
            } * widthPulse

            // Respawn when lifetime ends
            if (ray.age >= ray.lifetime) {
                resetRay(ray)
            }
        }
    }

    override fun draw(scope: DrawScope) {
        val w = scope.size.width
        val h = scope.size.height

        if (envState == EnvironmentVisualState.DARK) return

        val isAlert = envState == EnvironmentVisualState.ALERT

        for (i in rays.indices) {
            val ray = rays[i]
            if (ray.alpha < 0.001f) continue

            val cx = ray.x * w
            val topHalf = ray.topWidth * w * 0.5f
            val botHalf = ray.bottomWidth * w * 0.5f
            val botY = ray.length * h

            val path = rayPaths[i]
            path.reset()
            path.moveTo(cx - topHalf, 0f)
            path.lineTo(cx + topHalf, 0f)
            path.lineTo(cx + botHalf, botY)
            path.lineTo(cx - botHalf, botY)
            path.close()

            scope.drawPath(
                path = path,
                brush = Brush.verticalGradient(
                    colors = listOf(
                        cachedTintColor(isAlert, ray.alpha),
                        Color.Transparent,
                    ),
                    startY = 0f,
                    endY = botY,
                ),
                blendMode = BlendMode.Screen,
            )
        }
    }

    private fun createRay(): LightRay {
        return LightRay().also { resetRay(it) }
    }

    private fun resetRay(ray: LightRay) {
        val peakAlpha = when (envState) {
            EnvironmentVisualState.DARK -> 0f
            EnvironmentVisualState.CALM -> 0.04f
            EnvironmentVisualState.ACTIVE -> 0.06f
            EnvironmentVisualState.ALERT -> 0.05f
        }
        ray.x = Random.nextFloat() * 0.8f + 0.1f
        ray.topWidth = Random.nextFloat() * 0.02f + 0.02f
        ray.bottomWidth = ray.topWidth * (2.5f + Random.nextFloat() * 1.5f)
        ray.length = Random.nextFloat() * 0.30f + 0.40f // 40-70% of canvas
        ray.maxAlpha = peakAlpha
        ray.alpha = 0f
        ray.lifetime = Random.nextFloat() * 4f + FADE_DURATION * 2f + 6f // 14-18s total
        ray.age = 0f
        ray.driftSpeed = (Random.nextFloat() - 0.5f) * 0.004f // ±0.002 canvas/sec
        ray.widthPhase = Random.nextFloat() * 2f * PI.toFloat()
    }

    companion object {
        private const val MAX_RAYS = 5
        private const val FADE_DURATION = 4f // seconds
        private val AMBER_TINT = Color(0xFFFBBF24)

        // Pre-computed alpha-bucketed colors for gradient — avoids per-frame Color.copy() allocations
        private const val ALPHA_BUCKETS = 20
        private val WHITE_ALPHA_CACHE = Array(ALPHA_BUCKETS + 1) { i ->
            Color.White.copy(alpha = i.toFloat() / ALPHA_BUCKETS)
        }
        private val AMBER_ALPHA_CACHE = Array(ALPHA_BUCKETS + 1) { i ->
            AMBER_TINT.copy(alpha = i.toFloat() / ALPHA_BUCKETS)
        }

        fun cachedTintColor(isAlert: Boolean, alpha: Float): Color {
            val cache = if (isAlert) AMBER_ALPHA_CACHE else WHITE_ALPHA_CACHE
            val idx = (alpha * ALPHA_BUCKETS).toInt().coerceIn(0, ALPHA_BUCKETS)
            return cache[idx]
        }
    }
}
