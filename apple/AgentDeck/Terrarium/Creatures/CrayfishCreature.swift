// CrayfishCreature.swift — SVG Path front-facing crayfish
// Ported from android CrayfishCreature.kt

import SwiftUI

final class CrayfishCreature {
    // MARK: - SVG Path Data (viewBox 0 0 120 120)

    private static let svgViewBox: Float = 120

    private static let bodyPathData =
        "M60 10c-30 0-45 25-45 45s15 40 30 45v10h10v-10s5 2 10 0v10h10v-10c15-5 30-25 30-45S90 10 60 10"
    private static let leftClawPathData =
        "M20 45C5 40 0 50 5 60s15 5 20-5c3-7 0-10-5-10"
    private static let rightClawPathData =
        "M100 45c15-5 20 5 15 15s-15 5-20-5c-3-7 0-10 5-10"
    private static let leftAntennaPathData = "M45 15Q35 5 30 8"
    private static let rightAntennaPathData = "M75 15Q85 5 90 8"

    // Parsed paths (lazy)
    private lazy var bodyPath: SwiftUI.Path = Self.parseSvgPath(Self.bodyPathData)
    private lazy var leftClawPath: SwiftUI.Path = Self.parseSvgPath(Self.leftClawPathData)
    private lazy var rightClawPath: SwiftUI.Path = Self.parseSvgPath(Self.rightClawPathData)
    private lazy var leftAntennaPath: SwiftUI.Path = Self.parseSvgPath(Self.leftAntennaPathData)
    private lazy var rightAntennaPath: SwiftUI.Path = Self.parseSvgPath(Self.rightAntennaPathData)

    // MARK: - State

    var visualState: CrayfishVisualState = .dormant
    var visible = false

    private var time: Float = 0
    private var heartbeatPhase: Float = 0
    private var currentXFraction: Float
    private var currentYFraction: Float
    private let centerXFraction: Float
    private let centerYFraction: Float

    init(centerX: Float = TerrariumLayout.crayfishDefaultX,
         centerY: Float = TerrariumLayout.crayfishSittingY) {
        self.centerXFraction = centerX
        self.centerYFraction = centerY
        self.currentXFraction = centerX
        self.currentYFraction = centerY
    }

    // MARK: - Public API

    func currentPosition() -> (x: Float, y: Float) {
        (currentXFraction, currentYFraction)
    }

    func isRouting() -> Bool {
        visualState == .routing
    }

    // MARK: - Update

    func update(dt: Float, state: TerrariumState) {
        time += dt
        heartbeatPhase += dt
        visible = state.crayfishVisible

        guard visible else { return }
        visualState = state.crayfishState
    }

    // MARK: - Draw

