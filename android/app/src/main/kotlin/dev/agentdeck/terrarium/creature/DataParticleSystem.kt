package dev.agentdeck.terrarium.creature

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import dev.agentdeck.terrarium.TetraVisualState
import dev.agentdeck.terrarium.TerrariumColors
import dev.agentdeck.terrarium.TerrariumLayout
import dev.agentdeck.terrarium.TerrariumTiming
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * Neon Tetra school + food crumb system.
 *
 * WORKING octopuses scatter glowing data crumbs as they swim.
 * Tetras flock toward and consume the crumbs — visualizing data flow
 * as a natural feeding behavior.
 *
 * States:
 * - STREAMING: frequent food spawns, tetras dart aggressively
 * - CIRCLING: slow food spawns, tetras orbit lazily
 * - HOVERING: no food, tetras drift near option area
 * - ABSENT: all hidden
 */
class DataParticleSystem : Creature {

    // --- Neon Tetra ---

    private data class NeonTetra(
        var x: Float, var y: Float,
        var vx: Float, var vy: Float,
        var heading: Float,
        var targetHeading: Float,
        var turnRate: Float,       // current angular velocity — drives body bend
        var alpha: Float,
        var alive: Boolean,
        var tailPhase: Float,
        var bodyPhase: Float,
        var zLayer: Int,           // 0=back (behind creatures), 1=front (in front of creatures)
        var schoolId: Int,         // 0 or 1 — which school this fish belongs to
    )

    // --- Food crumbs (data particles scattered by working agents) ---

    private data class FoodCrumb(
        var x: Float, var y: Float,
        var alpha: Float,
        var alive: Boolean,
        var age: Float,
        var color: Color,
        var driftX: Float, var driftY: Float,
        var pulsePhase: Float,
    )

    private var visualState by mutableStateOf(TetraVisualState.CIRCLING)
    private var time by mutableFloatStateOf(0f)
    private val school = Array(SCHOOL_SIZE) {
        val sid = it % 2
        NeonTetra(
            x = 0.3f + Random.nextFloat() * 0.3f,
            y = 0.25f + Random.nextFloat() * 0.3f,
            vx = (Random.nextFloat() - 0.5f) * 0.02f,
            vy = (Random.nextFloat() - 0.5f) * 0.02f,
            heading = 0f,
            targetHeading = 0f,
            turnRate = 0f,
            alpha = 1f,
            alive = false,
            tailPhase = Random.nextFloat() * 2f * PI.toFloat(),
            bodyPhase = Random.nextFloat() * 2f * PI.toFloat(),
            zLayer = it % 2, // alternate back/front layers
            schoolId = sid,
        )
    }
    private val foodCrumbs = Array(MAX_FOOD) {
        FoodCrumb(0f, 0f, 0f, false, 0f, FOOD_COLORS[0], 0f, 0f, 0f)
    }
    private var foodSpawnTimer = 0f

    /** Live octopus positions (all agents). */
    private var liveAgentPositions: List<Pair<Float, Float>> = emptyList()
    /** Positions of WORKING agents only (food scatter sources). */
    private var workingAgentPositions: List<Pair<Float, Float>> = emptyList()

    fun setState(newState: TetraVisualState) {
        val wasAbsent = visualState == TetraVisualState.ABSENT
        visualState = newState
        if (newState == TetraVisualState.ABSENT) {
            for (t in school) t.alive = false
            for (f in foodCrumbs) f.alive = false
        } else if (wasAbsent) {
            for (t in school) spawnTetra(t)
        }
    }

    /** Update all agent positions (for general awareness). */
    fun setLiveAgentPositions(positions: List<Pair<Float, Float>>) {
        liveAgentPositions = positions
    }

    /** Update WORKING agent positions (food scatter sources). */
    fun setWorkingAgentPositions(positions: List<Pair<Float, Float>>) {
        workingAgentPositions = positions
    }

    // Keep setAgentPositions for backward compat (MonitorScreen state effect)
    fun setAgentPositions(
        slots: List<dev.agentdeck.terrarium.CreatureSlot>,
        states: List<dev.agentdeck.terrarium.AgentCreatureState>,
    ) {
        // No-op — we use live positions now
    }

