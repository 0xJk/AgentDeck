package dev.agentdeck.terrarium.renderer

import android.graphics.Bitmap
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.IntSize
import dev.agentdeck.terrarium.CrayfishVisualState
import dev.agentdeck.terrarium.OctopusVisualState
import dev.agentdeck.terrarium.TetraVisualState
import dev.agentdeck.terrarium.TerrariumState
import dev.agentdeck.terrarium.TerrariumTiming
import kotlinx.coroutines.delay

/**
 * E-ink terrarium renderer — draws line art creatures into an offscreen bitmap,
 * applies Floyd-Steinberg dithering, then renders the 1-bit result.
 *
 * Style: "Marine biologist's journal" — pen drawing line art, high contrast.
 * Re-renders only on state changes (debounced 500ms).
 */
@Composable
fun EinkTerrariumView(
    state: TerrariumState,
    modifier: Modifier = Modifier,
) {
    var renderedBitmap by remember { mutableStateOf<Bitmap?>(null) }
    var lastRenderState by remember { mutableStateOf<TerrariumState?>(null) }
    var pendingRender by remember { mutableLongStateOf(0L) }

    // Debounced re-render on state change
    LaunchedEffect(state.octopus, state.crayfish, state.tetra, state.environment, state.agents.size) {
        if (state == lastRenderState) return@LaunchedEffect
        pendingRender = System.currentTimeMillis()
        delay(TerrariumTiming.EINK_DEBOUNCE_MS)

        // Only render if no newer state arrived
        if (System.currentTimeMillis() - pendingRender >= TerrariumTiming.EINK_DEBOUNCE_MS - 50) {
            lastRenderState = state
            renderedBitmap = renderEinkFrame(state, EINK_WIDTH, EINK_HEIGHT)
        }
    }

    // Initial render
    LaunchedEffect(Unit) {
        if (renderedBitmap == null) {
            renderedBitmap = renderEinkFrame(state, EINK_WIDTH, EINK_HEIGHT)
            lastRenderState = state
        }
    }

    Canvas(modifier = modifier.fillMaxSize()) {
        val bmp = renderedBitmap ?: return@Canvas
        drawImage(
            image = bmp.asImageBitmap(),
            dstSize = IntSize(size.width.toInt(), size.height.toInt()),
        )
    }
}

/** Render a single e-ink frame: draw line art → dither → return 1-bit bitmap. */
private fun renderEinkFrame(state: TerrariumState, width: Int, height: Int): Bitmap {
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(bitmap)
    val paint = Paint().apply { isAntiAlias = false }

    // White background
    canvas.drawColor(android.graphics.Color.WHITE)

    // Tank border — rounded rectangle for aquarium glass feel
    paint.color = android.graphics.Color.BLACK
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 3f
    val tankRect = RectF(4f, 4f, width - 4f, height - 4f)
    canvas.drawRoundRect(tankRect, 12f, 12f, paint)

    // Water surface — double wave
    val surfaceY = height * 0.08f
    paint.strokeWidth = 1.5f
    canvas.drawLine(8f, surfaceY, width - 8f, surfaceY, paint)

    // Wave marks on surface (more for wider canvas)
    paint.strokeWidth = 1f
    for (i in 0 until 8) {
        val x = width * (0.05f + i * 0.12f)
        canvas.drawArc(
            RectF(x, surfaceY - 3f, x + 15f, surfaceY + 3f),
            180f, 180f, false, paint,
        )
    }

    // Bubbles — scattered near surface
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 0.8f
    for (i in 0 until 4) {
        val bx = width * (0.15f + i * 0.2f + (i % 2) * 0.05f)
        val by = surfaceY + height * (0.05f + i * 0.08f)
        canvas.drawCircle(bx, by, 2f + i * 0.5f, paint)
    }

    // Seaweed / plants
    drawEinkSeaweed(canvas, paint, width, height)

    // Bottom terrain (rocks silhouette)
    drawEinkRocks(canvas, paint, width, height)
    drawEinkGravel(canvas, paint, width, height)

    // Creatures (line art)
    if (state.agents.size > 1) {
        // Multi-session: draw each agent octopus at its layout position
        val slots = dev.agentdeck.terrarium.layoutOctopuses(state.agents.size)
        for (i in state.agents.indices) {
            val slot = slots.getOrElse(i) { slots.last() }
            drawEinkOctopus(canvas, paint, width, height,
                state.agents[i].visualState, state.agents[i].agentType,
                centerXFraction = slot.centerXFraction, centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor)
        }
    } else {
        drawEinkOctopus(canvas, paint, width, height, state.octopus, state.agentType)
    }
    drawEinkCrayfish(canvas, paint, width, height, state.crayfish)
    drawEinkDataParticles(canvas, paint, width, height, state.tetra, state.agents.size)

    // State label at bottom
    paint.style = Paint.Style.FILL
    paint.textSize = 14f
    paint.color = android.graphics.Color.BLACK
    val label = einkStateLabel(state)
    val textWidth = paint.measureText(label)
    canvas.drawText(label, (width - textWidth) / 2, height - 12f, paint)

    // Apply Floyd-Steinberg dithering
    DitherEngine.floydSteinberg(bitmap)

    return bitmap
}

