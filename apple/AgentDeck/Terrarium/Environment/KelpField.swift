// KelpField.swift — Swaying kelp bezier curves + grass blades
// Ported from android KelpField.kt

import SwiftUI

final class KelpField {
    private struct KelpStrand {
        let baseX: Float
        let height: Float
        let phase: Float
        let segments: Int
    }

    private struct GrassBlade {
        let baseX: Float
        let height: Float
        let phase: Float
        let width: Float
    }

    private let strands: [KelpStrand] = [
        KelpStrand(baseX: 0.08, height: 0.25, phase: 0, segments: 3),
        KelpStrand(baseX: 0.12, height: 0.30, phase: 1.2, segments: 4),
        KelpStrand(baseX: 0.15, height: 0.20, phase: 2.5, segments: 2),
        KelpStrand(baseX: 0.88, height: 0.22, phase: 0.8, segments: 3),
        KelpStrand(baseX: 0.92, height: 0.28, phase: 1.8, segments: 3),
        KelpStrand(baseX: 0.55, height: 0.18, phase: 3.0, segments: 2),
    ]

    private let grassBlades: [GrassBlade] = [
        // Left cluster (near left rocks)
        GrassBlade(baseX: 0.04, height: 0.035, phase: 0.3, width: 0.8),
        GrassBlade(baseX: 0.06, height: 0.050, phase: 1.1, width: 1.0),
        GrassBlade(baseX: 0.08, height: 0.040, phase: 2.0, width: 0.7),
        GrassBlade(baseX: 0.10, height: 0.055, phase: 0.7, width: 0.9),
        GrassBlade(baseX: 0.13, height: 0.030, phase: 1.5, width: 0.8),
        // Center cluster
        GrassBlade(baseX: 0.42, height: 0.045, phase: 2.3, width: 0.9),
        GrassBlade(baseX: 0.44, height: 0.060, phase: 0.5, width: 1.0),
        GrassBlade(baseX: 0.46, height: 0.040, phase: 1.8, width: 0.8),
        GrassBlade(baseX: 0.48, height: 0.050, phase: 3.1, width: 0.7),
        GrassBlade(baseX: 0.43, height: 0.035, phase: 2.8, width: 0.9),
        // Right cluster
        GrassBlade(baseX: 0.83, height: 0.040, phase: 0.9, width: 0.8),
        GrassBlade(baseX: 0.86, height: 0.055, phase: 2.2, width: 1.0),
        GrassBlade(baseX: 0.88, height: 0.035, phase: 1.4, width: 0.7),
        GrassBlade(baseX: 0.90, height: 0.050, phase: 3.5, width: 0.9),
        GrassBlade(baseX: 0.91, height: 0.030, phase: 0.2, width: 0.8),
    ]

    private var time: Float = 0

    func update(dt: Float) {
        time += dt * TerrariumTiming.kelpSwaySpeed
    }

    func draw(context: inout GraphicsContext, size: CGSize) {
        guard size.width > 0, size.height > 0,
              size.width.isFinite, size.height.isFinite else { return }
        let w = Float(size.width)
        let h = Float(size.height)

        // Draw grass blades first (below kelp)
        for blade in grassBlades {
            drawGrassBlade(context: &context, blade: blade, w: w, h: h)
        }

        for strand in strands {
            drawStrand(context: &context, strand: strand, w: w, h: h)
        }
    }

    private func drawGrassBlade(context: inout GraphicsContext, blade: GrassBlade, w: Float, h: Float) {
        let baseX = blade.baseX * w
        let baseY = h * (1 - TerrariumLayout.sandHeightFraction)
        let tipY = baseY - blade.height * h
        let sway = sin(time * 1.5 + blade.phase) * w * 0.008

        var path = Path()
        path.move(to: CGPoint(x: CGFloat(baseX), y: CGFloat(baseY)))
        path.addQuadCurve(
            to: CGPoint(x: CGFloat(baseX + sway * 0.7), y: CGFloat(tipY)),
            control: CGPoint(x: CGFloat(baseX + sway), y: CGFloat((baseY + tipY) * 0.5))
        )

        context.stroke(path,
                       with: .color(TerrariumColors.kelpDark.opacity(0.6)),
                       lineWidth: CGFloat(w * 0.002 * blade.width))
    }

    private func drawStrand(context: inout GraphicsContext, strand: KelpStrand, w: Float, h: Float) {
        let baseX = strand.baseX * w
        let baseY = h * (1 - TerrariumLayout.sandHeightFraction)
        let topY = baseY - strand.height * h
        let segHeight = (baseY - topY) / Float(strand.segments)

        var path = Path()
        path.move(to: CGPoint(x: CGFloat(baseX), y: CGFloat(baseY)))
        for i in 0..<strand.segments {
            let sway = sin(time + strand.phase + Float(i) * 0.8) * w * 0.015 * Float(i + 1)
            let y1 = baseY - (Float(i) + 0.5) * segHeight
            let y2 = baseY - (Float(i) + 1) * segHeight
            let cpX = baseX + sway
            path.addQuadCurve(
                to: CGPoint(x: CGFloat(baseX + sway * 0.6), y: CGFloat(y2)),
                control: CGPoint(x: CGFloat(cpX), y: CGFloat(y1))
            )
        }

        // Main stem (dark)
        context.stroke(path,
                       with: .color(TerrariumColors.kelpDark),
                       lineWidth: CGFloat(w * 0.004))

        // Lighter inner stroke
        context.stroke(path,
                       with: .color(TerrariumColors.kelpGreen.opacity(0.5)),
                       lineWidth: CGFloat(w * 0.002))

        // Leaf blobs at segment joints
        for i in 1...strand.segments {
            let sway = sin(time + strand.phase + Float(i) * 0.8) * w * 0.015 * Float(i)
            let leafY = baseY - Float(i) * segHeight
            let leafX = baseX + sway * 0.6

            let rect = CGRect(x: CGFloat(leafX - w * 0.006), y: CGFloat(leafY - w * 0.003),
                              width: CGFloat(w * 0.012), height: CGFloat(w * 0.006))
            context.fill(Path(ellipseIn: rect),
                         with: .color(TerrariumColors.kelpGreen.opacity(0.4)))
        }
    }
}
