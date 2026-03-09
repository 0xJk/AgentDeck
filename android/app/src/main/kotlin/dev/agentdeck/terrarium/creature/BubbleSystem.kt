package dev.agentdeck.terrarium.creature

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.DrawScope
import dev.agentdeck.terrarium.EnvironmentVisualState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumTiming
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/**
 * Particle engine for bubbles rising from the bottom.
 * Ring buffer (max 50). Spawn rate depends on environment state.
 */
class BubbleSystem : Creature {

    private data class Bubble(
        var x: Float,
        var y: Float,
        var radius: Float,
        var speed: Float,
        var wobblePhase: Float,
        var wobbleAmp: Float,
        var alpha: Float,
        var alive: Boolean = true,
        // Pop burst fields
        var popping: Boolean = false,
        var popProgress: Float = 0f,
        var popOriginX: Float = 0f,
        var popOriginY: Float = 0f,
        var popAngle: Float = 0f,
        var popDistance: Float = 0f,
    )

    private val bubbles = Array(MAX_BUBBLES) {
        Bubble(0f, 0f, 0f, 0f, 0f, 0f, 0f, alive = false)
    }
    private var nextSlot = 0
    private var timeSinceSpawn = 0f
    private var envState by mutableStateOf(EnvironmentVisualState.CALM)
    private var time by mutableFloatStateOf(0f)

    fun setState(state: EnvironmentVisualState) {
        envState = state
    }

    override fun update(dt: Float) {
        time += dt
        timeSinceSpawn += dt * 1000f

        val spawnInterval = when (envState) {
            EnvironmentVisualState.DARK -> Float.MAX_VALUE // no bubbles
            EnvironmentVisualState.CALM -> TerrariumTiming.CALM_SPAWN_INTERVAL_MS
            EnvironmentVisualState.ACTIVE -> TerrariumTiming.ACTIVE_SPAWN_INTERVAL_MS
            EnvironmentVisualState.ALERT -> TerrariumTiming.ACTIVE_SPAWN_INTERVAL_MS * 1.5f
        }

        // Spawn new bubbles
        while (timeSinceSpawn >= spawnInterval) {
            timeSinceSpawn -= spawnInterval
            spawnBubble()
        }

        // Update existing bubbles
        for (bubble in bubbles) {
            if (!bubble.alive) continue

            if (bubble.popping) {
                // Pop burst: expand outward from origin, then transition to normal rise
                bubble.popProgress += dt * POP_SPEED
                if (bubble.popProgress >= 1f) {
                    // Transition to normal rising bubble
                    bubble.popping = false
                    bubble.speed = TerrariumTiming.BUBBLE_RISE_SPEED * (0.5f + Random.nextFloat() * 0.4f)
                } else {
                    // Radial expansion with easing (fast start, slow end)
                    val ease = 1f - (1f - bubble.popProgress) * (1f - bubble.popProgress)
                    bubble.x = bubble.popOriginX + cos(bubble.popAngle) * bubble.popDistance * ease
                    bubble.y = bubble.popOriginY + sin(bubble.popAngle) * bubble.popDistance * ease
                    // Shrink during pop
                    bubble.radius = bubble.radius * (1f - bubble.popProgress * 0.3f).coerceAtLeast(0.001f)
                    bubble.alpha = (1f - bubble.popProgress * 0.4f).coerceAtLeast(0.3f)
                }
                continue
            }

            bubble.y -= bubble.speed * dt
            bubble.x += sin(time * TerrariumTiming.BUBBLE_WOBBLE_SPEED + bubble.wobblePhase) *
                bubble.wobbleAmp * dt

            // Fade out near top
            if (bubble.y < 0.1f) {
                bubble.alpha = (bubble.y / 0.1f).coerceIn(0f, 1f)
            }

            // Kill if off screen
            if (bubble.y < -0.02f) {
                bubble.alive = false
            }
        }
    }

