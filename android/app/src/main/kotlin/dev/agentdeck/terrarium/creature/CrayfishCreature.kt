package dev.agentdeck.terrarium.creature

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import dev.agentdeck.terrarium.CrayfishVisualState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumLayout
import dev.agentdeck.terrarium.TerrariumTiming
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * OpenClaw — front-facing lobster SVG mascot.
 * Based on openclaw.svg (viewBox 0 0 120 120) with gradient body,
 * articulated claws (pivot rotation) and wiggling antennae.
 *
 * SITTING/DORMANT: completely still on the rocks (no floating).
 * ROUTING: full animation — claw rotation, signal waves, eye flash, antenna wiggle.
 */
class CrayfishCreature(
    private val centerXFraction: Float = TerrariumLayout.CRAYFISH_CENTER_X_FRACTION,
    private val centerYFraction: Float = TerrariumLayout.CRAYFISH_CENTER_Y_FRACTION,
    private val scaleFactor: Float = 1f,
) : Creature {

    private var visualState by mutableStateOf(CrayfishVisualState.SITTING)
    private var time by mutableFloatStateOf(0f)
    private var transitionProgress by mutableFloatStateOf(1f)

    // Lazy-init parsed SVG paths (parsed once at first use)
    private val bodyPath by lazy { parseSvgPath(BODY_PATH_DATA) }
    private val leftClawPath by lazy { parseSvgPath(LEFT_CLAW_PATH_DATA) }
    private val rightClawPath by lazy { parseSvgPath(RIGHT_CLAW_PATH_DATA) }
    private val leftAntennaPath by lazy { parseSvgPath(LEFT_ANTENNA_PATH_DATA) }
    private val rightAntennaPath by lazy { parseSvgPath(RIGHT_ANTENNA_PATH_DATA) }

    fun setState(newState: CrayfishVisualState) {
        if (newState != visualState) {
            Log.d("Terrarium", "Crayfish: $visualState -> $newState")
            visualState = newState
            transitionProgress = 0f
        }
    }

    override fun update(dt: Float) {
        time += dt
        if (transitionProgress < 1f) {
            transitionProgress = (transitionProgress + dt * 2f).coerceAtMost(1f)
        }
    }

    override fun draw(scope: DrawScope) {
        val w = scope.size.width
        val h = scope.size.height

        val cx = w * centerXFraction
        val cy = h * centerYFraction
        val bodyWidth = w * TerrariumLayout.CRAYFISH_WIDTH_FRACTION * scaleFactor

        val alpha = when (visualState) {
            CrayfishVisualState.DORMANT -> 0.4f
            else -> 1f
        }

        val effectiveCX: Float
        val effectiveCY: Float
        when (visualState) {
            CrayfishVisualState.DORMANT -> {
                effectiveCX = cx
                effectiveCY = cy + bodyWidth * 0.3f
            }
            CrayfishVisualState.ROUTING -> {
                effectiveCX = cx
                effectiveCY = cy + sin(time * 3f) * bodyWidth * 0.05f
            }
            CrayfishVisualState.SITTING -> {
                effectiveCX = cx
                effectiveCY = cy + sin(time * 0.5f) * bodyWidth * 0.008f
            }
            else -> {
                effectiveCX = cx
                effectiveCY = cy
            }
        }

        // ROUTING: draw signal waves BEHIND creature
        if (visualState == CrayfishVisualState.ROUTING) {
            drawSignalWaves(scope, effectiveCX, effectiveCY, bodyWidth, w)
        }

        // ROUTING: shell glow pulse underneath
        if (visualState == CrayfishVisualState.ROUTING) {
            val glowPulse = (sin(time * 4f) * 0.5f + 0.5f)
            val glowRadius = bodyWidth * (0.4f + glowPulse * 0.15f)
            scope.drawCircle(
                color = TerrariumColors.CrayfishEye.copy(alpha = 0.15f * glowPulse),
                radius = glowRadius,
                center = Offset(effectiveCX, effectiveCY),
            )
        }

        // Draw SVG-based creature
        drawSvgCreature(scope, effectiveCX, effectiveCY, bodyWidth, alpha)
    }

    private fun drawSvgCreature(
        scope: DrawScope,
        cx: Float, cy: Float,
        bodyWidth: Float,
        alpha: Float,
    ) {
        val scale = bodyWidth / SVG_VIEWBOX
        // SVG center is at (60, 60) — translate so it maps to (cx, cy)
        val offsetX = cx - SVG_VIEWBOX / 2f * scale
        val offsetY = cy - SVG_VIEWBOX / 2f * scale

        val brush = bodyBrush()

        scope.withTransform({
            translate(left = offsetX, top = offsetY)
            scale(scaleX = scale, scaleY = scale, pivot = Offset.Zero)
        }) {
            // 1. Body with gradient
            drawPath(bodyPath, brush = brush, alpha = alpha)

            // 2. Left claw with pivot rotation
            val leftAngle = clawAngleForState(side = -1f)
            withTransform({
                rotate(leftAngle, pivot = Offset(20f, 45f))
            }) {
                drawPath(leftClawPath, brush = brush, alpha = alpha)
            }

            // 3. Right claw with pivot rotation
            val rightAngle = clawAngleForState(side = 1f)
            withTransform({
                rotate(rightAngle, pivot = Offset(100f, 45f))
            }) {
                drawPath(rightClawPath, brush = brush, alpha = alpha)
            }

            // 4. Antennae with wiggle
            val antennaColor = shellColorForState().copy(alpha = alpha)
            val antennaStroke = Stroke(width = 3f, cap = StrokeCap.Round)

            val wiggleX = when (visualState) {
                CrayfishVisualState.ROUTING -> sin(time * 7f) * 4f
                CrayfishVisualState.SITTING -> sin(time * 0.8f) * 0.7f
                else -> 0f
            }
            val wiggleY = when (visualState) {
                CrayfishVisualState.ROUTING -> sin(time * 5f) * 3f
                CrayfishVisualState.SITTING -> sin(time * 0.5f) * 0.4f
                else -> 0f
            }

            withTransform({ translate(left = wiggleX, top = -wiggleY) }) {
                drawPath(leftAntennaPath, color = antennaColor, style = antennaStroke)
            }
            withTransform({ translate(left = -wiggleX, top = -wiggleY) }) {
                drawPath(rightAntennaPath, color = antennaColor, style = antennaStroke)
            }

            // 5. Eyes — dark circles with teal highlights
            val eyeDark = Color(0xFF050810).copy(alpha = alpha)
            drawCircle(eyeDark, radius = 6f, center = Offset(45f, 35f))
            drawCircle(eyeDark, radius = 6f, center = Offset(75f, 35f))

            val highlightColor = eyeColorForState().copy(alpha = alpha)
            drawCircle(highlightColor, radius = 2.5f, center = Offset(46f, 34f))
            drawCircle(highlightColor, radius = 2.5f, center = Offset(76f, 34f))
        }
    }

    private fun bodyBrush(): Brush {
        return if (visualState == CrayfishVisualState.ROUTING) {
            val pulse = (sin(time * 4f) * 0.5f + 0.5f) * 0.3f
            val startColor = lerpColor(TerrariumColors.CrayfishShell, TerrariumColors.CrayfishBodyLight, pulse)
            val endColor = lerpColor(TerrariumColors.CrayfishDark, TerrariumColors.CrayfishShell, pulse)
            Brush.linearGradient(
                colors = listOf(startColor, endColor),
                start = Offset(0f, 0f),
                end = Offset(SVG_VIEWBOX, SVG_VIEWBOX),
            )
        } else {
            Brush.linearGradient(
                colors = listOf(TerrariumColors.CrayfishShell, TerrariumColors.CrayfishDark),
                start = Offset(0f, 0f),
                end = Offset(SVG_VIEWBOX, SVG_VIEWBOX),
            )
        }
    }

    private fun shellColorForState(): Color {
        return when (visualState) {
            CrayfishVisualState.ROUTING -> {
                val pulse = (sin(time * 4f) * 0.5f + 0.5f) * 0.3f
                lerpColor(TerrariumColors.CrayfishShell, TerrariumColors.CrayfishBodyLight, pulse)
            }
            else -> TerrariumColors.CrayfishShell
        }
    }

    private fun clawAngleForState(side: Float): Float {
        return when (visualState) {
            CrayfishVisualState.ROUTING -> {
                val phase = time * 2f * PI.toFloat() / (TerrariumTiming.CLAW_CLAP_PERIOD_MS / 1000f)
                val clap = sin(phase + side * 0.3f)
                side * clap * 28f
            }
            CrayfishVisualState.SITTING -> {
                side * sin(time * 0.4f) * 1.5f
            }
            CrayfishVisualState.WAITING -> side * 15f
            CrayfishVisualState.OBSERVING -> side * (3f + sin(time * 2f) * 5f)
            else -> 0f
        }
    }

    private fun eyeColorForState(): Color {
        return when (visualState) {
            CrayfishVisualState.ROUTING -> {
                val flash = sin(time * 2f * PI.toFloat() / (TerrariumTiming.EYE_FLASH_PERIOD_MS / 1000f))
                val intensity = flash * 0.5f + 0.5f
                lerpColor(TerrariumColors.CrayfishEye, Color.White, intensity * 0.5f)
            }
            CrayfishVisualState.SITTING -> {
                val breath = sin(time * 0.6f) * 0.15f + 0.85f
                TerrariumColors.CrayfishEye.copy(alpha = breath)
            }
            else -> TerrariumColors.CrayfishEye
        }
    }

    private fun drawSignalWaves(scope: DrawScope, cx: Float, cy: Float, bodyWidth: Float, canvasWidth: Float) {
        val waveSpeed = time * 2f
        val maxRadius = canvasWidth * 0.15f

        for (i in 0 until 4) {
            val progress = ((waveSpeed + i * 0.25f) % 1f)
            val radius = bodyWidth * 0.3f + progress * maxRadius
            val waveAlpha = (1f - progress) * 0.35f

            scope.drawArc(
                color = TerrariumColors.CrayfishEye.copy(alpha = waveAlpha),
                startAngle = 120f,
                sweepAngle = 120f,
                useCenter = false,
                topLeft = Offset(cx - radius, cy - radius),
                size = Size(radius * 2, radius * 2),
                style = Stroke(width = 3f + (1f - progress) * 2f),
            )
        }

        for (i in 0 until 6) {
            val dotProgress = ((time * 3f + i * 0.16f) % 1f)
            val dotRadius = bodyWidth * 0.3f + dotProgress * maxRadius
            val dotAngle = (150f + dotProgress * 40f) * PI.toFloat() / 180f
            val dotX = cx + cos(dotAngle) * dotRadius
            val dotY = cy + sin(dotAngle) * dotRadius
            val dotAlpha = (1f - dotProgress) * 0.6f

            scope.drawCircle(
                color = TerrariumColors.TetraNeon.copy(alpha = dotAlpha),
                radius = bodyWidth * 0.015f,
                center = Offset(dotX, dotY),
            )
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

    private fun parseSvgPath(data: String): Path {
        return PathParser().parsePathString(data).toPath()
    }

    companion object {
        private const val SVG_VIEWBOX = 120f

        // SVG path data from openclaw.svg (viewBox 0 0 120 120)
        private const val BODY_PATH_DATA =
            "M60 10c-30 0-45 25-45 45s15 40 30 45v10h10v-10s5 2 10 0v10h10v-10c15-5 30-25 30-45S90 10 60 10"
        private const val LEFT_CLAW_PATH_DATA =
            "M20 45C5 40 0 50 5 60s15 5 20-5c3-7 0-10-5-10"
        private const val RIGHT_CLAW_PATH_DATA =
            "M100 45c15-5 20 5 15 15s-15 5-20-5c-3-7 0-10 5-10"
        private const val LEFT_ANTENNA_PATH_DATA = "M45 15Q35 5 30 8"
        private const val RIGHT_ANTENNA_PATH_DATA = "M75 15Q85 5 90 8"
    }
}
