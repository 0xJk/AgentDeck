// AgentStatusIcon.swift — Menu bar label: AgentDeck logo + fixed status badge
// Design from `explore/menubar-icons.jsx::MBComposite`.
//
// Rendering gotcha: `MenuBarExtra { … } label: { … }` does NOT render
// arbitrary SwiftUI content reliably. Canvas-based views measure as zero
// size, HStack children with conditional branches get dropped, and the
// icon disappears altogether. Apple's own guidance is "use a simple
// `Image` or `Label` as the label." We honor that by building the
// composite view in a hidden SwiftUI hierarchy, rasterizing it via
// `ImageRenderer` into an `NSImage`, and handing the menu bar a plain
// `Image` as the label — which renders the way any other status item
// does. The image is not marked as a template because the status badge
// intentionally carries semantic color.

#if os(macOS)
import SwiftUI
import AppKit

struct AgentStatusIcon: View {
    let sessions: [SessionInfo]
    let bridgeConnected: Bool
    let style: AppPreferences.MenuBarIconStyle

    @Environment(\.colorScheme) private var colorScheme
    @State private var renderedImage: NSImage? = nil
    @State private var pulseTick: Bool = false

    var body: some View {
        Group {
            if let img = renderedImage {
                Image(nsImage: img)
            } else {
                // Placeholder during the first render — SF Symbol is guaranteed
                // to display, which keeps the menubar slot visible even if
                // ImageRenderer hasn't fired yet.
                Image(systemName: "square.stack.3d.up")
                    .frame(
                        width: IconComposite.renderWidth(for: style),
                        height: IconComposite.renderHeight
                    )
            }
        }
        .onAppear { refreshIcon() }
        .onChange(of: compositeSignature) { _, _ in refreshIcon() }
        // Pulse timer: drives the awaiting-agent status badge opacity. 1.1s cycle
        // matches the JS prototype's `mbPulse` animation. We only schedule
        // the timer when there is something to pulse, to avoid unnecessary
        // menubar redraws when the app is idle.
        .onReceive(
            Timer.publish(every: 0.55, on: .main, in: .common).autoconnect()
        ) { _ in
            if shouldPulseIcon {
                pulseTick.toggle()
                refreshIcon()
            } else if pulseTick {
                pulseTick = false
                refreshIcon()
            }
        }
    }

    /// Signature of the inputs that should invalidate the rendered image.
    /// Re-render only when the aggregate status or visual style changes —
    /// not on every sibling-session mutation.
    private var compositeSignature: String {
        "\(style.rawValue)|\(colorScheme)|\(activeStatus.rawValue)|\(pulseTick)"
    }

    private var shouldPulseIcon: Bool {
        style != .app && activeStatus == .awaiting
    }

    private func refreshIcon() {
        let composite = IconComposite(
            style: style,
            activeStatus: activeStatus,
            pulseDim: pulseTick
        )
        let view = composite.environment(\.colorScheme, colorScheme)
        // `ImageRenderer` was introduced in macOS 13. AgentDeck already
        // targets macOS 14+, so we can use it unconditionally.
        let renderer = ImageRenderer(content: view)
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2.0
        if let cg = renderer.cgImage {
            let size = NSSize(width: composite.renderWidth, height: IconComposite.renderHeight)
            let img = NSImage(cgImage: cg, size: size)
            img.isTemplate = false
            renderedImage = img
        }
    }

    // MARK: - Aggregate status

    fileprivate enum ActiveStatus: String {
        case disconnected
        case idle
        case processing
        case awaiting
    }

    private var activeStatus: ActiveStatus {
        guard bridgeConnected else { return .disconnected }
        let liveStates = sessions
            .filter(\.alive)
            .compactMap { AgentConnectionState(rawValue: $0.state ?? "idle") }
        if liveStates.contains(where: \.isAwaiting) { return .awaiting }
        if liveStates.contains(.processing) { return .processing }
        return .idle
    }
}

/// Pure SwiftUI composition that gets rasterized into the menu bar icon.
/// Keeps all layout decisions in one place so `ImageRenderer` has a known
/// canvas size to work with (important — menubar icons must be ~18pt tall).
private struct IconComposite: View {
    let style: AppPreferences.MenuBarIconStyle
    let activeStatus: AgentStatusIconActiveStatusProxy
    let pulseDim: Bool

    static let renderHeight: CGFloat = 18

    init(
        style: AppPreferences.MenuBarIconStyle,
        activeStatus: AgentStatusIcon.ActiveStatus,
        pulseDim: Bool = false
    ) {
        self.style = style
        self.activeStatus = AgentStatusIconActiveStatusProxy(activeStatus)
        self.pulseDim = pulseDim
    }

    static func renderWidth(for style: AppPreferences.MenuBarIconStyle) -> CGFloat {
        switch style {
        case .app, .status:
            return 20
        case .minimal:
            return 12
        }
    }

    var renderWidth: CGFloat {
        Self.renderWidth(for: style)
    }

    var body: some View {
        Group {
            switch style {
            case .app:
                AgentDeckLogo(size: 16, color: Color(nsColor: .labelColor))
            case .minimal:
                statusCircle(size: 7)
            case .status:
                ZStack {
                    AgentDeckLogo(size: 16, color: Color(nsColor: .labelColor))
                        .opacity(activeStatus.logoOpacity)
                        .frame(width: 18, height: 18)
                        .overlay(alignment: .bottomTrailing) {
                            statusBadge
                        }
                }
            }
        }
        .frame(width: renderWidth, height: Self.renderHeight, alignment: .center)
    }

    private func statusCircle(size: CGFloat) -> some View {
        Circle()
            .fill(activeStatus.color)
            .frame(width: size, height: size)
            .opacity(activeStatus.pulses && pulseDim ? 0.45 : 1.0)
    }

    private var statusBadge: some View {
        statusCircle(size: 6)
            .overlay(
                Circle()
                    .stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 1)
            )
    }
}

private struct AgentStatusIconActiveStatusProxy {
    let color: Color
    let pulses: Bool
    let logoOpacity: Double

    init(_ status: AgentStatusIcon.ActiveStatus) {
        switch status {
        case .disconnected:
            color = Color(nsColor: .systemRed)
            pulses = false
            logoOpacity = 0.5
        case .idle:
            color = Color(nsColor: .systemGreen)
            pulses = false
            logoOpacity = 1.0
        case .processing:
            color = Color(nsColor: .systemCyan)
            pulses = false
            logoOpacity = 1.0
        case .awaiting:
            color = Color(nsColor: .systemOrange)
            pulses = true
            logoOpacity = 1.0
        }
    }
}
#endif
