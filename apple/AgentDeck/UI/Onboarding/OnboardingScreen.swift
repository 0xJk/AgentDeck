#if os(iOS)
// OnboardingScreen.swift — First-launch 3-pane orientation for iOS/iPadOS.
//
// Parallels `OnboardingSheet` on macOS but tuned for touch + a companion-
// app mental model: the iOS user's value is "my Mac's sessions on my
// iPad", so the third pane is about finding the Mac via mDNS rather than
// "install an agent" (which the user does on their Mac, not their iPad).

import SwiftUI
import UIKit

struct OnboardingScreen: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences

    @State private var pane: Int = 0

    var body: some View {
        VStack(spacing: 0) {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            footer
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
        }
        .background(Color(.systemBackground))
    }

    /// 4 panes: Welcome → Agent info → Integrations heads-up → Find Mac.
    /// Added the integrations pane so iPad/iPhone users are at least aware
    /// of what's happening on the Mac side (hooks, OpenClaw, Admin API)
    /// and know where to look when they want those features — all of which
    /// are macOS-only configured.
    private static let paneCount = 4

    @ViewBuilder
    private var content: some View {
        switch pane {
        case 0: WelcomePaneiOS()
        case 1: AgentInfoPaneiOS()
        case 2: IntegrationsPaneiOS()
        default: FindMacPaneiOS()
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            HStack(spacing: 6) {
                ForEach(0..<Self.paneCount, id: \.self) { idx in
                    Circle()
                        .fill(idx == pane ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: 8, height: 8)
                }
            }

            Spacer()

            if pane > 0 {
                Button("Back") { pane = max(0, pane - 1) }
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
        }
    }

    private func finish() {
        preferences.hasSeenOnboarding = true
    }
}

// MARK: - Panes

private struct WelcomePaneiOS: View {
    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "scribble.variable")
                .resizable()
                .scaledToFit()
                .frame(width: 120, height: 120)
                .foregroundStyle(Color.accentColor)

            Text("Stop Chatting.\nStart Steering.")
                .font(.system(size: 28, weight: .bold))
                .multilineTextAlignment(.center)

            Text("Real-time monitoring and evaluation for AI coding agents running on your Mac — Claude Code, Codex, OpenCode.")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 30)

            Spacer()
        }
        .padding(.horizontal, 24)
    }
}

private struct AgentInfoPaneiOS: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Install an agent on your Mac")
                    .font(.system(size: 22, weight: .semibold))
                Text("AgentDeck watches AI coding agents on your Mac and shows their state here. Install at least one on your Mac — you don't install anything on iPad/iPhone.")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 10) {
                agentRow("Claude Code", detail: "Anthropic's CLI agent with hooks and permissions.")
                agentRow("Codex", detail: "OpenAI's coding agent CLI.")
                agentRow("OpenCode", detail: "Open-source multi-model coding agent.")
            }

            Text("On your Mac, install AgentDeck from the App Store and follow its onboarding to finish the setup.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .padding(.top, 6)

            Spacer()
        }
        .padding(24)
    }

    private func agentRow(_ name: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(name)
                .font(.system(size: 15, weight: .semibold))
            Text(detail)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.secondary.opacity(0.08))
        )
    }
}

/// Heads-up for iOS users about the optional integrations that live on
/// the Mac side. Can't configure them from iOS (Keychain writes + hook
/// consent are macOS Settings scenes), so this pane is purely
/// informational — similar to the equivalent `IntegrationsPane` on
/// macOS but tuned for the companion-app mental model.
private struct IntegrationsPaneiOS: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Optional Mac integrations")
                    .font(.system(size: 22, weight: .semibold))
                Text("AgentDeck on your Mac has a few optional integrations. You don't need them to use the iPad dashboard — but your Mac is where they get turned on.")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 10) {
                integrationCard(
                    icon: "bolt.fill",
                    title: "Claude Code hooks",
                    detail: "Live per-turn token counts and tool calls. Enabled in AgentDeck on your Mac → Settings → Integrations."
                )
                integrationCard(
                    icon: "network",
                    title: "OpenClaw Gateway",
                    detail: "Route agent traffic through a local OpenClaw Gateway. Requires the shared token configured on your Mac."
                )
                integrationCard(
                    icon: "chart.line.uptrend.xyaxis",
                    title: "Anthropic API usage",
                    detail: "Org-wide token consumption for Anthropic Console admin key holders. Paste the key on your Mac."
                )
            }

            Text("Everything you see here on iPad reflects what your Mac reports — no setup on this device.")
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
                    .font(.system(size: 12))
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

private struct FindMacPaneiOS: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @State private var showQRScanner: Bool = false
    @State private var scanError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Find your Mac")
                    .font(.system(size: 22, weight: .semibold))
                Text("When your Mac is on the same Wi-Fi network, AgentDeck discovers it automatically. Just tap **Get Started** — the dashboard pairs as soon as a Mac comes online.")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                Image(systemName: "dot.radiowaves.left.and.right")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 80, height: 80)
                    .foregroundStyle(Color.accentColor.opacity(0.8))
                Spacer()
            }
            .padding(.vertical, 8)

            VStack(alignment: .leading, spacing: 8) {
                bullet("AgentDeck uses Bonjour to find Macs on your Wi-Fi")
                bullet("iOS will ask for **Local Network** permission — tap Allow")
                bullet("For different networks, scan the QR code shown by AgentDeck on your Mac")
            }
            .font(.system(size: 13))

            // Direct QR scan shortcut — shaves a step off the "different
            // network" pairing flow (previously the copy said "scan QR in
            // Settings", forcing the user to finish onboarding, open
            // Settings, and find the scan button). Mirrors the
            // SettingsScreen iOS scanner presentation (handleQRScan logic).
            Button {
                showQRScanner = true
            } label: {
                Label("Scan QR from Mac", systemImage: "qrcode.viewfinder")
                    .font(.system(size: 14, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(red: 0.231, green: 0.51, blue: 0.965))

            if let scanError {
                Text(scanError)
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
            }

            Spacer()
        }
        .padding(24)
        .fullScreenCover(isPresented: $showQRScanner) {
            QRScannerView(
                onScan: { payload in
                    showQRScanner = false
                    handleQRScan(payload)
                },
                onCancel: { showQRScanner = false }
            )
        }
    }

    private func bullet(_ markdown: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
                .foregroundStyle(Color.accentColor)
            Text((try? AttributedString(markdown: markdown)) ?? AttributedString(markdown))
                .foregroundStyle(.primary)
        }
    }

    /// Validate the QR payload (AgentDeck pairing URL format
    /// `ws://host:port?token=…`) before handing it to the state holder.
    /// Mirrors SettingsScreen iOS's `handleQRScan(_:)` so the scan result
    /// parsing stays consistent between onboarding and Settings entry
    /// points — any hardening applied later should be mirrored back.
    private func handleQRScan(_ payload: String) {
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              url.host != nil
        else {
            scanError = "That QR doesn't look like an AgentDeck pairing link."
            return
        }
        scanError = nil
        stateHolder.connectTo(url: trimmed)
    }
}
#endif
