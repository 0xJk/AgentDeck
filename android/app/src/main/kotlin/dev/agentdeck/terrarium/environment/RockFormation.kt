package dev.agentdeck.terrarium.environment

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import dev.agentdeck.terrarium.EnvironmentVisualState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumLayout
import dev.agentdeck.terrarium.TerrariumTiming
import kotlin.math.sin

/**
 * Bottom terrain — sand gradient + rocky formations + LED cables.
 */
class RockFormation {

    private var envState by mutableStateOf(EnvironmentVisualState.CALM)
    private var time by mutableFloatStateOf(0f)
    // Pre-allocated ripple paths (12 sine-wave ripples)
    private val ripplePaths = Array(12) { Path() }
    // Pre-allocated rock paths (6 rocks)
    private val rockPaths = Array(6) { Path() }
    private var rockPathIdx = 0

    fun setState(state: EnvironmentVisualState) {
        envState = state
    }

    fun update(dt: Float) {
        time += dt
    }

    fun draw(scope: DrawScope) {
        val w = scope.size.width
        val h = scope.size.height

        drawSand(scope, w, h)
        drawRocks(scope, w, h)
    }

    /** Draw LED cables on top of rocks (called separately for correct layering). */
    fun drawLEDs(scope: DrawScope, env: EnvironmentVisualState) {
        val w = scope.size.width
        val h = scope.size.height
        drawLEDCables(scope, w, h, env)
    }

    private fun drawSand(scope: DrawScope, w: Float, h: Float) {
        val sandTop = h * (1f - TerrariumLayout.SAND_HEIGHT_FRACTION)

        scope.drawRect(
            brush = Brush.verticalGradient(
                colors = listOf(TerrariumColors.SandLight, TerrariumColors.SandBase),
                startY = sandTop,
                endY = h,
            ),
            topLeft = Offset(0f, sandTop),
            size = Size(w, h - sandTop),
        )

        // 12 sine-wave sand ripples (deterministic, pre-calculated positions)
        for (i in 0 until 12) {
            val startX = w * RIPPLE_START_X[i]
            val endX = startX + w * RIPPLE_LENGTHS[i]
            val y = sandTop + (h - sandTop) * RIPPLE_Y_OFFSETS[i]

            val path = ripplePaths[i]
            path.reset()
            val steps = 20
            for (s in 0..steps) {
                val x = startX + (endX - startX) * s / steps
                val waveY = y + sin(x * 0.02f + i * 0.7f) * 2f
                if (s == 0) path.moveTo(x, waveY) else path.lineTo(x, waveY)
            }

            scope.drawPath(
                path = path,
                color = TerrariumColors.SandBase.copy(alpha = 0.25f),
                style = Stroke(width = 0.8f, cap = StrokeCap.Round),
            )
        }

        // 10 pebbles (small ovals scattered on sand)
        for (i in 0 until PEBBLE_COUNT) {
            val px = w * PEBBLE_X[i]
            val py = sandTop + (h - sandTop) * PEBBLE_Y[i]
            val pw = w * PEBBLE_W[i]
            val ph = pw * 0.6f

            scope.drawOval(
                color = PEBBLE_COLORS[i % 2].copy(alpha = 0.40f),
                topLeft = Offset(px - pw * 0.5f, py - ph * 0.5f),
                size = Size(pw, ph),
            )
        }
    }

    private fun drawRocks(scope: DrawScope, w: Float, h: Float) {
        val bottomY = h * (1f - TerrariumLayout.SAND_HEIGHT_FRACTION)
        rockPathIdx = 0

        // Large rock cluster (right side, where crayfish sits)
        drawRock(scope, w * 0.7f, bottomY, w * 0.15f, w * 0.08f, TerrariumColors.RockMid)
        drawRock(scope, w * 0.8f, bottomY - w * 0.02f, w * 0.12f, w * 0.10f, TerrariumColors.RockDark)
        drawRock(scope, w * 0.75f, bottomY - w * 0.01f, w * 0.08f, w * 0.06f, TerrariumColors.RockLight)

        // Small rocks (left side)
        drawRock(scope, w * 0.05f, bottomY, w * 0.08f, w * 0.05f, TerrariumColors.RockDark)
        drawRock(scope, w * 0.12f, bottomY + w * 0.01f, w * 0.06f, w * 0.04f, TerrariumColors.RockMid)

        // Center small rock
        drawRock(scope, w * 0.45f, bottomY + w * 0.01f, w * 0.05f, w * 0.03f, TerrariumColors.RockLight)
    }