    func draw(context: inout GraphicsContext, size: CGSize) {
        guard visible else { return }

        let w = Float(size.width)
        let h = Float(size.height)
        let cx = w * centerXFraction
        let cy = h * centerYFraction
        let bodyWidth = w * TerrariumLayout.crayfishWidthFraction

        // Effective position (state-dependent)
        let effectiveCX: Float
        let effectiveCY: Float
        switch visualState {
        case .dormant:
            effectiveCX = cx
            effectiveCY = cy + bodyWidth * 0.3
        case .routing:
            effectiveCX = cx
            effectiveCY = cy + sin(time * 3) * bodyWidth * 0.05
        case .sitting:
            effectiveCX = cx
            effectiveCY = cy + sin(time * 0.5) * bodyWidth * 0.008
        case .sick:
            effectiveCX = cx
            effectiveCY = cy + bodyWidth * 0.08 + sin(time * 0.7) * bodyWidth * 0.02
        default:
            effectiveCX = cx
            effectiveCY = cy
        }

        currentXFraction = effectiveCX / w
        currentYFraction = effectiveCY / h

        let alpha: Float = switch visualState {
        case .dormant: 0.4
        case .sick: 0.7
        default: 1.0
        }

        // Signal waves BEHIND creature
        if visualState == .routing {
            drawSignalWaves(context: &context, cx: CGFloat(effectiveCX), cy: CGFloat(effectiveCY),
                            bodyW: CGFloat(bodyWidth), canvasW: CGFloat(w))
        }

        // Shell glow pulse (ROUTING)
        if visualState == .routing {
            let glowPulse = (sin(time * 4) * 0.5 + 0.5)
            let glowRadius = CGFloat(bodyWidth) * CGFloat(0.4 + glowPulse * 0.15)
            let glowRect = CGRect(x: CGFloat(effectiveCX) - glowRadius,
                                  y: CGFloat(effectiveCY) - glowRadius,
                                  width: glowRadius * 2, height: glowRadius * 2)
            context.fill(Path(ellipseIn: glowRect),
                         with: .color(TerrariumColors.crayfishEye.opacity(Double(0.15 * glowPulse))))
        }

        // Heartbeat glow (SITTING)
        if visualState == .sitting {
            let cycle = heartbeatPhase.truncatingRemainder(dividingBy: 4.0)
            var pulse: Float = 0
            if cycle < 0.15 {
                pulse = sin(cycle / 0.15 * .pi)
            } else if cycle >= 0.25 && cycle < 0.40 {
                pulse = sin((cycle - 0.25) / 0.15 * .pi) * 0.6
            }
            if pulse > 0.01 {
                let glowRadius = CGFloat(bodyWidth) * CGFloat(0.25 + pulse * 0.08)
                let glowRect = CGRect(x: CGFloat(effectiveCX) - glowRadius,
                                      y: CGFloat(effectiveCY) - glowRadius,
                                      width: glowRadius * 2, height: glowRadius * 2)
                context.fill(Path(ellipseIn: glowRect),
                             with: .color(TerrariumColors.crayfishEye.opacity(Double(0.08 * pulse))))
            }
        }

        // Draw SVG creature
        drawSvgCreature(context: &context,
                        cx: CGFloat(effectiveCX), cy: CGFloat(effectiveCY),
                        bodyWidth: CGFloat(bodyWidth), alpha: Double(alpha))
    }

    // MARK: - SVG Creature Drawing

    private func drawSvgCreature(context: inout GraphicsContext,
                                 cx: CGFloat, cy: CGFloat,
                                 bodyWidth: CGFloat, alpha: Double) {
        let scale = bodyWidth / CGFloat(Self.svgViewBox)
        let offsetX = cx - CGFloat(Self.svgViewBox) / 2 * scale
        let offsetY = cy - CGFloat(Self.svgViewBox) / 2 * scale
        let sickTilt: Angle = visualState == .sick ? .degrees(-12) : .zero

        context.drawLayer { ctx in
            ctx.translateBy(x: offsetX, y: offsetY)
            ctx.scaleBy(x: scale, y: scale)

            if sickTilt != .zero {
                let pivot = CGFloat(Self.svgViewBox) / 2
                ctx.translateBy(x: pivot, y: pivot)
                ctx.rotate(by: sickTilt)
                ctx.translateBy(x: -pivot, y: -pivot)
            }

            let fillColor = shellColorForState()

            // 1. Body
            ctx.fill(bodyPath, with: .color(fillColor.opacity(alpha)))

            // 2. Left claw with pivot rotation
            let leftAngle = clawAngle(side: -1)
            ctx.drawLayer { clawCtx in
                clawCtx.translateBy(x: 20, y: 45)
                clawCtx.rotate(by: .degrees(Double(leftAngle)))
                clawCtx.translateBy(x: -20, y: -45)
                clawCtx.fill(leftClawPath, with: .color(fillColor.opacity(alpha)))
            }

            // 3. Right claw with pivot rotation
            let rightAngle = clawAngle(side: 1)
            ctx.drawLayer { clawCtx in
                clawCtx.translateBy(x: 100, y: 45)
                clawCtx.rotate(by: .degrees(Double(rightAngle)))
                clawCtx.translateBy(x: -100, y: -45)
                clawCtx.fill(rightClawPath, with: .color(fillColor.opacity(alpha)))
            }

            // 4. Antennae with wiggle
            let antennaColor = shellColorForState().opacity(alpha)
            let antennaStroke = StrokeStyle(lineWidth: 3, lineCap: .round)

            let wiggleX: CGFloat
            let wiggleY: CGFloat
            switch visualState {
            case .routing:
                wiggleX = CGFloat(sin(time * 7) * 4)
                wiggleY = CGFloat(sin(time * 5) * 3)
            case .sitting:
                wiggleX = CGFloat(sin(time * 0.8) * 0.7)
                wiggleY = CGFloat(sin(time * 0.5) * 0.4)
            case .sick:
                wiggleX = CGFloat(sin(time * 0.3) * 0.4)
                wiggleY = CGFloat(2 + sin(time * 0.4) * 0.5)
            default:
                wiggleX = 0
                wiggleY = 0
            }

            ctx.drawLayer { antCtx in
                antCtx.translateBy(x: wiggleX, y: wiggleY)
                antCtx.stroke(leftAntennaPath, with: .color(antennaColor), style: antennaStroke)
            }
            ctx.drawLayer { antCtx in
                antCtx.translateBy(x: -wiggleX, y: wiggleY)
                antCtx.stroke(rightAntennaPath, with: .color(antennaColor), style: antennaStroke)
            }

            // 5. Eyes — dark circles with teal highlights
            let eyeDark = Color(red: 0.02, green: 0.031, blue: 0.063).opacity(alpha) // #050810
            for eyeX in [45.0, 75.0] as [CGFloat] {
                let eyeRect = CGRect(x: eyeX - 6, y: 35 - 6, width: 12, height: 12)
                ctx.fill(Path(ellipseIn: eyeRect), with: .color(eyeDark))
            }

            let hlColor = eyeHighlightColor().opacity(alpha)
            for eyeX in [46.0, 76.0] as [CGFloat] {
                let hlRect = CGRect(x: eyeX - 2.5, y: 34 - 2.5, width: 5, height: 5)
                ctx.fill(Path(ellipseIn: hlRect), with: .color(hlColor))
            }
        }
    }