private fun drawEinkRocks(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int) {
    val bottomY = h * 0.82f
    paint.style = Paint.Style.FILL
    paint.color = android.graphics.Color.BLACK

    // Right rock cluster
    val rockPath = android.graphics.Path().apply {
        moveTo(w * 0.65f, h.toFloat())
        lineTo(w * 0.62f, bottomY)
        cubicTo(w * 0.68f, bottomY - h * 0.06f, w * 0.82f, bottomY - h * 0.08f, w * 0.88f, bottomY)
        lineTo(w * 0.92f, h.toFloat())
        close()
    }
    canvas.drawPath(rockPath, paint)

    // Left small rocks
    val leftRock = android.graphics.Path().apply {
        moveTo(w * 0.02f, h.toFloat())
        lineTo(w * 0.04f, bottomY + h * 0.02f)
        cubicTo(w * 0.08f, bottomY - h * 0.02f, w * 0.14f, bottomY - h * 0.01f, w * 0.18f, bottomY + h * 0.03f)
        lineTo(w * 0.20f, h.toFloat())
        close()
    }
    canvas.drawPath(leftRock, paint)

    // Sand texture lines
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 0.5f
    for (i in 0 until 4) {
        val y = bottomY + (h - bottomY) * (0.3f + i * 0.15f)
        canvas.drawLine(w * 0.05f, y, w * 0.25f + i * w * 0.1f, y + 2f, paint)
    }
}

private fun drawEinkSeaweed(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int) {
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 1.2f
    paint.color = android.graphics.Color.BLACK

    // Left wall: 2 wavy stems
    for (stem in 0 until 2) {
        val baseX = w * (0.04f + stem * 0.04f)
        val path = android.graphics.Path().apply {
            moveTo(baseX, h * 0.85f)
            for (seg in 0 until 4) {
                val segY = h * (0.85f - (seg + 1) * 0.12f)
                val cpX = baseX + (if (seg % 2 == 0) w * 0.02f else -w * 0.01f)
                quadTo(cpX, segY + h * 0.06f, baseX + (seg % 2) * w * 0.01f, segY)
            }
        }
        canvas.drawPath(path, paint)
    }

    // Right wall: 1 stem near rocks
    val rightBaseX = w * 0.93f
    val rightPath = android.graphics.Path().apply {
        moveTo(rightBaseX, h * 0.85f)
        for (seg in 0 until 3) {
            val segY = h * (0.85f - (seg + 1) * 0.14f)
            val cpX = rightBaseX + (if (seg % 2 == 0) -w * 0.015f else w * 0.01f)
            quadTo(cpX, segY + h * 0.07f, rightBaseX - (seg % 2) * w * 0.005f, segY)
        }
    }
    canvas.drawPath(rightPath, paint)
}

