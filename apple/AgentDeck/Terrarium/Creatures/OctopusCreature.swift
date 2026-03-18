// OctopusCreature.swift — 14×5 pixel grid octopus mascot
// Ported from android OctopusCreature.kt

import SwiftUI

final class OctopusCreature: Creature {
    // MARK: - Pixel Grid

    // Cell types: 0=transparent, 1=body, 2=eye, 3=left arm, 4=right arm, 5=left leg, 6=right leg
    private static let grid: [[Int]] = [
        [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
        [0, 0, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 0, 0],
        [3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4, 4],
        [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
        [0, 0, 0, 5, 0, 5, 0, 0, 6, 0, 6, 0, 0, 0],
    ]

    private static let gridCols = 14
    private static let gridRows = 5
    private static let pixelAspect: Float = 2.0
    private static let pixelGap: Float = 0.5

    // Starburst arm lengths
    private static let starburstArmLengths: [Float] = [1.0, 0.75, 0.95, 0.70, 1.0, 0.80, 0.90, 0.72, 0.98, 0.78]

    // MARK: - Properties

    let sessionId: String
    var displayName: String?
    var visualState: OctopusVisualState = .floating
    var homeX: Float
    var homeY: Float
    var scale: Float

    // Animation state
    private var time: Float = 0
    private(set) var currentX: Float
    private(set) var currentY: Float
    private var targetX: Float
    private var targetY: Float
    private var phaseOffset: Float
    private var standingJitter: Float
    private var waypointTimer: Float = 0
    private var waypointInterval: Float

    // Transition
    private var previousState: OctopusVisualState?
    private var transitionProgress: Float = 1.0

    // ASKING exit callback
    var onAskingExit: (() -> Void)?

    // MARK: - Init

    init(sessionId: String, homeX: Float, homeY: Float, scale: Float) {
        self.sessionId = sessionId
        self.homeX = homeX
        self.homeY = homeY
        self.scale = scale
        self.currentX = homeX
        self.currentY = TerrariumLayout.standingY
        self.targetX = homeX
        self.targetY = homeY
        self.phaseOffset = Float.random(in: 0...Float.pi * 2)
        self.standingJitter = Float.random(in: -TerrariumLayout.jitterRange...TerrariumLayout.jitterRange)
        self.waypointInterval = Float.random(in: TerrariumTiming.waypointMinInterval...TerrariumTiming.waypointMaxInterval)
    }

    // MARK: - Update

    func update(dt: Float, state: TerrariumState) {
        time += dt

        // Find matching creature state
        if let creature = state.creatures.first(where: { $0.id == sessionId }) {
            let newState = creature.state
            if newState != visualState {
                if visualState == .asking {
                    onAskingExit?()
                }
                previousState = visualState
                transitionProgress = 0
                visualState = newState
            }
        }

        // Advance transition
        if transitionProgress < 1.0 {
            transitionProgress = min(1.0, transitionProgress + dt * 3.0)
        }

        // Position
        updatePosition(dt: dt)
    }

    private func updatePosition(dt: Float) {
        let depthOffset = (homeX - 0.4) * 0.15

        switch visualState {
        case .sleeping:
            let myDeepY = TerrariumLayout.standingYDeep + standingJitter * 0.5
            currentX += (homeX - currentX) * dt * 4
            currentY += (myDeepY - currentY) * dt * 4

        case .floating:
            let myStandingY = TerrariumLayout.standingY + standingJitter + depthOffset
            let breathBob = sin(time * 0.8) * 0.002
            let idleSway = sin(time * 0.3) * 0.005
            currentX += (homeX + idleSway - currentX) * dt * 4
            currentY += (myStandingY + breathBob - currentY) * dt * 4

        case .working:
            // Free swimming with waypoints
            waypointTimer += dt
            if waypointTimer >= waypointInterval {
                waypointTimer = 0
                waypointInterval = Float.random(in: TerrariumTiming.waypointMinInterval...TerrariumTiming.waypointMaxInterval)
                pickNewWaypoint()
            }
            let rate = TerrariumTiming.swimLerpRate * dt
            currentX += (targetX - currentX) * rate
            currentY += (targetY - currentY) * rate
            currentX = min(TerrariumLayout.swimMaxX, max(TerrariumLayout.swimMinX, currentX))
            currentY = min(TerrariumLayout.swimMaxY, max(TerrariumLayout.swimMinY, currentY))

        case .asking:
            let myStandingY = TerrariumLayout.standingY + standingJitter + depthOffset
            let fidgetX = sin(time * 1.2) * 0.008
            currentX += (homeX + fidgetX - currentX) * dt * 4
            currentY += (myStandingY - currentY) * dt * 4
        }
    }

    private func pickNewWaypoint() {
        let angle = Float.random(in: 0...Float.pi * 2)
        let wanderRadius: Float = 0.12
        let radius = Float.random(in: 0...wanderRadius)
        targetX = min(TerrariumLayout.swimMaxX, max(TerrariumLayout.swimMinX,
            homeX + cos(angle) * radius))
        targetY = min(TerrariumLayout.swimMaxY, max(TerrariumLayout.swimMinY,
            homeY + sin(angle) * radius * 0.7))
    }

    /// Current live position for tetra attractor tracking
    func currentPosition() -> (x: Float, y: Float) {
        (currentX, currentY)
    }

    /// Whether this octopus is currently working
    func isWorking() -> Bool {
        visualState == .working
    }

    // MARK: - Draw

    func draw(context: inout GraphicsContext, size: CGSize) {
        let w = Float(size.width)
        let h = Float(size.height)
        let bodyRadius = w * TerrariumLayout.octopusBodyRadius * scale

        let centerX = currentX * w

        // Bob only when swimming (WORKING)
        let bobOffset: Float = visualState == .working ?
            sin(time * 2 * Float.pi / TerrariumTiming.bobPeriod) * h * TerrariumTiming.bobAmplitude : 0
        let centerY = currentY * h + bobOffset

        let bodyAlpha: Float = visualState == .sleeping ? 0.4 : 1.0

        // Draw pixel body
        drawPixelBody(context: &context, cx: centerX, cy: centerY, bodyRadius: bodyRadius, alpha: bodyAlpha)

        // WORKING: starburst sparkle
        if visualState == .working {
            drawStarburst(context: &context, cx: centerX, cy: centerY,
                          radius: bodyRadius * 0.55, alpha: bodyAlpha * 0.7)
        }

        // ASKING: speech bubble with "?"
        if visualState == .asking {
            drawSpeechBubble(context: &context, cx: CGFloat(centerX), cy: CGFloat(centerY),
                             bodyRadius: CGFloat(bodyRadius))
        }

        // Name tag
        if let name = displayName {
            drawNameTag(context: &context, name: name, cx: CGFloat(centerX),
                        cy: CGFloat(centerY), bodyRadius: CGFloat(bodyRadius))
        }
    }

    // MARK: - Tentacle/Arm Animation

    private func tentacleOffset(isLeft: Bool, pixelH: Float) -> Float {
        guard visualState != .sleeping else { return 0 }
        let phase: Float = isLeft ? .pi : 0
        let (speed, amplitude): (Float, Float) = switch visualState {
        case .working: (TerrariumTiming.tentacleSpeedWorking, TerrariumTiming.tentacleAmpWorking)
        case .floating: (TerrariumTiming.tentacleSpeedFloating, TerrariumTiming.tentacleAmpFloating)
        case .asking: (TerrariumTiming.tentacleSpeedAsking, TerrariumTiming.tentacleAmpAsking)
        case .sleeping: (0, 0)
        }
        return sin(time * speed + phase) * pixelH * amplitude
    }

    private func armOffset(isLeft: Bool, pixelH: Float) -> Float {
        guard visualState != .sleeping else { return 0 }
        let phase: Float = isLeft ? 0 : .pi
        let (speed, amplitude): (Float, Float) = switch visualState {
        case .working: (TerrariumTiming.armSpeedWorking, TerrariumTiming.armAmpWorking)
        case .floating: (TerrariumTiming.armSpeedFloating, TerrariumTiming.armAmpFloating)
        case .asking: (0.8, 0.04)
        case .sleeping: (0, 0)
        }
        return sin(time * speed + phase) * pixelH * amplitude
    }

    // MARK: - Pixel Body Drawing

    private func drawPixelBody(context: inout GraphicsContext, cx: Float, cy: Float,
                                bodyRadius: Float, alpha: Float) {
        let pixelW = bodyRadius * 2 / Float(Self.gridCols)
        let pixelH = pixelW * Self.pixelAspect
        let gridW = Float(Self.gridCols) * pixelW
        let gridH = Float(Self.gridRows) * pixelH
        let startX = cx - gridW / 2
        let startY = cy - gridH / 2

        let bodyColor = bodyColorForState()
        let gap = Self.pixelGap

        for row in 0..<Self.gridRows {
            for col in 0..<Self.gridCols {
                let cell = Self.grid[row][col]
                guard cell != 0 else { continue }

                let px = startX + Float(col) * pixelW
                var py = startY + Float(row) * pixelH

                // Arm Y-offset (bob up/down)
                if cell == 3 { py += armOffset(isLeft: true, pixelH: pixelH) }
                if cell == 4 { py += armOffset(isLeft: false, pixelH: pixelH) }

                switch cell {
                case 2: // Eye
                    if visualState == .sleeping {
                        // Narrow bar for sleeping eyes
                        let rect = CGRect(x: CGFloat(px + gap), y: CGFloat(py + pixelH * 0.4),
                                          width: CGFloat(pixelW - gap * 2), height: CGFloat(pixelH * 0.2))
                        context.fill(Path(rect),
                                     with: .color(TerrariumColors.claudeEye.opacity(Double(alpha) * 0.6)))
                    } else {
                        let rect = CGRect(x: CGFloat(px + gap), y: CGFloat(py + gap),
                                          width: CGFloat(pixelW - gap * 2), height: CGFloat(pixelH - gap * 2))
                        context.fill(Path(rect),
                                     with: .color(TerrariumColors.claudeEye.opacity(Double(alpha))))
                    }

                case 5, 6: // Tentacles — stretch height, stay connected
                    let stretch = tentacleOffset(isLeft: cell == 5, pixelH: pixelH)
                    let stretchedH = max(pixelH * 0.3, pixelH + stretch - gap)
                    let rect = CGRect(x: CGFloat(px + gap), y: CGFloat(py),
                                      width: CGFloat(pixelW - gap * 2), height: CGFloat(stretchedH))
                    context.fill(Path(rect),
                                 with: .color(bodyColor.opacity(Double(alpha))))

                default: // Body + arms
                    let rect = CGRect(x: CGFloat(px + gap), y: CGFloat(py + gap),
                                      width: CGFloat(pixelW - gap * 2), height: CGFloat(pixelH - gap * 2))
                    context.fill(Path(rect),
                                 with: .color(bodyColor.opacity(Double(alpha))))
                }
            }
        }
    }

    private func bodyColorForState() -> Color {
        if visualState == .working {
            // Pulse between body and bodyLight during WORKING
            let t = (sin(time * TerrariumTiming.thinkingPulseSpeed) * 0.5 + 0.5)
            return lerpColor(TerrariumColors.claudeBody, TerrariumColors.claudeBodyLight, t)
        }
        return TerrariumColors.claudeBody
    }

    // MARK: - Starburst

    private func drawStarburst(context: inout GraphicsContext, cx: Float, cy: Float,
                                radius: Float, alpha: Float) {
        let rotation = time * 0.5
        let pulse = sin(time * TerrariumTiming.thinkingPulseSpeed) * 0.15 + 0.85

        for i in 0..<TerrariumTiming.starburstArmCount {
            let baseAngle = (Float(i) / Float(TerrariumTiming.starburstArmCount)) * 2 * Float.pi + rotation
            let armLen = radius * pulse * Self.starburstArmLengths[i % Self.starburstArmLengths.count]
            let endX = cx + cos(baseAngle) * armLen
            let endY = cy + sin(baseAngle) * armLen

            var path = Path()
            path.move(to: CGPoint(x: CGFloat(cx), y: CGFloat(cy)))
            path.addLine(to: CGPoint(x: CGFloat(endX), y: CGFloat(endY)))
            context.stroke(path,
                           with: .color(TerrariumColors.claudeBody.opacity(Double(alpha) * 0.35)),
                           lineWidth: CGFloat(radius * 0.10))
        }
    }

    // MARK: - Speech Bubble

    private func drawSpeechBubble(context: inout GraphicsContext, cx: CGFloat, cy: CGFloat, bodyRadius: CGFloat) {
        let pixelW = bodyRadius * 2 / CGFloat(Self.gridCols)
        let gridH = CGFloat(Self.gridRows) * pixelW * CGFloat(Self.pixelAspect)

        // Position: upper-right of the octopus head
        let bubbleX = cx + bodyRadius * 1.2
        let bubbleY = cy - gridH / 2 - bodyRadius * 0.6
        let bubbleR = bodyRadius * 0.7

        let pulse = CGFloat(sin(time * 2.5)) * 0.08 + 1
        let r = bubbleR * pulse

        // Bubble fill
        let bubbleRect = CGRect(x: bubbleX - r, y: bubbleY - r, width: r * 2, height: r * 2)
        context.fill(Path(ellipseIn: bubbleRect), with: .color(.white.opacity(0.25)))

        // Bubble border
        context.stroke(Path(ellipseIn: bubbleRect),
                       with: .color(TerrariumColors.hudText.opacity(0.5)),
                       lineWidth: bodyRadius * 0.04)

        // Tail triangle
        var tail = Path()
        tail.move(to: CGPoint(x: bubbleX - r * 0.3, y: bubbleY + r * 0.8))
        tail.addLine(to: CGPoint(x: cx + bodyRadius * 0.5, y: cy - gridH / 2))
        tail.addLine(to: CGPoint(x: bubbleX - r * 0.05, y: bubbleY + r * 0.95))
        tail.closeSubpath()
        context.fill(tail, with: .color(.white.opacity(0.25)))

        // "?" text
        context.draw(
            Text("?").font(.system(size: r * 1.2, weight: .bold)).foregroundColor(TerrariumColors.hudText.opacity(0.7)),
            at: CGPoint(x: bubbleX, y: bubbleY)
        )
    }

    // MARK: - Name Tag

    private func drawNameTag(context: inout GraphicsContext, name: String,
                             cx: CGFloat, cy: CGFloat, bodyRadius: CGFloat) {
        let pixelW = bodyRadius * 2 / CGFloat(Self.gridCols)
        let gridH = CGFloat(Self.gridRows) * pixelW * CGFloat(Self.pixelAspect)
        let hatY = cy - gridH / 2 - bodyRadius * 0.15
        let hatWidth = bodyRadius * 1.8
        let hatHeight = bodyRadius * 0.5

        let fontSize = bodyRadius * 0.3

        // Background pill
        let bgRect = CGRect(x: cx - hatWidth / 2, y: hatY - hatHeight,
                            width: hatWidth, height: hatHeight)
        context.fill(Path(roundedRect: bgRect, cornerRadius: 4),
                     with: .color(TerrariumColors.claudeNameBg))

        // Name text
        let text = Text(name)
            .font(.system(size: fontSize, weight: .medium, design: .default))
            .foregroundColor(TerrariumColors.hudText.opacity(0.86))
        context.draw(text, at: CGPoint(x: cx, y: hatY - hatHeight / 2))
    }
}

// MARK: - Helpers

private func lerpColor(_ a: Color, _ b: Color, _ t: Float) -> Color {
    TerrariumColors.lerpColor(a, b, t)
}