    // MARK: - State-dependent appearance

    private func shellColorForState() -> Color {
        switch visualState {
        case .routing:
            let pulse = (sin(time * 4) * 0.5 + 0.5) * 0.3
            return lerpColor(TerrariumColors.crayfishShell, TerrariumColors.crayfishBodyLight, Float(pulse))
        case .sick:
            return lerpColor(TerrariumColors.crayfishShell, Color(red: 0.545, green: 0.482, blue: 0.482), 0.55)
        default:
            return TerrariumColors.crayfishShell
        }
    }

    private func clawAngle(side: Float) -> Float {
        switch visualState {
        case .routing:
            let period = TerrariumTiming.clawClapPeriod
            let phase = time * 2 * Float.pi / period
            return side * sin(phase + side * 0.3) * 28
        case .sitting:
            return side * sin(time * 0.4) * 1.5
        case .waiting:
            return side * 15
        case .observing:
            return side * (3 + sin(time * 2) * 5)
        case .sick:
            return side * (-8 + sin(time * 0.5) * 2)
        case .dormant:
            return 0
        }
    }

    private func eyeHighlightColor() -> Color {
        switch visualState {
        case .routing:
            let period = TerrariumTiming.eyeFlashPeriod
            let flash = sin(time * 2 * Float.pi / period)
            let intensity = (flash * 0.5 + 0.5) * 0.5
            return lerpColor(TerrariumColors.crayfishEye, .white, Float(intensity))
        case .sitting:
            let breath = sin(time * 0.6) * 0.15 + 0.85
            return TerrariumColors.crayfishEye.opacity(Double(breath))
        case .sick:
            let flicker = sin(time * 1.2) * 0.1 + 0.45
            return TerrariumColors.crayfishEye.opacity(Double(flicker))
        default:
            return TerrariumColors.crayfishEye
        }
    }

    // MARK: - Signal Waves + Orbiting Dots