    private fun drawRock(scope: DrawScope, cx: Float, baseY: Float, rw: Float, rh: Float, color: Color) {
        val path = rockPaths[rockPathIdx++].also { it.reset() }
        path.moveTo(cx - rw * 0.5f, baseY)
        path.cubicTo(
            cx - rw * 0.4f, baseY - rh * 0.8f,
            cx + rw * 0.4f, baseY - rh * 1.1f,
            cx + rw * 0.5f, baseY,
        )
        path.close()
        scope.drawPath(path = path, color = color)

        // Highlight edge
        scope.drawPath(
            path = path,
            color = Color.White,
            alpha = 0.05f,
            style = Stroke(width = 1f),
        )
    }

    private fun drawLEDCables(scope: DrawScope, w: Float, h: Float, env: EnvironmentVisualState) {
        val bottomY = h * (1f - TerrariumLayout.SAND_HEIGHT_FRACTION)

        val ledColor = when (env) {
            EnvironmentVisualState.DARK -> TerrariumColors.LEDRed.copy(alpha = 0.15f)
            EnvironmentVisualState.CALM -> TerrariumColors.LEDGreen
            EnvironmentVisualState.ACTIVE -> TerrariumColors.LEDAmber
            EnvironmentVisualState.ALERT -> TerrariumColors.LEDRed
        }

        // Pulse effect
        val pulse = sin(time * TerrariumTiming.LED_PULSE_SPEED) * 0.3f + 0.7f
        val effectiveColor = ledColor.copy(alpha = ledColor.alpha * pulse)

        // Cable from left rocks to right rocks
        val cablePath = Path().apply {
            moveTo(w * 0.1f, bottomY - w * 0.02f)
            quadraticBezierTo(w * 0.3f, bottomY + w * 0.02f, w * 0.5f, bottomY - w * 0.01f)
            quadraticBezierTo(w * 0.65f, bottomY + w * 0.01f, w * 0.75f, bottomY - w * 0.04f)
        }

        scope.drawPath(
            path = cablePath,
            color = effectiveColor.copy(alpha = effectiveColor.alpha * 0.4f),
            style = Stroke(
                width = 2f,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 4f)),
                cap = StrokeCap.Round,
            ),
        )

        // LED dots along cable
        val dotCount = 8
        for (i in 0 until dotCount) {
            val t = i.toFloat() / (dotCount - 1)
            val dotX = w * (0.1f + t * 0.65f)
            val dotY = bottomY - w * 0.01f +
                sin(t * PI.toFloat() * 2f) * w * 0.015f

            val dotPulse = sin(time * TerrariumTiming.LED_PULSE_SPEED + i * 0.5f) * 0.4f + 0.6f
            scope.drawCircle(
                color = effectiveColor.copy(alpha = dotPulse * 0.8f),
                radius = w * 0.003f,
                center = Offset(dotX, dotY),
            )
        }
    }

    companion object {
        private val PI = kotlin.math.PI

        // Pre-calculated ripple positions (12 ripples)
        private val RIPPLE_START_X = floatArrayOf(
            0.03f, 0.15f, 0.28f, 0.42f, 0.55f, 0.68f,
            0.08f, 0.22f, 0.35f, 0.50f, 0.62f, 0.78f,
        )
        private val RIPPLE_LENGTHS = floatArrayOf(
            0.15f, 0.12f, 0.18f, 0.10f, 0.14f, 0.12f,
            0.13f, 0.16f, 0.11f, 0.14f, 0.10f, 0.15f,
        )
        private val RIPPLE_Y_OFFSETS = floatArrayOf(
            0.15f, 0.25f, 0.35f, 0.20f, 0.40f, 0.30f,
            0.50f, 0.45f, 0.55f, 0.60f, 0.70f, 0.65f,
        )

        // Pre-calculated pebble positions (10 pebbles)
        private const val PEBBLE_COUNT = 10
        private val PEBBLE_X = floatArrayOf(
            0.10f, 0.22f, 0.35f, 0.48f, 0.58f,
            0.30f, 0.42f, 0.65f, 0.18f, 0.52f,
        )
        private val PEBBLE_Y = floatArrayOf(
            0.25f, 0.40f, 0.55f, 0.30f, 0.50f,
            0.70f, 0.65f, 0.45f, 0.60f, 0.75f,
        )
        private val PEBBLE_W = floatArrayOf(
            0.004f, 0.003f, 0.005f, 0.003f, 0.004f,
            0.003f, 0.005f, 0.004f, 0.003f, 0.004f,
        )
        private val PEBBLE_COLORS = arrayOf(
            TerrariumColors.RockDark,
            TerrariumColors.RockMid,
        )
    }
}
