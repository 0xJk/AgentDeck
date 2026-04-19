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
    /// iOS fallback — on macOS we use `SettingsLink` to open the Settings
    /// scene directly, so the callback is never invoked there. iOS has no
    /// Settings scene and still needs a sheet-driven approach.
    let onOpenSettings: () -> Void

    @State private var pulse = false

    /// Open-Settings call-to-action. Uses `SettingsLink` on macOS 14+ so the
    /// Settings scene is opened via SwiftUI's first-party path — the older
    /// `NSApp.sendAction(showSettingsWindow:)` route was flaky when the
    /// Monitor window had keyboard focus and silently failed under the
    /// MenuBarExtra responder chain. `SettingsLink` wraps the same label
    /// so styling matches the rest of the card.
    @ViewBuilder
    private var openSettingsButton: some View {
        #if os(macOS)
        SettingsLink {
            settingsButtonLabel
        }
        .buttonStyle(.plain)
        .simultaneousGesture(TapGesture().onEnded {
            NSApp.activate(ignoringOtherApps: true)
        })
        #else
        Button {
            onOpenSettings()
        } label: {
            settingsButtonLabel
        }
        .buttonStyle(.plain)
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
    /// Kept as a plain function so both Monitor and Menubar can call into
    /// the same decision tree if we ever want the menubar to mirror the
    /// card — right now only MonitorScreen consumes it.
    ///
    /// Platform split:
    /// - macOS accepts `DaemonService` so the Claude-quota branch can
    ///   distinguish "CLI not installed" / "CLI installed but this Mac
    ///   app is still the daemon" / "external CLI daemon but quota still
    ///   missing" — each needs different instructions.
    /// - iOS has no `DaemonService` (daemon concept is macOS-only). The
    ///   iOS variant falls back to a simpler message pointing users at
    ///   their Mac, since iPad/iPhone can't install or manage the CLI.
    #if os(macOS)
    /// `@MainActor` because `DaemonService` is itself `@MainActor` —
    /// reaching its `isSelfDaemon` property from a nonisolated context
    /// fails the Swift 6 actor-isolation check. The caller (MonitorScreen
    /// body) is already on MainActor, so this annotation is a no-op at
    /// call sites.
    @MainActor
    func setupNeededItems(
        preferences: AppPreferences,
        daemonService: DaemonService
    ) -> [SetupItem] {
        var items: [SetupItem] = []

        // 1) Claude quota. App Store builds must remain useful without
        // requiring another executable install (App Review 2.5.2 / 4.2.3),
        // so sandbox copy does not tell users to install or register a CLI
        // daemon. If an external terminal-managed daemon is already running,
        // we can still surface its relay failures accurately.
        if (state.oauthConnected ?? false) == false {
            let hint: String
            if !AgentDeckRuntime.isSandboxed {
                hint = "Sign in with `claude` in Terminal to populate 5h / 7d quota gauges."
            } else if daemonService.isSelfDaemon {
                hint = "Subscription quota is unavailable inside the App Store sandbox. AgentDeck still monitors sessions through approved hooks; API usage can be shown with an Anthropic Admin API key in Settings."
            } else {
                hint = "The external terminal daemon is connected, but Claude quota is still unavailable. Sign in with Claude Code in Terminal so that daemon can relay quota."
            }
            items.append(SetupItem(
                id: "claude",
                icon: "bolt.badge.clock",
                tint: .orange,
                title: "Claude quota unavailable",
                hint: hint
            ))
        }

        // 2) OpenClaw — the Gateway process is reachable but the shared
        //    token hasn't been authorized. Without the card, the only hint
        //    was the crayfish appearing in the terrarium anyway (now fixed
        //    in TerrariumState to hide until authenticated).
        if state.gatewayAvailable && !state.gatewayConnected {
            let authStatus = state.gatewayAuthStatus ?? ""
            let title: String
            let hint: String
            switch authStatus {
            case "gateway_token_missing":
                title = "OpenClaw needs a shared token"
                hint = "Paste the OPENCLAW_GATEWAY_TOKEN value in Settings → Services → OpenClaw."
            case "approval_pending", "pairing_required":
                title = "OpenClaw awaiting approval"
                hint = "Approve this Mac in OpenClaw's Web UI to finish pairing."
            case "auth_failed", "token_mismatch", "device_auth_invalid":
                title = "OpenClaw authentication failed"
                hint = state.gatewayAuthMessage ?? "Revoke this device in OpenClaw and re-approve it."
            default:
                title = "OpenClaw not authenticated"
                hint = "Paste the Gateway's shared token (OPENCLAW_GATEWAY_TOKEN) in Settings."
            }
            items.append(SetupItem(
                id: "openclaw",
                icon: "lock.shield",
                tint: .red,
                title: title,
                hint: hint
            ))
        }

        // 3) Hook consent — live session tokens, currentTool, and timeline
        //    depend on `~/.claude/settings.local.json` being wired up.
        //    Respect `.declined` so users who actively opted out aren't
        //    nagged; only surface for `.unknown` or previously-accepted
        //    installs that have been wiped.
        if !preferences.hooksInstalled && preferences.hookInstallConsent != .declined {
            items.append(SetupItem(
                id: "hooks",
                icon: "bolt.slash",
                tint: .yellow,
                title: "Live session hooks off",
                hint: "Enable hooks to track per-turn tokens and tool calls in real time."
            ))
        }

        return items
    }
    #else
    /// iOS variant — configuration lives on the Mac side, so the iPad
    /// surface stays purely informational. Avoids the word "daemon"
    /// (could be read by App Review as "requires external executable")
    /// and points users at the Mac Integrations pane instead.
    func setupNeededItems(preferences: AppPreferences) -> [SetupItem] {
        var items: [SetupItem] = []

        if (state.oauthConnected ?? false) == false {
            items.append(SetupItem(
                id: "claude",
                icon: "bolt.badge.clock",
                tint: .orange,
                title: "Claude quota unavailable",
                hint: "Enable Claude Code hooks in AgentDeck on your Mac — live sessions then appear here automatically."
            ))
        }

        if state.gatewayAvailable && !state.gatewayConnected {
            items.append(SetupItem(
                id: "openclaw",
                icon: "lock.shield",
                tint: .red,
                title: "OpenClaw not authenticated",
                hint: "Paste the OpenClaw Gateway shared token in AgentDeck on your Mac. Changes flow here automatically."
            ))
        }

        return items
    }
    #endif
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
            ],
            onOpenSettings: {}
        )
        .padding(30)
        .background(TerrariumHUD.bg)
    }
}
#endif
