// WaterSurface.swift — Water surface line with two-sine composite + meniscus + sparkles
// Ported from android WaterSurface.kt

import SwiftUI

final class WaterSurface {
    private var time: Float = 0
    private var envState: EnvironmentVisualState = .calm

    private static let surfaceYFraction: Float = 0.04
    private static let gradientHeight: Float = 0.03
    private static let waveSegments = 60
    private static let waveFreq1: Float = 2.5
    private static let waveFreq2: Float = 5.0
    private static let waveFreq3: Float = 8.0
    private static let waveSpeed1: Float = 0.6
    private static let waveSpeed2: Float = 1.2
    private static let waveSpeed3: Float = 2.5
    private static let sparkleCount = 4
    private static let sparklePositions: [Float] = [0.15, 0.38, 0.62, 0.85]

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
        let surfaceY = h * Self.surfaceYFraction

        let amplitude1: Float = switch envState {
        case .dark: h * 0.002
        case .calm: h * 0.005
        case .active: h * 0.008
        case .alert: h * 0.007
        }
        let amplitude2 = amplitude1 * 0.4
        let amplitude3: Float = envState == .alert ? h * 0.003 : 0

        let lineAlpha: Float = switch envState {
        case .dark: 0.08
        case .calm: 0.20
        case .active: 0.25
        case .alert: 0.22
        }

        let gradAlpha: Float = switch envState {
        case .dark: 0.03
        case .calm: 0.08
        case .active: 0.10
        case .alert: 0.08
        }

        let twoPi = Float.pi * 2

        // Build wave path
        var wavePath = Path()
        for i in 0...Self.waveSegments {
            let nx = Float(i) / Float(Self.waveSegments)
            let x = nx * w
            var y = surfaceY +
                sin(nx * Self.waveFreq1 * twoPi + time * Self.waveSpeed1) * amplitude1 +
                sin(nx * Self.waveFreq2 * twoPi + time * Self.waveSpeed2) * amplitude2 +
                sin(nx * Self.waveFreq3 * twoPi + time * Self.waveSpeed3) * amplitude3

            // Meniscus at edges
            if nx < 0.05 {
                y -= amplitude1 * 0.6 * (1 - nx / 0.05)
            } else if nx > 0.95 {
                y -= amplitude1 * 0.6 * ((nx - 0.95) / 0.05)
            }

            let pt = CGPoint(x: CGFloat(x), y: CGFloat(y))
            if i == 0 { wavePath.move(to: pt) } else { wavePath.addLine(to: pt) }
        }

        // Air/water gradient above surface line
        var gradientPath = wavePath
        gradientPath.addLine(to: CGPoint(x: CGFloat(w), y: CGFloat(surfaceY - h * Self.gradientHeight)))
        gradientPath.addLine(to: CGPoint(x: 0, y: CGFloat(surfaceY - h * Self.gradientHeight)))
        gradientPath.closeSubpath()

        context.fill(gradientPath,
                     with: .linearGradient(
                        Gradient(colors: [.clear, Color.white.opacity(Double(gradAlpha))]),
                        startPoint: CGPoint(x: 0, y: CGFloat(surfaceY - h * Self.gradientHeight)),
                        endPoint: CGPoint(x: 0, y: CGFloat(surfaceY))
                     ))

        // Surface line stroke
        context.stroke(wavePath,
                       with: .color(.white.opacity(Double(lineAlpha))),
                       lineWidth: 1.5)

        // Sparkle highlights on wave crests
        for i in 0..<Self.sparkleCount {
            let nx = Self.sparklePositions[i] + sin(time * 0.2 + Float(i) * 1.3) * 0.03
            let x = nx * w
            let waveY = surfaceY +
                sin(nx * Self.waveFreq1 * twoPi + time * Self.waveSpeed1) * amplitude1 +
                sin(nx * Self.waveFreq2 * twoPi + time * Self.waveSpeed2) * amplitude2

            let sparkleAlpha = lineAlpha * 0.6 * ((sin(time * 0.8 + Float(i) * 2.1) + 1) * 0.5)
            guard sparkleAlpha > 0.02 else { continue }

            let sparkleRect = CGRect(
                x: CGFloat(x - w * 0.006), y: CGFloat(waveY - h * 0.002),
                width: CGFloat(w * 0.012), height: CGFloat(h * 0.003))
            context.fill(Path(ellipseIn: sparkleRect),
                         with: .color(.white.opacity(Double(sparkleAlpha))))
        }
    }
}
