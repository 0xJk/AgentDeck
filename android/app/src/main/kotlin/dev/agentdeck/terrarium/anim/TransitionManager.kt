package dev.agentdeck.terrarium.anim

import androidx.compose.ui.graphics.Color
import dev.agentdeck.terrarium.EnvironmentVisualState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumTiming

/**
 * Manages global scene transitions between terrarium states.
 * - Color mode: smooth color interpolation (500ms ease-in-out)
 * - E-ink mode: page-turn wipe (300ms left→right black bar)
 */
class TransitionManager {

    private var transitionProgress = 1f
    private var previousEnv = EnvironmentVisualState.CALM
    private var currentEnv = EnvironmentVisualState.CALM

    /** Whether a scene transition is in progress. */
    val isTransitioning: Boolean get() = transitionProgress < 1f

    /** Wipe progress for e-ink mode (0..1). */
    val wipeProgress: Float get() = if (transitionProgress < 1f) {
        easeInOut(transitionProgress)
    } else 1f

    /** Trigger a new environment transition. */
    fun transitionTo(newEnv: EnvironmentVisualState) {
        if (newEnv == currentEnv) return
        previousEnv = currentEnv
        currentEnv = newEnv
        transitionProgress = 0f
    }

    /** Advance the transition by [dt] seconds. */
    fun update(dt: Float) {
        if (transitionProgress < 1f) {
            val speed = 1000f / TerrariumTiming.STATE_TRANSITION_MS
            transitionProgress = (transitionProgress + dt * speed).coerceAtMost(1f)
        }
    }

    /** Get interpolated background top color for color mode. */
    fun interpolatedTopColor(): Color {
        if (!isTransitioning) return envTopColor(currentEnv)
        val t = easeInOut(transitionProgress)
        return lerpColor(envTopColor(previousEnv), envTopColor(currentEnv), t)
    }

    /** Get interpolated caustics alpha. */
    fun interpolatedCausticsAlpha(): Float {
        if (!isTransitioning) return envCausticsAlpha(currentEnv)
        val t = easeInOut(transitionProgress)
        return envCausticsAlpha(previousEnv) + (envCausticsAlpha(currentEnv) - envCausticsAlpha(previousEnv)) * t
    }

    private fun envTopColor(env: EnvironmentVisualState): Color = when (env) {
        EnvironmentVisualState.DARK -> ENV_DARK_TOP
        EnvironmentVisualState.CALM -> TerrariumColors.ShallowWater
        EnvironmentVisualState.ACTIVE -> ENV_ACTIVE_TOP
        EnvironmentVisualState.ALERT -> ENV_ALERT_TOP
    }

    companion object {
        // Pre-computed colors — avoids per-transition Color.copy() allocations
        private val ENV_DARK_TOP = TerrariumColors.DeepSea.copy(alpha = 0.5f)
        private val ENV_ACTIVE_TOP = TerrariumColors.ShallowWater.copy(alpha = 0.9f)
        private val ENV_ALERT_TOP = Color(0xFF1A3D5C)
    }

    private fun envCausticsAlpha(env: EnvironmentVisualState): Float = when (env) {
        EnvironmentVisualState.DARK -> 0f
        EnvironmentVisualState.CALM -> 0.08f
        EnvironmentVisualState.ACTIVE -> 0.12f
        EnvironmentVisualState.ALERT -> 0.10f
    }

    private fun easeInOut(t: Float): Float {
        return if (t < 0.5f) {
            2f * t * t
        } else {
            1f - (-2f * t + 2f).let { it * it } / 2f
        }
    }

    private fun lerpColor(a: Color, b: Color, t: Float): Color {
        return Color(
            red = a.red + (b.red - a.red) * t,
            green = a.green + (b.green - a.green) * t,
            blue = a.blue + (b.blue - a.blue) * t,
            alpha = a.alpha + (b.alpha - a.alpha) * t,
        )
    }
}