private fun drawEinkGravel(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int) {
    val bottomY = h * 0.88f
    paint.color = android.graphics.Color.BLACK

    // Gravel: small dots along bottom
    paint.style = Paint.Style.FILL
    for (i in 0 until 20) {
        val x = w * (0.05f + i * 0.045f)
        val y = bottomY + (i % 3) * 3f
        canvas.drawCircle(x, y, 1f + (i % 2) * 0.5f, paint)
    }

    // Pebbles: small ovals
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 0.8f
    canvas.drawOval(RectF(w * 0.20f, bottomY, w * 0.26f, bottomY + h * 0.04f), paint)
    canvas.drawOval(RectF(w * 0.40f, bottomY + 2f, w * 0.45f, bottomY + h * 0.035f), paint)
    canvas.drawOval(RectF(w * 0.60f, bottomY + 1f, w * 0.64f, bottomY + h * 0.03f), paint)
}

private fun drawEinkOctopus(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: OctopusVisualState,
    agentType: String? = null,
    centerXFraction: Float = 0.38f,
    centerYFraction: Float = 0.42f,
    scaleFactor: Float = 1f,
) {
    paint.color = android.graphics.Color.BLACK
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 2f * scaleFactor

    val cx = w * centerXFraction
    val cy = when (state) {
        OctopusVisualState.SLEEPING -> h * 0.75f
        else -> h * centerYFraction
    }
    val bodyRx = w * 0.06f * scaleFactor
    val bodyRy = w * 0.07f * scaleFactor

    // Body outline
    canvas.drawOval(RectF(cx - bodyRx, cy - bodyRy, cx + bodyRx, cy + bodyRy), paint)

    // Agent mark (simplified starburst for Claude Code)
    if (agentType == "claude-code") {
        paint.strokeWidth = 0.8f
        val markR = bodyRx * 0.35f
        val markCy = cy - bodyRy * 0.05f
        // 6-pointed starburst
        for (i in 0 until 6) {
            val angle = (i.toFloat() / 6f) * 2f * Math.PI.toFloat()
            canvas.drawLine(
                cx + kotlin.math.cos(angle) * markR * 0.3f,
                markCy + kotlin.math.sin(angle) * markR * 0.3f,
                cx + kotlin.math.cos(angle) * markR,
                markCy + kotlin.math.sin(angle) * markR,
                paint,
            )
        }
        paint.strokeWidth = 2f
    }

    // Eyes
    val eyeR = bodyRx * 0.18f
    if (state == OctopusVisualState.SLEEPING) {
        // Closed eyes — lines
        canvas.drawLine(cx - bodyRx * 0.35f - eyeR, cy - bodyRy * 0.15f,
            cx - bodyRx * 0.35f + eyeR, cy - bodyRy * 0.15f, paint)
        canvas.drawLine(cx + bodyRx * 0.35f - eyeR, cy - bodyRy * 0.15f,
            cx + bodyRx * 0.35f + eyeR, cy - bodyRy * 0.15f, paint)
    } else {
        // Open eyes
        paint.style = Paint.Style.FILL
        canvas.drawCircle(cx - bodyRx * 0.35f, cy - bodyRy * 0.15f, eyeR, paint)
        canvas.drawCircle(cx + bodyRx * 0.35f, cy - bodyRy * 0.15f, eyeR, paint)
        paint.style = Paint.Style.STROKE
    }

    // Tentacles (8 curved lines)
    val tentacleBase = cy + bodyRy * 0.7f
    for (i in 0 until 8) {
        val angle = -0.8f * Math.PI.toFloat() + (i / 7f) * 1.6f * Math.PI.toFloat()
        val startX = cx + kotlin.math.cos(angle) * bodyRx * 0.6f
        val endX = startX + kotlin.math.cos(angle) * w * 0.08f
        val endY = tentacleBase + w * 0.06f

        val cpX = startX + kotlin.math.cos(angle) * w * 0.04f
        val cpY = tentacleBase + w * 0.03f

        when (state) {
            OctopusVisualState.SLEEPING -> {
                // Curled tentacles
                val path = android.graphics.Path().apply {
                    moveTo(startX, tentacleBase)
                    quadTo(cpX, tentacleBase + w * 0.01f,
                        startX + kotlin.math.cos(angle) * w * 0.02f, tentacleBase + w * 0.02f)
                }
                canvas.drawPath(path, paint)
            }
            OctopusVisualState.THINKING -> {
                // Curled inward
                val path = android.graphics.Path().apply {
                    moveTo(startX, tentacleBase)
                    cubicTo(cpX, cpY, cx, endY, cx + (startX - cx) * 0.3f, endY - w * 0.01f)
                }
                canvas.drawPath(path, paint)
            }
            else -> {
                // Normal flowing
                val path = android.graphics.Path().apply {
                    moveTo(startX, tentacleBase)
                    cubicTo(cpX, cpY, cpX + (endX - cpX) * 0.5f, endY - w * 0.02f, endX, endY)
                }
                canvas.drawPath(path, paint)
            }
        }
    }

    // State-specific decorations
    when (state) {
        OctopusVisualState.TYPING -> {
            // Small keyboard rectangle below
            paint.strokeWidth = 1f
            val kbW = bodyRx * 3f
            val kbH = bodyRy * 0.8f
            val kbY = cy + bodyRy * 2.5f
            canvas.drawRect(cx - kbW / 2, kbY, cx + kbW / 2, kbY + kbH, paint)
            // Key grid
            for (r in 1 until 3) {
                val y = kbY + r * kbH / 3
                canvas.drawLine(cx - kbW / 2, y, cx + kbW / 2, y, paint)
            }
        }
        OctopusVisualState.OFFERING -> {
            // Permission marks: checkmark and X
            paint.strokeWidth = 2f
            // Check
            val checkX = cx - bodyRx * 2f
            val checkY = cy
            canvas.drawLine(checkX - 6f, checkY, checkX, checkY + 6f, paint)
            canvas.drawLine(checkX, checkY + 6f, checkX + 10f, checkY - 8f, paint)
            // X
            val xX = cx + bodyRx * 2f
            canvas.drawLine(xX - 6f, checkY - 6f, xX + 6f, checkY + 6f, paint)
            canvas.drawLine(xX + 6f, checkY - 6f, xX - 6f, checkY + 6f, paint)
        }
        OctopusVisualState.REVIEWING -> {
            // Two small document outlines
            paint.strokeWidth = 1f
            for (side in listOf(-1f, 1f)) {
                val docX = cx + side * bodyRx * 2f
                val docY = cy - bodyRy * 0.5f
                canvas.drawRect(docX - bodyRx * 0.8f, docY, docX + bodyRx * 0.8f, docY + bodyRy * 1.5f, paint)
                // Text lines
                for (l in 0 until 4) {
                    val ly = docY + 4f + l * bodyRy * 0.35f
                    canvas.drawLine(docX - bodyRx * 0.6f, ly, docX + bodyRx * 0.4f, ly, paint)
                }
            }
        }
        else -> {}
    }
}

