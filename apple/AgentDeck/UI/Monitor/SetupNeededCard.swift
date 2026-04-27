// SetupNeededCard.swift — Dashboard surfacer for un-wired integrations.
//
// The user pain this solves: running the macOS App Store build on a fresh
// Mac means three things commonly aren't set up — Claude Code's OAuth
// token is unreadable by the sandbox, the OpenClaw Gateway needs a shared
// token pasted in, and Claude Code hooks require explicit consent. The
// dashboard used to render the terrarium identically in all of those
// states, so users saw creatures moving around and assumed everything
// worked. This card calls out *which* integrations aren't wired and
// routes a tap directly into the macOS Settings window so the user has a
// clear entry path instead of archaeology through Help docs.
//
// Visual language matches AttentionTheaterHUD: glass-on-terrarium, amber
// accent, monospaced kerning. Sits at the bottom-leading of the monitor
// so it doesn't collide with the top-center attention theater card.

import SwiftUI

#if os(macOS)
import AppKit
#endif

struct SetupNeededCard: View {
    let items: [SetupItem]

    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #endif

    @State private var pulse = false

    /// Open-Settings call-to-action — macOS only. iOS hides the button
    /// because every iOS-surfaced item already routes the user back to
    /// AgentDeck on the Mac (item hint copy: "Open AgentDeck on your
    /// Mac to configure"); opening the iOS Settings sheet here would
    /// be a dead end since none of the integration editors ship on iOS.
    @ViewBuilder
    private var openSettingsButton: some View {
        #if os(macOS)
        Button {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "settings")
        } label: {
            settingsButtonLabel
        }
        .buttonStyle(.plain)
        #else
        EmptyView()
        #endif
    }

    private var settingsButtonLabel: some View {
        HStack(spacing: 4) {
            Text("Open Settings")
            Image(systemName: "arrow.right")
        }
        .font(.system(size: 11, weight: .semibold))
        .foregroundColor(Color.black.opacity(0.85))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(TerrariumHUD.ledAmber)
                .shadow(color: TerrariumHUD.ledAmber.opacity(0.4), radius: 4, x: 0, y: 1)
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "bolt.horizontal.circle")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.ledAmber)
                Text("SETUP")
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                    .kerning(1.4)
                    .foregroundStyle(TerrariumHUD.ledAmber)
                Text("·  \(items.count) item\(items.count == 1 ? "" : "s") unfinished")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
                Spacer(minLength: 0)
            }

            ForEach(items) { item in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: item.icon)
                        .font(.system(size: 10))
                        .foregroundStyle(item.tint)
                        .frame(width: 14)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.title)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(TerrariumHUD.text)
                        Text(item.hint)
                            .font(.system(size: 10))
                            .foregroundStyle(TerrariumHUD.subtext)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            openSettingsButton
        }
        .padding(10)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color.black.opacity(0.62))
                RoundedRectangle(cornerRadius: 10)
                    .stroke(TerrariumHUD.ledAmber.opacity(0.35), lineWidth: 1)
                RoundedRectangle(cornerRadius: 10)
                    .stroke(TerrariumHUD.ledAmber.opacity(pulse ? 0.18 : 0.05), lineWidth: 2)
                    .blur(radius: 3)
            }
        )
        .frame(maxWidth: 340, alignment: .leading)
        .onAppear {
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}

struct SetupItem: Identifiable {
    let id: String
    let icon: String
    let tint: Color
    let title: String
    let hint: String
}

// MARK: - Item derivation