    override fun draw(scope: DrawScope) {
        val w = scope.size.width
        val h = scope.size.height

        for (bubble in bubbles) {
            if (!bubble.alive) continue

            val screenX = bubble.x * w
            val screenY = bubble.y * h
            val screenRadius = bubble.radius * w

            // Bubble body
            scope.drawCircle(
                color = TerrariumColors.BubbleWhite.copy(alpha = bubble.alpha * 0.3f),
                radius = screenRadius,
                center = Offset(screenX, screenY),
            )

            // Bubble highlight (upper-left)
            scope.drawCircle(
                color = TerrariumColors.BubbleHighlight.copy(alpha = bubble.alpha * 0.5f),
                radius = screenRadius * 0.3f,
                center = Offset(
                    screenX - screenRadius * 0.25f,
                    screenY - screenRadius * 0.25f,
                ),
            )
        }
    }

    private fun spawnBubble() {
        val bubble = bubbles[nextSlot]
        nextSlot = (nextSlot + 1) % MAX_BUBBLES

        val isError = envState == EnvironmentVisualState.ALERT

        bubble.x = Random.nextFloat() * 0.8f + 0.1f // 10%-90% width
        bubble.y = 0.95f + Random.nextFloat() * 0.05f // bottom
        bubble.radius = if (isError) {
            Random.nextFloat() * 0.008f + 0.005f
        } else {
            Random.nextFloat() * 0.005f + 0.002f
        }
        bubble.speed = TerrariumTiming.BUBBLE_RISE_SPEED * (0.7f + Random.nextFloat() * 0.6f)
        bubble.wobblePhase = Random.nextFloat() * 2f * PI.toFloat()
        bubble.wobbleAmp = Random.nextFloat() * 0.02f + 0.005f
        bubble.alpha = 1f
        bubble.alive = true
    }

    /**
     * Emit small bubbles from a creature's position.
     * Creature bubbles are 50% smaller and 70% speed of normal bubbles.
     */
    fun emitCreatureBubbles(nx: Float, ny: Float, count: Int) {
        repeat(count) {
            val bubble = bubbles[nextSlot]
            nextSlot = (nextSlot + 1) % MAX_BUBBLES

            bubble.x = nx + (Random.nextFloat() - 0.5f) * 0.02f
            bubble.y = ny - 0.01f // just above creature
            bubble.radius = (Random.nextFloat() * 0.003f + 0.001f) // 50% of normal
            bubble.speed = TerrariumTiming.BUBBLE_RISE_SPEED * (0.7f + Random.nextFloat() * 0.6f) * 0.7f
            bubble.wobblePhase = Random.nextFloat() * 2f * PI.toFloat()
            bubble.wobbleAmp = Random.nextFloat() * 0.015f + 0.003f
            bubble.alpha = 0.8f
            bubble.alive = true
        }
    }

    /**
     * Emit a radial burst of small bubbles — triggered when leaving ASKING state.
     * Bubbles expand outward then transition to normal upward drift.
     */
    fun emitPopBurst(nx: Float, ny: Float, count: Int = 10) {
        val angleStep = 2f * PI.toFloat() / count
        repeat(count) { i ->
            val bubble = bubbles[nextSlot]
            nextSlot = (nextSlot + 1) % MAX_BUBBLES

            val angle = angleStep * i + Random.nextFloat() * angleStep * 0.5f
            bubble.x = nx
            bubble.y = ny
            bubble.radius = Random.nextFloat() * 0.004f + 0.002f
            bubble.speed = 0f // movement handled by pop physics
            bubble.wobblePhase = Random.nextFloat() * 2f * PI.toFloat()
            bubble.wobbleAmp = Random.nextFloat() * 0.01f + 0.003f
            bubble.alpha = 0.9f
            bubble.alive = true
            bubble.popping = true
            bubble.popProgress = 0f
            bubble.popOriginX = nx
            bubble.popOriginY = ny
            bubble.popAngle = angle
            bubble.popDistance = 0.03f + Random.nextFloat() * 0.04f
        }
    }

    companion object {
        private const val MAX_BUBBLES = 70
        /** Pop expansion speed — 1/duration in seconds (~400ms). */
        private const val POP_SPEED = 2.5f
    }
}