private fun drawEinkCrayfish(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: CrayfishVisualState,
) {
    paint.color = android.graphics.Color.BLACK
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 1.5f

    val cx = w * 0.78f
    val cy = when (state) {
        CrayfishVisualState.DORMANT -> h * 0.82f  // Behind rocks
        else -> h * 0.73f
    }
    val bodyW = w * 0.07f

    if (state == CrayfishVisualState.DORMANT) {
        // Only show antenna tips above rocks
        canvas.drawLine(cx - bodyW * 0.3f, cy - bodyW * 0.2f, cx - bodyW * 0.6f, cy - bodyW * 0.6f, paint)
        canvas.drawLine(cx + bodyW * 0.1f, cy - bodyW * 0.2f, cx + bodyW * 0.3f, cy - bodyW * 0.5f, paint)
        return
    }

    // Carapace (oval)
    canvas.drawOval(RectF(cx - bodyW * 0.3f, cy - bodyW * 0.15f,
        cx + bodyW * 0.3f, cy + bodyW * 0.15f), paint)

    // Abdomen segments
    for (i in 0 until 3) {
        val segX = cx + bodyW * (0.3f + i * 0.12f)
        canvas.drawOval(RectF(segX, cy - bodyW * 0.1f,
            segX + bodyW * 0.13f, cy + bodyW * 0.1f), paint)
    }

    // Tail fan
    val tailX = cx + bodyW * 0.65f
    canvas.drawLine(tailX, cy, tailX + bodyW * 0.15f, cy - bodyW * 0.12f, paint)
    canvas.drawLine(tailX, cy, tailX + bodyW * 0.18f, cy, paint)
    canvas.drawLine(tailX, cy, tailX + bodyW * 0.15f, cy + bodyW * 0.12f, paint)

    // Claws
    val clawBaseX = cx - bodyW * 0.25f
    for (side in listOf(-1f, 1f)) {
        val clawY = cy + side * bodyW * 0.1f
        val clawAngle = when (state) {
            CrayfishVisualState.WAITING -> side * bodyW * 0.15f
            else -> side * bodyW * 0.05f
        }
        // Arm
        canvas.drawLine(clawBaseX, clawY, clawBaseX - bodyW * 0.25f, clawY + clawAngle, paint)
        // Pincer
        val pincerX = clawBaseX - bodyW * 0.25f
        val pincerY = clawY + clawAngle
        canvas.drawLine(pincerX, pincerY, pincerX - bodyW * 0.1f, pincerY - bodyW * 0.04f, paint)
        canvas.drawLine(pincerX, pincerY, pincerX - bodyW * 0.1f, pincerY + bodyW * 0.04f, paint)
    }

    // Eyes
    paint.style = Paint.Style.FILL
    val eyeR = bodyW * 0.025f
    canvas.drawCircle(cx - bodyW * 0.2f, cy - bodyW * 0.08f, eyeR, paint)
    canvas.drawCircle(cx - bodyW * 0.2f, cy + bodyW * 0.08f, eyeR, paint)

    // Antenna
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 0.8f
    canvas.drawLine(cx - bodyW * 0.25f, cy - bodyW * 0.05f,
        cx - bodyW * 0.45f, cy - bodyW * 0.2f, paint)
    canvas.drawLine(cx - bodyW * 0.25f, cy + bodyW * 0.05f,
        cx - bodyW * 0.45f, cy + bodyW * 0.2f, paint)

    // ROUTING: signal arcs
    if (state == CrayfishVisualState.ROUTING) {
        paint.strokeWidth = 1f
        for (i in 1..3) {
            val r = bodyW * 0.2f * i
            canvas.drawArc(
                RectF(cx - bodyW * 0.4f - r, cy - r, cx - bodyW * 0.4f + r, cy + r),
                150f, 60f, false, paint,
            )
        }
    }
}

