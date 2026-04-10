// JellyfishCreature.swift — Cloud creature for Codex CLI
// 5-lobe clover shape (5 overlapping circles) matching the Codex CLI icon
// Vertical gradient (lavender top → blue bottom), edge glow, morphing >_ prompt

import SwiftUI

// MARK: - Jellyfish Visual State

enum JellyfishVisualState {
    case dormant
    case drifting   // Idle — gentle pulse, slow drift
    case pulsing    // Processing — vivid gradient, glow, faster morph
    case waiting    // Awaiting — "?" bubble
}

final class JellyfishCreature: Creature {
    // MARK: - 5-Lobe Cloud Geometry

    /// Lobe centers relative to cloud center (0,0), radius fraction of bodyWidth
    private struct Lobe {
        let dx: Float  // offset from center (fraction of bodyWidth)
        let dy: Float
        let r: Float   // radius (fraction of bodyWidth)
    }

    // 6 lobes arranged in flower pattern (matches Codex icon)
    // Slightly rotated clockwise — top-left lobe is highest
    private static let lobes: [Lobe] = [
        Lobe(dx: -0.14, dy: -0.30, r: 0.30),  // top-left (highest)
        Lobe(dx:  0.16, dy: -0.26, r: 0.28),  // top-right
        Lobe(dx:  0.32, dy: -0.02, r: 0.28),  // right
        Lobe(dx:  0.14, dy:  0.26, r: 0.28),  // bottom-right
        Lobe(dx: -0.16, dy:  0.26, r: 0.28),  // bottom-left
        Lobe(dx: -0.32, dy: -0.02, r: 0.28),  // left
    ]

    // >_ morph animation: cycle through prompt symbol states
    private static let promptStates: [(chevron: String, bar: String, chevronFlipped: Bool)] = [
        (">", "_", false),   // >_
        (">", "",  false),   // >
        ("<", "=", true),    // =<
        ("<", "|", true),    // |<
        (">", "_", false),   // >_
    ]

    // MARK: - Properties

    let sessionId: String
    var displayName: String?
    var visualState: JellyfishVisualState = .drifting
    var homeX: Float
    var homeY: Float
    var scale: Float

    private var time: Float = 0
    private(set) var currentX: Float
    private(set) var currentY: Float
    private var phaseOffset: Float
    private var driftPhase: Float

    private var previousState: JellyfishVisualState?
    private var transitionProgress: Float = 1.0

    var onWaitingExit: (() -> Void)?

    // MARK: - Init

    init(sessionId: String, homeX: Float, homeY: Float, scale: Float) {
        self.sessionId = sessionId
        self.homeX = homeX
        self.homeY = homeY
        self.scale = scale
        self.currentX = homeX
        self.currentY = homeY
        self.phaseOffset = Float.random(in: 0...Float.pi * 2)
        self.driftPhase = Float.random(in: 0...Float.pi * 2)
    }

    // MARK: - Update

    func update(dt: Float, state: TerrariumState) {
        time += dt

        if let creature = state.jellyfishCreatures.first(where: { $0.id == sessionId }) {
            let newState = creature.state
            if newState != visualState {
                if visualState == .waiting { onWaitingExit?() }
                previousState = visualState
                transitionProgress = 0
                visualState = newState
            }
        }

        if transitionProgress < 1.0 {
            transitionProgress = min(1.0, transitionProgress + dt * 2.5)
        }

        updatePosition(dt: dt)
    }

