#if os(macOS)
// OnboardingSheet.swift — First-launch 3-pane orientation for macOS.
//
// App Store review expects a clear first-run path for non-developer users.
// The dashboard starts empty by design (no session until the user launches
// one), so without onboarding a fresh user sees a blank terrarium and no
// affordance to proceed. This sheet bridges that gap with three screens:
//
//   1. Welcome — brand + value prop ("Stop Chatting. Start Steering.")
//   2. Pick an agent — Claude Code / Codex / OpenCode install links
//   3. Pair your iPad — Bonjour pitch + iOS companion download link
//
// Gated by `AppPreferences.hasSeenOnboarding` so returning users skip it.
// xctest environments bypass the gate so test runs don't deadlock on a
// modal sheet.

import SwiftUI
import AppKit

struct OnboardingSheet: View {
    @EnvironmentObject private var preferences: AppPreferences
    @Environment(\.dismiss) private var dismiss

    @State private var pane: Int = 0
    @State private var userHasAgent: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            footer
                .padding(.horizontal, 24)
                .padding(.vertical, 14)
        }
        .frame(width: 640, height: 540)
    }

    /// 4 panes: Welcome → Agent picker → Optional integrations → Pair iPad.
    /// Adding the integrations pane (Claude Code hooks / OpenClaw /
    /// Anthropic API) keeps the wizard length reasonable while letting
    /// first-run users know those surfaces exist before they go hunting
    /// in Settings. The pane is purely informational — actual token
    /// paste and hook consent stay in Settings → Integrations to keep
    /// the wizard short.
    private static let paneCount = 4

    @ViewBuilder
    private var content: some View {
        switch pane {
        case 0: WelcomePane()
        case 1: AgentPickerPane(userHasAgent: $userHasAgent)
        case 2: IntegrationsPane()
        default: PairIPadPane()
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            // Progress dots.
            HStack(spacing: 6) {
                ForEach(0..<Self.paneCount, id: \.self) { idx in
                    Circle()
                        .fill(idx == pane ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: 8, height: 8)
                }
            }

            Spacer()

            if pane > 0 {
                Button("Back") {
                    pane = max(0, pane - 1)
                }
                .buttonStyle(.bordered)
            }

            Button(pane == Self.paneCount - 1 ? "Get Started" : "Continue") {
                if pane < Self.paneCount - 1 {
                    pane += 1
                } else {
                    finish()
                }
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
        }
    }

    private func finish() {
        preferences.hasSeenOnboarding = true
        dismiss()
    }
}

// MARK: - Pane 1: Welcome

private struct WelcomePane: View {
    var body: some View {
        VStack(spacing: 22) {
            Spacer()

            // Terrarium creature — use the octopus app icon as a recognizable
            // brand anchor rather than a runtime-animated creature (Canvas
            // sizing inside a sheet has edge cases we'd rather avoid here).
            Image(systemName: "scribble.variable")
                .resizable()
                .scaledToFit()
                .frame(width: 120, height: 120)
                .foregroundStyle(Color.accentColor)
                .padding(.bottom, 6)

            Text("Stop Chatting.\nStart Steering.")
                .font(.system(size: 30, weight: .bold))
                .multilineTextAlignment(.center)

            Text("Real-time monitoring and evaluation for AI coding agents. Works with Claude Code, Codex, and OpenCode sessions across every device in your setup.")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 40)

            Spacer()
        }
        .padding(24)
    }
}

// MARK: - Pane 2: Agent picker

/// Two-branch pane. First asks whether the user already has an agent set
/// up — that's the majority case for developers buying AgentDeck — and
/// only shows the install guide cards if they say no. A previous version
/// used a tiny "I already have one" checkbox that had no UI effect; users
/// reasonably asked "what does this change?". The answer is now visible:
/// saying yes hides the install step entirely, saying no (or not yet)
/// reveals it.
private struct AgentPickerPane: View {
    @Binding var userHasAgent: Bool

    private struct AgentOption {
        let name: String
        let tagline: String
        let installCommand: String
        let docsURL: URL
    }