private fun drawEinkDataParticles(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: TetraVisualState,
    agentCount: Int,
) {
    if (state == TetraVisualState.ABSENT) return

    paint.color = android.graphics.Color.BLACK
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 0.8f

    // Draw dotted connection lines between active agent positions
    val slots = dev.agentdeck.terrarium.layoutOctopuses(agentCount.coerceAtLeast(1))

    if (state == TetraVisualState.STREAMING || state == TetraVisualState.CIRCLING) {
        // Draw data flow dots from primary agent to environment
        val primary = slots.firstOrNull() ?: return
        val srcX = w * primary.centerXFraction
        val srcY = h * primary.centerYFraction

        // Dotted line down to rocks area
        val dstX = w * 0.5f
        val dstY = h * 0.75f
        val dotCount = 8
        val dotRadius = 1.5f
        paint.style = Paint.Style.FILL
        for (i in 0 until dotCount) {
            val t = i.toFloat() / (dotCount - 1)
            val x = srcX + (dstX - srcX) * t
            val y = srcY + (dstY - srcY) * t + kotlin.math.sin(t * 3.14f) * h * 0.05f
            canvas.drawCircle(x, y, dotRadius, paint)
        }

        // If multiple agents, draw dotted lines between them
        if (slots.size > 1) {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 0.5f
            val dashPath = DashPathEffect(floatArrayOf(4f, 4f), 0f)
            paint.pathEffect = dashPath
            for (i in 0 until slots.size - 1) {
                val a = slots[i]
                val b = slots[i + 1]
                canvas.drawLine(
                    w * a.centerXFraction, h * a.centerYFraction,
                    w * b.centerXFraction, h * b.centerYFraction,
                    paint,
                )
            }
            paint.pathEffect = null
        }
    } else if (state == TetraVisualState.HOVERING) {
        // Small dots near options area
        paint.style = Paint.Style.FILL
        for (i in 0 until 5) {
            val x = w * (0.55f + (i % 3) * 0.04f)
            val y = h * (0.35f + (i / 3) * 0.04f)
            canvas.drawCircle(x, y, 1.5f, paint)
        }
    }
}

