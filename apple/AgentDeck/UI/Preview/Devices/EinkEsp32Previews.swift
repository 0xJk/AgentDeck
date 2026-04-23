// EinkEsp32Previews.swift — E-ink readers + ESP32 display boards.
//
// E-ink previews deliberately use a cream/paper-white canvas with near-black
// creature outlines — this mirrors the CremaS / Kobo rendering pipeline which
// forces the drawable into 2-bit or 4-bit greyscale. The color e-ink variant
// (Pantone6) tints the creature with the agent brand because the device
// actually supports ~6 colours.
//
// ESP32 previews are all framed device bodies with a creature + HUD. The real
// firmware is LVGL + custom draw routines that we don't try to port here.

import SwiftUI

// MARK: - E-ink Mono

struct EinkMonoPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(
                cornerRadius: 14,
                bezelWidth: 16,
                bezelColor: Color(white: 0.85),
                screenColor: Color(red: 0.95, green: 0.94, blue: 0.90)
            ) {
                ZStack {
                    LinearGradient(
                        colors: [Color(white: 0.85), Color(white: 0.90), Color(white: 0.95)],
                        startPoint: .top, endPoint: .bottom
                    )
                    
                    GeometryReader { geo in
                        Image(creatureAsset)
                            .resizable()
                            .renderingMode(.template)
                            .interpolation(.high)
                            .aspectRatio(contentMode: .fit)
                            .foregroundStyle(.black.opacity(0.8))
                            .frame(width: geo.size.width * 0.45)
                            .opacity(selection.state == .disconnected ? 0.25 : 1)
                            .position(x: geo.size.width * 0.55, y: geo.size.height * 0.45)
                    }

                    VStack {
                        HStack {
                            Text("AgentDeck").font(.system(size: 11, weight: .semibold, design: .serif))
                            Spacer()
                            Text("CREMAS")
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(.black.opacity(0.5))
                        }
                        .foregroundStyle(.black.opacity(0.85))
                        Spacer()
                        VStack(spacing: 4) {
                            Text(selection.agent.displayName)
                                .font(.system(size: 13, weight: .bold, design: .serif))
                                .foregroundStyle(.black)
                            Text(stateLine)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.black.opacity(0.65))
                        }
                    }
                }
            }
            .frame(width: 240, height: 320)
            Text("E-ink mono • CremaS / Kobo")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }

    private var creatureAsset: String {
        switch selection.agent {
        case .claudeCode: return "CreatureClaudeCode"
        case .codex:      return "CreatureCodex"
        case .opencode:   return "CreatureOpenCode"
        case .openclaw:   return "CreatureOpenClaw"
        }
    }

    private var stateLine: String {
        "STATE: \(selection.state.displayName.uppercased()) • \(selection.sessionCount)x"
    }
}

// MARK: - E-ink Color (Pantone6)

struct EinkColorPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(
                cornerRadius: 14,
                bezelWidth: 16,
                bezelColor: Color(white: 0.88),
                screenColor: Color(red: 0.96, green: 0.95, blue: 0.88)
            ) {
                ZStack {
                    LinearGradient(
                        colors: [Color(red: 0.80, green: 0.85, blue: 0.88),
                                 Color(red: 0.90, green: 0.92, blue: 0.94),
                                 Color(red: 0.96, green: 0.95, blue: 0.88)],
                        startPoint: .top, endPoint: .bottom
                    )

                    GeometryReader { geo in
                        PreviewCreature(agent: selection.agent, state: selection.state, size: min(geo.size.width, geo.size.height) * 0.45)
                            .position(x: geo.size.width * 0.55, y: geo.size.height * 0.45)
                    }

                    VStack {
                        HStack {
                            Text("AgentDeck").font(.system(size: 11, weight: .semibold, design: .serif))
                                .foregroundStyle(.black)
                            Spacer()
                            Text("PANTONE6")
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(.black.opacity(0.5))
                        }
                        Spacer()
                        VStack(spacing: 4) {
                            Text(selection.agent.displayName)
                                .font(.system(size: 13, weight: .bold, design: .serif))
                                .foregroundStyle(StateColors.brand(agent: selection.agent.rawValue))
                            Text(selection.state.displayName.uppercased())
                                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                                .foregroundStyle(StateColors.color(for: selection.state.sessionStateStringForUI))
                        }
                    }
                }
            }
            .frame(width: 240, height: 320)
            Text("E-ink color • Pantone6")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - ESP32 terrarium scene (shared across boards)
//
// Real ESP32 firmware renders a full terrarium (deepSea → shallowWater
// gradient, creatures swimming, kelp, particles) with a HUD bar at the
// bottom carrying the AgentDeck wordmark + session name on the left and
// 5h / 7d water-fill gauges on the right. See esp32/src/ui/widgets/
// hud_bar.cpp for the reference layout and esp32/src/ui/terrarium/* for
// the scene renderer. We don't port the LVGL renderer — instead we
// reproduce its visual signature (water gradient, subtle creature
// silhouette, HUD bar with gauges) so the preview reads as the same
// artifact the user will see on-device.

private struct Esp32TerrariumScene<Content: View>: View {
    let selection: DevicePreviewSelection
    let isRound: Bool
    let hudHeight: CGFloat
    @ViewBuilder let overlay: () -> Content

    init(
        selection: DevicePreviewSelection,
        isRound: Bool = false,
        hudHeight: CGFloat = 58,
        @ViewBuilder overlay: @escaping () -> Content = { EmptyView() }
    ) {
        self.selection = selection
        self.isRound = isRound
        self.hudHeight = hudHeight
        self.overlay = overlay
    }

