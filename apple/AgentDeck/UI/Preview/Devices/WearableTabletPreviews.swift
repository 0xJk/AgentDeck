// WearableTabletPreviews.swift — Apple Watch, iPad, Android tablet mockups.
//
// All three are framed device schematics with the creature + HUD. Tablets show
// a secondary "sidebar" strip so the mockup reads as dashboard-style.

import SwiftUI

// MARK: - Apple Watch

struct AppleWatchPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                // Case (capsule, approximating Series 11 46mm)
                RoundedRectangle(cornerRadius: 50, style: .continuous)
                    .fill(Color(white: 0.08))
                    .frame(width: 180, height: 220)
                    .overlay(
                        // Digital Crown hint
                        Capsule()
                            .fill(Color(white: 0.22))
                            .frame(width: 4, height: 28)
                            .offset(x: 92, y: -32)
                    )
                // Screen
                ZStack {
                    RoundedRectangle(cornerRadius: 42, style: .continuous)
                        .fill(LinearGradient(
                            colors: [TerrariumColors.deepSea, TerrariumColors.midWater, TerrariumColors.shallowWater],
                            startPoint: .top, endPoint: .bottom))
                    
                    GeometryReader { geo in
                        PreviewCreature(agent: selection.agent, state: selection.state, size: min(geo.size.width, geo.size.height) * 0.45)
                            .position(x: geo.size.width * 0.55, y: geo.size.height * 0.45)
                    }

                    VStack(spacing: 4) {
                        Spacer()
                        Text(stateLabel)
                            .font(.system(size: 12, weight: .heavy, design: .rounded))
                            .foregroundStyle(StateColors.color(for: selection.state.sessionStateStringForUI))
                        Text("\(selection.sessionCount) session\(selection.sessionCount == 1 ? "" : "s")")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                    .padding(.bottom, 20)
                }
                .frame(width: 160, height: 200)
                .clipShape(RoundedRectangle(cornerRadius: 42, style: .continuous))
            }
            Text("Apple Watch Series 11 46mm")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }

    private var stateLabel: String {
        switch selection.state {
        case .idle:           return "IDLE"
        case .processing:     return "RUNNING"
        case .awaitingPrompt: return "PERMIT?"
        case .disconnected:   return "OFFLINE"
        }
    }
}

// MARK: - iPad (Landscape)

struct IPadLandscapePreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 12) {
            DeviceBezel(cornerRadius: 24, bezelWidth: 12) {
                HStack(spacing: 12) {
                    // Sidebar
                    VStack(alignment: .leading, spacing: 6) {
                        Text("SESSIONS").font(.system(size: 9, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.secondary)
                        ForEach(0..<min(max(selection.sessionCount, 1), 4), id: \.self) { i in
                            HStack(spacing: 4) {
                                PreviewStateDot(state: i == 0 ? selection.state : .idle, size: 6)
                                Text(agentLabel(for: i))
                                    .font(.system(size: 10))
                                    .foregroundStyle(.white.opacity(0.85))
                                Spacer(minLength: 0)
                            }
                        }
                        Spacer()
                    }
                    .frame(width: 110)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 8)
                    .background(Color(white: 0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    // Main canvas — terrarium-like
                    VStack(spacing: 8) {
                        PreviewHUD(
                            agent: selection.agent,
                            state: selection.state,
                            sessionCount: selection.sessionCount
                        )
                        ZStack {
                            RoundedRectangle(cornerRadius: 10)
                                .fill(LinearGradient(
                                    colors: [TerrariumColors.deepSea, TerrariumColors.midWater, TerrariumColors.shallowWater],
                                    startPoint: .top, endPoint: .bottom))
                            GeometryReader { geo in
                                PreviewCreature(agent: selection.agent, state: selection.state, size: min(geo.size.width, geo.size.height) * 0.45)
                                    .position(x: geo.size.width * 0.55, y: geo.size.height * 0.45)
                            }
                        }
                    }
                }
            }
            .frame(width: 440, height: 300)
            Text("iPad landscape • dashboard")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }

    private func agentLabel(for i: Int) -> String {
        i == 0 ? selection.agent.displayName : ["Claude", "Codex", "OpenCode", "OpenClaw"][i % 4]
    }
}

// MARK: - Android Tablet (Lenovo-style)

struct AndroidTabletPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 12) {
            DeviceBezel(cornerRadius: 20, bezelWidth: 10, bezelColor: Color(white: 0.12)) {
                VStack(spacing: 8) {
                    // Status bar
                    HStack {
                        Text("AgentDeck")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.8))
                        Spacer()
                        Text("\(selection.sessionCount) sessions")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.6))
                    }
                    // Aquarium canvas
                    ZStack {
                        RoundedRectangle(cornerRadius: 12)
                            .fill(LinearGradient(
                                colors: [TerrariumColors.deepSea, TerrariumColors.midWater, TerrariumColors.shallowWater],
                                startPoint: .top, endPoint: .bottom))
                        GeometryReader { geo in
                            PreviewCreature(
                                agent: selection.agent,
                                state: selection.state,
                                size: min(geo.size.width, geo.size.height) * 0.45
                            )
                            .position(x: geo.size.width * 0.55, y: geo.size.height * 0.45)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
            .frame(width: 420, height: 280)
            Text("Android tablet • Lenovo / generic")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}
