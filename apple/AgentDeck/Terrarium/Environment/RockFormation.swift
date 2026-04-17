// RockFormation.swift — Bottom terrain: sand gradient + rocks + LED cables
// Ported from android RockFormation.kt

import SwiftUI

final class RockFormation {
    private var envState: EnvironmentVisualState = .calm
    private var time: Float = 0

    // Pre-calculated ripple positions (12 ripples)
    private static let rippleStartX: [Float] = [
        0.03, 0.15, 0.28, 0.42, 0.55, 0.68,
        0.08, 0.22, 0.35, 0.50, 0.62, 0.78,
    ]
    private static let rippleLengths: [Float] = [
        0.15, 0.12, 0.18, 0.10, 0.14, 0.12,
        0.13, 0.16, 0.11, 0.14, 0.10, 0.15,
    ]
    private static let rippleYOffsets: [Float] = [
        0.15, 0.25, 0.35, 0.20, 0.40, 0.30,
        0.50, 0.45, 0.55, 0.60, 0.70, 0.65,
    ]

    // Pre-calculated pebble positions
    private static let pebbleX: [Float] = [0.10, 0.22, 0.35, 0.48, 0.58, 0.30, 0.42, 0.65, 0.18, 0.52]
    private static let pebbleY: [Float] = [0.25, 0.40, 0.55, 0.30, 0.50, 0.70, 0.65, 0.45, 0.60, 0.75]
    private static let pebbleW: [Float] = [0.004, 0.003, 0.005, 0.003, 0.004, 0.003, 0.005, 0.004, 0.003, 0.004]

    func setState(_ state: EnvironmentVisualState) {
        envState = state
    }

    func update(dt: Float) {
        time += dt
    }

    func draw(context: inout GraphicsContext, size: CGSize) {
        guard size.width > 0, size.height > 0,
              size.width.isFinite, size.height.isFinite else { return }
        let w = Float(size.width)
        let h = Float(size.height)

        drawSand(context: &context, w: w, h: h)
        drawRocks(context: &context, w: w, h: h)
    }

    /// Draw LED cables on top of rocks (called separately for correct layering)
    func drawLEDs(context: inout GraphicsContext, size: CGSize, envState: EnvironmentVisualState) {
        self.envState = envState
        let w = Float(size.width)
        let h = Float(size.height)
        drawLEDCables(context: &context, w: w, h: h)
    }

    // MARK: - Sand

    private func drawSand(context: inout GraphicsContext, w: Float, h: Float) {
        let sandTop = h * (1 - TerrariumLayout.sandHeightFraction)

        // Sand gradient
        let sandRect = CGRect(x: 0, y: CGFloat(sandTop), width: CGFloat(w), height: CGFloat(h - sandTop))
        context.fill(
            Path(sandRect),
            with: .linearGradient(
                Gradient(colors: [TerrariumColors.sandLight, TerrariumColors.sandBase]),
                startPoint: CGPoint(x: 0, y: CGFloat(sandTop)),
                endPoint: CGPoint(x: 0, y: CGFloat(h))
            )
        )

        // 12 sine-wave sand ripples
        for i in 0..<12 {
            let startX = w * Self.rippleStartX[i]
            let endX = startX + w * Self.rippleLengths[i]
            let y = sandTop + (h - sandTop) * Self.rippleYOffsets[i]

            var path = Path()
            let steps = 20
            for s in 0...steps {
                let x = startX + (endX - startX) * Float(s) / Float(steps)
                let waveY = y + sin(x * 0.02 + Float(i) * 0.7) * 2
                let pt = CGPoint(x: CGFloat(x), y: CGFloat(waveY))
                if s == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
            }

            context.stroke(path,
                           with: .color(TerrariumColors.sandBase.opacity(0.25)),
                           lineWidth: 0.8)
        }

        // 10 pebbles
        for i in 0..<10 {
            let px = w * Self.pebbleX[i]
            let py = sandTop + (h - sandTop) * Self.pebbleY[i]
            let pw = w * Self.pebbleW[i]
            let ph = pw * 0.6
            let color = i % 2 == 0 ? TerrariumColors.rockDark : TerrariumColors.rockMid

            let rect = CGRect(x: CGFloat(px - pw * 0.5), y: CGFloat(py - ph * 0.5),
                              width: CGFloat(pw), height: CGFloat(ph))
            context.fill(Path(ellipseIn: rect), with: .color(color.opacity(0.40)))
        }
    }

    // MARK: - Rocks

