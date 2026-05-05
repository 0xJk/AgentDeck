package dev.agentdeck.terrarium

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

/**
 * Layout slot for positioning a creature in the terrarium.
 */
data class CreatureSlot(
    val centerXFraction: Float,
    val centerYFraction: Float,
    val scaleFactor: Float,
)

/**
 * Compute layout positions for multiple octopuses (coding agents).
 * Distributes them across the left-center area of the terrarium.
 */
fun layoutOctopuses(count: Int): List<CreatureSlot> {
    return layoutBand(
        count = count,
        xMin = 0.20f,
        xMax = 0.50f,
        frontY = 0.42f,
        backY = 0.52f,
        singleRowLimit = 4,
        baseScale = 1.0f,
        minScale = 0.58f,
    )
}

/**
 * Agent info for project-based clustering layout.
 */
data class AgentLayoutInfo(
    val sessionId: String,
    val projectName: String?,
)

/**
 * Compute layout positions grouped by project name.
 * Same-project agents cluster together; groups are spaced apart.
 */
fun layoutOctopusesByProject(agents: List<AgentLayoutInfo>): List<CreatureSlot> {
    return layoutOctopuses(agents.size)
}

/**
 * Compute layout positions for cloud creatures (Codex CLI agents).
 * Clouds float in the upper-center area, above octopuses.
 */
fun layoutCloudCreatures(count: Int): List<CreatureSlot> {
    return layoutBand(
        count = count,
        xMin = 0.30f,
        xMax = 0.55f,
        frontY = 0.16f,
        backY = 0.28f,
        singleRowLimit = 3,
        baseScale = 0.98f,
        minScale = 0.56f,
    )
}

/**
 * Compute layout positions for OpenCode creatures.
 * Similar to cloud creatures but positioned in the mid-center area.
 */
fun layoutOpenCodeCreatures(count: Int): List<CreatureSlot> {
    return layoutBand(
        count = count,
        xMin = 0.45f,
        xMax = 0.68f,
        frontY = 0.34f,
        backY = 0.46f,
        singleRowLimit = 3,
        baseScale = 0.96f,
        minScale = 0.56f,
    )
}

private fun layoutBand(
    count: Int,
    xMin: Float,
    xMax: Float,
    frontY: Float,
    backY: Float,
    singleRowLimit: Int,
    baseScale: Float,
    minScale: Float,
): List<CreatureSlot> {
    if (count <= 0) return emptyList()

    val rows = when {
        count <= singleRowLimit -> 1
        count <= singleRowLimit * 2 -> 2
        else -> 3
    }

    val scale = max(minScale, baseScale - (count - 1) * 0.055f)
    val rowCounts = distribute(count, rows)
    val slots = mutableListOf<CreatureSlot>()
    var absoluteIndex = 0

    for (row in 0 until rows) {
        val rowCount = rowCounts[row]
        if (rowCount <= 0) continue

        val rowT = if (rows == 1) 0f else row.toFloat() / (rows - 1).toFloat()
        val rowY = frontY + (backY - frontY) * rowT
        val rowInset = 0.015f + row * 0.02f
        val rowMinX = xMin + rowInset
        val rowMaxX = xMax - rowInset
        val rowScale = max(minScale, scale - row * 0.04f)

        for (col in 0 until rowCount) {
            val t = if (rowCount == 1) 0.5f else col.toFloat() / (rowCount - 1).toFloat()
            val baseX = rowMinX + (rowMaxX - rowMinX) * t
            val spread = max(0.003f, minOf(0.012f, (rowMaxX - rowMinX) / (rowCount * 5).coerceAtLeast(1)))
            val phase = if ((absoluteIndex + row) % 2 == 0) -1f else 1f
            val x = (baseX + spread * phase).coerceIn(xMin, xMax)
            val yJitter = ((absoluteIndex % 3) - 1) * 0.008f
            slots += CreatureSlot(x, rowY + yJitter, rowScale)
            absoluteIndex += 1
        }
    }

    return slots
}

private fun distribute(count: Int, rows: Int): IntArray {
    val result = IntArray(rows) { count / rows }
    repeat(count % rows) { index -> result[index] += 1 }
    return result
}

/**
 * Compute layout positions for OpenClaw worker crayfish.
 * Workers are smaller and arranged in an arc around the main crayfish position.
 */
fun layoutWorkerCrayfish(
    count: Int,
    mainX: Float = TerrariumLayout.CRAYFISH_CENTER_X_FRACTION,
    mainY: Float = TerrariumLayout.CRAYFISH_CENTER_Y_FRACTION,
): List<CreatureSlot> {
    if (count == 0) return emptyList()

    val arcRadius = 0.08f

    return (0 until count).map { i ->
        val angle = PI.toFloat() * 0.8f + (i.toFloat() / max(1, count - 1).toFloat()) * PI.toFloat() * 0.4f
        CreatureSlot(
            mainX + cos(angle) * arcRadius,
            mainY + sin(angle) * arcRadius,
            0.5f,
        )
    }
}