    var body: some View {
        ZStack {
            // Water gradient background — the terrarium renderer's base layer.
            LinearGradient(
                colors: [TerrariumColors.deepSea, TerrariumColors.midWater, TerrariumColors.shallowWater],
                startPoint: .top,
                endPoint: .bottom
            )

            // Water surface highlight at y ≈ 14% — echoes the bright
            // caustic band the firmware draws just below the top edge.
            GeometryReader { geo in
                Rectangle()
                    .fill(
                        LinearGradient(
                            colors: [Color.white.opacity(0.0), Color.white.opacity(0.05), Color.white.opacity(0.0)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(height: max(6, geo.size.height * 0.08))
                    .offset(y: geo.size.height * 0.12)
            }

            // Background swimming creature — small and off-center, so
            // it reads as "a creature is in the scene" instead of the
            // giant dashboard-style icon the old preview used.
            GeometryReader { geo in
                PreviewCreature(
                    agent: selection.agent,
                    state: selection.state,
                    size: min(geo.size.width, geo.size.height) * 0.45
                )
                .position(
                    x: geo.size.width * 0.55,
                    y: geo.size.height * (isRound ? 0.46 : 0.40)
                )
            }

            // Bottom HUD bar — matches hud_bar.cpp layout direction.
            VStack {
                Spacer()
                Esp32HudBar(selection: selection, isRound: isRound)
                    .frame(height: hudHeight)
            }

            overlay()
        }
    }
}

/// Mini HUD bar that mirrors the real firmware's bottom panel: left
/// side carries the AgentDeck wordmark + accent underline + session
/// line; right side carries two water-fill gauges (5h / 7d). Values are
/// placeholders — the real firmware drives them from the usage relay.
private struct Esp32HudBar: View {
    let selection: DevicePreviewSelection
    let isRound: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            // Left panel: logo + underline + session line
            VStack(alignment: .leading, spacing: 3) {
                Text("AgentDeck")
                    .font(.system(size: 11, weight: .heavy, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
                Rectangle()
                    .fill(TerrariumColors.tetraNeon.opacity(0.55))
                    .frame(width: 46, height: 1)
                HStack(spacing: 4) {
                    PreviewStateDot(state: selection.state, size: 6)
                    Text(sessionLine)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.text.opacity(0.88))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 4)

            // Right panel: 5h + 7d water-fill gauges
            HStack(spacing: 6) {
                waterGauge(period: "5h", percent: 0.42)
                waterGauge(period: "7d", percent: 0.68)
            }
        }
        .padding(.horizontal, isRound ? 30 : 10)
        .padding(.vertical, 6)
        .background(
            Rectangle()
                .fill(Color.black.opacity(isRound ? 0.0 : 0.35))
        )
    }

    private var sessionLine: String {
        let base = selection.sessionCount == 1 ? "1 session" : "\(selection.sessionCount) sessions"
        return "\(base) · \(selection.state.displayName)"
    }

    /// Water-fill gauge — mirrors the firmware's `createGauge`: glass
    /// background, bottom-aligned tinted fill, period label at top,
    /// percentage in the center.
    private func waterGauge(period: String, percent: CGFloat) -> some View {
        let size: CGFloat = 36
        let color = percent >= 0.9 ? TerrariumHUD.ledRed
            : percent >= 0.7 ? TerrariumHUD.ledAmber
            : TerrariumHUD.ledGreen
        return ZStack(alignment: .bottom) {
            RoundedRectangle(cornerRadius: 5)
                .fill(Color.white.opacity(0.12))
                .overlay(
                    RoundedRectangle(cornerRadius: 5)
                        .stroke(Color.white.opacity(0.22), lineWidth: 0.5)
                )
            RoundedRectangle(cornerRadius: 5)
                .fill(color.opacity(0.55))
                .frame(height: size * percent)
            VStack(spacing: 0) {
                Text(period)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .padding(.top, 3)
                Spacer(minLength: 0)
                Text("\(Int(percent * 100))%")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
                    .padding(.bottom, 3)
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - ESP32 86Box (1.28" round)

struct Esp3286BoxPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            Esp32TerrariumScene(
                selection: selection,
                isRound: true,
                hudHeight: 46
            )
            .frame(width: 240, height: 240)
            .clipShape(Circle())
            .overlay(
                Circle()
                    .stroke(Color(white: 0.12), lineWidth: 6)
            )
            Text("ESP32 86Box • 1.28\" round")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - ESP32 IPS 3.5" Landscape

struct Esp3235LandscapePreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(cornerRadius: 14, bezelWidth: 10) {
                Esp32TerrariumScene(selection: selection)
            }
            .frame(width: 400, height: 240)
            Text("ESP32 IPS 3.5\" landscape")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - ESP32 IPS 3.5" Portrait

struct Esp3235PortraitPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(cornerRadius: 14, bezelWidth: 10) {
                Esp32TerrariumScene(selection: selection, hudHeight: 64)
            }
            .frame(width: 240, height: 360)
            Text("ESP32 IPS 3.5\" portrait")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - ESP32 Round AMOLED 1.6"

struct Esp32RoundPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            Esp32TerrariumScene(
                selection: selection,
                isRound: true,
                hudHeight: 44
            )
            .frame(width: 230, height: 230)
            .clipShape(Circle())
            .overlay(
                Circle()
                    .stroke(Color(white: 0.14), lineWidth: 10)
            )
            Text("ESP32 round AMOLED 1.6\"")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}
