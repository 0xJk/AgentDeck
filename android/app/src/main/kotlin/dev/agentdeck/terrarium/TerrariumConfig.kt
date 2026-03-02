package dev.agentdeck.terrarium

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Color palette and timing constants for the terrarium scene. */
object TerrariumColors {
    // Background layers
    val DeepSea = Color(0xFF0A1628)
    val MidWater = Color(0xFF0F2744)
    val ShallowWater = Color(0xFF163B5C)

    // Claude Code mascot (pixel art — matching official terracotta)
    val ClaudeBody = Color(0xFFC07058)       // muted terracotta/copper
    val ClaudeBodyLight = Color(0xFFD08870)  // THINKING pulse bright
    val ClaudeBodyDark = Color(0xFFA05840)   // shadow
    val ClaudeEye = Color(0xFF2D1F16)        // dark brown

    // Crayfish (OpenClaw brand: #FF4D4D→#991B1B gradient, #00E5CC teal eyes)
    val CrayfishShell = Color(0xFFFF4D4D)
    val CrayfishDark = Color(0xFF991B1B)
    val CrayfishClaw = Color(0xFFFF4D4D)
    val CrayfishEye = Color(0xFF00E5CC)
    val CrayfishBodyLight = Color(0xFFFF6B6B)  // ROUTING pulse bright

    // Neon Tetra
    val TetraNeon = Color(0xFF00E5FF)
    val TetraBody = Color(0xFF1E40AF)
    val TetraFin = Color(0xFFFF6B6B)
    val TetraStripe = Color(0xFF00E5FF)

    // Environment
    val BubbleWhite = Color(0x40FFFFFF)
    val BubbleHighlight = Color(0x80FFFFFF)
    val CausticsLight = Color(0x14FFFFFF)
    val SandBase = Color(0xFF2A1F14)
    val SandLight = Color(0xFF3D2E1F)
    val RockDark = Color(0xFF1A1A2E)
    val RockMid = Color(0xFF2D2D44)
    val RockLight = Color(0xFF3A3A55)
    val KelpGreen = Color(0xFF22C55E)
    val KelpDark = Color(0xFF166534)

    // LED cables
    val LEDGreen = Color(0xFF22C55E)
    val LEDAmber = Color(0xFFFBBF24)
    val LEDRed = Color(0xFFEF4444)

    // Holographic UI
    val HoloBlue = Color(0x6000E5FF)
    val HoloText = Color(0xB000E5FF)

    // Error state
    val ErrorTint = Color(0x40EF4444)

    // HUD overlay
    val HUDBg = Color(0x80000000)
    val HUDText = Color(0xFFE2E8F0)
    val HUDSubtext = Color(0xFF94A3B8)
}

/** Layout and sizing constants. */
object TerrariumLayout {
    // Scene proportions (fraction of canvas)
    const val SAND_HEIGHT_FRACTION = 0.28f
    const val ROCK_HEIGHT_FRACTION = 0.25f

    // Octopus sizing (fraction of canvas width)
    const val OCTOPUS_BODY_RADIUS_FRACTION = 0.07f
    const val OCTOPUS_CENTER_X_FRACTION = 0.4f
    const val OCTOPUS_CENTER_Y_FRACTION = 0.45f
    // (TENTACLE_LENGTH_FRACTION removed — pixel mascot has no tentacles)

    // Crayfish sizing
    const val CRAYFISH_WIDTH_FRACTION = 0.14f
    const val CRAYFISH_CENTER_X_FRACTION = 0.78f
    const val CRAYFISH_CENTER_Y_FRACTION = 0.65f

    // Tetra sizing
    const val TETRA_SIZE_FRACTION = 0.015f
    const val TETRA_COUNT = 7

    // Octopus swimming boundaries (fraction of canvas)
    const val SWIM_MIN_X = 0.20f   // clear of left HUD panel (~19%)
    const val SWIM_MAX_X = 0.68f   // before crayfish area (0.78)
    const val SWIM_MIN_Y = 0.10f   // below surface (0.05) margin
    const val SWIM_MAX_Y = 0.68f   // above sand (0.72)

    // Neon Tetra swim boundaries — full aquarium range
    const val TETRA_SWIM_MIN_X = 0.03f   // near left wall
    const val TETRA_SWIM_MAX_X = 0.92f   // near right wall (seaweed at 0.93)
    const val TETRA_SWIM_MIN_Y = 0.08f   // just below surface (0.05)
    const val TETRA_SWIM_MAX_Y = 0.68f   // above sand (0.72)
}

/** Animation timing constants. */
object TerrariumTiming {
    // Octopus
    const val FLOAT_PERIOD_MS = 4000f
    const val FLOAT_AMPLITUDE_FRACTION = 0.015f
    const val TENTACLE_WAVE_SPEED = 2.5f
    const val THINKING_PULSE_SPEED = 3.0f
    const val TYPING_SPEED = 8.0f

    // Crayfish
    const val CLAW_CLAP_PERIOD_MS = 1200f
    const val EYE_FLASH_PERIOD_MS = 800f

    // Tetra
    const val BOID_SPEED = 0.3f
    const val STREAM_SPEED = 1.5f
    const val SEPARATION_RADIUS = 0.04f
    const val ALIGNMENT_RADIUS = 0.08f
    const val COHESION_RADIUS = 0.12f

    // Octopus swimming
    const val SWIM_SPEED = 0.03f           // canvas fraction/sec
    const val SWIM_LERP_RATE = 1.5f        // target convergence speed
    const val WAYPOINT_MIN_INTERVAL = 3.0f // seconds
    const val WAYPOINT_MAX_INTERVAL = 5.0f

    // Neon Tetra tail
    const val TETRA_TAIL_SPEED = 8.0f

    // Bubbles
    const val BUBBLE_RISE_SPEED = 0.08f
    const val BUBBLE_WOBBLE_SPEED = 3.0f
    const val CALM_SPAWN_INTERVAL_MS = 2000f
    const val ACTIVE_SPAWN_INTERVAL_MS = 300f
    const val ERROR_SPAWN_INTERVAL_MS = 100f

    // Environment
    const val CAUSTICS_SPEED = 1.5f
    const val KELP_SWAY_SPEED = 1.0f
    const val LED_PULSE_SPEED = 2.0f

    // Transitions
    const val STATE_TRANSITION_MS = 500f
    const val EINK_WIPE_MS = 300f
    const val EINK_DEBOUNCE_MS = 500L
}
