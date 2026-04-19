// DevicePreviewScreen.swift — Capstone window for the Device Preview track.
//
// Layout:
//   - Sidebar: grouped list of 14 device types across 7 categories.
//   - Main canvas: the selected device's view, centered with a header + byline.
//   - Toolbar: Agent / State / Sessions pickers. A running animation clock
//     ticks `selection.animationFrame` forward twice per second so dynamic
//     devices (Stream Deck+ slot, TUI terrarium) visibly animate.
//
// This window opens via:
//   - macOS menu bar: "Preview Devices" button in ControlTowerPanel.
//   - First launch: the device-empty banner nudges the user here.
//   - `openWindow(id: "device-preview")` from anywhere else.
//
// The window is macOS-only in the App scene, but the screen View is
// platform-agnostic so iOS compiles it too — useful for future iPad previews.

import SwiftUI

// MARK: - Screen

struct DevicePreviewScreen: View {
    @State private var selection = DevicePreviewSelection(
        agent: .claudeCode,
        state: .processing,
        sessionCount: 1,
        device: .streamDeckPlus
    )

    /// Mark first-view-seen. The window is the only caller that should write
    /// this flag — don't leak the side-effect into subviews.
    @EnvironmentObject private var preferences: AppPreferences

    private let sessionCountOptions: [Int] = [0, 1, 2, 4]

#if os(macOS)
    /// External CLI daemon presence gates the desktop-bridge-only device
    /// previews. When absent, the picker hides Android / e-ink / TC001
    /// rows so the catalog reflects only what this app can drive itself.
    @EnvironmentObject private var daemonService: DaemonService

    private var visibleDevices: [PreviewDevice] {
        if daemonService.isUsingExternalDaemon {
            return PreviewDevice.allCases
        }
        return PreviewDevice.allCases.filter { !$0.requiresDesktopBridge }
    }
#else
    private var visibleDevices: [PreviewDevice] {
        PreviewDevice.allCases.filter { !$0.requiresDesktopBridge }
    }
#endif

    var body: some View {
        #if os(macOS)
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        } detail: {
            detail
        }
        .frame(minWidth: 900, minHeight: 600)
        .onAppear {
            if !preferences.hasSeenDevicePreview {
                preferences.hasSeenDevicePreview = true
            }
            let pool = visibleDevices
            if !pool.contains(selection.device), let first = pool.first {
                selection.device = first
            }
        }
        #else
        // iOS has no NavigationSplitView detail column with this API shape
        // before iOS 17.0, and the preview screen is macOS-facing; on iOS we
        // just show the detail.
        VStack(spacing: 0) {
            toolbar
            Divider()
            detail
        }
        #endif
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        let pool = visibleDevices
        return List(selection: Binding<PreviewDevice?>(
            get: { selection.device },
            set: { new in if let new { selection.device = new } }
        )) {
            ForEach(PreviewDevice.Category.allCases) { cat in
                let entries = pool.filter { $0.category == cat }
                if !entries.isEmpty {
                    Section(cat.displayName) {
                        ForEach(entries) { dev in
                            Text(dev.displayName).tag(dev)
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
#if os(macOS)
        .onChange(of: daemonService.isUsingExternalDaemon) { _ in
            if !pool.contains(selection.device), let first = pool.first {
                selection.device = first
            }
        }
#endif
    }

    // MARK: - Detail

    private var detail: some View {
        VStack(alignment: .leading, spacing: 0) {
            toolbar
            Divider()
            ScrollView {
                VStack(spacing: 24) {
                    // Tagline
                    Text("Hardware optional. Here's what your agents look like on each device.")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    // Device header
                    VStack(alignment: .leading, spacing: 4) {
                        Text(selection.device.displayName)
                            .font(.system(size: 22, weight: .bold))
                        Text(selection.device.byline)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    // The device itself
                    TimelineView(.animation(minimumInterval: 0.1, paused: false)) { context in
                        deviceBody(animationFrame: frameFromTimeline(context.date))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }
                .padding(24)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(white: 0.04))
        }
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack(spacing: 16) {
            Picker("Agent", selection: $selection.agent) {
                ForEach(PixooPreviewAgent.allCases) { agent in
                    Text(agent.displayName).tag(agent)
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: 180)

            Picker("State", selection: $selection.state) {
                ForEach(PixooPreviewState.allCases) { state in
                    Text(state.displayName).tag(state)
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: 180)

            Picker("Sessions", selection: $selection.sessionCount) {
                ForEach(sessionCountOptions, id: \.self) { n in
                    Text("\(n)").tag(n)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 200)

            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Device dispatch

    @ViewBuilder
    private func deviceBody(animationFrame: Int) -> some View {
        // Merge the toolbar selection with the live animation frame so each
        // per-device view receives a single, coherent DevicePreviewSelection.
        let live = DevicePreviewSelection(
            agent: selection.agent,
            state: selection.state,
            sessionCount: selection.sessionCount,
            device: selection.device,
            animationFrame: animationFrame
        )

        switch selection.device {
        case .streamDeckKey:     StreamDeckKeyPreview(selection: live)
        case .streamDeckPlus:    StreamDeckPlusPreview(selection: live)
        case .d200hKey:          D200HKeyPreview(selection: live)
        case .d200hDeck:         D200HDeckPreview(selection: live)
        case .appleWatch:        AppleWatchPreview(selection: live)
        case .iPadLandscape:     IPadLandscapePreview(selection: live)
        case .androidTablet:     AndroidTabletPreview(selection: live)
        case .einkMono:          EinkMonoPreview(selection: live)
        case .einkColor:         EinkColorPreview(selection: live)
        case .esp32_86box:       Esp3286BoxPreview(selection: live)
        case .esp32_35Landscape: Esp3235LandscapePreview(selection: live)
        case .esp32_35Portrait:  Esp3235PortraitPreview(selection: live)
        case .esp32Round:        Esp32RoundPreview(selection: live)
        case .pixoo64:           Pixoo64Preview(selection: live)
        case .ulanziMatrix:      UlanziMatrixPreview(selection: live)
        case .terminalTerrarium: TerminalTerrariumPreview(selection: live)
        }
    }

    /// Convert a Date tick into a monotonic integer animation frame. We use
    /// seconds * 10 so Canvas / SessionSlotView animations feel smooth but
    /// don't burn CPU — the animations internally are cheap (angle/sin).
    private func frameFromTimeline(_ date: Date) -> Int {
        Int(date.timeIntervalSinceReferenceDate * 10)
    }
}

#if DEBUG
#Preview("Device preview") {
    DevicePreviewScreen()
        .environmentObject(AppPreferences.shared)
        .frame(width: 1100, height: 760)
}
#endif