    private func drawSignalWaves(context: inout GraphicsContext,
                                 cx: CGFloat, cy: CGFloat,
                                 bodyW: CGFloat, canvasW: CGFloat) {
        let waveSpeed = time * 2
        let maxRadius = canvasW * 0.15

        // 4 expanding arcs
        for i in 0..<4 {
            let progress = (waveSpeed + Float(i) * 0.25).truncatingRemainder(dividingBy: 1.0)
            let radius = bodyW * 0.3 + CGFloat(progress) * maxRadius
            let waveAlpha = Double(1 - progress) * 0.35
            let lineWidth = 3 + CGFloat(1 - progress) * 2

            let arcPath = Path { p in
                p.addArc(center: CGPoint(x: cx, y: cy),
                         radius: radius,
                         startAngle: .degrees(120),
                         endAngle: .degrees(240),
                         clockwise: false)
            }
            context.stroke(arcPath,
                           with: .color(TerrariumColors.crayfishEye.opacity(waveAlpha)),
                           lineWidth: lineWidth)
        }

        // 6 orbiting neon dots
        for i in 0..<6 {
            let dotProgress = (time * 3 + Float(i) * 0.16).truncatingRemainder(dividingBy: 1.0)
            let dotRadius = bodyW * 0.3 + CGFloat(dotProgress) * maxRadius
            let dotAngle = (150 + dotProgress * 40) * Float.pi / 180
            let dotX = cx + CGFloat(cos(dotAngle)) * dotRadius
            let dotY = cy + CGFloat(sin(dotAngle)) * dotRadius
            let dotAlpha = Double(1 - dotProgress) * 0.6
            let dotSize = bodyW * 0.015

            let dotRect = CGRect(x: dotX - dotSize, y: dotY - dotSize,
                                 width: dotSize * 2, height: dotSize * 2)
            context.fill(Path(ellipseIn: dotRect),
                         with: .color(TerrariumColors.tetraNeon.opacity(dotAlpha)))
        }
    }

    // MARK: - Helpers

    private func lerpColor(_ a: Color, _ b: Color, _ t: Float) -> Color {
        TerrariumColors.lerpColor(a, b, t)
    }

    // MARK: - SVG Path Parser

