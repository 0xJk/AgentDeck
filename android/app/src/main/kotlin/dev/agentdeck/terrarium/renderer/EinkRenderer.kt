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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.neverEqualPolicy
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.IntSize
import dev.agentdeck.terrarium.CrayfishVisualState
import dev.agentdeck.terrarium.OctopusVisualState
import dev.agentdeck.terrarium.TetraVisualState
import dev.agentdeck.terrarium.TerrariumState
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/** E-ink animation frame interval (ms). 600ms for snappier movement. */
private const val EINK_ANIM_FRAME_MS = 600L

/** Total animation cycle frames — fish patrol uses the full range, creatures use % 4. */
private const val EINK_ANIM_CYCLE = 32

// --- E-ink octopus pixel grid (14×5, matching OctopusCreature) ---

private const val EINK_OCTOPUS_COLS = 14
private const val EINK_OCTOPUS_ROWS = 5
private const val EINK_PIXEL_ASPECT = 2.0f
private const val EINK_PIXEL_GAP = 0.5f
private val EINK_OCTOPUS_GRID = arrayOf(
    intArrayOf(0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0), // row 0: head (10w)
    intArrayOf(0, 0, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 0, 0), // row 1: eyes at 4,9 (10w)
    intArrayOf(3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4, 4), // row 2: body + arms (14w)
    intArrayOf(0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0), // row 3: waist (10w)
    intArrayOf(0, 0, 0, 5, 0, 5, 0, 0, 6, 0, 6, 0, 0, 0), // row 4: tentacles ×4
)

// --- E-ink crayfish SVG paths (cached, android.graphics.Path) ---

private const val EINK_SVG_VIEWBOX = 120f

private val einkCrayfishBodyPath: android.graphics.Path by lazy {
    android.graphics.Path().apply {
        moveTo(60f, 10f)
        cubicTo(30f, 10f, 15f, 35f, 15f, 55f)
        cubicTo(15f, 75f, 30f, 95f, 45f, 100f)
        lineTo(45f, 110f)
        lineTo(55f, 110f)
        lineTo(55f, 100f)
        cubicTo(55f, 100f, 60f, 102f, 65f, 100f)
        lineTo(65f, 110f)
        lineTo(75f, 110f)
        lineTo(75f, 100f)
        cubicTo(90f, 95f, 105f, 75f, 105f, 55f)
        cubicTo(105f, 35f, 90f, 10f, 60f, 10f)
        close()
    }
}

private val einkCrayfishLeftClawPath: android.graphics.Path by lazy {
    android.graphics.Path().apply {
        moveTo(20f, 45f)
        cubicTo(5f, 40f, 0f, 50f, 5f, 60f)
        cubicTo(10f, 70f, 20f, 65f, 25f, 55f)
        cubicTo(28f, 48f, 25f, 45f, 20f, 45f)
        close()
    }
}

private val einkCrayfishRightClawPath: android.graphics.Path by lazy {
    android.graphics.Path().apply {
        moveTo(100f, 45f)
        cubicTo(115f, 40f, 120f, 50f, 115f, 60f)
        cubicTo(110f, 70f, 100f, 65f, 95f, 55f)
        cubicTo(92f, 48f, 95f, 45f, 100f, 45f)
        close()
    }
}

private val einkCrayfishLeftAntennaPath: android.graphics.Path by lazy {
    android.graphics.Path().apply {
        moveTo(45f, 15f)
        quadTo(35f, 5f, 30f, 8f)
    }
}

private val einkCrayfishRightAntennaPath: android.graphics.Path by lazy {
    android.graphics.Path().apply {
        moveTo(75f, 15f)
        quadTo(85f, 5f, 90f, 8f)
    }
}

/**
 * E-ink terrarium renderer — draws creatures into an offscreen bitmap,
 * applies 16-level grayscale quantization, then renders the result.
 *
 * Style: "Marine biologist's journal" — pixel blocks + SVG outlines, native 16-level grayscale.
 * Supports slow 4-frame animation (600ms interval) for active states.
 */
