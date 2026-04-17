// PlanktonSystem.swift — Floating plankton micro-particles, back/front layers
// Ported from android PlanktonSystem.kt

import SwiftUI

final class PlanktonSystem {
    private struct Particle {
        var x: Float
        var y: Float
        var size: Float
        var alpha: Float
        var baseAlpha: Float
        var driftAngle: Float
        var speed: Float
        var flickerPhase: Float
        var phase: Float
        var zLayer: Int  // 0=back, 1=front
    }

    private static let maxParticles = 80
    private static let cyanTint = Color(red: 0.69, green: 0.898, blue: 1.0) // #B0E5FF

    private var particles: [Particle]
    private var time: Float = 0
    private var envState: EnvironmentVisualState = .calm

    init() {
        particles = (0..<Self.maxParticles).map { i in
            Particle(
                x: Float.random(in: 0...1),
                y: Float.random(in: 0.05...0.90),
                size: Float.random(in: 0.001...0.003),
                alpha: Float.random(in: 0.05...0.15),
                baseAlpha: Float.random(in: 0.05...0.15),
                driftAngle: Float.random(in: 0...Float.pi * 2),
                speed: Float.random(in: 0.004...0.012),
                flickerPhase: Float.random(in: 0...Float.pi * 2),
                phase: Float.random(in: 0...Float.pi * 2),
                zLayer: i < Self.maxParticles / 2 ? 0 : 1
            )
        }
    }

    func setState(_ state: EnvironmentVisualState) {
        envState = state
    }

    func update(dt: Float) {
        time += dt

        let speedMultiplier: Float = switch envState {
        case .dark: 0.3
        case .calm: 0.6
        case .active: 1.0
        case .alert: 0.8
        }

        let alphaMultiplier: Float = switch envState {
        case .dark: 0.3
        case .calm: 0.6
        case .active: 1.0
        case .alert: 0.8
        }

        for i in particles.indices {
            // Slow irregular drift
            particles[i].driftAngle += sin(time * 0.3 + particles[i].phase) * 0.5 * dt
            particles[i].x += cos(particles[i].driftAngle) * particles[i].speed * speedMultiplier * dt
            particles[i].y += sin(particles[i].driftAngle) * particles[i].speed * speedMultiplier * dt * 0.7

            // Flicker
            let flicker = sin(time * 1.5 + particles[i].flickerPhase) * 0.03
            particles[i].alpha = min(0.18, max(0.02, particles[i].baseAlpha * alphaMultiplier + flicker))

            // Wrap at boundaries
            if particles[i].x < -0.02 { particles[i].x = 1.02 }
            if particles[i].x > 1.02 { particles[i].x = -0.02 }
            if particles[i].y < 0.03 { particles[i].y = 0.72 }
            if particles[i].y > 0.73 { particles[i].y = 0.03 }
        }
    }

    /// Draw back-layer plankton (behind creatures)
    func drawBackLayer(context: inout GraphicsContext, size: CGSize) {
        drawLayer(context: &context, size: size, zLayer: 0)
    }

    /// Draw front-layer plankton (in front of creatures)
    func drawFrontLayer(context: inout GraphicsContext, size: CGSize) {
        drawLayer(context: &context, size: size, zLayer: 1)
    }

    private func drawLayer(context: inout GraphicsContext, size: CGSize, zLayer: Int) {
        guard size.width > 0, size.height > 0,
              size.width.isFinite, size.height.isFinite else { return }
        let w = Float(size.width)
        let h = Float(size.height)

        let tintColor: Color = envState == .active ? Self.cyanTint : .white

        for p in particles where p.zLayer == zLayer {
            let rect = CGRect(
                x: CGFloat(p.x * w - p.size * w),
                y: CGFloat(p.y * h - p.size * w),
                width: CGFloat(p.size * w * 2),
                height: CGFloat(p.size * w * 2))
            context.fill(Path(ellipseIn: rect),
                         with: .color(tintColor.opacity(Double(p.alpha))))
        }
    }
}
