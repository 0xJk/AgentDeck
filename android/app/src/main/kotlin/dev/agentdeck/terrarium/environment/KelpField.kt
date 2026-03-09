package dev.agentdeck.terrarium.environment

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumLayout
import dev.agentdeck.terrarium.TerrariumTiming
import kotlin.math.PI
import kotlin.math.sin

/**
 * Swaying kelp bezier curves growing from the bottom.
 * Each strand has a phase-offset sine for organic movement.
 */
class KelpField {

    private data class KelpStrand(
        val baseX: Float,    // 0..1 fraction of width
        val height: Float,   // 0..1 fraction of canvas height
        val phase: Float,    // sine phase offset
        val segments: Int,   // number of bezier segments (2-4)
    )

    private val strands = listOf(
        KelpStrand(0.08f, 0.25f, 0f, 3),
        KelpStrand(0.12f, 0.30f, 1.2f, 4),
        KelpStrand(0.15f, 0.20f, 2.5f, 2),
        KelpStrand(0.88f, 0.22f, 0.8f, 3),
        KelpStrand(0.92f, 0.28f, 1.8f, 3),
        KelpStrand(0.55f, 0.18f, 3.0f, 2),
    )

    private var time by mutableFloatStateOf(0f)
    // Pre-allocated Path objects — one per strand, reused every frame
    private val strandPaths = Array(strands.size) { Path() }

    fun update(dt: Float) {
        time += dt * TerrariumTiming.KELP_SWAY_SPEED
    }

    fun draw(scope: DrawScope) {
        val w = scope.size.width
        val h = scope.size.height

        for (i in strands.indices) {
            drawStrand(scope, strands[i], w, h, strandPaths[i])
        }
    }

    private fun drawStrand(scope: DrawScope, strand: KelpStrand, w: Float, h: Float, path: Path) {
        val baseX = strand.baseX * w
        val baseY = h * (1f - TerrariumLayout.SAND_HEIGHT_FRACTION) // sand top line (rock height)
        val topY = baseY - strand.height * h
        val segHeight = (baseY - topY) / strand.segments

        path.reset()
        path.moveTo(baseX, baseY)
        for (i in 0 until strand.segments) {
            val sway = sin(time + strand.phase + i * 0.8f) * w * 0.015f * (i + 1)
            val y1 = baseY - (i + 0.5f) * segHeight
            val y2 = baseY - (i + 1f) * segHeight
            val cpX = baseX + sway
            path.quadraticBezierTo(cpX, y1, baseX + sway * 0.6f, y2)
        }

        // Main stem
        scope.drawPath(
            path = path,
            color = TerrariumColors.KelpDark,
            style = Stroke(width = w * 0.004f, cap = StrokeCap.Round),
        )

        // Lighter inner stroke
        scope.drawPath(
            path = path,
            color = TerrariumColors.KelpGreen.copy(alpha = 0.5f),
            style = Stroke(width = w * 0.002f, cap = StrokeCap.Round),
        )

        // Leaf blobs at segment joints
        for (i in 1..strand.segments) {
            val sway = sin(time + strand.phase + i * 0.8f) * w * 0.015f * i
            val leafY = baseY - i * segHeight
            val leafX = baseX + sway * 0.6f

            scope.drawOval(
                color = TerrariumColors.KelpGreen.copy(alpha = 0.4f),
                topLeft = Offset(leafX - w * 0.006f, leafY - w * 0.003f),
                size = androidx.compose.ui.geometry.Size(w * 0.012f, w * 0.006f),
            )
        }
    }
}
