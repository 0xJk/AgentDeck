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
    return when (count) {
        0 -> emptyList()
        1 -> listOf(
            CreatureSlot(
                TerrariumLayout.OCTOPUS_CENTER_X_FRACTION,
                TerrariumLayout.OCTOPUS_CENTER_Y_FRACTION,
                1.0f,
            )
        )
        2 -> listOf(
            CreatureSlot(0.25f, 0.42f, 0.85f),
            CreatureSlot(0.58f, 0.48f, 0.85f),
        )
        3 -> listOf(
            CreatureSlot(0.24f, 0.36f, 0.75f),
            CreatureSlot(0.54f, 0.36f, 0.75f),
            CreatureSlot(0.38f, 0.54f, 0.75f),
        )
        else -> {
            // Grid layout for 4+, shrinking as needed
            val scale = max(0.45f, 0.75f - (count - 3) * 0.05f)
            val cols = if (count <= 4) 2 else 3
            val rows = (count + cols - 1) / cols
            val startX = 0.20f
            val endX = 0.62f
            val startY = 0.32f
            val endY = 0.55f
            val dx = if (cols > 1) (endX - startX) / (cols - 1) else 0f
            val dy = if (rows > 1) (endY - startY) / (rows - 1) else 0f

            (0 until count).map { i ->
                val col = i % cols
                val row = i / cols
                CreatureSlot(
                    startX + col * dx,
                    startY + row * dy,
                    scale,
                )
            }
        }
    }
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
    if (agents.isEmpty()) return emptyList()
    if (agents.size == 1) return listOf(
        CreatureSlot(
            TerrariumLayout.OCTOPUS_CENTER_X_FRACTION,
            TerrariumLayout.OCTOPUS_CENTER_Y_FRACTION,
            1.0f,
        )
    )

    // Group by project name (null groups separately)
    val groups = agents.mapIndexed { i, a -> i to a }
        .groupBy { it.second.projectName ?: "__null_${it.first}" }
        .values.toList()

    // Distribute group centers across swim area
    val areaMinX = 0.22f   // clear of left HUD panel
    val areaMaxX = 0.65f
    val areaMinY = 0.30f
    val areaMaxY = 0.58f
    val clusterRadius = 0.07f

    val result = Array<CreatureSlot?>(agents.size) { null }
    val scale = max(0.50f, 0.85f - (agents.size - 1) * 0.05f)

    for (gi in groups.indices) {
        val group = groups[gi]
        // Group center
        val gt = if (groups.size == 1) 0.5f else gi.toFloat() / (groups.size - 1)
        val gcx = areaMinX + (areaMaxX - areaMinX) * gt
        val gcy = areaMinY + (areaMaxY - areaMinY) * (0.5f + (gi % 2) * 0.3f - 0.15f)

        if (group.size == 1) {
            val (idx, _) = group[0]
            result[idx] = CreatureSlot(gcx, gcy, scale)
        } else {
            for (mi in group.indices) {
                val (idx, _) = group[mi]
                val angle = (2.0 * PI * mi / group.size).toFloat()
                val cx = gcx + cos(angle) * clusterRadius
                val cy = gcy + sin(angle) * clusterRadius * 0.7f
                result[idx] = CreatureSlot(cx, cy, scale)
            }
        }
    }

    return result.map { it!! }
}

/**
 * Compute layout positions for OpenClaw worker crayfish.
 * Workers are smaller and arranged in an arc around the main crayfish position.
 */
fun layoutWorkerCrayfish(count: Int): List<CreatureSlot> {
    if (count == 0) return emptyList()

    val mainX = TerrariumLayout.CRAYFISH_CENTER_X_FRACTION
    val mainY = TerrariumLayout.CRAYFISH_CENTER_Y_FRACTION
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
