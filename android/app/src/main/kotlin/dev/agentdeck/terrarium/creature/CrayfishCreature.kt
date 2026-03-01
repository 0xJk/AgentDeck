package dev.agentdeck.terrarium.creature

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import android.util.Log
import dev.agentdeck.terrarium.CrayfishVisualState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumLayout
import dev.agentdeck.terrarium.TerrariumTiming
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * OpenClaw — front-facing lobster pixel mascot.
 * 12×9 pixel grid with articulated claws, antennae, and legs.
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

        // Position: only ROUTING moves. All other states = still on the rocks.
        val effectiveCX: Float
        val effectiveCY: Float
        when (visualState) {
            CrayfishVisualState.DORMANT -> {
                // Shift down behind rocks, dimmed
                effectiveCX = cx
                effectiveCY = cy + bodyWidth * 0.3f
            }
            CrayfishVisualState.ROUTING -> {
                // Active: slight body movement to convey energy
                effectiveCX = cx
                effectiveCY = cy + sin(time * 3f) * bodyWidth * 0.03f
            }
            else -> {
                // SITTING, OBSERVING, WAITING — completely still
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

        // Draw pixel body
        drawPixelBody(scope, effectiveCX, effectiveCY, bodyWidth, alpha)
    }

    private fun clawAngleForState(side: Float): Float {
        return when (visualState) {
            CrayfishVisualState.ROUTING -> {
                // ±25° rotation, vigorous
                val clap = sin(time * 2f * PI.toFloat() / (TerrariumTiming.CLAW_CLAP_PERIOD_MS / 1000f))
                side * clap * 25f
            }
            CrayfishVisualState.WAITING -> {
                // Raised open ±15°
                side * 15f
            }
            CrayfishVisualState.OBSERVING -> {
                // Very subtle claw twitch (no body movement, only claws hint at awareness)
                side * (3f + sin(time * 2f) * 5f)
            }
            else -> 0f // SITTING, DORMANT — completely still
        }
    }

    private fun drawPixelBody(scope: DrawScope, cx: Float, cy: Float, bodyWidth: Float, alpha: Float) {
        val pixelSize = bodyWidth / GRID_COLS
        val gridWidth = GRID_COLS * pixelSize
        val gridHeight = GRID_ROWS * pixelSize
        val startX = cx - gridWidth / 2f
        val startY = cy - gridHeight / 2f

        val leftClawAngle = clawAngleForState(side = -1f)
        val rightClawAngle = clawAngleForState(side = 1f)
        // Pivot points in pixel coordinates
        val leftPivotX = 1.5f
        val leftPivotY = 2.5f
        val rightPivotX = 10.5f
        val rightPivotY = 2.5f

        for (row in 0 until GRID_ROWS) {
            for (col in 0 until GRID_COLS) {
                val cellType = PIXEL_GRID[row][col]
                if (cellType == EMPTY) continue

                val color = colorForCell(cellType, alpha)
                var px = startX + col * pixelSize
                var py = startY + row * pixelSize

                when (cellType) {
                    CLAW_L_UPPER, CLAW_L_LOWER -> {
                        val rotated = rotatePixelAroundPivot(
                            col.toFloat() + 0.5f, row.toFloat() + 0.5f,
                            leftPivotX, leftPivotY, leftClawAngle
                        )
                        px = startX + (rotated.first - 0.5f) * pixelSize
                        py = startY + (rotated.second - 0.5f) * pixelSize
                    }
                    CLAW_R_UPPER, CLAW_R_LOWER -> {
                        val rotated = rotatePixelAroundPivot(
                            col.toFloat() + 0.5f, row.toFloat() + 0.5f,
                            rightPivotX, rightPivotY, rightClawAngle
                        )
                        px = startX + (rotated.first - 0.5f) * pixelSize
                        py = startY + (rotated.second - 0.5f) * pixelSize
                    }
                    LEG -> {
                        // Walking gait offset
                        px += sin(time * 4f + col * 0.5f) * pixelSize * 0.15f
                    }
                    ANTENNA_L -> {
                        // Antenna wiggle (only during ROUTING)
                        if (visualState == CrayfishVisualState.ROUTING) {
                            px += sin(time * 7f) * pixelSize * 0.3f
                            py -= sin(time * 5f) * pixelSize * 0.2f
                        }
                    }
                    ANTENNA_R -> {
                        if (visualState == CrayfishVisualState.ROUTING) {
                            px -= sin(time * 7f) * pixelSize * 0.3f
                            py -= sin(time * 5f) * pixelSize * 0.2f
                        }
                    }
                }

                scope.drawRect(
                    color = color,
                    topLeft = Offset(px, py),
                    size = Size(pixelSize, pixelSize),
                )
            }
        }
    }

    private fun colorForCell(cellType: Int, alpha: Float): Color {
        val base = when (cellType) {
            BODY, LEG, ANTENNA_L, ANTENNA_R -> TerrariumColors.CrayfishShell
            HEAD -> TerrariumColors.CrayfishShell
            EYE_L, EYE_R -> eyeColorForState()
            CLAW_L_UPPER, CLAW_L_LOWER, CLAW_R_UPPER, CLAW_R_LOWER -> TerrariumColors.CrayfishDark
            else -> TerrariumColors.CrayfishShell
        }
        // ROUTING: shell glow pulse
        val glowed = if (visualState == CrayfishVisualState.ROUTING &&
            cellType != EYE_L && cellType != EYE_R) {
            val pulse = (sin(time * 4f) * 0.5f + 0.5f) * 0.3f
            lerpColor(base, TerrariumColors.CrayfishBodyLight, pulse)
        } else {
            base
        }
        return glowed.copy(alpha = alpha)
    }

    private fun eyeColorForState(): Color {
        return when (visualState) {
            CrayfishVisualState.ROUTING -> {
                val flash = sin(time * 2f * PI.toFloat() / (TerrariumTiming.EYE_FLASH_PERIOD_MS / 1000f))
                val intensity = flash * 0.5f + 0.5f
                lerpColor(TerrariumColors.CrayfishEye, Color.White, intensity * 0.5f)
            }
            else -> TerrariumColors.CrayfishEye
        }
    }

    private fun rotatePixelAroundPivot(
        px: Float, py: Float,
        pivotX: Float, pivotY: Float,
        angleDegrees: Float
    ): Pair<Float, Float> {
        val rad = angleDegrees * PI.toFloat() / 180f
        val dx = px - pivotX
        val dy = py - pivotY
        val cosA = cos(rad)
        val sinA = sin(rad)
        return Pair(
            pivotX + dx * cosA - dy * sinA,
            pivotY + dx * sinA + dy * cosA,
        )
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

        // Data dots traveling along signal arcs
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

    companion object {
        private const val EMPTY = 0
        private const val BODY = 1
        private const val HEAD = 2
        private const val EYE_L = 3
        private const val EYE_R = 4
        private const val CLAW_L_UPPER = 5
        private const val CLAW_L_LOWER = 6
        private const val CLAW_R_UPPER = 7
        private const val CLAW_R_LOWER = 8
        private const val LEG = 9
        private const val ANTENNA_L = 10
        private const val ANTENNA_R = 11

        private const val GRID_COLS = 12
        private const val GRID_ROWS = 9

        // 12×9 front-facing lobster pixel grid
        private val PIXEL_GRID = arrayOf(
            intArrayOf( 0,10, 0, 2, 2, 2, 2, 2, 2, 0,11, 0),  // row 0: antennae + head top
            intArrayOf( 0, 5, 0, 2, 3, 2, 2, 4, 2, 0, 7, 0),  // row 1: eyes + claw roots
            intArrayOf( 5, 5, 0, 1, 1, 1, 1, 1, 1, 0, 7, 7),  // row 2: upper body + claws
            intArrayOf( 6, 6, 0, 1, 1, 1, 1, 1, 1, 0, 8, 8),  // row 3: mid body + claw lower
            intArrayOf( 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0),  // row 4: lower body
            intArrayOf( 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0),  // row 5: abdomen
            intArrayOf( 0, 0, 9, 0, 9, 0, 0, 9, 0, 9, 0, 0),  // row 6: upper legs (4 pairs)
            intArrayOf( 0, 0, 9, 0, 0, 0, 0, 0, 0, 9, 0, 0),  // row 7: mid legs
            intArrayOf( 0, 0, 9, 0, 0, 0, 0, 0, 0, 9, 0, 0),  // row 8: outer legs
        )
    }
}