    private func updatePosition(dt: Float) {
        let idleY = min(0.62, max(0.58, homeY + 0.30))
        let waitingY = min(0.54, max(0.48, homeY + 0.18))
        let pulseY = min(0.25, max(0.05, homeY))
        let targetY: Float = switch visualState {
        case .dormant: 0.70
        case .drifting: idleY
        case .pulsing: pulseY
        case .waiting: waitingY
        }

        let lerpRate: Float = visualState == .pulsing ? 2.0 : 1.5
        let pulseSpeed: Float = visualState == .pulsing ? 1.5 : 0.5
        let pulseAmp: Float = visualState == .pulsing ? 0.015 : 0.008
        let pulseBob = sin((time + phaseOffset) * pulseSpeed) * pulseAmp
        currentY += (targetY + pulseBob - currentY) * dt * lerpRate

        // Processing: wider horizontal drift (floating near surface, drifting side to side)
        let driftAmp: Float = visualState == .pulsing ? min(0.05, 0.02 + scale * 0.03) : 0.006
        let driftSpeed: Float = visualState == .pulsing ? 0.15 : 0.3
        let driftX = sin((time + driftPhase) * driftSpeed) * driftAmp
        currentX += (homeX + driftX - currentX) * dt * lerpRate

        let minX = max(0.18, homeX - 0.08)
        let maxX = min(0.72, homeX + 0.08)
        currentX = min(maxX, max(minX, currentX))
        currentY = min(0.62, max(0.08, currentY))
    }

    func currentPosition() -> (x: Float, y: Float) { (currentX, currentY) }
    func isPulsing() -> Bool { visualState == .pulsing }

    // MARK: - Draw

    func draw(context: inout GraphicsContext, size: CGSize) {
        guard visualState != .dormant else { return }

        let w = Float(size.width)
        let h = Float(size.height)
        let bodyWidth = w * 0.060 * scale

        let cx = CGFloat(currentX * w)
        let bobOffset = visualState == .pulsing ? CGFloat(sin(time * 2.0) * h * 0.008) : 0
        let cy = CGFloat(currentY * h) + bobOffset

        // Glow behind cloud (processing)
        if visualState == .pulsing {
            drawGlow(context: &context, cx: cx, cy: cy, bodyW: CGFloat(bodyWidth))
        }

        // Cloud body (5 overlapping circles with gradient)
        drawCloudBody(context: &context, cx: cx, cy: cy, bodyW: CGFloat(bodyWidth))

        // >_ prompt
        drawPrompt(context: &context, cx: cx, cy: cy, bodyW: CGFloat(bodyWidth))

        // "?" bubble
        if visualState == .waiting {
            drawSpeechBubble(context: &context, cx: cx, cy: cy, bodyW: CGFloat(bodyWidth))
        }

        // Name tag
        if let name = displayName {
            drawNameTag(
                context: &context,
                name: name,
                cx: cx,
                cy: cy,
                bodyW: CGFloat(bodyWidth),
                canvasWidth: size.width
            )
        }
    }

    // MARK: - Cloud Body (6 overlapping circles, rendered as unified shape)