    private func drawRocks(context: inout GraphicsContext, w: Float, h: Float) {
        let bottomY = h * (1 - TerrariumLayout.sandHeightFraction)

        // Large rock cluster (right side — crayfish sits here)
        drawRock(context: &context, cx: w * 0.7, baseY: bottomY, rw: w * 0.15, rh: w * 0.08, color: TerrariumColors.rockMid)
        drawRock(context: &context, cx: w * 0.8, baseY: bottomY - w * 0.02, rw: w * 0.12, rh: w * 0.10, color: TerrariumColors.rockDark)
        drawRock(context: &context, cx: w * 0.75, baseY: bottomY - w * 0.01, rw: w * 0.08, rh: w * 0.06, color: TerrariumColors.rockLight)

        // Small rocks (left side)
        drawRock(context: &context, cx: w * 0.05, baseY: bottomY, rw: w * 0.08, rh: w * 0.05, color: TerrariumColors.rockDark)
        drawRock(context: &context, cx: w * 0.12, baseY: bottomY + w * 0.01, rw: w * 0.06, rh: w * 0.04, color: TerrariumColors.rockMid)

        // Center small rock
        drawRock(context: &context, cx: w * 0.45, baseY: bottomY + w * 0.01, rw: w * 0.05, rh: w * 0.03, color: TerrariumColors.rockLight)
    }

    private func drawRock(context: inout GraphicsContext, cx: Float, baseY: Float, rw: Float, rh: Float, color: Color) {
        var path = Path()
        path.move(to: CGPoint(x: CGFloat(cx - rw * 0.5), y: CGFloat(baseY)))
        path.addCurve(
            to: CGPoint(x: CGFloat(cx + rw * 0.5), y: CGFloat(baseY)),
            control1: CGPoint(x: CGFloat(cx - rw * 0.4), y: CGFloat(baseY - rh * 0.8)),
            control2: CGPoint(x: CGFloat(cx + rw * 0.4), y: CGFloat(baseY - rh * 1.1))
        )
        path.closeSubpath()

        context.fill(path, with: .color(color))

        // Highlight edge
        context.stroke(path, with: .color(.white.opacity(0.05)), lineWidth: 1)
    }

    // MARK: - LED Cables

    private func drawLEDCables(context: inout GraphicsContext, w: Float, h: Float) {
        let bottomY = h * (1 - TerrariumLayout.sandHeightFraction)

        let ledColor: Color = switch envState {
        case .dark: TerrariumColors.ledRed.opacity(0.15)
        case .calm: TerrariumColors.ledGreen
        case .active: TerrariumColors.ledAmber
        case .alert: TerrariumColors.ledRed
        }

        let pulse = sin(time * TerrariumTiming.ledPulseSpeed) * 0.3 + 0.7

        // Cable path from left rocks to right rocks
        var cablePath = Path()
        cablePath.move(to: CGPoint(x: CGFloat(w * 0.1), y: CGFloat(bottomY - w * 0.02)))
        cablePath.addQuadCurve(
            to: CGPoint(x: CGFloat(w * 0.5), y: CGFloat(bottomY - w * 0.01)),
            control: CGPoint(x: CGFloat(w * 0.3), y: CGFloat(bottomY + w * 0.02))
        )
        cablePath.addQuadCurve(
            to: CGPoint(x: CGFloat(w * 0.75), y: CGFloat(bottomY - w * 0.04)),
            control: CGPoint(x: CGFloat(w * 0.65), y: CGFloat(bottomY + w * 0.01))
        )

        context.stroke(cablePath,
                       with: .color(ledColor.opacity(Double(pulse) * 0.4)),
                       style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [6, 4]))

        // LED dots along cable
        let dotCount = 8
        for i in 0..<dotCount {
            let t = Float(i) / Float(dotCount - 1)
            let dotX = w * (0.1 + t * 0.65)
            let dotY = bottomY - w * 0.01 + sin(t * Float.pi * 2) * w * 0.015

            let dotPulse = sin(time * TerrariumTiming.ledPulseSpeed + Float(i) * 0.5) * 0.4 + 0.6
            let rect = CGRect(x: CGFloat(dotX - w * 0.003), y: CGFloat(dotY - w * 0.003),
                              width: CGFloat(w * 0.006), height: CGFloat(w * 0.006))
            context.fill(Path(ellipseIn: rect),
                         with: .color(ledColor.opacity(Double(dotPulse) * 0.8)))
        }
    }
}
