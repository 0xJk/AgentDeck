// LightRaySystem.swift — God rays with lifecycle management
// Ported from android LightRaySystem.kt

import SwiftUI

final class LightRaySystem {
    private struct LightRay {
        var x: Float = 0           // center X (0..1 fraction)
        var topWidth: Float = 0
        var bottomWidth: Float = 0
        var length: Float = 0      // how far down (fraction)
        var alpha: Float = 0
        var maxAlpha: Float = 0
        var lifetime: Float = 0
        var age: Float = 0
        var driftSpeed: Float = 0
        var widthPhase: Float = 0
    }

    private static let maxRays = 5
    private static let fadeDuration: Float = 4.0
    private static let amberTint = Color(red: 0.984, green: 0.749, blue: 0.141) // #FBBF24

    private var time: Float = 0
    private var envState: EnvironmentVisualState = .calm
    private var rays: [LightRay]

    init() {
        rays = (0..<Self.maxRays).map { _ in Self.createRay(env: .calm) }
    }

    func setState(_ state: EnvironmentVisualState) {
        envState = state
    }

    func update(dt: Float) {
        time += dt

        let activeCount: Int = switch envState {
        case .dark: 0
        case .calm: 3
        case .active: 5
        case .alert: 4
        }

        for i in rays.indices {
            rays[i].age += dt

            if i >= activeCount {
                // Fade out inactive rays
                rays[i].alpha = max(0, rays[i].alpha - dt * 0.3)
                continue
            }

            // Horizontal drift
            rays[i].x += rays[i].driftSpeed * dt

            // Width pulsation (10% variation)
            let widthPulse = 1 + sin(time + rays[i].widthPhase) * 0.1

            // Lifecycle: 4s fade-in, hold, 4s fade-out, respawn
            let fadeInEnd = Self.fadeDuration
            let fadeOutStart = rays[i].lifetime - Self.fadeDuration
            let baseAlpha: Float
            if rays[i].age < fadeInEnd {
                baseAlpha = rays[i].maxAlpha * (rays[i].age / fadeInEnd)
            } else if rays[i].age > fadeOutStart {
                baseAlpha = rays[i].maxAlpha * max(0, (rays[i].lifetime - rays[i].age) / Self.fadeDuration)
            } else {
                baseAlpha = rays[i].maxAlpha
            }
            rays[i].alpha = baseAlpha * widthPulse

            // Respawn
            if rays[i].age >= rays[i].lifetime {
                rays[i] = Self.createRay(env: envState)
            }
        }
    }

    func draw(context: inout GraphicsContext, size: CGSize) {
        guard envState != .dark else { return }
        guard size.width > 0, size.height > 0,
              size.width.isFinite, size.height.isFinite else { return }

        let w = size.width
        let h = size.height

        let tintColor: Color = envState == .alert ? Self.amberTint : .white

        for ray in rays {
            guard ray.alpha > 0.001 else { continue }

            let cx = CGFloat(ray.x) * w
            let topHalf = CGFloat(ray.topWidth) * w * 0.5
            let botHalf = CGFloat(ray.bottomWidth) * w * 0.5
            let botY = CGFloat(ray.length) * h

            var path = Path()
            path.move(to: CGPoint(x: cx - topHalf, y: 0))
            path.addLine(to: CGPoint(x: cx + topHalf, y: 0))
            path.addLine(to: CGPoint(x: cx + botHalf, y: botY))
            path.addLine(to: CGPoint(x: cx - botHalf, y: botY))
            path.closeSubpath()

            context.fill(path,
                         with: .linearGradient(
                            Gradient(colors: [
                                tintColor.opacity(Double(ray.alpha)),
                                .clear,
                            ]),
                            startPoint: CGPoint(x: cx, y: 0),
                            endPoint: CGPoint(x: cx, y: botY)
                         ))
        }
    }

    private static func createRay(env: EnvironmentVisualState) -> LightRay {
        let peakAlpha: Float = switch env {
        case .dark: 0
        case .calm: 0.04
        case .active: 0.06
        case .alert: 0.05
        }

        let topW = Float.random(in: 0.02...0.04)
        return LightRay(
            x: Float.random(in: 0.1...0.9),
            topWidth: topW,
            bottomWidth: topW * Float.random(in: 2.5...4.0),
            length: Float.random(in: 0.40...0.70),
            alpha: 0,
            maxAlpha: peakAlpha,
            lifetime: Float.random(in: 0...4) + fadeDuration * 2 + 6, // 14-18s
            age: 0,
            driftSpeed: Float.random(in: -0.002...0.002),
            widthPhase: Float.random(in: 0...Float.pi * 2)
        )
    }
}
