// TerrariumConfig.swift — Colors, layout constants, timing
// Ported from android TerrariumConfig.kt

import SwiftUI

// MARK: - Environment Visual State

enum EnvironmentVisualState {
    case dark    // Disconnected — dim/off
    case calm    // Idle — gentle caustics, slow bubbles
    case active  // Processing — bright caustics, more bubbles
    case alert   // Awaiting input — pulsing highlights
}

// MARK: - Colors

enum TerrariumColors {
    // Background layers
    static let deepSea = Color(red: 0.039, green: 0.086, blue: 0.157)         // #0A1628
    static let midWater = Color(red: 0.059, green: 0.153, blue: 0.267)        // #0F2744
    static let shallowWater = Color(red: 0.086, green: 0.231, blue: 0.361)    // #163B5C

    // Claude Code (Octopus)
    static let claudeBody = Color(red: 0.753, green: 0.439, blue: 0.345)      // #C07058
    static let claudeBodyLight = Color(red: 0.816, green: 0.533, blue: 0.439) // #D08870
    static let claudeBodyDark = Color(red: 0.627, green: 0.345, blue: 0.251)  // #A05840
    static let claudeEye = Color(red: 0.176, green: 0.122, blue: 0.086)       // #2D1F16

    // Crayfish
    static let crayfishShell = Color(red: 1.0, green: 0.302, blue: 0.302)     // #FF4D4D
    static let crayfishDark = Color(red: 0.6, green: 0.106, blue: 0.106)      // #991B1B
    static let crayfishClaw = Color(red: 1.0, green: 0.302, blue: 0.302)      // #FF4D4D
    static let crayfishEye = Color(red: 0.0, green: 0.898, blue: 0.8)         // #00E5CC
    static let crayfishBodyLight = Color(red: 1.0, green: 0.42, blue: 0.42)   // #FF6B6B

    // Neon Tetra
    static let tetraNeon = Color(red: 0.0, green: 0.898, blue: 1.0)           // #00E5FF
    static let tetraBody = Color(red: 0.118, green: 0.251, blue: 0.686)       // #1E40AF
    static let tetraFin = Color(red: 1.0, green: 0.42, blue: 0.42)            // #FF6B6B
    static let tetraStripe = Color(red: 0.0, green: 0.898, blue: 1.0)         // #00E5FF

    // Jellyfish (Codex CLI) — matches icon gradient: lavender/pink top → vivid blue bottom
    static let jellyfishBell = Color(red: 0.380, green: 0.400, blue: 0.880)      // #6166E0 mid blue-indigo
    static let jellyfishDeep = Color(red: 0.200, green: 0.260, blue: 0.780)      // #3342C7 vivid deep blue
    static let jellyfishHighlight = Color(red: 0.700, green: 0.580, blue: 0.900) // #B394E5 lavender-pink (top glow)
    static let jellyfishGlow = Color(red: 0.560, green: 0.580, blue: 0.950)      // #8F94F2 periwinkle
    static let jellyfishTentacle = Color(red: 0.450, green: 0.490, blue: 0.920)  // #737DEA mid
    static let jellyfishNameBg = Color(red: 0.333, green: 0.380, blue: 0.878).opacity(0.6)

    // Environment
    static let bubbleWhite = Color.white.opacity(0.25)      // 0x40FFFFFF
    static let bubbleHighlight = Color.white.opacity(0.5)    // 0x80FFFFFF
    static let causticsLight = Color.white.opacity(0.08)     // 0x14FFFFFF
    static let sandBase = Color(red: 0.165, green: 0.122, blue: 0.078)        // #2A1F14
    static let sandLight = Color(red: 0.239, green: 0.180, blue: 0.122)       // #3D2E1F
    static let rockDark = Color(red: 0.102, green: 0.102, blue: 0.180)        // #1A1A2E
    static let rockMid = Color(red: 0.176, green: 0.176, blue: 0.267)         // #2D2D44
    static let rockLight = Color(red: 0.227, green: 0.227, blue: 0.333)       // #3A3A55
    static let kelpGreen = Color(red: 0.133, green: 0.773, blue: 0.369)       // #22C55E
    static let kelpDark = Color(red: 0.086, green: 0.396, blue: 0.204)        // #166534

