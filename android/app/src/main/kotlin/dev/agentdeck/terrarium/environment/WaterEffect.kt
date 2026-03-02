package dev.agentdeck.terrarium.environment

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import dev.agentdeck.terrarium.EnvironmentVisualState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumLayout
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
    private var surfaceTime by mutableFloatStateOf(0f)

    fun setState(state: EnvironmentVisualState) {
        envState = state
    }

    fun update(dt: Float) {
        time += dt * TerrariumTiming.CAUSTICS_SPEED
        val speedMul = when (envState) {
            EnvironmentVisualState.DARK -> 0.3f
            EnvironmentVisualState.CALM -> 1.0f
            EnvironmentVisualState.ACTIVE -> 1.6f
            EnvironmentVisualState.ALERT -> 1.1f
        }
        surfaceTime += dt * TerrariumTiming.SURFACE_WAVE_SPEED * speedMul
    }

    /**
     * Draw animated water surface — filled wave regions create air/water contrast.
     *
     * Instead of thin stroke lines (invisible), we fill the area ABOVE the wave curve
     * with a lighter tint. The surface is perceived as the boundary between two regions,
     * not as a drawn line.
     */
    fun drawSurface(scope: DrawScope) {
        val w = scope.size.width
        val h = scope.size.height
        val surfaceY = h * TerrariumLayout.WATER_SURFACE_Y_FRACTION

        // Amplitude relative to canvas — visible at any resolution
        val amp = h * when (envState) {
            EnvironmentVisualState.DARK -> 0.003f
            EnvironmentVisualState.CALM -> 0.008f
            EnvironmentVisualState.ACTIVE -> 0.014f
            EnvironmentVisualState.ALERT -> 0.009f
        }
        val fillAlpha = when (envState) {
            EnvironmentVisualState.DARK -> 0.03f
            EnvironmentVisualState.CALM -> 0.08f
            EnvironmentVisualState.ACTIVE -> 0.12f
            EnvironmentVisualState.ALERT -> 0.09f
        }

        val twoPi = 2f * PI.toFloat()

        // (1) Primary wave — filled from curve up to top of canvas
        //     Creates the main air/water tonal boundary
        drawFilledWave(scope, w, surfaceY, amp,
            freq = twoPi / (w * 0.6f),
            phase = surfaceTime * twoPi,
            fillAlpha = fillAlpha)

        // (2) Secondary wave — shorter wavelength, smaller amplitude, opposite direction
        //     Overlaps with primary to create natural interference shimmer
        drawFilledWave(scope, w, surfaceY, amp * 0.4f,
            freq = twoPi / (w * 0.35f),
            phase = -surfaceTime * twoPi * 1.4f + 1.5f,
            fillAlpha = fillAlpha * 0.5f)

        // (3) Sub-surface glow — bright gradient just below the wave line
        //     Simulates light refraction at water surface
        val glowDepth = h * 0.025f
        scope.drawRect(
            brush = Brush.verticalGradient(
                colors = listOf(
                    Color.White.copy(alpha = fillAlpha * 0.7f),
                    Color.Transparent,
                ),
                startY = surfaceY,
                endY = surfaceY + glowDepth,
            ),
            topLeft = Offset(0f, surfaceY),
            size = Size(w, glowDepth),
        )
    }

    /**
     * Fill the region from a sine wave curve up to y=0 (top of canvas).
     * The filled area represents "air" — slightly brighter than water below.
     */
    private fun drawFilledWave(
        scope: DrawScope, w: Float, baseY: Float, amplitude: Float,
        freq: Float, phase: Float, fillAlpha: Float,
    ) {
        val path = Path().apply {
            // Start at top-left corner
            moveTo(0f, 0f)

            // Walk the wave curve left to right
            val step = 3f
            var x = 0f
            while (x <= w) {
                val y = baseY + sin(freq * x + phase) * amplitude
                lineTo(x, y)
                x += step
            }
            // Ensure we reach the right edge
            lineTo(w, baseY + sin(freq * w + phase) * amplitude)

            // Close back to top-right → top-left
            lineTo(w, 0f)
            close()
        }
        scope.drawPath(
            path = path,
            color = Color.White.copy(alpha = fillAlpha),
        )
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
        drawCausticLayer(scope, w, h, alpha, phase = 0f)
        drawCausticLayer(scope, w, h, alpha * 0.6f, phase = PI.toFloat() * 0.7f)
    }

    /**
     * Crossing wave-line mesh — two families of undulating lines at different angles.
     * Their intersections create organic, irregularly-shaped caustic cells,
     * mimicking real underwater light refraction patterns.
     */
    private fun drawCausticLayer(
        scope: DrawScope, w: Float, h: Float, alpha: Float, phase: Float,
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
            val path = Path()
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
            val path = Path()
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