    private static func parseSvgPath(_ data: String) -> SwiftUI.Path {
        var path = SwiftUI.Path()
        let chars = Array(data)
        var idx = 0
        var currentX: CGFloat = 0
        var currentY: CGFloat = 0
        var startX: CGFloat = 0
        var startY: CGFloat = 0
        var lastCmd: Character = " "
        var lastCPX: CGFloat = 0
        var lastCPY: CGFloat = 0

        func skipWhitespaceAndCommas() {
            while idx < chars.count && (chars[idx] == " " || chars[idx] == "," || chars[idx] == "\n" || chars[idx] == "\r" || chars[idx] == "\t") {
                idx += 1
            }
        }

        func parseNumber() -> CGFloat? {
            skipWhitespaceAndCommas()
            guard idx < chars.count else { return nil }
            var numStr = ""
            if idx < chars.count && (chars[idx] == "-" || chars[idx] == "+") {
                numStr.append(chars[idx])
                idx += 1
            }
            var hasDot = false
            while idx < chars.count && (chars[idx].isNumber || (chars[idx] == "." && !hasDot)) {
                if chars[idx] == "." { hasDot = true }
                numStr.append(chars[idx])
                idx += 1
            }
            // Handle exponential notation
            if idx < chars.count && (chars[idx] == "e" || chars[idx] == "E") {
                numStr.append(chars[idx])
                idx += 1
                if idx < chars.count && (chars[idx] == "-" || chars[idx] == "+") {
                    numStr.append(chars[idx])
                    idx += 1
                }
                while idx < chars.count && chars[idx].isNumber {
                    numStr.append(chars[idx])
                    idx += 1
                }
            }
            return numStr.isEmpty ? nil : CGFloat(Double(numStr) ?? 0)
        }

        while idx < chars.count {
            skipWhitespaceAndCommas()
            guard idx < chars.count else { break }

            var cmd = chars[idx]
            if cmd.isLetter {
                idx += 1
                lastCmd = cmd
            } else {
                cmd = lastCmd
            }

            switch cmd {
            case "M":
                guard let x = parseNumber(), let y = parseNumber() else { break }
                currentX = x; currentY = y; startX = x; startY = y
                path.move(to: CGPoint(x: x, y: y))
                lastCmd = "L"
            case "m":
                guard let dx = parseNumber(), let dy = parseNumber() else { break }
                currentX += dx; currentY += dy; startX = currentX; startY = currentY
                path.move(to: CGPoint(x: currentX, y: currentY))
                lastCmd = "l"
            case "L":
                guard let x = parseNumber(), let y = parseNumber() else { break }
                currentX = x; currentY = y
                path.addLine(to: CGPoint(x: x, y: y))
            case "l":
                guard let dx = parseNumber(), let dy = parseNumber() else { break }
                currentX += dx; currentY += dy
                path.addLine(to: CGPoint(x: currentX, y: currentY))
            case "H":
                guard let x = parseNumber() else { break }
                currentX = x
                path.addLine(to: CGPoint(x: currentX, y: currentY))
            case "h":
                guard let dx = parseNumber() else { break }
                currentX += dx
                path.addLine(to: CGPoint(x: currentX, y: currentY))
            case "V":
                guard let y = parseNumber() else { break }
                currentY = y
                path.addLine(to: CGPoint(x: currentX, y: currentY))
            case "v":
                guard let dy = parseNumber() else { break }
                currentY += dy
                path.addLine(to: CGPoint(x: currentX, y: currentY))
            case "C":
                guard let x1 = parseNumber(), let y1 = parseNumber(),
                      let x2 = parseNumber(), let y2 = parseNumber(),
                      let x = parseNumber(), let y = parseNumber() else { break }
                path.addCurve(to: CGPoint(x: x, y: y),
                              control1: CGPoint(x: x1, y: y1),
                              control2: CGPoint(x: x2, y: y2))
                lastCPX = x2; lastCPY = y2
                currentX = x; currentY = y
            case "c":
                guard let dx1 = parseNumber(), let dy1 = parseNumber(),
                      let dx2 = parseNumber(), let dy2 = parseNumber(),
                      let dx = parseNumber(), let dy = parseNumber() else { break }
                let x1 = currentX + dx1, y1 = currentY + dy1
                let x2 = currentX + dx2, y2 = currentY + dy2
                let x = currentX + dx, y = currentY + dy
                path.addCurve(to: CGPoint(x: x, y: y),
                              control1: CGPoint(x: x1, y: y1),
                              control2: CGPoint(x: x2, y: y2))
                lastCPX = x2; lastCPY = y2
                currentX = x; currentY = y
            case "S":
                guard let x2 = parseNumber(), let y2 = parseNumber(),
                      let x = parseNumber(), let y = parseNumber() else { break }
                let x1 = 2 * currentX - lastCPX
                let y1 = 2 * currentY - lastCPY
                path.addCurve(to: CGPoint(x: x, y: y),
                              control1: CGPoint(x: x1, y: y1),
                              control2: CGPoint(x: x2, y: y2))
                lastCPX = x2; lastCPY = y2
                currentX = x; currentY = y
            case "s":
                guard let dx2 = parseNumber(), let dy2 = parseNumber(),
                      let dx = parseNumber(), let dy = parseNumber() else { break }
                let x1 = 2 * currentX - lastCPX
                let y1 = 2 * currentY - lastCPY
                let x2 = currentX + dx2, y2 = currentY + dy2
                let x = currentX + dx, y = currentY + dy
                path.addCurve(to: CGPoint(x: x, y: y),
                              control1: CGPoint(x: x1, y: y1),
                              control2: CGPoint(x: x2, y: y2))
                lastCPX = x2; lastCPY = y2
                currentX = x; currentY = y
            case "Q":
                guard let cx = parseNumber(), let cy = parseNumber(),
                      let x = parseNumber(), let y = parseNumber() else { break }
                path.addQuadCurve(to: CGPoint(x: x, y: y),
                                  control: CGPoint(x: cx, y: cy))
                lastCPX = cx; lastCPY = cy
                currentX = x; currentY = y
            case "q":
                guard let dcx = parseNumber(), let dcy = parseNumber(),
                      let dx = parseNumber(), let dy = parseNumber() else { break }
                let cx = currentX + dcx, cy = currentY + dcy
                let x = currentX + dx, y = currentY + dy
                path.addQuadCurve(to: CGPoint(x: x, y: y),
                                  control: CGPoint(x: cx, y: cy))
                lastCPX = cx; lastCPY = cy
                currentX = x; currentY = y
            case "Z", "z":
                path.closeSubpath()
                currentX = startX; currentY = startY
            default:
                idx += 1
            }
        }

        return path
    }
}