    private let options: [AgentOption] = [
        AgentOption(
            name: "Claude Code",
            tagline: "Anthropic's CLI agent with hooks + permissions.",
            installCommand: "npm install -g @anthropic-ai/claude-code",
            docsURL: URL(string: "https://docs.claude.com/en/docs/claude-code/quickstart")!
        ),
        AgentOption(
            name: "Codex",
            tagline: "OpenAI's coding agent CLI.",
            installCommand: "npm install -g @openai/codex",
            docsURL: URL(string: "https://github.com/openai/codex")!
        ),
        AgentOption(
            name: "OpenCode",
            tagline: "Open-source multi-model coding agent.",
            installCommand: "npm install -g opencode",
            docsURL: URL(string: "https://opencode.ai/docs")!
        ),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Are you already using an AI coding agent?")
                    .font(.system(size: 22, weight: .semibold))
                Text(userHasAgent
                     ? "Great — AgentDeck will start monitoring the moment you launch a session from the menu bar."
                     : "AgentDeck works with any of these. If you already have one installed, just say so and we'll skip this step.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Primary two-button choice — equivalent weight. The user's
            // answer persists via `userHasAgent`; when yes, we hide the
            // install cards so the pane stops nagging.
            HStack(spacing: 10) {
                choiceButton(
                    title: "Yes, I have one",
                    systemImage: "checkmark.circle.fill",
                    selected: userHasAgent
                ) { userHasAgent = true }

                choiceButton(
                    title: "Help me install one",
                    systemImage: "arrow.down.circle",
                    selected: !userHasAgent
                ) { userHasAgent = false }
            }

            if !userHasAgent {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Install one of these on your Mac")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                    VStack(spacing: 10) {
                        ForEach(options, id: \.name) { option in
                            agentCard(option)
                        }
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            Spacer()
        }
        .padding(24)
        .animation(.easeInOut(duration: 0.18), value: userHasAgent)
    }

    /// Big segmented-style button. Selected state uses accent color fill so
    /// the current answer is unambiguous — addresses the previous UX gap
    /// where a checkbox gave no feedback.
    private func choiceButton(
        title: String,
        systemImage: String,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: 14))
                Text(title)
                    .font(.system(size: 13, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .padding(.horizontal, 12)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(selected ? Color.accentColor.opacity(0.2) : Color.secondary.opacity(0.08))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(selected ? Color.accentColor : Color.clear, lineWidth: 1.5)
            )
            .foregroundStyle(selected ? Color.accentColor : Color.primary)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func agentCard(_ option: AgentOption) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(option.name)
                    .font(.system(size: 14, weight: .semibold))
                Text(option.tagline)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Text(option.installCommand)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
            Spacer()
            Button("Open Guide") {
                NSWorkspace.shared.open(option.docsURL)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.secondary.opacity(0.08))
        )
    }
}

// MARK: - Pane 3: Optional integrations

/// Informational pane introducing the three Settings integrations that
/// unlock extra features. Each row is a "what + where" line — no paste
/// fields here, because token entry in a wizard is brittle (users lose
/// context, tokens get truncated by IME, etc.). Keeps the wizard short;
/// the Setup card on the dashboard will nag users who actually need
/// these to follow through.
private struct IntegrationsPane: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Optional integrations")
                    .font(.system(size: 22, weight: .semibold))
                Text("These unlock extra features. Skip any you don't need — every one of them can be enabled later from Settings → Integrations.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 10) {
                integrationCard(
                    icon: "bolt.fill",
                    title: "Claude Code hooks",
                    detail: "Live per-turn token counts, tool calls, and timeline events. Requires your consent to edit `~/.claude/settings.local.json`."
                )
                integrationCard(
                    icon: "network",
                    title: "OpenClaw Gateway",
                    detail: "Route agent traffic through a local OpenClaw Gateway. Paste the shared `OPENCLAW_GATEWAY_TOKEN` value in Settings."
                )
                integrationCard(
                    icon: "chart.line.uptrend.xyaxis",
                    title: "Anthropic API usage (optional)",
                    detail: "Org-wide token consumption for users with an Anthropic Console Admin API key. Separate from Pro/Max subscription quota."
                )
            }

            Text("Most people only need hooks. OpenClaw and Admin API usage are for power users.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)

            Spacer()
        }
        .padding(24)
    }

    private func integrationCard(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(Color.accentColor)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.secondary.opacity(0.08))
        )
    }
}

// MARK: - Pane 4: Pair iPad

private struct PairIPadPane: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Pair your iPad or iPhone")
                    .font(.system(size: 22, weight: .semibold))
                Text("AgentDeck has a free iOS companion app. It auto-discovers this Mac over Wi-Fi and mirrors your live sessions to a second screen — great as a bedside monitor or for pair programming.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(alignment: .top, spacing: 16) {
                Image(systemName: "ipad.landscape")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 120, height: 120)
                    .foregroundStyle(Color.accentColor.opacity(0.8))

                VStack(alignment: .leading, spacing: 10) {
                    bullet("Install **AgentDeck** from the iOS App Store")
                    bullet("Open it on the same Wi-Fi network as this Mac")
                    bullet("The iPad finds the Mac automatically via mDNS")
                    bullet("For different networks, use **Pair iPad** in the menu bar to show a QR code")
                }
                .font(.system(size: 13))
            }

            HStack(spacing: 10) {
                Button {
                    // Placeholder — actual ID set after App Store publish.
                    // Using a search URL so the button is never a dead end.
                    if let url = URL(string: "https://apps.apple.com/search?term=agentdeck") {
                        NSWorkspace.shared.open(url)
                    }
                } label: {
                    Label("Open iOS App Store", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.borderedProminent)

                Button("Do It Later") {
                    // Ignored — footer "Get Started" is the primary close path.
                }
                .buttonStyle(.bordered)
                .opacity(0.5)
                .disabled(true)
            }

            Spacer()
        }
        .padding(24)
    }

    private func bullet(_ markdown: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
                .foregroundStyle(Color.accentColor)
            Text((try? AttributedString(markdown: markdown)) ?? AttributedString(markdown))
                .foregroundStyle(.primary)
        }
    }
}
#endif