extension AgentStateHolder {
    /// Collect the integration gaps the dashboard Setup card should surface.
    /// Derives items from `IntegrationCatalog` so the wording stays in sync
    /// with Settings → Integrations and the Onboarding pane. Hooks consent
    /// is the one item not in the catalog (it's a sub-affordance of Claude
    /// rather than a standalone integration), so it's checked separately.
    ///
    /// Platform split:
    /// - macOS includes Claude / OpenClaw / Antigravity, plus the hooks
    ///   consent step.
    /// - iOS surfaces only the integrations the Mac side controls — pairing
    ///   and credential paste live on macOS, so iPad/iPhone just nudge the
    ///   user to fix things on their Mac.
    #if os(macOS)
    /// `@MainActor` because callers reach `DaemonService.isSelfDaemon`
    /// before invoking; we keep the annotation for symmetry with the
    /// previous signature even though we no longer take `daemonService`.
    @MainActor
    func setupNeededItems(
        preferences: AppPreferences,
        daemonService: DaemonService
    ) -> [SetupItem] {
        _ = daemonService  // Kept in signature to avoid call-site churn.

        let anthropicSaved = anthropicAdminKeySavedValue()
        let descriptors: [IntegrationDescriptor] = [
            IntegrationCatalog.claudeCode,
            IntegrationCatalog.codex,
            IntegrationCatalog.openClaw,
            IntegrationCatalog.antigravity,
        ]
        var items: [SetupItem] = descriptors.compactMap { descriptor in
            let status = IntegrationStatusEvaluator.status(
                for: descriptor,
                state: state,
                preferences: preferences,
                anthropicKeySaved: anthropicSaved
            )
            guard status.needsAttention else { return nil }
            return SetupItem(
                id: descriptor.id,
                icon: descriptor.iconSystemName,
                tint: status.tint,
                title: descriptor.displayName,
                hint: status.detail ?? descriptor.connectInstructions ?? status.label
            )
        }

        // Hooks consent — live session tokens / timeline depend on
        // `~/.claude/settings.local.json`. Respect `.declined` so users
        // who actively opted out aren't nagged; only surface for `.unknown`
        // or previously-accepted installs that have been wiped.
        if !preferences.hooksInstalled && preferences.hookInstallConsent != .declined {
            items.append(SetupItem(
                id: "hooks",
                icon: "bolt.slash",
                tint: .yellow,
                title: "Live session hooks off",
                hint: "Enable hooks to track per-turn tokens and tool calls in real time."
            ))
        }

        // Codex observation consent — only nudge users who actually run
        // Codex (the daemon already saw an auth mode for it). Without that
        // gate every fresh-install user would see the nudge regardless of
        // whether they own the CLI, which is exactly the noise the
        // App Review companion-install ban warns against.
        let codexAuthVisible = (state.codexAuthMode.flatMap { $0.isEmpty ? nil : $0 }) != nil
        if codexAuthVisible
            && !preferences.codexConfigInstalled
            && preferences.codexConfigConsent != .declined {
            items.append(SetupItem(
                id: "codex-config",
                icon: "bolt.slash",
                tint: .yellow,
                title: "Codex live observation off",
                hint: "Enable Codex notify + OTel to track turns and tool calls in real time."
            ))
        }

        return items
    }
    #else
    func setupNeededItems(preferences: AppPreferences) -> [SetupItem] {
        let anthropicSaved = anthropicAdminKeySavedValue()
        let descriptors: [IntegrationDescriptor] = [
            IntegrationCatalog.claudeCode,
            IntegrationCatalog.openClaw,
        ]
        return descriptors.compactMap { descriptor in
            let status = IntegrationStatusEvaluator.status(
                for: descriptor,
                state: state,
                preferences: preferences,
                anthropicKeySaved: anthropicSaved
            )
            guard status.needsAttention else { return nil }
            // iOS users can't fix any of this here — point them at the Mac.
            let macHint = "Open AgentDeck on your Mac to configure. Changes flow here automatically."
            return SetupItem(
                id: descriptor.id,
                icon: descriptor.iconSystemName,
                tint: status.tint,
                title: descriptor.displayName,
                hint: macHint
            )
        }
    }
    #endif

    /// Anthropic Admin key presence — Keychain on App Store, env on CLI.
    /// Checked once per `setupNeededItems` call so the catalog evaluator
    /// can render a meaningful "Connected" detail when applicable.
    private func anthropicAdminKeySavedValue() -> Bool {
        #if os(macOS)
        return AnthropicAdminApiClient.shared.hasKey()
        #else
        return false
        #endif
    }
}

// MARK: - Preview helpers

#if DEBUG && os(macOS)
struct SetupNeededCard_Previews: PreviewProvider {
    static var previews: some View {
        SetupNeededCard(
            items: [
                SetupItem(id: "claude", icon: "bolt.badge.clock", tint: .orange,
                          title: "Claude quota unavailable",
                          hint: "App Store build can't read Claude's OAuth token. Session monitoring still works through approved hooks."),
                SetupItem(id: "openclaw", icon: "lock.shield", tint: .red,
                          title: "OpenClaw needs a shared token",
                          hint: "Paste the OPENCLAW_GATEWAY_TOKEN value in Settings → Services → OpenClaw."),
                SetupItem(id: "hooks", icon: "bolt.slash", tint: .yellow,
                          title: "Live session hooks off",
                          hint: "Enable hooks to track per-turn tokens and tool calls in real time.")
            ]
        )
        .padding(30)
        .background(TerrariumHUD.bg)
    }
}
#endif
