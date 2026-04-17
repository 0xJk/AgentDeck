// WaterEffect.swift — Caustics light pattern with overlapping sine meshes
// Ported from android WaterEffect.kt

import SwiftUI

final class WaterEffect {
    private var time: Float = 0
    private var envState: EnvironmentVisualState = .calm

    private static let lineCount = 5

    func setState(_ state: EnvironmentVisualState) {
        envState = state
    }

    func update(dt: Float) {
        time += dt * TerrariumTiming.causticsSpeed
    }

    func draw(context: inout GraphicsContext, size: CGSize) {
        guard envState != .dark else { return }
        guard size.width > 0, size.height > 0,
              size.width.isFinite, size.height.isFinite else { return }

        let w = Float(size.width)
        let h = Float(size.height)

        let alpha: Float = switch envState {
        case .dark: 0
        case .calm: 0.08
        case .active: 0.12
        case .alert: 0.10
        }

        // Use additive blending (matching Android BlendMode.Plus)
        // This creates a lighter, more ethereal caustic effect instead of opaque overlay
        var additive = context
        additive.blendMode = .plusLighter

        // Two overlapping caustic layers with different phases
        drawCausticLayer(context: &additive, w: w, h: h, alpha: alpha, phase: 0)
        drawCausticLayer(context: &additive, w: w, h: h, alpha: alpha * 0.05, phase: Float.pi * 0.7)
    }

    private func drawCausticLayer(context: inout GraphicsContext, w: Float, h: Float,
                                   alpha: Float, phase: Float) {
        let twoPi: Float = 2 * .pi
        let spacing = w / Float(Self.lineCount)
        let waveLen1 = w * 0.4
        let waveLen2 = w * 0.32
        let amp = spacing * 0.35
        let strokeW = CGFloat(w * 0.004)
        let reducedAlpha = alpha * 0.04

        let freq1 = twoPi / waveLen1
        let freq2 = twoPi / waveLen2
        let step: Float = 6

        // Family 1: near-horizontal lines (~10° tilt)
        let angle1: Float = 10 * .pi / 180
        let sin1 = sin(angle1), cos1 = cos(angle1)
        let extent = w * 0.15

        for i in 0..<Self.lineCount {
            let lineOffset = (Float(i) - Float(Self.lineCount) / 2) * spacing
            let linePhase = phase + Float(i) * 0.7
            var path = Path()
            var t: Float = -extent
            var first = true
            while t <= w + extent {
                let wave = sin(freq1 * t + time + linePhase) * amp
                let x = t * cos1 - (lineOffset + wave) * sin1
                let y = t * sin1 + (lineOffset + wave) * cos1 + h * 0.5
                let pt = CGPoint(x: CGFloat(x), y: CGFloat(y))
                if first { path.move(to: pt); first = false } else { path.addLine(to: pt) }
                t += step
            }
            context.stroke(path,
                           with: .color(.white.opacity(Double(reducedAlpha))),
                           lineWidth: strokeW)
        }

        // Family 2: ~60° angled lines
        let angle2: Float = 60 * .pi / 180
        let sin2 = sin(angle2), cos2 = cos(angle2)
        let diag = w + h

        for i in 0..<Self.lineCount {
            let lineOffset = (Float(i) - Float(Self.lineCount) / 2) * spacing * 1.2
            let linePhase = phase + Float(i) * 0.9 + 2.0
            var path = Path()
            var t: Float = -extent
            var first = true
            while t <= diag + extent {
                let wave = sin(freq2 * t + time * 0.85 + linePhase) * amp
                let x = t * cos2 - (lineOffset + wave) * sin2
                let y = t * sin2 + (lineOffset + wave) * cos2
                let pt = CGPoint(x: CGFloat(x), y: CGFloat(y))
                if first { path.move(to: pt); first = false } else { path.addLine(to: pt) }
                t += step
            }
            context.stroke(path,
                           with: .color(.white.opacity(Double(reducedAlpha))),
                           lineWidth: strokeW)
        }
    }
}