    override fun update(dt: Float) {
        time += dt
        if (visualState == TetraVisualState.ABSENT) return

        // Ensure all fish are alive
        for (t in school) {
            if (!t.alive) spawnTetra(t)
        }

        // --- Food crumb spawning (from WORKING agents) ---
        if (workingAgentPositions.isNotEmpty()) {
            foodSpawnTimer += dt
            val spawnRate = when (visualState) {
                TetraVisualState.STREAMING -> 0.06f  // rapid during tool use
                TetraVisualState.CIRCLING -> 0.2f    // frequent ambient
                else -> Float.MAX_VALUE
            }
            if (foodSpawnTimer >= spawnRate) {
                foodSpawnTimer = 0f
                spawnFoodCrumb()
            }
        }

        // --- Food crumb update ---
        for (f in foodCrumbs) {
            if (!f.alive) continue
            f.age += dt
            // Slow drift
            f.x += f.driftX * dt
            f.y += f.driftY * dt
            f.pulsePhase += dt * 3f
            // Natural fade over lifetime
            f.alpha = ((FOOD_LIFETIME - f.age) / FOOD_LIFETIME).coerceIn(0f, 1f)
            if (f.age >= FOOD_LIFETIME) f.alive = false
        }

        // --- School center Lissajous paths (two independent wandering centers) ---
        val schoolCenterX0 = 0.35f + 0.18f * sin(time * 0.15f)
        val schoolCenterY0 = 0.35f + 0.12f * sin(time * 0.21f)
        val schoolCenterX1 = 0.55f + 0.18f * cos(time * 0.13f)
        val schoolCenterY1 = 0.40f + 0.12f * cos(time * 0.18f)

        // --- Boids update ---
        for (i in school.indices) {
            val fish = school[i]
            if (!fish.alive) continue

            // Accumulate Boids forces
            var sepX = 0f; var sepY = 0f
            var aliX = 0f; var aliY = 0f
            var cohX = 0f; var cohY = 0f
            var sepCount = 0; var aliCount = 0; var cohCount = 0

            for (j in school.indices) {
                if (i == j || !school[j].alive) continue
                val other = school[j]
                val dx = other.x - fish.x
                val dy = other.y - fish.y
                val dist = sqrt(dx * dx + dy * dy).coerceAtLeast(0.001f)

                // Separation: all fish (both schools avoid collision)
                if (dist < TerrariumTiming.SEPARATION_RADIUS) {
                    sepX -= dx / dist
                    sepY -= dy / dist
                    sepCount++
                }
                // Alignment + Cohesion: same school only
                if (other.schoolId == fish.schoolId) {
                    if (dist < TerrariumTiming.ALIGNMENT_RADIUS) {
                        aliX += other.vx
                        aliY += other.vy
                        aliCount++
                    }
                    if (dist < TerrariumTiming.COHESION_RADIUS) {
                        cohX += other.x
                        cohY += other.y
                        cohCount++
                    }
                }
            }

            if (sepCount > 0) { sepX /= sepCount; sepY /= sepCount }
            if (aliCount > 0) { aliX /= aliCount; aliY /= aliCount }
            if (cohCount > 0) {
                cohX = cohX / cohCount - fish.x
                cohY = cohY / cohCount - fish.y
            }

            // School attractor: pull toward own school center (Lissajous path)
            val scX = if (fish.schoolId == 0) schoolCenterX0 else schoolCenterX1
            val scY = if (fish.schoolId == 0) schoolCenterY0 else schoolCenterY1
            var schX = (scX - fish.x) * SCHOOL_ATTRACTOR_WEIGHT
            var schY = (scY - fish.y) * SCHOOL_ATTRACTOR_WEIGHT

            // Attractor: chase nearest food crumb
            var attX = 0f; var attY = 0f
            var hasFood = false
            when (visualState) {
                TetraVisualState.STREAMING, TetraVisualState.CIRCLING -> {
                    val nearestFood = findNearestFood(fish.x, fish.y)
                    if (nearestFood != null) {
                        hasFood = true
                        // Chase food! — prefer horizontal approach
                        val dx = nearestFood.x - fish.x
                        val dy = nearestFood.y - fish.y
                        val dist = sqrt(dx * dx + dy * dy).coerceAtLeast(0.001f)
                        val strength = if (visualState == TetraVisualState.STREAMING) 1.0f else 0.5f
                        attX = dx / dist * strength
                        attY = dy / dist * strength * 0.4f  // reduced vertical pull

                        // Eat food when close enough
                        if (dist < FOOD_EAT_RADIUS) {
                            nearestFood.alpha *= 0.6f  // rapid fade
                            nearestFood.age += dt * 4f // accelerate death
                        }
                    } else {
                        // No food: gentle orbit around agents
                        val positions = liveAgentPositions.ifEmpty {
                            listOf(TerrariumLayout.OCTOPUS_CENTER_X_FRACTION to TerrariumLayout.OCTOPUS_CENTER_Y_FRACTION)
                        }
                        val cx = positions.map { it.first }.average().toFloat()
                        val cy = positions.map { it.second }.average().toFloat()
                        val dx = fish.x - cx
                        val dy = fish.y - cy
                        val dist = sqrt(dx * dx + dy * dy).coerceAtLeast(0.001f)
                        attX = -dy / dist * 0.3f
                        attY = dx / dist * 0.3f
                        val radialForce = (0.10f - dist) * 1.5f
                        attX += dx / dist * radialForce
                        attY += dy / dist * radialForce
                    }
                }
                TetraVisualState.HOVERING -> {
                    attX = (0.50f - fish.x) * 0.3f
                    attY = (0.35f - fish.y) * 0.3f
                }
                TetraVisualState.ABSENT -> {}
            }

            // Food chasing overrides school attractor (both schools intermix while feeding)
            if (hasFood) { schX = 0f; schY = 0f }

            // Combine forces — stronger schooling, moderate food chasing, school attractor
            val fx = sepX * 1.5f + aliX * 1.5f + cohX * 1.5f + attX * 0.6f + schX
            val fy = sepY * 1.5f + aliY * 1.5f + cohY * 1.5f + attY * 0.6f + schY

            fish.vx += fx * dt
            fish.vy += fy * dt

            // Dampen vertical velocity — fish swim mostly horizontally
            fish.vy *= 0.92f

            // Soft wall repulsion
            val wallForce = 0.08f
            if (fish.x < TerrariumLayout.TETRA_SWIM_MIN_X + 0.03f) fish.vx += wallForce * dt
            if (fish.x > TerrariumLayout.TETRA_SWIM_MAX_X - 0.03f) fish.vx -= wallForce * dt
            if (fish.y < TerrariumLayout.TETRA_SWIM_MIN_Y + 0.03f) fish.vy += wallForce * dt
            if (fish.y > TerrariumLayout.TETRA_SWIM_MAX_Y - 0.03f) fish.vy -= wallForce * dt

            // Speed limit
            val maxSpeed = when (visualState) {
                TetraVisualState.STREAMING -> TerrariumTiming.STREAM_SPEED * 0.20f
                else -> TerrariumTiming.BOID_SPEED * 0.20f
            }
            val speed = sqrt(fish.vx * fish.vx + fish.vy * fish.vy)
            if (speed > maxSpeed) {
                fish.vx = fish.vx / speed * maxSpeed
                fish.vy = fish.vy / speed * maxSpeed
            }

            fish.x += fish.vx * dt
            fish.y += fish.vy * dt

            fish.x = fish.x.coerceIn(TerrariumLayout.TETRA_SWIM_MIN_X, TerrariumLayout.TETRA_SWIM_MAX_X)
            fish.y = fish.y.coerceIn(TerrariumLayout.TETRA_SWIM_MIN_Y, TerrariumLayout.TETRA_SWIM_MAX_Y)

            // Minimum forward speed — fish don't hover in place
            val minSpeed = maxSpeed * 0.2f
            if (speed < minSpeed) {
                // Nudge forward along current heading (horizontal only)
                fish.vx += cos(fish.heading) * minSpeed * 0.8f * dt
            }

            // Smooth heading from velocity — clamp to mostly horizontal (±20°)
            if (speed > 0.002f) {
                val rawHeading = atan2(fish.vy, fish.vx)
                // Determine which horizontal direction: left (-π) or right (0)
                val facingRight = abs(rawHeading) < PI.toFloat() / 2f
                val maxPitch = 0.35f  // ~20 degrees max pitch
                fish.targetHeading = if (facingRight) {
                    rawHeading.coerceIn(-maxPitch, maxPitch)
                } else {
                    // Facing left: heading near ±π, clamp pitch around π
                    if (rawHeading > 0f) {
                        rawHeading.coerceIn(PI.toFloat() - maxPitch, PI.toFloat())
                    } else {
                        rawHeading.coerceIn(-PI.toFloat(), -PI.toFloat() + maxPitch)
                    }
                }
            }
            var headingDiff = fish.targetHeading - fish.heading
            while (headingDiff > PI.toFloat()) headingDiff -= 2f * PI.toFloat()
            while (headingDiff < -PI.toFloat()) headingDiff += 2f * PI.toFloat()
            val turnAccel = headingDiff * 2.0f
            fish.turnRate += (turnAccel - fish.turnRate) * 3f * dt
            fish.heading += fish.turnRate * dt

            // Tail/body — faster when moving faster
            val tailSpeed = TerrariumTiming.TETRA_TAIL_SPEED * (0.5f + speed * 8f)
            fish.tailPhase += tailSpeed * dt
            fish.bodyPhase += tailSpeed * 0.7f * dt
        }
    }