    private func drawCloudBody(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyW: CGFloat) {
        let alpha = visualState == .dormant ? 0.3 : 0.9
        let breathScale: CGFloat = 1.0 + CGFloat(sin(time * (visualState == .pulsing ? 2.0 : 0.6)) * 0.03)

        // Precompute lobe rects
        let lobeRects: [CGRect] = Self.lobes.map { lobe in
            let lobeCx = cx + CGFloat(lobe.dx) * bodyW * breathScale
            let lobeCy = cy + CGFloat(lobe.dy) * bodyW * breathScale
            let lobeR = CGFloat(lobe.r) * bodyW * breathScale
            return CGRect(x: lobeCx - lobeR, y: lobeCy - lobeR, width: lobeR * 2, height: lobeR * 2)
        }

        let topY = cy - bodyW * 0.7
        let bottomY = cy + bodyW * 0.6

        // Gradient colors
        let topColor: Color
        let bottomColor: Color
        if visualState == .pulsing {
            let pulse = sin(time * 2.5) * 0.3 + 0.7
            topColor = TerrariumColors.lerpColor(
                TerrariumColors.jellyfishHighlight, Color.white, Float(pulse) * 0.2)
            bottomColor = TerrariumColors.lerpColor(
                TerrariumColors.jellyfishDeep, TerrariumColors.jellyfishBell, Float(pulse) * 0.3)
        } else {
            topColor = TerrariumColors.jellyfishHighlight
            bottomColor = TerrariumColors.jellyfishDeep
        }

        // Build bounding rect for gradient fill
        let allMinX = lobeRects.map(\.minX).min() ?? cx
        let allMinY = lobeRects.map(\.minY).min() ?? cy
        let allMaxX = lobeRects.map(\.maxX).max() ?? cx
        let allMaxY = lobeRects.map(\.maxY).max() ?? cy
        // 0. Outer edge glow — slightly expanded, behind body
        context.drawLayer { glowCtx in
            glowCtx.opacity = alpha * 0.12
            for rect in lobeRects {
                let expanded = rect.insetBy(dx: -rect.width * 0.04, dy: -rect.height * 0.04)
                glowCtx.fill(Path(ellipseIn: expanded),
                             with: .color(TerrariumColors.jellyfishGlow))
            }
        }

        // 1. Main body — single combined path, filled ONCE (no per-circle seams)
        var cloudPath = SwiftUI.Path()
        for rect in lobeRects {
            cloudPath.addEllipse(in: rect)
        }
        // Center patch to guarantee no gap
        let centerR = bodyW * 0.18
        cloudPath.addEllipse(in: CGRect(x: cx - centerR, y: cy - centerR,
                                         width: centerR * 2, height: centerR * 2))

        let nonZero = FillStyle(eoFill: false)  // non-zero winding = fills union

        context.drawLayer { bodyCtx in
            bodyCtx.opacity = alpha

            // Base gradient — single fill over entire union
            bodyCtx.fill(cloudPath, with: .linearGradient(
                Gradient(colors: [topColor, bottomColor]),
                startPoint: CGPoint(x: cx, y: topY),
                endPoint: CGPoint(x: cx, y: bottomY)
            ), style: nonZero)

            // 3D highlight — top-left glossy sheen
            bodyCtx.fill(cloudPath, with: .linearGradient(
                Gradient(colors: [Color.white.opacity(0.15), Color.white.opacity(0.04), Color.clear]),
                startPoint: CGPoint(x: cx - bodyW * 0.35, y: topY - bodyW * 0.1),
                endPoint: CGPoint(x: cx + bodyW * 0.2, y: cy + bodyW * 0.15)
            ), style: nonZero)
        }
    }

    // MARK: - >_ Morphing Prompt

    private func drawPrompt(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyW: CGFloat) {
        let promptAlpha = visualState == .pulsing ?
            Double(sin(time * 3) * 0.1 + 0.9) : 0.9
        let promptColor = Color.white.opacity(promptAlpha)

        // Morph cycle: slower when idle, faster when processing
        let morphSpeed: Float = visualState == .pulsing ? 0.4 : 0.15
        let morphIndex = Int(time * morphSpeed) % Self.promptStates.count
        let state = Self.promptStates[morphIndex]

        let fontSize = bodyW * 0.45
        let chevronSize = bodyW * 0.50

        if state.chevronFlipped {
            // Bar on left, chevron on right (e.g. =< or |<)
            if !state.bar.isEmpty {
                context.draw(
                    Text(state.bar).font(.system(size: fontSize, weight: .bold, design: .rounded))
                        .foregroundColor(promptColor),
                    at: CGPoint(x: cx - bodyW * 0.18, y: cy + bodyW * 0.02)
                )
            }
            context.draw(
                Text(state.chevron).font(.system(size: chevronSize, weight: .bold, design: .rounded))
                    .foregroundColor(promptColor),
                at: CGPoint(x: cx + bodyW * 0.15, y: cy)
            )
        } else {
            // Chevron on left, bar on right (e.g. >_ or >)
            context.draw(
                Text(state.chevron).font(.system(size: chevronSize, weight: .bold, design: .rounded))
                    .foregroundColor(promptColor),
                at: CGPoint(x: cx - bodyW * 0.10, y: cy)
            )
            if !state.bar.isEmpty {
                let visible = state.bar == "_" ? (Int(time * 2) % 2 == 0) : true
                if visible {
                    context.draw(
                        Text(state.bar).font(.system(size: fontSize, weight: .bold, design: .rounded))
                            .foregroundColor(promptColor),
                        at: CGPoint(x: cx + bodyW * 0.20, y: cy + bodyW * 0.02)
                    )
                }
            }
        }
    }

    // MARK: - Tentacles

