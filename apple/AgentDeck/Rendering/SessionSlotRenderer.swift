// SessionSlotRenderer.swift — Swift port of shared/src/svg-renderers/session-slot-renderer.ts.
//
// Renders the 144×144 Stream Deck+ session button as a native SwiftUI view, so the
// Device Preview feature and any future in-app Stream Deck simulator can share the
// same rendering pipeline. The real Stream Deck hardware still receives SVG via the
// TypeScript bridge — this Swift version is visual-parity only.
//
// Scope for this first pass:
//   - renderSessionSlot (primary session button)
// Future ports if needed:
//   - renderEmptySlot / renderNoDaemonSlot / renderDetailInfo / renderOptionButton / etc.

import SwiftUI

enum SessionSlot {
    static let size: CGFloat = 144
    static let cornerRadius: CGFloat = 16
    static let innerInset: CGFloat = 8
    static let innerCornerRadius: CGFloat = 12
}

/// Premium palette (matches the p1/p2 pairs in the TS renderer, not StateColors.brand).
private struct AgentSlotPalette {
    let primary: Color
    let secondary: Color

    static func `for`(_ agent: String?) -> AgentSlotPalette {
        switch agent {
        case "claude-code":
            return .init(primary: Color(hex: "#D97757"), secondary: Color(hex: "#BE6D52"))
        case "codex-cli":
            return .init(primary: Color(hex: "#8BA4FF"), secondary: Color(hex: "#5981FF"))
        case "openclaw":
            return .init(primary: Color(hex: "#FF6B6B"), secondary: Color(hex: "#CC3333"))
        default: // opencode + unknown
            return .init(primary: Color(hex: "#F1ECEC"), secondary: Color(hex: "#AFAFAF"))
        }
    }
}

private enum SlotMode {
    case idle, working, asking

    init(state: String?) {
        switch state {
        case "processing":                                     self = .working
        case let s? where s.hasPrefix("awaiting"):             self = .asking
        default:                                                self = .idle
        }
    }
}

// MARK: - Primary entry point

struct SessionSlotView: View {
    let session: SessionInfo
    var isActive: Bool = false
    var animFrame: Int = 0
    var displayName: String? = nil

    private var mode: SlotMode { SlotMode(state: session.state) }
    private var agent: String { session.agentType ?? "claude-code" }
    private var palette: AgentSlotPalette { .for(session.agentType) }
    private var nameForDisplay: String {
        displayName ?? session.projectName ?? "—"
    }
    private var modelText: String {
        guard let m = session.modelName else { return "" }
        return SessionSlotText.truncate(m, max: 12)
    }
    private var stateLabelText: String {
        switch mode {
        case .working: return "RUNNING"
        case .asking:  return "PERMIT?"
        case .idle:    return "IDLE"
        }
    }
    private var accentColorText: Color {
        switch mode {
        case .working: return Color(hex: "#FDE68A")
        case .asking:  return Color(hex: "#FECACA")
        case .idle:    return palette.primary
        }
    }
    private var leftStripColor: Color {
        switch mode {
        case .working: return Color(hex: "#F5B942")
        case .asking:  return Color(hex: "#F87171")
        case .idle:    return palette.primary
        }
    }
    private var toolText: String {
        mode == .working ? "Running task" : modelText
    }

    var body: some View {
        ZStack {
            // Outer gradient background — matches the #1C1C1E → #0C0C0E fill in TS
            RoundedRectangle(cornerRadius: SessionSlot.cornerRadius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(hex: "#1C1C1E"), Color(hex: "#0C0C0E")],
                        startPoint: .top, endPoint: .bottom
                    )
                )

            // Inner panel (the 128×128 rounded rect at 8,8 in TS)
            RoundedRectangle(cornerRadius: SessionSlot.innerCornerRadius, style: .continuous)
                .fill(Color(hex: "#2C2C2E").opacity(0.8))
                .padding(SessionSlot.innerInset)