    override fun draw(scope: DrawScope) {
        if (visualState == TetraVisualState.ABSENT) return
        drawBackLayer(scope)
        drawFrontLayer(scope)
    }

    /** Draw back-layer fish + food crumbs (behind creatures for 3D depth). */
    fun drawBackLayer(scope: DrawScope) {
        if (visualState == TetraVisualState.ABSENT) return
        val w = scope.size.width
        val h = scope.size.height
        drawFoodCrumbs(scope, w, h)
        drawFishByLayer(scope, w, h, zLayer = 0)
    }

    /** Draw front-layer fish (in front of creatures for 3D depth). */
    fun drawFrontLayer(scope: DrawScope) {
        if (visualState == TetraVisualState.ABSENT) return
        val w = scope.size.width
        val h = scope.size.height
        drawFishByLayer(scope, w, h, zLayer = 1)
    }

    private fun drawFoodCrumbs(scope: DrawScope, w: Float, h: Float) {
        for (f in foodCrumbs) {
            if (!f.alive || f.alpha < 0.01f) continue
            val pulse = sin(f.pulsePhase) * 0.15f + 0.85f
            val radius = w * 0.009f * pulse
            val cx = f.x * w
            val cy = f.y * h
            // Wide outer glow
            scope.drawCircle(
                color = f.color.copy(alpha = f.alpha * 0.15f),
                radius = radius * 4.5f,
                center = Offset(cx, cy),
                blendMode = BlendMode.Screen,
            )
            // Inner glow
            scope.drawCircle(
                color = f.color.copy(alpha = f.alpha * 0.35f),
                radius = radius * 2.2f,
                center = Offset(cx, cy),
                blendMode = BlendMode.Screen,
            )
            // Core
            scope.drawCircle(
                color = f.color.copy(alpha = f.alpha),
                radius = radius,
                center = Offset(cx, cy),
            )
            // Bright center
            scope.drawCircle(
                color = Color.White.copy(alpha = f.alpha * 0.7f),
                radius = radius * 0.35f,
                center = Offset(cx, cy),
            )
        }
    }