@Composable
fun EinkTerrariumView(
    state: TerrariumState,
    modifier: Modifier = Modifier,
    onFrameRendered: ((isAnimationFrame: Boolean) -> Unit)? = null,
) {
    // neverEqualPolicy: bitmap is reused (same reference), so every assignment
    // must trigger recomposition even though the reference doesn't change.
    var renderedBitmap by remember { mutableStateOf<Bitmap?>(null, neverEqualPolicy()) }
    // Capture hosting Android View — postInvalidate() flushes the LAYER_TYPE_SOFTWARE
    // cache in the parent EinkRefreshZone FrameLayout, ensuring animation frames reach the EPD.
    val hostView = LocalView.current
    // Reusable render target — NOT displayed directly, only used as renderEinkFrame target
    var reusableBitmap by remember { mutableStateOf<Bitmap?>(null) }
    var animFrame by remember { mutableIntStateOf(0) }
    val currentState by rememberUpdatedState(state)

    val isAnimating = state.octopus != OctopusVisualState.SLEEPING ||
        state.crayfish != CrayfishVisualState.DORMANT

    // Unified animation loop — handles both periodic frames and state-change renders.
    // Keyed on isAnimating only; uses rememberUpdatedState to always see latest state.
    // No separate debounce LaunchedEffect, so no animFrame reset race.
    LaunchedEffect(isAnimating) {
        if (!isAnimating) {
            // Static state: render once with full dither
            val bmp = reusableBitmap ?: Bitmap.createBitmap(EINK_WIDTH, EINK_HEIGHT, Bitmap.Config.ARGB_8888)
                .also { reusableBitmap = it }
            renderedBitmap = renderEinkFrame(currentState, EINK_WIDTH, EINK_HEIGHT, 0, bmp)
            hostView.postInvalidate()
            onFrameRendered?.invoke(false)
            return@LaunchedEffect
        }
        while (isActive) {
            val bmp = reusableBitmap ?: Bitmap.createBitmap(EINK_WIDTH, EINK_HEIGHT, Bitmap.Config.ARGB_8888)
                .also { reusableBitmap = it }
            animFrame = (animFrame + 1) % EINK_ANIM_CYCLE
            // skipDither=true: all colors are pre-quantized grays, AA is off.
            // Saves ~100-200ms per frame on RK3566.
            renderedBitmap = renderEinkFrame(currentState, EINK_WIDTH, EINK_HEIGHT, animFrame, bmp, skipDither = true)
            hostView.postInvalidate()
            onFrameRendered?.invoke(true)
            delay(EINK_ANIM_FRAME_MS)
        }
    }

    // Force immediate re-render on state change (e.g. FLOATING→WORKING).
    // The animation loop picks up currentState automatically, but we also render
    // one frame immediately so the transition isn't delayed by up to 600ms.
    val agentsKey = state.agents.map { it.visualState }
    LaunchedEffect(state.octopus, state.crayfish, state.tetra, state.environment, agentsKey) {
        val bmp = reusableBitmap ?: Bitmap.createBitmap(EINK_WIDTH, EINK_HEIGHT, Bitmap.Config.ARGB_8888)
            .also { reusableBitmap = it }
        renderedBitmap = renderEinkFrame(currentState, EINK_WIDTH, EINK_HEIGHT, animFrame, bmp)
        hostView.postInvalidate()
        onFrameRendered?.invoke(false)
    }

    // Initial render
    LaunchedEffect(Unit) {
        if (renderedBitmap == null) {
            val bmp = Bitmap.createBitmap(EINK_WIDTH, EINK_HEIGHT, Bitmap.Config.ARGB_8888)
                .also { reusableBitmap = it }
            renderedBitmap = renderEinkFrame(state, EINK_WIDTH, EINK_HEIGHT, 0, bmp)
            hostView.postInvalidate()
            onFrameRendered?.invoke(false)
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

/**
 * Render a single e-ink frame with optional animation. Reuses [target] bitmap to avoid allocation.
 * [skipDither] skips the snapToNearestGray pass — safe because all draw colors are pre-quantized
 * 16-level grays and paint.isAntiAlias=false. Use for animation frames where speed matters.
 */
private fun renderEinkFrame(
    state: TerrariumState, width: Int, height: Int, animFrame: Int = 0,
    target: Bitmap? = null, skipDither: Boolean = false,
): Bitmap {
    val bitmap = if (target != null && target.width == width && target.height == height) {
        target.eraseColor(0)
        target
    } else {
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    }
    val canvas = android.graphics.Canvas(bitmap)
    val paint = Paint().apply { isAntiAlias = false }

    // Water background — entire frame is the aquarium (no inner border)
    canvas.drawColor(GRAY_WATER_BG)

    // Water surface — flat air region above water line, wave only on the boundary
    val creatureFrame = animFrame % 4
    val surfaceY = height * 0.08f
    val surfaceAmp = height * 0.012f
    val surfaceFreq = (2.0 * kotlin.math.PI / (width * 0.5)).toFloat()
    val phaseShift = creatureFrame * kotlin.math.PI.toFloat() / 2f

    // Air fill — everything above the sine wave curve.
    // The contrast between GRAY_AIR (0xEE) and GRAY_WATER_BG (0xDD) forms a natural
    // subtle water surface. No separate wave stroke needed (it was too prominent on e-ink).
    paint.style = Paint.Style.FILL
    paint.color = GRAY_AIR
    val airPath = android.graphics.Path().apply {
        moveTo(0f, 0f)
        lineTo(width.toFloat(), 0f)
        // Trace sine wave from right to left (bottom edge of air region)
        var sx = width.toFloat()
        while (sx >= 0f) {
            val sy = surfaceY + kotlin.math.sin((surfaceFreq * sx + phaseShift).toDouble()).toFloat() * surfaceAmp
            lineTo(sx, sy)
            sx -= 4f
        }
        close()
    }
    canvas.drawPath(airPath, paint)

    // Bubbles — filled + outline for e-ink visibility (4-frame cycle)
    val bubbleBasePositions = floatArrayOf(0.15f, 0.35f, 0.55f, 0.75f)
    for (i in 0 until 4) {
        val bx = width * (bubbleBasePositions[i] + (i % 2) * 0.05f) +
            (if (creatureFrame % 2 == 0) 2f else -2f) * (i % 2 * 2 - 1)
        val baseY = surfaceY + height * (0.05f + i * 0.08f)
        val by = baseY - creatureFrame * height * 0.015f
        val r = 3f + i * 0.8f
        // Inner highlight
        paint.style = Paint.Style.FILL
        paint.color = GRAY_AIR
        canvas.drawCircle(bx, by, r * 0.5f, paint)
        // Outer ring
        paint.style = Paint.Style.STROKE
        paint.color = GRAY_BUBBLE
        paint.strokeWidth = 1.0f
        canvas.drawCircle(bx, by, r, paint)
    }

    // Sand floor — subtle darker band at bottom for visual grounding
    paint.style = Paint.Style.FILL
    paint.color = GRAY_SAND
    canvas.drawRect(0f, height * 0.82f, width.toFloat(), height.toFloat(), paint)

    // Environment (4-frame cycle for seaweed sway)
    drawEinkSeaweed(canvas, paint, width, height, creatureFrame)
    drawEinkRocks(canvas, paint, width, height)
    drawEinkGravel(canvas, paint, width, height)

    // Back-layer fish (behind creatures for 3D depth)
    drawEinkDataParticles(canvas, paint, width, height, state.tetra, state.agents.size, state.crayfish, animFrame, layer = 0)

    // Creatures (4-frame cycle for limb animation)
    if (state.agents.isEmpty()) {
        // No agents — skip octopus drawing
    } else if (state.agents.size > 1) {
        val slots = dev.agentdeck.terrarium.layoutOctopuses(state.agents.size)
        for (i in state.agents.indices) {
            val slot = slots.getOrElse(i) { slots.last() }
            drawEinkOctopus(canvas, paint, width, height,
                state.agents[i].visualState, state.agents[i].agentType,
                centerXFraction = slot.centerXFraction, centerYFraction = slot.centerYFraction,
                scaleFactor = slot.scaleFactor, animFrame = creatureFrame,
                displayName = state.agents[i].displayName)
        }
    } else {
        drawEinkOctopus(canvas, paint, width, height, state.octopus, state.agentType,
            animFrame = creatureFrame,
            displayName = state.agents.getOrNull(0)?.displayName)
    }
    drawEinkCrayfish(canvas, paint, width, height, state.crayfish, creatureFrame)

    // Front-layer fish (in front of creatures for 3D depth)
    drawEinkDataParticles(canvas, paint, width, height, state.tetra, state.agents.size, state.crayfish, animFrame, layer = 1)

    // Snap to native 16-level grayscale — only needed on state-change renders.
    // Animation frames skip this because all draw colors are already pre-quantized
    // gray values and isAntiAlias=false, so the 180K-pixel pass is essentially a no-op.
    if (!skipDither) {
        DitherEngine.snapToNearestGray(bitmap)
    }

    return bitmap
}

// --- Environment ---

private fun drawEinkRocks(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int) {
    val bottomY = h * 0.82f
    paint.style = Paint.Style.FILL
    paint.color = GRAY_ROCK

    // Right rock cluster
    val rockPath = android.graphics.Path().apply {
        moveTo(w * 0.65f, h.toFloat())
        lineTo(w * 0.62f, bottomY)
        cubicTo(w * 0.68f, bottomY - h * 0.06f, w * 0.82f, bottomY - h * 0.08f, w * 0.88f, bottomY)
        lineTo(w * 0.92f, h.toFloat())
        close()
    }
    canvas.drawPath(rockPath, paint)
    // Outline for definition on e-ink
    paint.style = Paint.Style.STROKE
    paint.color = GRAY_GRAVEL
    paint.strokeWidth = 1.0f
    canvas.drawPath(rockPath, paint)
    paint.style = Paint.Style.FILL
    paint.color = GRAY_ROCK

    // Left small rocks
    val leftRock = android.graphics.Path().apply {
        moveTo(w * 0.02f, h.toFloat())
        lineTo(w * 0.04f, bottomY + h * 0.02f)
        cubicTo(w * 0.08f, bottomY - h * 0.02f, w * 0.14f, bottomY - h * 0.01f, w * 0.18f, bottomY + h * 0.03f)
        lineTo(w * 0.20f, h.toFloat())
        close()
    }
    canvas.drawPath(leftRock, paint)
    // Outline for definition
    paint.style = Paint.Style.STROKE
    paint.color = GRAY_GRAVEL
    paint.strokeWidth = 1.0f
    canvas.drawPath(leftRock, paint)

    // Sand texture lines
    paint.color = GRAY_GRAVEL
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 0.5f
    for (i in 0 until 4) {
        val y = bottomY + (h - bottomY) * (0.3f + i * 0.15f)
        canvas.drawLine(w * 0.05f, y, w * 0.25f + i * w * 0.1f, y + 2f, paint)
    }
}

private fun drawEinkSeaweed(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int, animFrame: Int = 0) {
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 2.0f
    paint.color = GRAY_SEAWEED

    // Sway offset per frame: control points shift 1-2px horizontally (4-frame cycle)
    val swayOffsets = floatArrayOf(0f, 1.5f, 0f, -1.5f)
    val sway = swayOffsets[animFrame % 4]

    // Left wall: 2 wavy stems
    for (stem in 0 until 2) {
        val baseX = w * (0.04f + stem * 0.04f)
        val stemSway = sway * (1f + stem * 0.5f) // second stem sways more
        val path = android.graphics.Path().apply {
            moveTo(baseX, h * 0.85f)
            for (seg in 0 until 4) {
                val segY = h * (0.85f - (seg + 1) * 0.12f)
                val cpX = baseX + (if (seg % 2 == 0) w * 0.02f else -w * 0.01f) + stemSway * (seg + 1) * 0.3f
                quadTo(cpX, segY + h * 0.06f, baseX + (seg % 2) * w * 0.01f + stemSway * (seg + 1) * 0.15f, segY)
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
            val cpX = rightBaseX + (if (seg % 2 == 0) -w * 0.015f else w * 0.01f) - sway * (seg + 1) * 0.3f
            quadTo(cpX, segY + h * 0.07f, rightBaseX - (seg % 2) * w * 0.005f - sway * (seg + 1) * 0.15f, segY)
        }
    }
    canvas.drawPath(rightPath, paint)
}

private fun drawEinkGravel(canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int) {
    val bottomY = h * 0.88f
    paint.color = GRAY_GRAVEL

    // Gravel: small dots along bottom
    paint.style = Paint.Style.FILL
    for (i in 0 until 20) {
        val x = w * (0.05f + i * 0.045f)
        val y = bottomY + (i % 3) * 3f
        canvas.drawCircle(x, y, 1.5f + (i % 2) * 0.8f, paint)
    }

    // Pebbles: small ovals
    paint.color = GRAY_PEBBLE
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 1.2f
    canvas.drawOval(RectF(w * 0.20f, bottomY, w * 0.26f, bottomY + h * 0.04f), paint)
    canvas.drawOval(RectF(w * 0.40f, bottomY + 2f, w * 0.45f, bottomY + h * 0.035f), paint)
    canvas.drawOval(RectF(w * 0.60f, bottomY + 1f, w * 0.64f, bottomY + h * 0.03f), paint)
}

// --- Creatures ---

/** E-ink octopus — 14×5 pixel block rendering matching the color OctopusCreature grid. */
private fun drawEinkOctopus(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: OctopusVisualState,
    agentType: String? = null,
    centerXFraction: Float = 0.38f,
    centerYFraction: Float = 0.42f,
    scaleFactor: Float = 1f,
    animFrame: Int = 0,
    displayName: String? = null,
) {
    val cx = w * centerXFraction
    // Y-position by state — staggered by X position for natural multi-session variety
    val standingOffset = (centerXFraction - 0.38f) * 0.10f
    val cy = when (state) {
        OctopusVisualState.SLEEPING -> h * (0.78f + standingOffset * 0.5f)
        OctopusVisualState.FLOATING -> h * (0.74f + standingOffset)
        OctopusVisualState.ASKING -> h * (0.74f + standingOffset)
        // WORKING: subtle vertical bob (4-frame cycle) like floating while busy
        OctopusVisualState.WORKING -> h * (centerYFraction +
            0.02f * kotlin.math.sin(animFrame * kotlin.math.PI / 8).toFloat())
    }

    // Pixel block grid — 14×5, portrait-rectangle pixels
    val bodyWidth = w * 0.14f * scaleFactor
    val pixelW = bodyWidth / EINK_OCTOPUS_COLS
    val pixelH = pixelW * EINK_PIXEL_ASPECT
    val gridW = EINK_OCTOPUS_COLS * pixelW
    val gridH = EINK_OCTOPUS_ROWS * pixelH
    val startX = cx - gridW / 2f
    val startY = cy - gridH / 2f

    // WORKING: pulsing outline behind body — visible state indicator replacing starburst
    if (state == OctopusVisualState.WORKING) {
        paint.style = Paint.Style.STROKE
        paint.color = GRAY_STARBURST
        // 4-frame pulse cycle: expand/contract outline
        val pulseR = gridW * (0.55f + (animFrame % 4) * 0.05f)
        paint.strokeWidth = 2f * scaleFactor
        canvas.drawOval(
            RectF(cx - pulseR, cy - pulseR * 0.6f, cx + pulseR, cy + pulseR * 0.6f),
            paint,
        )
    }

    // Animation (4-frame, left/right opposite phase)
    // WORKING: full amplitude for e-ink visibility; ASKING: moderate; FLOATING: near-static (match tablet)
    val tentacleScale = when (state) {
        OctopusVisualState.WORKING -> 1.0f
        OctopusVisualState.ASKING -> 0.3f
        OctopusVisualState.FLOATING -> 0f
        OctopusVisualState.SLEEPING -> 0f
    }
    val leftTentacleStretch = if (tentacleScale > 0f) tentacleScale * when (animFrame % 4) {
        0 -> pixelH * 0.3f
        1 -> pixelH * 0.8f
        2 -> -pixelH * 0.3f
        3 -> -pixelH * 0.7f
        else -> 0f
    } else 0f
    val rightTentacleStretch = -leftTentacleStretch
    val armScale = when (state) {
        OctopusVisualState.WORKING -> 1.0f
        OctopusVisualState.ASKING -> 0.3f
        OctopusVisualState.FLOATING -> 0f
        OctopusVisualState.SLEEPING -> 0f
    }
    val leftArmOffset = if (armScale > 0f) armScale * when (animFrame % 4) {
        0 -> pixelH * 0.4f
        1 -> pixelH * 0.15f
        2 -> -pixelH * 0.4f
        3 -> -pixelH * 0.15f
        else -> 0f
    } else 0f
    val rightArmOffset = -leftArmOffset
    val gap = EINK_PIXEL_GAP

    // SLEEPING: dimmer body (lighter gray = closer to background)
    val bodyGray = if (state == OctopusVisualState.SLEEPING) GRAY_SEAWEED else GRAY_OCTO_BODY
    val limbGray = if (state == OctopusVisualState.SLEEPING) GRAY_GRAVEL else GRAY_OCTO_LIMB

    paint.style = Paint.Style.FILL
    for (row in 0 until EINK_OCTOPUS_ROWS) {
        for (col in 0 until EINK_OCTOPUS_COLS) {
            val cell = EINK_OCTOPUS_GRID[row][col]
            if (cell == 0) continue

            val px = startX + col * pixelW
            var py = startY + row * pixelH

            // Arm Y-offset
            when (cell) {
                3 -> py += leftArmOffset
                4 -> py += rightArmOffset
            }

            when (cell) {
                2 -> { // EYE — white background + black pupil for e-ink visibility
                    if (state == OctopusVisualState.SLEEPING) {
                        // Closed eyes — thin horizontal slit
                        paint.color = android.graphics.Color.BLACK
                        canvas.drawRect(
                            px + gap, py + pixelH * 0.4f,
                            px + pixelW - gap, py + pixelH * 0.6f, paint,
                        )
                    } else {
                        // White eye background
                        paint.color = android.graphics.Color.WHITE
                        canvas.drawRect(
                            px + gap, py + gap,
                            px + pixelW - gap, py + pixelH - gap, paint,
                        )
                        // Black pupil (center dot)
                        paint.color = android.graphics.Color.BLACK
                        val pupilR = minOf(pixelW, pixelH) * 0.22f
                        canvas.drawCircle(
                            px + pixelW / 2f, py + pixelH / 2f, pupilR, paint,
                        )
                    }
                }
                3, 4 -> { // ARMS — darker limb gray
                    paint.color = limbGray
                    canvas.drawRect(
                        px + gap, py + gap,
                        px + pixelW - gap, py + pixelH - gap, paint,
                    )
                }
                5 -> { // LEFT_LEG — stretch height, darker limb gray
                    paint.color = limbGray
                    val legH = (pixelH + leftTentacleStretch - gap).coerceAtLeast(pixelH * 0.3f)
                    canvas.drawRect(px + gap, py, px + pixelW - gap, py + legH, paint)
                }
                6 -> { // RIGHT_LEG — stretch height, darker limb gray
                    paint.color = limbGray
                    val legH = (pixelH + rightTentacleStretch - gap).coerceAtLeast(pixelH * 0.3f)
                    canvas.drawRect(px + gap, py, px + pixelW - gap, py + legH, paint)
                }
                else -> { // BODY (cell=1) — lighter body gray
                    paint.color = bodyGray
                    canvas.drawRect(
                        px + gap, py + gap,
                        px + pixelW - gap, py + pixelH - gap, paint,
                    )
                }
            }
        }
    }

    // ASKING: speech bubble with "?"
    if (state == OctopusVisualState.ASKING) {
        val bubbleR = gridW * 0.25f * scaleFactor
        val bubbleX = cx + gridW * 0.6f
        val bubbleY = (startY - gridH * 0.3f).coerceAtLeast(bubbleR + 2f)

        // Bubble circle
        paint.color = GRAY_AIR
        paint.style = Paint.Style.FILL
        canvas.drawCircle(bubbleX, bubbleY, bubbleR, paint)
        paint.color = GRAY_OCTO_LIMB
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.5f * scaleFactor
        canvas.drawCircle(bubbleX, bubbleY, bubbleR, paint)

        // "?" text
        paint.color = android.graphics.Color.BLACK
        paint.style = Paint.Style.FILL
        paint.textSize = bubbleR * 1.4f
        paint.textAlign = Paint.Align.CENTER
        canvas.drawText("?", bubbleX, bubbleY + bubbleR * 0.45f, paint)
        paint.textAlign = Paint.Align.LEFT
    }

    // Name tag (multi-session only)
    if (displayName != null) {
        drawEinkNameTag(canvas, paint, cx, startY, scaleFactor, displayName, w)
    }
}

/** E-ink name tag above octopus — adaptive font with 2-line wrapping, text-fit width. */
private fun drawEinkNameTag(
    canvas: android.graphics.Canvas, paint: Paint,
    cx: Float, startY: Float, scaleFactor: Float,
    name: String, w: Int,
) {
    val baseFontSize = w * 0.024f * scaleFactor
    val maxTagWidth = w * 0.16f * scaleFactor * 1.8f
    val maxTextWidth = maxTagWidth * 0.9f
    val hPad = baseFontSize * 0.6f  // horizontal padding each side
    val gap = baseFontSize * 0.4f

    // 3-tier adaptive font: 100% → 75% → 60%
    val tiers = floatArrayOf(1.0f, 0.75f, 0.60f)
    var chosenSize = baseFontSize
    var lines = listOf(name)

    paint.textAlign = Paint.Align.CENTER
    for (tier in tiers) {
        chosenSize = baseFontSize * tier
        paint.textSize = chosenSize
        val textWidth = paint.measureText(name)
        if (textWidth <= maxTextWidth) {
            lines = listOf(name)
            break
        }
        if (tier == tiers.last()) {
            lines = einkWrapToTwoLines(name, paint, maxTextWidth)
        }
    }

    // Dynamic width: measure actual text + minimal padding
    val measuredMaxLine = lines.maxOf { paint.measureText(it) }
    val tagWidth = (measuredMaxLine + hPad * 2).coerceAtMost(maxTagWidth)

    val lineHeight = chosenSize * 1.3f
    val tagHeight = if (lines.size == 1) chosenSize * 1.6f else lineHeight * lines.size + chosenSize * 0.4f
    val tagTop = (startY - tagHeight - gap).coerceAtLeast(2f)

    // Background rounded rect for readability
    paint.color = GRAY_WATER_BG
    paint.style = Paint.Style.FILL
    val rect = RectF(cx - tagWidth / 2, tagTop, cx + tagWidth / 2, tagTop + tagHeight)
    canvas.drawRoundRect(rect, 3f, 3f, paint)
    // Border for separation from background
    paint.color = GRAY_OCTO_LIMB
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 1f
    canvas.drawRoundRect(rect, 3f, 3f, paint)

    // Text in dark gray for contrast
    paint.color = GRAY_CREATURE
    paint.style = Paint.Style.FILL
    paint.textSize = chosenSize

    if (lines.size == 1) {
        canvas.drawText(lines[0], cx, tagTop + tagHeight * 0.65f, paint)
    } else {
        val topTextY = tagTop + chosenSize * 0.3f + chosenSize
        for (i in lines.indices) {
            canvas.drawText(lines[i], cx, topTextY + i * lineHeight, paint)
        }
    }

    paint.textAlign = Paint.Align.LEFT
}

/** Split text into 2 lines at the space that minimizes max line width. */
private fun einkWrapToTwoLines(text: String, paint: Paint, maxWidth: Float): List<String> {
    val spaces = text.indices.filter { text[it] == ' ' }
    if (spaces.isEmpty()) return listOf(text)

    var bestSplit = spaces.minByOrNull { kotlin.math.abs(it - text.length / 2) } ?: return listOf(text)
    var bestMax = Float.MAX_VALUE

    for (sp in spaces) {
        val w1 = paint.measureText(text, 0, sp)
        val w2 = paint.measureText(text, sp + 1, text.length)
        val maxW = maxOf(w1, w2)
        if (maxW < bestMax) {
            bestMax = maxW
            bestSplit = sp
        }
    }

    return listOf(text.substring(0, bestSplit), text.substring(bestSplit + 1))
}

/** E-ink crayfish — front-facing SVG path rendering with claw/antenna animation. */
private fun drawEinkCrayfish(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: CrayfishVisualState,
    animFrame: Int = 0,
) {
    val cx = w * 0.75f
    // Y-position by state — sitting on rock when idle, floating up when active
    // ROUTING: bob animation (match tablet's sin(time*3f) * 0.05f)
    val baseY = when (state) {
        CrayfishVisualState.DORMANT -> h * 0.82f
        CrayfishVisualState.SITTING -> h * 0.72f
        CrayfishVisualState.ROUTING -> h * 0.55f
        CrayfishVisualState.OBSERVING -> h * 0.62f
        CrayfishVisualState.WAITING -> h * 0.60f
    }
    val bobOffset = when (state) {
        CrayfishVisualState.ROUTING -> h * 0.015f * kotlin.math.sin(animFrame * kotlin.math.PI / 6).toFloat()
        else -> 0f
    }
    val cy = baseY + bobOffset
    val bodyWidth = w * 0.14f

    if (state == CrayfishVisualState.DORMANT) {
        // Only show antenna tips above rocks
        paint.color = GRAY_CRAY_BODY
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.5f
        canvas.drawLine(cx - bodyWidth * 0.1f, cy - bodyWidth * 0.1f,
            cx - bodyWidth * 0.3f, cy - bodyWidth * 0.4f, paint)
        canvas.drawLine(cx + bodyWidth * 0.1f, cy - bodyWidth * 0.1f,
            cx + bodyWidth * 0.3f, cy - bodyWidth * 0.4f, paint)
        return
    }

    val scale = bodyWidth / EINK_SVG_VIEWBOX
    val offsetX = cx - EINK_SVG_VIEWBOX / 2f * scale
    val offsetY = cy - EINK_SVG_VIEWBOX / 2f * scale

    // Claw animation — amplified for e-ink visibility, all 4 frames non-zero
    val clawAngle = when (state) {
        CrayfishVisualState.ROUTING -> when (animFrame % 4) {
            0 -> 10f; 1 -> 30f; 2 -> -8f; 3 -> -20f; else -> 0f
        }
        CrayfishVisualState.OBSERVING -> when (animFrame % 4) {
            0 -> 5f; 1 -> 15f; 2 -> -3f; 3 -> -10f; else -> 0f
        }
        CrayfishVisualState.SITTING -> when (animFrame % 4) {
            0 -> 1f; 1 -> 3f; 2 -> 0f; 3 -> -2f; else -> 0f
        }
        CrayfishVisualState.WAITING -> 18f  // claws open wide
        else -> 0f
    }

    // Antenna wiggle — amplified, all 4 frames moving
    val antennaWiggle = when (state) {
        CrayfishVisualState.ROUTING -> when (animFrame % 4) {
            0 -> 2f; 1 -> 5f; 2 -> -2f; 3 -> -5f; else -> 0f
        }
        CrayfishVisualState.SITTING -> when (animFrame % 4) {
            0 -> 0f; 1 -> 1f; 2 -> 0f; 3 -> -1f; else -> 0f
        }
        else -> 0f
    }

    canvas.save()
    canvas.translate(offsetX, offsetY)
    canvas.scale(scale, scale)

    // 1. Body — filled with body gray
    paint.style = Paint.Style.FILL
    paint.color = GRAY_CRAY_BODY
    canvas.drawPath(einkCrayfishBodyPath, paint)

    // 2. Left claw with rotation — darker claw gray
    paint.color = GRAY_CRAY_CLAW
    canvas.save()
    canvas.rotate(-clawAngle, 20f, 45f)
    canvas.drawPath(einkCrayfishLeftClawPath, paint)
    canvas.restore()

    // 3. Right claw with rotation
    canvas.save()
    canvas.rotate(clawAngle, 100f, 45f)
    canvas.drawPath(einkCrayfishRightClawPath, paint)
    canvas.restore()

    // 4. Antennae — stroked with body gray
    paint.color = GRAY_CRAY_BODY
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 3f
    paint.strokeCap = Paint.Cap.ROUND

    canvas.save()
    canvas.translate(antennaWiggle, 0f)
    canvas.drawPath(einkCrayfishLeftAntennaPath, paint)
    canvas.restore()

    canvas.save()
    canvas.translate(-antennaWiggle, 0f)
    canvas.drawPath(einkCrayfishRightAntennaPath, paint)
    canvas.restore()

    // 5. Eyes — white circles on black body
    paint.style = Paint.Style.FILL
    paint.color = android.graphics.Color.WHITE
    canvas.drawCircle(45f, 35f, 6f, paint)
    canvas.drawCircle(75f, 35f, 6f, paint)

    // Eye pupils
    paint.color = android.graphics.Color.BLACK
    canvas.drawCircle(46f, 34f, 2.5f, paint)
    canvas.drawCircle(76f, 34f, 2.5f, paint)

    canvas.restore() // main transform

    // ROUTING: signal arcs (outside SVG transform)
    if (state == CrayfishVisualState.ROUTING) {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1.5f
        paint.color = GRAY_SIGNAL
        paint.strokeCap = Paint.Cap.BUTT
        for (i in 1..3) {
            val r = bodyWidth * 0.15f * i
            canvas.drawArc(
                RectF(cx - r, cy - r, cx + r, cy + r),
                150f, 60f, false, paint,
            )
        }
    }
}

// --- Data particles & labels ---

/**
 * Two-school neon tetra — 10 fish (5+5) optimized for e-ink 600ms frames.
 *
 * School A (5 fish, indices 0-4): left-start elliptical orbit
 * School B (5 fish, indices 5-9): right-start, different period
 *
 * E-ink strategy: heading from path derivative, per-fish orbit speeds, tail wiggle.
 * Depth layers: indices 0-3/5-8 = front, 4/9 = back (smaller, behind creatures).
 *
 * STREAMING: school centers pull 30% toward WORKING octopus + data particles orbit.
 * HOVERING: 7 fish gather near options area, 3 drift at distance.
 */
private const val EINK_FISH_COUNT = 10
private const val EINK_FISH_PER_SCHOOL = 5

private fun drawEinkDataParticles(
    canvas: android.graphics.Canvas, paint: Paint, w: Int, h: Int,
    state: TetraVisualState,
    agentCount: Int,
    crayfishState: CrayfishVisualState = CrayfishVisualState.DORMANT,
    animFrame: Int = 0,
    layer: Int = -1, // -1 = all, 0 = back (behind creatures), 1 = front
) {
    if (state == TetraVisualState.ABSENT) return

    val slots = dev.agentdeck.terrarium.layoutOctopuses(agentCount.coerceAtLeast(1))
    val crayfishRouting = crayfishState == CrayfishVisualState.ROUTING
    val fishSize = w * 0.014f  // slightly larger with fewer fish
    val frame = animFrame.toFloat()

    if (state == TetraVisualState.STREAMING || state == TetraVisualState.CIRCLING) {
        // School center elliptical orbits
        val angA = frame * 0.14
        val angB = frame * 0.11
        var cxA = 0.30f + 0.22f * kotlin.math.cos(angA).toFloat()
        var cyA = 0.38f + 0.18f * kotlin.math.sin(angA * 1.3).toFloat()
        var cxB = 0.60f + 0.22f * kotlin.math.cos(angB).toFloat()
        var cyB = 0.42f + 0.18f * kotlin.math.sin(angB * 1.3).toFloat()

        // School velocity direction for heading
        val vxA = -kotlin.math.sin(angA).toFloat()
        val vxB = -kotlin.math.sin(angB).toFloat()

        // STREAMING: pull toward active agent (octopus or crayfish)
        if (state == TetraVisualState.STREAMING) {
            val pullX: Float
            val pullY: Float
            if (agentCount > 0 && slots.isNotEmpty()) {
                // Pull toward working octopus
                pullX = slots[0].centerXFraction
                pullY = slots[0].centerYFraction +
                    0.02f * kotlin.math.sin(animFrame * kotlin.math.PI / 8).toFloat()
            } else if (crayfishRouting) {
                // No octopuses — pull toward routing crayfish
                pullX = 0.75f  // crayfish e-ink X
                pullY = 0.55f  // crayfish ROUTING Y
            } else {
                pullX = Float.NaN
                pullY = Float.NaN
            }
            if (!pullX.isNaN()) {
                val pull = 0.30f
                cxA += (pullX - cxA) * pull; cyA += (pullY - cyA) * pull
                cxB += (pullX - cxB) * pull; cyB += (pullY - cyB) * pull
            }
        }

        val spacing = w * 0.032f

        for (i in 0 until EINK_FISH_COUNT) {
            // Depth: last fish of each school (4, 9) = back layer
            val fishLayer = if (i % EINK_FISH_PER_SCHOOL == EINK_FISH_PER_SCHOOL - 1) 0 else 1
            if (layer != -1 && fishLayer != layer) continue
            val depthScale = if (fishLayer == 0) 0.80f else 1.0f

            val schoolA = i < EINK_FISH_PER_SCHOOL
            val baseX = if (schoolA) w * cxA else w * cxB
            val baseY = if (schoolA) h * cyA else h * cyB

            val localIdx = i % EINK_FISH_PER_SCHOOL
            val fishAng = frame * (0.18 + localIdx * 0.05) + localIdx * 1.26
            val dx = kotlin.math.cos(fishAng).toFloat() * spacing * (0.6f + localIdx * 0.15f)
            val dy = kotlin.math.sin(fishAng * 0.7).toFloat() * spacing * 0.5f

            val fx = (baseX + dx).coerceIn(w * 0.05f, w * 0.95f)
            val fy = (baseY + dy).coerceIn(h * 0.10f, h * 0.72f)

            val fishVx = -kotlin.math.sin(fishAng).toFloat()
            val schoolVx = if (schoolA) vxA else vxB
            val heading = if (fishVx + schoolVx * 0.5f >= 0f) 0f else 180f
            val tailPhase = (animFrame + localIdx * 2) % 4

            drawEinkFish(canvas, paint, fx, fy, fishSize * depthScale, heading, tailPhase)
        }

        // STREAMING: data particles (orbit around active agent or crayfish)
        if (state == TetraVisualState.STREAMING && (layer == -1 || layer == 1)) {
            val particleCenterX: Float
            val particleCenterY: Float
            if (agentCount > 0 && slots.isNotEmpty()) {
                particleCenterX = w * slots[0].centerXFraction
                particleCenterY = h * (slots[0].centerYFraction +
                    0.02f * kotlin.math.sin(animFrame * kotlin.math.PI / 8).toFloat())
            } else if (crayfishRouting) {
                particleCenterX = w * 0.75f
                particleCenterY = h * 0.55f
            } else {
                particleCenterX = Float.NaN
                particleCenterY = Float.NaN
            }
            if (!particleCenterX.isNaN()) {
                val agentX = particleCenterX
                val agentY = particleCenterY
                val particleR = w * 0.06f
                paint.style = Paint.Style.FILL
                paint.color = GRAY_PARTICLE
                for (p in 0 until 4) {
                    val angle = animFrame * 0.8 + p * kotlin.math.PI / 2.0
                    val pr = particleR * (0.6f + 0.4f * kotlin.math.sin(animFrame * 0.5 + p * 1.2).toFloat())
                    val px = agentX + kotlin.math.cos(angle).toFloat() * pr
                    val py = agentY + kotlin.math.sin(angle).toFloat() * pr
                    canvas.drawCircle(px, py, 1.5f + (p % 2) * 0.5f, paint)
                }
            }
        }

        // Dashed lines between agents (front layer only)
        if ((layer == -1 || layer == 1) && slots.size > 1) {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 0.5f
            paint.color = GRAY_PARTICLE
            paint.pathEffect = DashPathEffect(floatArrayOf(4f, 4f), 0f)
            for (i in 0 until slots.size - 1) {
                val a = slots[i]; val b = slots[i + 1]
                canvas.drawLine(w * a.centerXFraction, h * a.centerYFraction,
                    w * b.centerXFraction, h * b.centerYFraction, paint)
            }
            paint.pathEffect = null
        }
    } else if (state == TetraVisualState.HOVERING) {
        val driftAng = frame * 0.12
        val nearX = w * 0.45f + w * 0.012f * kotlin.math.cos(driftAng).toFloat()
        val nearY = h * 0.35f

        for (i in 0 until EINK_FISH_COUNT) {
            val fishLayer = if (i % EINK_FISH_PER_SCHOOL == EINK_FISH_PER_SCHOOL - 1) 0 else 1
            if (layer != -1 && fishLayer != layer) continue
            val depthScale = if (fishLayer == 0) 0.80f else 1.0f

            val isNear = i < 7  // 7 gather, 3 drift
            val localIdx = i % EINK_FISH_PER_SCHOOL
            val bx: Float; val by: Float; val vx: Float
            if (isNear) {
                val ang = frame * (0.12 + localIdx * 0.03) + localIdx * 1.1
                bx = nearX + kotlin.math.cos(ang).toFloat() * w * 0.04f
                by = nearY + kotlin.math.sin(ang * 0.8).toFloat() * h * 0.03f
                vx = -kotlin.math.sin(ang).toFloat()
            } else {
                val ang = frame * (0.08 + i * 0.02) + i * 2.1
                bx = w * 0.50f + kotlin.math.cos(ang).toFloat() * w * 0.10f
                by = h * 0.45f + kotlin.math.sin(ang * 0.7).toFloat() * h * 0.06f
                vx = -kotlin.math.sin(ang).toFloat()
            }

            val fx = bx.coerceIn(w * 0.05f, w * 0.95f)
            val fy = by.coerceIn(h * 0.10f, h * 0.72f)
            val heading = if (vx >= 0f) 0f else 180f
            val tailPhase = (animFrame + localIdx * 2) % 4

            drawEinkFish(canvas, paint, fx, fy, fishSize * depthScale, heading, tailPhase)
        }
    }
}

/**
 * Draw a single e-ink fish — teardrop body with neon stripe, animated tail.
 * [tailPhase] 0-3 drives tail wiggle (4 positions per cycle).
 */
private fun drawEinkFish(
    canvas: android.graphics.Canvas, paint: Paint,
    cx: Float, cy: Float, size: Float, heading: Float,
    tailPhase: Int = 0,
) {
    canvas.save()
    canvas.rotate(heading, cx, cy)

    val halfLen = size * 1.8f
    val halfH = size * 0.75f
    // Tail wiggle: 4-phase sinusoidal offset (±30% of halfH)
    val tailWiggle = when (tailPhase % 4) {
        0 -> 0f
        1 -> halfH * 0.30f
        2 -> 0f
        else -> -halfH * 0.30f
    }

    // Body — asymmetric diamond (wider toward head for fish shape)
    paint.style = Paint.Style.FILL
    paint.color = GRAY_FISH_BODY
    val bodyPath = android.graphics.Path().apply {
        moveTo(cx + halfLen, cy)                         // nose
        lineTo(cx + halfLen * 0.1f, cy - halfH)         // top (shifted forward)
        lineTo(cx - halfLen, cy + tailWiggle)            // tail base (wiggle)
        lineTo(cx + halfLen * 0.1f, cy + halfH)         // bottom
        close()
    }
    canvas.drawPath(bodyPath, paint)

    // Body outline for e-ink crispness
    paint.style = Paint.Style.STROKE
    paint.color = GRAY_CREATURE
    paint.strokeWidth = 0.8f
    canvas.drawPath(bodyPath, paint)

    // Neon stripe — lighter highlight for the signature tetra feature
    paint.color = GRAY_FISH_STRIPE
    paint.strokeWidth = size * 0.22f
    paint.strokeCap = Paint.Cap.ROUND
    canvas.drawLine(cx - halfLen * 0.3f, cy, cx + halfLen * 0.6f, cy, paint)

    // Tail — filled forked V with wiggle
    paint.color = GRAY_FISH_BODY
    paint.style = Paint.Style.FILL
    val tailX = cx - halfLen
    val tailPath = android.graphics.Path().apply {
        moveTo(tailX, cy + tailWiggle)
        lineTo(tailX - halfLen * 0.4f, cy + tailWiggle - halfH * 0.9f)
        lineTo(tailX + halfLen * 0.1f, cy + tailWiggle)
        lineTo(tailX - halfLen * 0.4f, cy + tailWiggle + halfH * 0.9f)
        close()
    }
    canvas.drawPath(tailPath, paint)
    paint.style = Paint.Style.STROKE
    paint.color = GRAY_CREATURE
    paint.strokeWidth = 0.6f
    canvas.drawPath(tailPath, paint)

    // Eye — white with black pupil for visibility
    paint.style = Paint.Style.FILL
    paint.color = android.graphics.Color.WHITE
    canvas.drawCircle(cx + halfLen * 0.45f, cy - halfH * 0.15f, size * 0.14f, paint)
    paint.color = android.graphics.Color.BLACK
    canvas.drawCircle(cx + halfLen * 0.45f, cy - halfH * 0.15f, size * 0.07f, paint)

    canvas.restore()
}

/**
 * Vendor-specific EPD refresh control.
 *
 * Rockchip RK3566 (Crema S, Xiaomi Reader, etc.):
 *   Uses `android.os.EinkManager` system service with string-based mode constants.
 *   Reference: KOReader's RK35xxEPDController.
 *   EPD modes: "2"=FULL_GC16, "7"=PART_GC16, "12"=A2, "14"=DU
 *
 * Onyx Boox (Qualcomm):
 *   Uses `com.onyx.android.sdk.device.BaseDevice` with UpdateMode enum.
 */
object EinkRefreshHelper {

    // Rockchip EPD mode constants (string values for EinkManager.setMode)
    private const val RK_EPD_FULL_GC16 = "2"
    private const val RK_EPD_A2 = "12"
    private const val RK_EPD_DU = "14"

    /** Full GC16 refresh — 16-level grayscale, full flash. */
    fun requestFullRefresh(view: View) {
        // Rockchip RK3566: EinkManager.sendOneFullFrame() forces GC16 full refresh
        if (tryRockchipRefresh(view, RK_EPD_FULL_GC16, sendFullFrame = true)) return

        try {
            // Onyx: com.onyx.android.sdk.device.Device.requestScreenUpdate()
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
        if (tryRockchipRefresh(view, RK_EPD_A2)) return

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

        // Fallback
        view.invalidate()
    }

    /** GC16 partial refresh without full-screen flash — for animation frames. */
    fun requestAnimationRefresh(view: View) {
        if (tryRockchipRefresh(view, RK_EPD_FULL_GC16, sendFullFrame = false)) return
        // Onyx/fallback: standard invalidate
        view.invalidate()
    }

    /** DU mode — fast monochrome refresh, ideal for usage gauges and footer. */
    fun requestDURefresh(view: View) {
        if (tryRockchipRefresh(view, RK_EPD_DU)) return

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

        // Fallback
        view.invalidate()
    }

    /**
     * Rockchip RK35xx EPD refresh via android.os.EinkManager system service.
     * Sets display mode and optionally triggers a full GC16 frame.
     */
    @android.annotation.SuppressLint("WrongConstant")
    private fun tryRockchipRefresh(view: View, mode: String, sendFullFrame: Boolean = false): Boolean {
        return try {
            val einkManagerClass = Class.forName("android.os.EinkManager")
            val einkManager = view.context.getSystemService("eink") ?: return false

            // Set EPD waveform mode
            val setMode = einkManagerClass.getDeclaredMethod("setMode", String::class.java)
            setMode.invoke(einkManager, mode)

            if (sendFullFrame) {
                // Force a single full-screen GC16 refresh (guaranteed grayscale)
                val sendOneFullFrame = einkManagerClass.getDeclaredMethod("sendOneFullFrame")
                sendOneFullFrame.invoke(einkManager)
            }

            view.invalidate()
            true
        } catch (_: Exception) {
            false
        }
    }
}

/** Snap coordinate to nearest grid multiple for retro pixel-art feel. */
private fun snapToGrid(value: Float, grid: Float): Float =
    kotlin.math.round(value / grid) * grid

private const val EINK_WIDTH = 600
private const val EINK_HEIGHT = 300

/**
 * Native 16-level grayscale palette for e-ink hardware.
 * Values mapped to hardware gray levels (0=black, 255=white, step ~17).
 * Spread across the full range for visible tonal separation on e-ink.
 */
private const val GRAY_WATER_BG   = 0xFFDDDDDD.toInt()  // level 13 — water background (frame = water)
private const val GRAY_CREATURE   = 0xFF222222.toInt()  // level 2 — eyes, outlines, darkest details
private const val GRAY_ROCK       = 0xFF999999.toInt()  // level 9 — rocks (lighter than creatures for contrast)
private const val GRAY_OCTO_BODY  = 0xFF444444.toInt()  // level 4 — octopus body (mid-dark gray)
private const val GRAY_OCTO_LIMB  = 0xFF333333.toInt()  // level 3 — octopus arms/tentacles (darker than body)
private const val GRAY_CRAY_BODY  = 0xFF333333.toInt()  // level 3 — crayfish body (dark, stands out from rocks)
private const val GRAY_CRAY_CLAW  = 0xFF222222.toInt()  // level 2 — crayfish claws (darkest)
private const val GRAY_STARBURST  = 0xFF999999.toInt()  // level 9 — WORKING starburst glow
private const val GRAY_DECORATION = 0xFF444444.toInt()  // level 4 — keyboard, review docs
private const val GRAY_SEAWEED    = 0xFF666666.toInt()  // level 6 — seaweed stems
private const val GRAY_SIGNAL     = 0xFF555555.toInt()  // level 5 — signal arcs
private const val GRAY_GRAVEL     = 0xFF777777.toInt()  // level 7 — gravel, sand
private const val GRAY_WAVE       = 0xFF777777.toInt()  // level 7 — water surface stroke
private const val GRAY_PEBBLE     = 0xFF999999.toInt()  // level 9 — pebbles
private const val GRAY_PARTICLE   = 0xFF888888.toInt()  // level 8 — data particles
private const val GRAY_FISH_BODY  = 0xFF555555.toInt()  // level 5 — fish body (darker for water contrast)
private const val GRAY_FISH_STRIPE = 0xFFBBBBBB.toInt() // level 11 — fish neon stripe highlight
private const val GRAY_BUBBLE     = 0xFFAAAAAA.toInt()  // level 10 — bubbles
private const val GRAY_SAND       = 0xFFCCCCCC.toInt()  // level 12 — sand floor (subtle against water)
private const val GRAY_AIR        = 0xFFEEEEEE.toInt()  // level 14 — air above surface