    private func drawTentacles(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyW: CGFloat) {
        let tentacleAlpha = (visualState == .dormant ? 0.2 : 0.4)
        let baseY = cy + bodyW * 0.55  // start below cloud

        let positions: [CGFloat] = [-0.25, -0.12, 0.0, 0.12, 0.25]  // X offsets

        for (i, xOff) in positions.enumerated() {
            let phase = Float(i) * Float.pi / 2.5
            let wiggle = CGFloat(sin(time * 0.8 + phase) * 3) * bodyW / 120

            let startX = cx + xOff * bodyW + wiggle
            let endY = baseY + bodyW * CGFloat(0.3 + sin(time * 0.5 + phase) * 0.05)

            let t = Float(i) / Float(positions.count)
            let color = TerrariumColors.lerpColor(
                TerrariumColors.jellyfishGlow,
                TerrariumColors.jellyfishDeep,
                t
            )

            var path = SwiftUI.Path()
            path.move(to: CGPoint(x: startX, y: baseY))
            path.addQuadCurve(
                to: CGPoint(x: startX + wiggle * 2, y: endY),
                control: CGPoint(x: startX + wiggle * 3, y: baseY + (endY - baseY) * 0.6)
            )

            context.stroke(path,
                           with: .color(color.opacity(tentacleAlpha)),
                           style: StrokeStyle(lineWidth: bodyW * 0.018, lineCap: .round))
        }
    }

    // MARK: - Glow

    private func drawGlow(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyW: CGFloat) {
        let glowPulse = CGFloat(sin(time * 2.5) * 0.3 + 0.7)
        let glowR = bodyW * 1.0 * glowPulse

        let rect = CGRect(x: cx - glowR, y: cy - glowR, width: glowR * 2, height: glowR * 2)
        context.fill(Path(ellipseIn: rect),
                     with: .color(TerrariumColors.jellyfishGlow.opacity(0.1 * Double(glowPulse))))

        for i in 0..<4 {
            let angle = CGFloat(Float(i) / 4 * Float.pi * 2 + time * 0.5)
            let orbitR = bodyW * 0.65
            let px = cx + cos(angle) * orbitR
            let py = cy + sin(angle) * orbitR * 0.6
            let pSize = bodyW * 0.03
            let pRect = CGRect(x: px - pSize, y: py - pSize, width: pSize * 2, height: pSize * 2)
            context.fill(Path(ellipseIn: pRect),
                         with: .color(TerrariumColors.jellyfishGlow.opacity(0.3 * Double(glowPulse))))
        }
    }

    // MARK: - Speech Bubble

    private func drawSpeechBubble(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyW: CGFloat) {
        let bx = cx + bodyW * 0.55
        let by = cy - bodyW * 0.1
        let br = bodyW * 0.22
        let pulse = CGFloat(sin(time * 2.5)) * 0.08 + 1
        let r = br * pulse

        let rect = CGRect(x: bx - r, y: by - r, width: r * 2, height: r * 2)
        context.fill(Path(ellipseIn: rect), with: .color(.white.opacity(0.25)))
        context.stroke(Path(ellipseIn: rect),
                       with: .color(TerrariumColors.hudText.opacity(0.5)),
                       lineWidth: bodyW * 0.02)

        var tail = SwiftUI.Path()
        tail.move(to: CGPoint(x: bx - r * 0.3, y: by + r * 0.3))
        tail.addLine(to: CGPoint(x: cx + bodyW * 0.28, y: cy))
        tail.addLine(to: CGPoint(x: bx - r * 0.05, y: by + r * 0.5))
        tail.closeSubpath()
        context.fill(tail, with: .color(.white.opacity(0.25)))

        context.draw(
            Text("?").font(.system(size: r * 1.2, weight: .bold)).foregroundColor(TerrariumColors.hudText.opacity(0.7)),
            at: CGPoint(x: bx, y: by)
        )
    }

    // MARK: - Name Tag

    private func drawNameTag(context: inout GraphicsContext, name: String,
                             cx: CGFloat, cy: CGFloat, bodyW: CGFloat, canvasWidth: CGFloat) {
        drawTerrariumNameTag(
            context: &context,
            name: name,
            cx: cx,
            bodyTopY: cy - bodyW * 0.6,
            bodyMetric: terrariumNameTagMetric(canvasWidth: canvasWidth, scale: scale),
            backgroundColor: TerrariumColors.jellyfishNameBg
        )
    }
}