    private fun drawFishByLayer(scope: DrawScope, w: Float, h: Float, zLayer: Int) {
        val fishSize = w * TerrariumLayout.TETRA_SIZE_FRACTION
        for (fish in school) {
            if (!fish.alive || fish.alpha < 0.01f || fish.zLayer != zLayer) continue
            drawNeonTetra(scope, fish, w, h, fishSize)
        }
    }

    // --- Food crumb helpers ---

    private fun findNearestFood(fx: Float, fy: Float): FoodCrumb? {
        var nearest: FoodCrumb? = null
        var minDist = Float.MAX_VALUE
        for (f in foodCrumbs) {
            if (!f.alive || f.alpha < 0.05f) continue
            val dx = f.x - fx
            val dy = f.y - fy
            val dist = dx * dx + dy * dy
            if (dist < minDist) {
                minDist = dist
                nearest = f
            }
        }
        return nearest
    }

    private fun spawnFoodCrumb() {
        val slot = foodCrumbs.firstOrNull { !it.alive } ?: foodCrumbs.minByOrNull { it.alpha }!!
        val source = workingAgentPositions[Random.nextInt(workingAgentPositions.size)]

        // Scatter around the agent with wider spread (like scattering food)
        slot.x = (source.first + (Random.nextFloat() - 0.5f) * 0.08f)
            .coerceIn(TerrariumLayout.TETRA_SWIM_MIN_X, TerrariumLayout.TETRA_SWIM_MAX_X)
        slot.y = (source.second + (Random.nextFloat() - 0.5f) * 0.06f)
            .coerceIn(TerrariumLayout.TETRA_SWIM_MIN_Y, TerrariumLayout.TETRA_SWIM_MAX_Y)
        slot.alpha = 0.9f + Random.nextFloat() * 0.1f
        slot.alive = true
        slot.age = 0f
        slot.color = FOOD_COLORS[Random.nextInt(FOOD_COLORS.size)]
        // Lateral drift + slight upward float (like bubbles, NOT sinking)
        slot.driftX = (Random.nextFloat() - 0.5f) * 0.012f
        slot.driftY = -(Random.nextFloat() * 0.004f + 0.001f)  // upward drift
        slot.pulsePhase = Random.nextFloat() * 2f * PI.toFloat()
    }