            // Pulsing glow border when asking (approximates the feGaussianBlur stroke in TS)
            if mode == .asking {
                let pulseOpacity = 0.4 + 0.5 * abs(sin(Double(animFrame) * 0.15))
                RoundedRectangle(cornerRadius: SessionSlot.innerCornerRadius, style: .continuous)
                    .strokeBorder(StateColors.color(for: session.state), lineWidth: 2.5)
                    .opacity(pulseOpacity)
                    .blur(radius: 2)
                    .padding(SessionSlot.innerInset)
            }

            // Left edge color strip (x=8, y=8, w=4, h=128 in TS)
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(leftStripColor)
                    .frame(width: 4, height: 128)
                    .padding(.leading, SessionSlot.innerInset)
                Spacer()
            }

            // Agent watermark (bottom-right, 40pt). Placeholder until AgentLogoIcon port lands.
            agentWatermark
                .frame(width: 40, height: 40)
                .opacity(mode == .idle ? 0.46 : 0.34)
                .offset(x: (SessionSlot.size / 2) - 24, y: (SessionSlot.size / 2) - 30)

            // Working spinner (top-right, rotates by animFrame)
            if mode == .working {
                workingSpinner
                    .offset(x: 42, y: -38)
            }

            // Asking dot (top-right, amber over white)
            if mode == .asking {
                askingDot
                    .offset(x: 42, y: -48)
            }

            // "ACT" badge when not asking (top-right)
            if mode != .asking {
                actBadge
                    .offset(x: 42, y: -47)
            }

            // Text block (left-aligned, three rows)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateLabelText)
                    .font(.system(size: 17, weight: .heavy))
                    .foregroundStyle(accentColorText)
                Text(SessionSlotText.truncate(nameForDisplay, max: 13))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(hex: "#E2E8F0"))
                Spacer()
                Text(toolText)
                    .font(.system(size: mode == .working ? 13 : 14, weight: .medium))
                    .foregroundStyle(accentColorText.opacity(0.8))
            }
            .padding(.leading, 20)
            .padding(.top, 16)
            .padding(.bottom, 16)
            .frame(width: SessionSlot.size, height: SessionSlot.size, alignment: .topLeading)
        }
        .frame(width: SessionSlot.size, height: SessionSlot.size)
    }

    // MARK: - Sub-views

    private var agentWatermark: some View {
        // Placeholder: colored circle with agent initial. Full agentLogoIcon port is TODO.
        ZStack {
            Circle()
                .fill(palette.primary)
            Text(agent.prefix(1).uppercased())
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(Color.white.opacity(0.85))
        }
    }

    private var workingSpinner: some View {
        let angle = Double((animFrame * 3) % 360)
        return Image(systemName: "sparkle")
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(accentColorText)
            .rotationEffect(.degrees(angle))
            .frame(width: 16, height: 16)
    }

    private var askingDot: some View {
        ZStack {
            Circle()
                .fill(Color(hex: "#F5B942"))
                .frame(width: 10, height: 10)
                .blur(radius: 1.5)
            Circle()
                .fill(Color.white)
                .frame(width: 6, height: 6)
        }
    }

    private var actBadge: some View {
        ZStack {
            Capsule()
                .fill(Color.white.opacity(0.1))
                .frame(width: 28, height: 16)
            Text("ACT")
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(Color(hex: "#A1A1AA"))
        }
    }
}

// MARK: - Text utilities

enum SessionSlotText {
    static func truncate(_ s: String, max: Int) -> String {
        s.count <= max ? s : String(s.prefix(max - 1)) + "\u{2026}"
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Session slot variants") {
    HStack(spacing: 16) {
        SessionSlotView(
            session: .init(
                id: "1", port: 9121, projectName: "AgentDeck",
                agentType: "claude-code", alive: true,
                state: "processing", modelName: "opus-4-7"
            ),
            animFrame: 20
        )
        SessionSlotView(
            session: .init(
                id: "2", port: 9122, projectName: "AgentDeck",
                agentType: "codex-cli", alive: true,
                state: "awaiting_permission", modelName: "gpt-5"
            ),
            animFrame: 15
        )
        SessionSlotView(
            session: .init(
                id: "3", port: 9123, projectName: "AgentDeck",
                agentType: "openclaw", alive: true,
                state: "idle", modelName: "router"
            )
        )
    }
    .padding()
    .background(Color.black)
}
#endif