    // LED cables
    static let ledGreen = Color(red: 0.133, green: 0.773, blue: 0.369)        // #22C55E
    static let ledAmber = Color(red: 0.984, green: 0.749, blue: 0.141)        // #FBBF24
    static let ledRed = Color(red: 0.937, green: 0.267, blue: 0.267)          // #EF4444

    // Holographic UI
    static let holoBlue = Color(red: 0.0, green: 0.898, blue: 1.0).opacity(0.375)
    static let holoText = Color(red: 0.0, green: 0.898, blue: 1.0).opacity(0.69)

    // Error state
    static let errorTint = Color(red: 0.937, green: 0.267, blue: 0.267).opacity(0.25)

    // HUD overlay
    static let hudBg = Color.black.opacity(0.5)
    static let hudText = Color(red: 0.886, green: 0.910, blue: 0.878)         // #E2E8F0
    static let hudSubtext = Color(red: 0.580, green: 0.639, blue: 0.722)      // #94A3B8

    // Sick/desaturated crayfish
    static let crayfishSick = Color(red: 0.545, green: 0.482, blue: 0.482) // #8B7B7B

    // Food crumbs
    static let foodCyan = Color(red: 0.0, green: 0.898, blue: 1.0)            // tools
    static let foodAmber = Color(red: 0.984, green: 0.749, blue: 0.141)       // messages
    static let foodGreen = Color(red: 0.133, green: 0.773, blue: 0.369)       // code

    // Name tag
    static let claudeNameBg = Color(red: 0.753, green: 0.439, blue: 0.345).opacity(0.6)

    /// Linear interpolation between two SwiftUI Colors using resolved RGBA components.
    static func lerpColor(_ a: Color, _ b: Color, _ t: Float) -> Color {
        let f = min(1, max(0, t))
        if f < 0.01 { return a }
        if f > 0.99 { return b }
        let env = EnvironmentValues()
        let ra = a.resolve(in: env)
        let rb = b.resolve(in: env)
        return Color(
            red: Double(ra.red * (1 - f) + rb.red * f),
            green: Double(ra.green * (1 - f) + rb.green * f),
            blue: Double(ra.blue * (1 - f) + rb.blue * f),
            opacity: Double(ra.opacity * (1 - f) + rb.opacity * f)
        )
    }
}

enum TerrariumNameTagStyle {
    // Use the current OpenCode name tag as the SSOT across all creature types.
    static let referenceBodyWidthFraction: CGFloat = 0.044
    static let gapRatio: CGFloat = 0.15
    static let fontRatio: CGFloat = 0.31
    static let minWidthRatio: CGFloat = 1.1
    static let minHeightRatio: CGFloat = 0.22
    static let paddingRatio: CGFloat = 0.12
    static let textMeasureWidth: CGFloat = 500
    static let textMeasureHeight: CGFloat = 100
    static let cornerRadius: CGFloat = 4
}

func terrariumNameTagMetric(canvasWidth: CGFloat, scale: Float) -> CGFloat {
    canvasWidth * TerrariumNameTagStyle.referenceBodyWidthFraction * CGFloat(scale)
}

func drawTerrariumNameTag(
    context: inout GraphicsContext,
    name: String,
    cx: CGFloat,
    bodyTopY: CGFloat,
    bodyMetric: CGFloat,
    backgroundColor: Color
) {
    let tagBottomY = bodyTopY - bodyMetric * TerrariumNameTagStyle.gapRatio
    let fontSize = bodyMetric * TerrariumNameTagStyle.fontRatio
    let padding = bodyMetric * TerrariumNameTagStyle.paddingRatio

    let text = Text(name)
        .font(.system(size: fontSize, weight: .medium, design: .default))
        .foregroundColor(TerrariumColors.hudText.opacity(0.86))
    let resolved = context.resolve(text)
    let textSize = resolved.measure(
        in: CGSize(
            width: TerrariumNameTagStyle.textMeasureWidth,
            height: TerrariumNameTagStyle.textMeasureHeight
        )
    )
    let tagWidth = max(bodyMetric * TerrariumNameTagStyle.minWidthRatio, textSize.width + padding * 2)
    let tagHeight = max(bodyMetric * TerrariumNameTagStyle.minHeightRatio, textSize.height + padding * 0.6)

    let backgroundRect = CGRect(
        x: cx - tagWidth / 2,
        y: tagBottomY - tagHeight,
        width: tagWidth,
        height: tagHeight
    )
    context.fill(
        Path(roundedRect: backgroundRect, cornerRadius: TerrariumNameTagStyle.cornerRadius),
        with: .color(backgroundColor)
    )

    context.draw(resolved, at: CGPoint(x: cx, y: tagBottomY - tagHeight / 2))
}