    // --- Neon Tetra rendering ---

    private fun drawNeonTetra(scope: DrawScope, fish: NeonTetra, w: Float, h: Float, size: Float) {
        val sx = fish.x * w
        val sy = fish.y * h
        val tailWag = sin(fish.tailPhase) * 0.35f
        val bodyWave = sin(fish.bodyPhase) * 0.12f

        // Body bend from turn rate — fish curves its body when turning
        // Clamp so fish doesn't fold in half
        val bendAmount = (fish.turnRate * 0.15f).coerceIn(-0.4f, 0.4f)

        // Pivot rotation at the nose (front of the fish), not center
        // This makes turns look like the head leads and body follows
        scope.withTransform({
            translate(sx, sy)
            rotate(Math.toDegrees(fish.heading.toDouble()).toFloat(), Offset.Zero)
        }) {
            val bodyLen = size * 2.0f
            val bodyH = size * 0.45f
            val noseX = bodyLen * 0.5f
            val tailBaseX = -bodyLen * 0.5f

            // Body bend offsets — tail swings opposite to turn direction
            val midBendY = bendAmount * bodyH * 2f
            val tailBendY = bendAmount * bodyH * 4f
            val midWaveY = bodyWave * bodyH + midBendY * 0.3f

            // Body — curved fish shape, bends during turns
            val bodyPath = Path().apply {
                moveTo(noseX, 0f)
                // Upper: nose → mid → tail (mid and tail offset by bend)
                cubicTo(
                    noseX * 0.5f, -bodyH * 0.5f,
                    bodyLen * 0.0f + midWaveY, -bodyH + midBendY * 0.5f,
                    tailBaseX, -bodyH * 0.25f + tailBendY,
                )
                // Lower: tail → mid → nose
                cubicTo(
                    bodyLen * 0.0f - midWaveY, bodyH + midBendY * 0.5f,
                    noseX * 0.5f, bodyH * 0.5f,
                    noseX, 0f,
                )
                close()
            }
            drawPath(
                path = bodyPath,
                color = TerrariumColors.TetraBody.copy(alpha = fish.alpha),
            )

            // Neon stripe — follows body curve
            val stripePath = Path().apply {
                moveTo(noseX * 0.65f, 0f)
                cubicTo(
                    bodyLen * 0.1f, midBendY * 0.3f + midWaveY * 0.3f,
                    -bodyLen * 0.1f, midBendY * 0.6f + midWaveY * 0.2f,
                    tailBaseX * 0.5f, tailBendY * 0.5f,
                )
            }
            drawPath(
                path = stripePath,
                color = TerrariumColors.TetraNeon.copy(alpha = fish.alpha * 0.95f),
                style = androidx.compose.ui.graphics.drawscope.Stroke(
                    width = size * 0.18f,
                    cap = StrokeCap.Round,
                ),
                blendMode = BlendMode.Screen,
            )

            // Caudal (tail) fin — forked, follows bend + wag
            val tailFinLen = bodyLen * 0.3f
            val forkSpread = bodyH * 1.0f
            val wagY = tailWag * bodyH + tailBendY
            val tailPath = Path().apply {
                moveTo(tailBaseX, tailBendY)
                // Upper fork
                cubicTo(
                    tailBaseX - tailFinLen * 0.4f, tailBendY - forkSpread * 0.4f + wagY * 0.3f,
                    tailBaseX - tailFinLen * 0.8f, tailBendY - forkSpread * 0.8f + wagY * 0.5f,
                    tailBaseX - tailFinLen, tailBendY - forkSpread + wagY * 0.6f,
                )
                // Return
                lineTo(tailBaseX - tailFinLen * 0.2f, tailBendY + wagY * 0.2f)
                // Lower fork
                cubicTo(
                    tailBaseX - tailFinLen * 0.8f, tailBendY + forkSpread * 0.8f + wagY * 0.5f,
                    tailBaseX - tailFinLen * 0.4f, tailBendY + forkSpread * 0.4f + wagY * 0.3f,
                    tailBaseX - tailFinLen, tailBendY + forkSpread + wagY * 0.6f,
                )
                lineTo(tailBaseX, tailBendY)
                close()
            }
            drawPath(
                path = tailPath,
                color = TerrariumColors.TetraFin.copy(alpha = fish.alpha * 0.85f),
            )

            // Dorsal fin — on the curved back
            val dorsalPath = Path().apply {
                val dmx = bodyLen * 0.05f
                val dmy = -bodyH * 0.85f + midBendY * 0.4f + midWaveY
                moveTo(dmx, dmy)
                lineTo(dmx + bodyLen * 0.1f, dmy - bodyH * 0.45f)
                lineTo(dmx - bodyLen * 0.15f, dmy + bodyH * 0.05f)
                close()
            }
            drawPath(
                path = dorsalPath,
                color = TerrariumColors.TetraBody.copy(alpha = fish.alpha * 0.7f),
            )

            // Eye
            drawCircle(
                color = TerrariumColors.TetraNeon.copy(alpha = fish.alpha * 0.8f),
                radius = size * 0.08f,
                center = Offset(noseX * 0.5f, -bodyH * 0.15f),
            )
        }
    }

