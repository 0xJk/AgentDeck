package dev.agentdeck.terrarium.environment

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import dev.agentdeck.terrarium.EnvironmentVisualState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumTiming
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * Caustics light pattern — overlapping sine meshes drawn with overlay blend.
 * Intensity varies with environment state.
 */
class WaterEffect {

    private var envState by mutableStateOf(EnvironmentVisualState.CALM)
    private var time by mutableFloatStateOf(0f)
    // Pre-allocated Path objects for caustic lines — 2 families × LINE_COUNT each
    private val causticPaths = Array(LINE_COUNT * 2) { Path() }
    fun setState(state: EnvironmentVisualState) {
        envState = state
    }

    fun update(dt: Float) {
        time += dt * TerrariumTiming.CAUSTICS_SPEED
    }

    fun draw(scope: DrawScope) {
        if (envState == EnvironmentVisualState.DARK) return

        val w = scope.size.width
        val h = scope.size.height

        val alpha = when (envState) {
            EnvironmentVisualState.DARK -> 0f
            EnvironmentVisualState.CALM -> 0.08f
            EnvironmentVisualState.ACTIVE -> 0.12f
            EnvironmentVisualState.ALERT -> 0.10f
        }

        // Draw two overlapping caustic layers with different phases
        drawCausticLayer(scope, w, h, alpha, phase = 0f, familyOffset = 0)
        drawCausticLayer(scope, w, h, alpha * 0.6f, phase = PI.toFloat() * 0.7f, familyOffset = LINE_COUNT)
    }

    /**
     * Crossing wave-line mesh — two families of undulating lines at different angles.
     * Their intersections create organic, irregularly-shaped caustic cells,
     * mimicking real underwater light refraction patterns.
     */
    private fun drawCausticLayer(
        scope: DrawScope, w: Float, h: Float, alpha: Float, phase: Float,
        familyOffset: Int,
    ) {
        val twoPi = 2f * PI.toFloat()
        val spacing = w / LINE_COUNT
        val waveLen1 = w * 0.4f
        val waveLen2 = w * 0.32f
        val amp = spacing * 0.35f
        val strokeW = w * 0.008f
        val color = TerrariumColors.CausticsLight.copy(alpha = alpha)
        val stroke = Stroke(width = strokeW, cap = StrokeCap.Round)

        val freq1 = twoPi / waveLen1
        val freq2 = twoPi / waveLen2
        val step = 4f

        // Family 1: near-horizontal lines (~10° tilt), slow undulation
        val angle1 = 10f * PI.toFloat() / 180f
        val sin1 = sin(angle1)
        val cos1 = cos(angle1)
        val extent = w * 0.15f  // overdraw beyond edges to avoid gaps from sine displacement

        for (i in 0 until LINE_COUNT) {
            val lineOffset = (i - LINE_COUNT / 2) * spacing
            val linePhase = phase + i * 0.7f
            val path = causticPaths[familyOffset + i].also { it.reset() }
            var t = -extent
            var first = true
            while (t <= w + extent) {
                val wave = sin(freq1 * t + time + linePhase) * amp
                val x = t * cos1 - (lineOffset + wave) * sin1
                val y = t * sin1 + (lineOffset + wave) * cos1 + h * 0.5f
                if (first) { path.moveTo(x, y); first = false } else path.lineTo(x, y)
                t += step
            }
            scope.drawPath(path, color, blendMode = BlendMode.Overlay, style = stroke)
        }

        // Family 2: ~60° angled lines, slightly different frequency
        val angle2 = 60f * PI.toFloat() / 180f
        val sin2 = sin(angle2)
        val cos2 = cos(angle2)
        val diag = w + h  // longer span needed for steep angle

        for (i in 0 until LINE_COUNT) {
            val lineOffset = (i - LINE_COUNT / 2) * spacing * 1.2f
            val linePhase = phase + i * 0.9f + 2.0f
            val path = causticPaths[familyOffset + i].also { it.reset() }
            var t = -extent
            var first = true
            while (t <= diag + extent) {
                val wave = sin(freq2 * t + time * 0.85f + linePhase) * amp
                val x = t * cos2 - (lineOffset + wave) * sin2
                val y = t * sin2 + (lineOffset + wave) * cos2
                if (first) { path.moveTo(x, y); first = false } else path.lineTo(x, y)
                t += step
            }
            scope.drawPath(path, color, blendMode = BlendMode.Overlay, style = stroke)
        }
    }

    companion object {
        private const val LINE_COUNT = 12
    }
}