private fun einkStateLabel(state: TerrariumState): String {
    val creature = when (state.octopus) {
        OctopusVisualState.SLEEPING -> "Dormant"
        OctopusVisualState.FLOATING -> "Observing"
        OctopusVisualState.THINKING -> "Contemplating"
        OctopusVisualState.TYPING -> "Scribing"
        OctopusVisualState.OFFERING -> "Presenting Choice"
        OctopusVisualState.PRESENTING -> "Displaying Options"
        OctopusVisualState.REVIEWING -> "Comparing Documents"
    }
    val tool = state.currentTool?.let { " — $it" } ?: ""
    val agents = if (state.agents.size > 1) " [${state.agents.size}]" else ""
    return "$creature$tool$agents"
}

/** Vendor-specific EPD refresh control. */
object EinkRefreshHelper {
    fun requestFullRefresh(view: View) {
        try {
            // Crema: com.crema.ink.EinkDisplay.requestFullUpdate()
            val cremaClass = Class.forName("com.crema.ink.EinkDisplay")
            cremaClass.getMethod("requestFullUpdate", View::class.java).invoke(null, view)
            return
        } catch (_: Exception) {}

        try {
            // Onyx: com.onyx.android.sdk.device.Device.requestFullUpdate()
            val onyxClass = Class.forName("com.onyx.android.sdk.device.Device")
            onyxClass.getMethod("requestScreenUpdate", View::class.java).invoke(null, view)
            return
        } catch (_: Exception) {}

        // Fallback: standard invalidate
        view.invalidate()
    }

    fun requestPartialRefresh(view: View) {
        view.invalidate()
    }

    /** A2 mode — fastest binary refresh, ideal for state markers and timeline. */
    fun requestA2Refresh(view: View) {
        try {
            // Onyx: setViewDefaultUpdateMode with ANIMATION/A2
            val deviceClass = Class.forName("com.onyx.android.sdk.device.BaseDevice")
            val instance = deviceClass.getMethod("currentDevice").invoke(null)
            val updateModeClass = Class.forName("com.onyx.android.sdk.device.BaseDevice\$UpdateMode")
            val a2Mode = updateModeClass.getField("ANIMATION").get(null)
            deviceClass.getMethod("setViewDefaultUpdateMode", View::class.java, updateModeClass)
                .invoke(instance, view, a2Mode)
            view.invalidate()
            return
        } catch (_: Exception) {}

        try {
            // Crema: requestPartialUpdate for region
            val cremaClass = Class.forName("com.crema.ink.EinkDisplay")
            cremaClass.getMethod("requestPartialUpdate", View::class.java).invoke(null, view)
            return
        } catch (_: Exception) {}

        // Fallback
        view.invalidate()
    }

    /** DU mode — fast monochrome refresh, ideal for usage gauges and footer. */
    fun requestDURefresh(view: View) {
        try {
            // Onyx: setViewDefaultUpdateMode with DU
            val deviceClass = Class.forName("com.onyx.android.sdk.device.BaseDevice")
            val instance = deviceClass.getMethod("currentDevice").invoke(null)
            val updateModeClass = Class.forName("com.onyx.android.sdk.device.BaseDevice\$UpdateMode")
            val duMode = updateModeClass.getField("DU").get(null)
            deviceClass.getMethod("setViewDefaultUpdateMode", View::class.java, updateModeClass)
                .invoke(instance, view, duMode)
            view.invalidate()
            return
        } catch (_: Exception) {}

        try {
            // Crema: requestPartialUpdate
            val cremaClass = Class.forName("com.crema.ink.EinkDisplay")
            cremaClass.getMethod("requestPartialUpdate", View::class.java).invoke(null, view)
            return
        } catch (_: Exception) {}

        // Fallback
        view.invalidate()
    }
}

private const val EINK_WIDTH = 600
private const val EINK_HEIGHT = 300