// MARK: - Layout

enum TerrariumLayout {
    // Scene proportions (fraction of canvas)
    static let sandHeightFraction: Float = 0.35
    static let rockHeightFraction: Float = 0.25

    // Octopus
    static let octopusBodyRadius: Float = 0.050
    static let pixelAspect: Float = 2.0
    static let pixelGap: Float = 0.5

    // Standing positions
    static let standingY: Float = 0.62
    static let standingYDeep: Float = 0.75
    static let jitterRange: Float = 0.03

    // Swim bounds (octopus)
    static let swimMinX: Float = 0.18
    static let swimMaxX: Float = 0.55
    static let swimMinY: Float = 0.15
    static let swimMaxY: Float = 0.55

    // Swim bounds (tetra)
    static let tetraMinX: Float = 0.03
    static let tetraMaxX: Float = 0.92
    static let tetraMinY: Float = 0.08
    static let tetraMaxY: Float = 0.61

    // Crayfish
    static let crayfishWidthFraction: Float = 0.11
    static let crayfishDefaultX: Float = 0.78
    static let crayfishSittingY: Float = 0.64
    static let crayfishRoutingY: Float = 0.42

    // Jellyfish
    static let jellyfishBodyRadius: Float = 0.050
    static let jellyfishDefaultX: Float = 0.50
    static let jellyfishIdleY: Float = 0.45
    static let jellyfishProcessingY: Float = 0.20

    // Surface
    static let surfaceY: Float = 0.04
}

// MARK: - Timing

enum TerrariumTiming {
    // Octopus
    static let bobPeriod: Float = 4.0
    static let bobAmplitude: Float = 0.015
    static let swayAmplitude: Float = 0.008
    static let thinkingPulseSpeed: Float = 3.0

    // Tentacle
    static let tentacleSpeedWorking: Float = 1.5
    static let tentacleSpeedFloating: Float = 0.8
    static let tentacleSpeedAsking: Float = 1.0
    static let tentacleAmpWorking: Float = 0.08
    static let tentacleAmpFloating: Float = 0.04
    static let tentacleAmpAsking: Float = 0.05

    // Arm bob
    static let armSpeedWorking: Float = 1.0
    static let armSpeedFloating: Float = 0.5
    static let armAmpWorking: Float = 0.06
    static let armAmpFloating: Float = 0.02

    // Starburst
    static let starburstArmCount = 10
    static let starburstRotSpeed: Float = 0.5
    static let starburstPulseSpeed: Float = 3.0

    // Swimming waypoints
    static let swimLerpRate: Float = 3.0
    static let waypointMinInterval: Float = 1.5
    static let waypointMaxInterval: Float = 3.0

    // Crayfish
    static let heartbeatPeriod: Float = 4.0
    static let clawClapPeriod: Float = 1.2
    static let eyeFlashPeriod: Float = 0.8

    // Bubble
    static let bubbleRiseSpeed: Float = 0.08
    static let bubbleWobbleSpeed: Float = 3.0
    static let bubbleMaxCount = 70
    static let bubbleSpawnCalm: Float = 2.0      // seconds
    static let bubbleSpawnActive: Float = 0.3
    static let bubbleSpawnAlert: Float = 0.45

    // Environment
    static let causticsSpeed: Float = 1.5
    static let kelpSwaySpeed: Float = 1.0
    static let ledPulseSpeed: Float = 2.0

    // Creature bubble exhales
    static let octoBubbleInterval: Float = 2.5
    static let crayfishBubbleInterval: Float = 1.5

    // Tetra
    static let tetraSize: Float = 0.015
    static let tetraTailSpeed: Float = 8.0
    static let schoolAttractorWeight: Float = 0.4
    static let separationRadius: Float = 0.04
    static let alignmentRadius: Float = 0.08
    static let cohesionRadius: Float = 0.12
    static let maxFood = 30
    static let foodLifetime: Float = 5.0
    static let foodEatRadius: Float = 0.03
}
