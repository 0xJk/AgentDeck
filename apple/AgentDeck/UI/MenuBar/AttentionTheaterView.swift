// AttentionTheaterView.swift — "Attention Theater" hero card
// Ported from design prototype `option-d.jsx::AttentionTheaterD`.
// When a session is awaiting (permission / option / diff), we surface it at
// the top of the menubar popup with a big creature, the question, and three
// large YES/NO/ALWAYS buttons that dispatch `PluginCommand.respond` upstream.
// Non-awaiting states render `CalmHeaderView` instead.

#if os(macOS)
import SwiftUI

struct AttentionTheaterView: View {
    let session: SessionInfo
    let question: String?
    /// Button handler — `index` matches `PluginCommand.selectOption`:
    /// 0=Yes, 1=No, 2=Always. Same convention as D200H hardware buttons
    /// and Cmd+Y/N keyboard shortcuts.
    let respond: (Int) -> Void

    /// Scale phase for the badge breathe animation. Matches the JS
    /// prototype's `breathe 1.8s ease-in-out infinite` — a subtle 4%
    /// scale oscillation that draws the eye to the pending decision
    /// without being distracting.
    @State private var breatheLarge: Bool = false

    private var agentType: String? { session.agentType }
    private var brandColor: Color { SessionBrand.color(for: agentType) }
    private var agentLabel: String { displayAgentLabel(agentType) }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            LinearGradient(
                colors: [
                    Color(red: 1.0, green: 0.913, blue: 0.78),
                    Color(red: 1.0, green: 0.851, blue: 0.627),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .overlay(
                // Soft highlight glow in the top-right corner.
                Circle()
                    .fill(Color.white.opacity(0.45))
                    .frame(width: 140, height: 140)
                    .blur(radius: 40)
                    .offset(x: 40, y: -40),
                alignment: .topTrailing
            )

            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 12) {
                    creatureBadge
                    VStack(alignment: .leading, spacing: 2) {
                        Text("NEEDS ATTENTION")
                            .font(.system(size: 9.5, weight: .bold))
                            .kerning(1.2)
                            .foregroundColor(Color(red: 0.541, green: 0.416, blue: 0.125))
                        Text(session.projectName ?? "Session")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(Color(red: 0.102, green: 0.102, blue: 0.122))
                            .lineLimit(1)
                        Text(subtitle)
                            .font(.system(size: 10.5))
                            .foregroundColor(Color(red: 0.416, green: 0.353, blue: 0.188))
                            .lineLimit(1)
                        if let question, !question.isEmpty {
                            Text(question)
                                .font(.system(size: 12))
                                .foregroundColor(Color(red: 0.102, green: 0.102, blue: 0.122))
                                .lineLimit(2)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(Color.white.opacity(0.75))
                                )
                                .padding(.top, 6)
                        }
                    }
                }

                HStack(spacing: 6) {
                    theaterButton(
                        label: "Yes",
                        hint: "⌘Y",
                        bg: Color(red: 0.102, green: 0.616, blue: 0.290)
                    ) { respond(0) }
                    theaterButton(
                        label: "No",
                        hint: "⌘N",
                        bg: Color(red: 0.788, green: 0.188, blue: 0.188)
                    ) { respond(1) }
                    theaterButton(
                        label: "Always",
                        hint: "⌘A",
                        bg: Color(red: 0.165, green: 0.435, blue: 0.847)
                    ) { respond(2) }
                }
            }
            .padding(14)
        }
        .overlay(
            Rectangle()
                .fill(Color.black.opacity(0.08))
                .frame(height: 0.5),
            alignment: .bottom
        )
    }

    private var subtitle: String {
        var parts: [String] = [agentLabel]
        if let model = session.modelName, !model.isEmpty {
            parts.append(shortModel(model))
        }
        if let started = relativeTime(session.startedAt) {
            parts.append(started)
        }
        return parts.joined(separator: " · ")
    }

    private var creatureBadge: some View {
        RoundedRectangle(cornerRadius: 14)
            .fill(Color.white)
            .frame(width: 54, height: 54)
            .overlay(
                SessionCreatureIcon(
                    agentType: agentType,
                    tint: brandColor,
                    size: 38
                )
            )
            .shadow(color: Color.black.opacity(0.12), radius: 8, x: 0, y: 4)
            .scaleEffect(breatheLarge ? 1.04 : 1.0)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                    breatheLarge = true
                }
            }
    }

    private func theaterButton(
        label: String,
        hint: String,
        bg: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 1) {
                Text(label)
                    .font(.system(size: 13, weight: .semibold))
                Text(hint)
                    .font(.system(size: 9, design: .monospaced))
                    .opacity(0.8)
            }
            .foregroundColor(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(bg)
                    .shadow(color: bg.opacity(0.35), radius: 4, x: 0, y: 2)
            )
        }
        .buttonStyle(.plain)
    }

    private func shortModel(_ name: String) -> String { displayShortModelName(name) }

    private func relativeTime(_ iso: String?) -> String? { displayRelativeTime(iso) }
}

// MARK: - Calm Header

/// Rendered in place of the theater when no session needs attention. Shows
/// the AgentDeck mark, session count, and daemon port.
struct CalmHeaderView: View {
    let sessionCount: Int
    let processingCount: Int
    let daemonPort: UInt16
    let bridgeConnected: Bool

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 8)
                .fill(LinearGradient(
                    colors: [
                        Color(red: 0.039, green: 0.416, blue: 0.541),
                        Color(red: 0.039, green: 0.227, blue: 0.353),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ))
                .frame(width: 28, height: 28)
                .overlay(
                    AgentDeckLogo(size: 18, color: Color(red: 0.604, green: 0.847, blue: 0.941))
                )

            VStack(alignment: .leading, spacing: 0) {
                Text("All calm")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(TerrariumHUD.text)
                Text(subtitle)
                    .font(.system(size: 10))
                    .foregroundColor(TerrariumHUD.subtext)
            }

            Spacer(minLength: 6)

            HStack(spacing: 4) {
                Circle()
                    .fill(bridgeConnected ? TerrariumHUD.ledGreen : TerrariumHUD.ledRed)
                    .frame(width: 6, height: 6)
                if daemonPort > 0 {
                    Text(verbatim: ":\(portString(daemonPort))")
                        .font(.system(size: 10, design: .monospaced))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color.white.opacity(0.08))
            )
            .foregroundColor(bridgeConnected ? TerrariumHUD.ledGreen : TerrariumHUD.ledRed)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .overlay(
            Rectangle()
                .fill(Color.white.opacity(0.08))
                .frame(height: 0.5),
            alignment: .bottom
        )
    }

    private var subtitle: String {
        let sessionWord = sessionCount == 1 ? "session" : "sessions"
        var s = "\(sessionCount) \(sessionWord)"
        if processingCount > 0 {
            s += " · \(processingCount) active"
        }
        return s
    }
}
#endif
