// SandDisturbance.swift — Sand particles kicked up by creatures near bottom
// Ported from android SandDisturbance.kt

import SwiftUI

final class SandDisturbance {
    private struct SandParticle {
        var x: Float = 0
        var y: Float = 0
        var vx: Float = 0
        var vy: Float = 0
        var alpha: Float = 0
        var size: Float = 0
        var age: Float = 0
        var lifetime: Float = 0
        var alive: Bool = false
    }

    private static let maxParticles = 20
    private static let gravity: Float = 0.03
    private static let sandProximityThreshold: Float = 0.62

    private var particles: [SandParticle]
    private var nextSlot = 0
    private var time: Float = 0
    private var timeSinceSpawn: Float = 0
    private var envState: EnvironmentVisualState = .calm

    var creaturePositions: [(x: Float, y: Float)] = []

    init() {
        particles = Array(repeating: SandParticle(), count: Self.maxParticles)
    }

    func setState(_ state: EnvironmentVisualState) {
        envState = state
    }

    func update(dt: Float) {
        time += dt
        timeSinceSpawn += dt * 1000

        let spawnInterval: Float = switch envState {
        case .dark: Float.greatestFiniteMagnitude
        case .calm: 3000
        case .active: 1500
        case .alert: 2000
        }

        // Spawn from creatures near sand line
        if timeSinceSpawn >= spawnInterval {
            timeSinceSpawn -= spawnInterval
            for pos in creaturePositions {
                if pos.y > Self.sandProximityThreshold {
                    spawnParticle(cx: pos.x, cy: pos.y)
                    break
                }
            }
        }

        // Update existing particles
        for i in particles.indices {
            guard particles[i].alive else { continue }
            particles[i].age += dt
            if particles[i].age >= particles[i].lifetime {
                particles[i].alive = false
                continue
            }

            particles[i].vy += Self.gravity * dt
            particles[i].x += particles[i].vx * dt
            particles[i].y += particles[i].vy * dt

            // Fade out over lifetime
            particles[i].alpha = max(0, 0.3 * (1 - particles[i].age / particles[i].lifetime))
        }
    }

    func draw(context: inout GraphicsContext, size: CGSize) {
        guard size.width > 0, size.height > 0,
              size.width.isFinite, size.height.isFinite else { return }
        let w = Float(size.width)
        let h = Float(size.height)

        for p in particles where p.alive {
            let rect = CGRect(
                x: CGFloat(p.x * w - p.size * w),
                y: CGFloat(p.y * h - p.size * w),
                width: CGFloat(p.size * w * 2),
                height: CGFloat(p.size * w * 2))
            context.fill(Path(ellipseIn: rect),
                         with: .color(TerrariumColors.sandLight.opacity(Double(p.alpha))))
        }
    }

    private func spawnParticle(cx: Float, cy: Float) {
        particles[nextSlot] = SandParticle(
            x: cx + Float.random(in: -0.02...0.02),
            y: cy + Float.random(in: 0...0.02),
            vx: Float.random(in: -0.01...0.01),
            vy: -(Float.random(in: 0.02...0.04)),
            alpha: 0.3,
            size: Float.random(in: 0.001...0.003),
            age: 0,
            lifetime: Float.random(in: 1.5...2.5),
            alive: true
        )
        nextSlot = (nextSlot + 1) % Self.maxParticles
    }
}