    private fun spawnTetra(t: NeonTetra) {
        // Spawn near own school center for natural grouping
        val cx = if (t.schoolId == 0) 0.35f else 0.55f
        val cy = if (t.schoolId == 0) 0.35f else 0.40f
        t.x = (cx + (Random.nextFloat() - 0.5f) * 0.12f)
            .coerceIn(TerrariumLayout.TETRA_SWIM_MIN_X, TerrariumLayout.TETRA_SWIM_MAX_X)
        t.y = (cy + (Random.nextFloat() - 0.5f) * 0.08f)
            .coerceIn(TerrariumLayout.TETRA_SWIM_MIN_Y, TerrariumLayout.TETRA_SWIM_MAX_Y)
        t.vx = (Random.nextFloat() - 0.5f) * 0.02f
        t.vy = (Random.nextFloat() - 0.5f) * 0.02f
        val h = atan2(t.vy, t.vx)
        t.heading = h
        t.targetHeading = h
        t.turnRate = 0f
        t.alpha = 0.85f + Random.nextFloat() * 0.15f
        t.alive = true
        t.tailPhase = Random.nextFloat() * 2f * PI.toFloat()
        t.bodyPhase = Random.nextFloat() * 2f * PI.toFloat()
        t.zLayer = if (Random.nextBoolean()) 0 else 1
    }

    companion object {
        private const val SCHOOL_SIZE = 14
        private const val MAX_FOOD = 30
        private const val FOOD_LIFETIME = 5.0f   // seconds — longer visibility
        private const val FOOD_EAT_RADIUS = 0.03f
        private const val SCHOOL_ATTRACTOR_WEIGHT = 0.4f  // pull toward school center (weaker than food chase)

        private val FOOD_COLORS = arrayOf(
            Color(0xFF00E5FF),   // cyan — tool data
            Color(0xFFFBBF24),   // amber — messages
            Color(0xFF22C55E),   // green — code
        )
    }
}
