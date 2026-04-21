// MenuBarTopologyList.swift — Compact linear topology for the menu bar
//
// Replaces the radial `UnifiedGraphView`. Dashboard's `TopologyRail` already
// established a clear "UPSTREAM → AgentDeck hub → DOWNSTREAM" flow that
// reads well in a narrow rail; this is the menu-bar-cream-palette sibling,
// sized for the 380pt popover.
//
// Kept intentionally thin:
//   * Provider rows only surface Claude / OpenClaw / MLX / Ollama. No
//     Antigravity, subscriptions, rate chips, or consumer badges — those
//     live in dedicated menu-bar sections (rate limits are already below
//     this view), so duplicating them here is noise.
//   * Device rows surface ADB / D200H / Pixoo / ESP32 from `moduleHealth`.
//   * Hub node = AgentDeck logo + port, nothing more.

#if os(macOS)
import SwiftUI

struct MenuBarTopologyList: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var daemonService: DaemonService

    /// Palette is a thin alias over the shared `TerrariumHUD` /
    /// `TerrariumColors` tokens so the menu-bar popup reads as part of
    /// the same visual system as the Dashboard and Monitor HUDs — no
    /// separate cream palette, no drifting hex codes.
    fileprivate enum Pal {
        static let text      = TerrariumHUD.text
        static let subtext   = TerrariumHUD.subtext
        static let divider   = Color.white.opacity(0.10)
        static let cardBg    = Color.white.opacity(0.04)
        static let hubFill   = TerrariumColors.midWater
        static let hubAccent = TerrariumColors.tetraNeon
        static let ok        = TerrariumHUD.ledGreen
        static let warn      = TerrariumHUD.ledAmber
        static let error     = TerrariumHUD.ledRed
        static let dim       = TerrariumHUD.subtext.opacity(0.5)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader("UPSTREAM")
            upstreamRows
            flowArrow
            hubNode
            flowArrow
            sectionHeader("DOWNSTREAM")
            downstreamRows
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Pal.cardBg))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.black.opacity(0.06), lineWidth: 0.5)
        )
    }

    // MARK: - Headers / flow arrow / hub

    private func sectionHeader(_ title: String) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                .kerning(1.2)
                .foregroundColor(Pal.subtext)
            Rectangle()
                .fill(Pal.divider)
                .frame(height: 0.5)
        }
    }

    private var flowArrow: some View {
        Text(verbatim: "▼")
            .font(.system(size: 9, design: .monospaced))
            .foregroundColor(Pal.hubAccent.opacity(0.55))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 2)
    }

    private var hubNode: some View {
        HStack(spacing: 8) {
            AgentDeckLogo(size: 16, color: Pal.hubAccent)
            VStack(alignment: .leading, spacing: 0) {
                Text("AgentDeck")
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .foregroundColor(TerrariumHUD.text)
                Text(verbatim: ":\(hubPortText)")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(TerrariumHUD.subtext)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 6).fill(Pal.hubFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Pal.hubAccent.opacity(0.70), lineWidth: 1)
        )
    }

    /// Prefer the live daemon port. When the in-process daemon hasn't
    /// bound yet we still have a value worth showing — the configured
    /// default — rather than a blank or zero.
    private var hubPortText: String {
        if daemonService.port > 0 { return portString(daemonService.port) }
        return portString(AppPreferences.defaultDaemonPort)
    }

    // MARK: - Upstream rows

    @ViewBuilder
    private var upstreamRows: some View {
        VStack(alignment: .leading, spacing: 4) {
            claudeRow
            openClawRow
            mlxRow
            ollamaRow
        }
    }

    private var claudeRow: some View {
        let status = claudeStatus
        return RailRow(
            status: status,
            name: "Claude",
            subtitle: claudeSubtitle
        )
    }

    private var claudeStatus: RailStatus {
        switch stateHolder.state.oauthConnected {
        case .some(true):  return .ok
        case .some(false): return .warn
        case .none:        return .dim
        }
    }

    /// Claude has rate limits rendered in a separate section; no need to
    /// echo them here. Just carry OAuth / availability in one short line.
    private var claudeSubtitle: String? {
        if stateHolder.state.oauthConnected == false {
            return "Not connected"
        }
        return nil
    }

    @ViewBuilder
    private var openClawRow: some View {
        if stateHolder.state.gatewayAvailable || stateHolder.state.gatewayHasError {
            let status: RailStatus = stateHolder.state.gatewayHasError ? .error
                : (stateHolder.state.gatewayConnected ? .ok : .warn)
            RailRow(
                status: status,
                name: "OpenClaw",
                subtitle: openClawSubtitle
            )
        }
    }

    private var openClawSubtitle: String? {
        switch stateHolder.state.gatewayAuthStatus {
        case "approval_pending":       return "Approve in OpenClaw"
        case "pairing_required":       return "Pairing required"
        case "gateway_token_missing":  return "Gateway token required"
        case "auth_failed",
             "token_mismatch",
             "device_auth_invalid":    return "Auth failed — re-approve"
        case "unsupported_protocol":   return "Unsupported — update OpenClaw"
        default:
            return stateHolder.state.gatewayHasError ? "Gateway error" : nil
        }
    }

    @ViewBuilder
    private var mlxRow: some View {
        if !stateHolder.state.mlxModels.isEmpty {
            let primary = stateHolder.state.mlxModels.first ?? ""
            let extra = max(0, stateHolder.state.mlxModels.count - 1)
            let subtitle = extra > 0 ? "\(primary) · +\(extra)" : primary
            RailRow(status: .ok, name: "MLX", subtitle: subtitle)
        }
    }

    @ViewBuilder
    private var ollamaRow: some View {
        if let ollama = stateHolder.state.ollamaStatus {
            let status: RailStatus = ollama.available ? .ok : .dim
            let subtitle: String = {
                if !ollama.available { return "stopped" }
                let running = ollama.models.filter { $0.sizeVram > 0 }
                let source = running.isEmpty ? ollama.models : running
                if source.isEmpty { return "idle" }
                return source.prefix(1).map(\.name).joined() +
                    (source.count > 1 ? " · +\(source.count - 1)" : "")
            }()
            RailRow(status: status, name: "Ollama", subtitle: subtitle)
        }
    }

    // MARK: - Downstream rows

    @ViewBuilder
    private var downstreamRows: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let health = stateHolder.state.moduleHealth {
                // D200H first — always the most permanent peripheral.
                if let d = health.d200h {
                    RailRow(
                        status: d.connected ? .ok : (d.managerOpened ? .warn : .dim),
                        name: "D200H",
                        subtitle: d.connected
                            ? "HID · 14 keys"
                            : (d.lastOpenError
                                ?? (d.usbEntitlementPresent ? "Disconnected" : "No USB entitlement"))
                    )
                }
                // Pixel displays — Pixoo + Ulanzi TC001 (same family).
                if let pixoo = health.pixoo, pixoo.configuredDeviceCount > 0 {
                    ForEach(pixoo.devices, id: \.ip) { dev in
                        RailRow(
                            status: dev.online ? .ok : (dev.backedOff ? .warn : .dim),
                            name: "Pixoo",
                            subtitle: dev.online
                                ? (pixoo.hasFrame ? "streaming · \(dev.ip)" : dev.ip)
                                : "fail \(dev.failures)\(dev.backedOff ? " · backed off" : "")"
                        )
                    }
                }
                if let adb = health.adb {
                    ForEach(adb.classifiedDevices.filter {
                        $0.deviceClass == AdbDeviceClass.ulanziTc001.rawValue
                    }, id: \.serial) { dev in
                        RailRow(
                            status: .ok,
                            name: "TC001",
                            subtitle: dev.model ?? dev.serial
                        )
                    }
                }
                // USB serial / ESP32.
                if let serial = health.serial, !serial.connectedBoards.isEmpty {
                    ForEach(serial.connectedBoards, id: \.port) { info in
                        let short = info.port.components(separatedBy: "/").last ?? info.port
                        RailRow(
                            status: .ok,
                            name: esp32Name(for: info.board),
                            subtitle: short
                        )
                    }
                }
                // Android — e-ink + tablet, with aggregate fallback.
                if let adb = health.adb {
                    let eInk = adb.classifiedDevices.filter { $0.deviceClass.hasPrefix("e-ink.") }
                    let tablets = adb.classifiedDevices.filter { $0.deviceClass == AdbDeviceClass.androidTablet.rawValue }
                    ForEach(eInk, id: \.serial) { dev in
                        RailRow(status: .ok, name: eInkName(for: dev.deviceClass), subtitle: dev.model ?? dev.serial)
                    }
                    ForEach(tablets, id: \.serial) { dev in
                        let label = [dev.manufacturer, dev.model].compactMap { $0 }.joined(separator: " ")
                        RailRow(status: .ok, name: "Tablet", subtitle: label.isEmpty ? dev.serial : label)
                    }
                    if adb.classifiedDevices.isEmpty,
                       (adb.available || !adb.devices.isEmpty || adb.lastError != nil) {
                        RailRow(
                            status: adb.available ? .ok : (adb.lastError != nil ? .warn : .dim),
                            name: "ADB",
                            subtitle: adbDetail(adb)
                        )
                    }
                }
            }
            if !hasAnyDownstream {
                Text("no devices connected")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(Pal.subtext.opacity(0.85))
            }
        }
    }

    private func eInkName(for deviceClass: String) -> String {
        switch deviceClass {
        case AdbDeviceClass.eInkCrema.rawValue: return "Crema"
        case AdbDeviceClass.eInkPantone.rawValue: return "Pantone"
        case AdbDeviceClass.eInkKobo.rawValue: return "Kobo"
        default: return "E-ink"
        }
    }

    private func adbDetail(_ adb: AdbHealth) -> String {
        if !adb.devices.isEmpty {
            let dev = "\(adb.devices.count) device" + (adb.devices.count == 1 ? "" : "s")
            let rev = adb.reverseReadyCount > 0 ? " · \(adb.reverseReadyCount) reverse" : ""
            return dev + rev
        }
        if let err = adb.lastError, !err.isEmpty { return err }
        return "No devices"
    }

    private var hasAnyDownstream: Bool {
        guard let h = stateHolder.state.moduleHealth else { return false }
        if let adb = h.adb, (adb.available || !adb.devices.isEmpty || adb.lastError != nil) { return true }
        if h.d200h != nil { return true }
        if let p = h.pixoo, p.configuredDeviceCount > 0 { return true }
        if let s = h.serial, !s.connectedBoards.isEmpty { return true }
        return false
    }

    private func esp32Name(for board: String?) -> String {
        switch board {
        case "ips_35": return "ESP32 · IPS 3.5\""
        case "round_amoled": return "ESP32 · AMOLED"
        case "86box": return "ESP32 · 86box"
        // Ulanzi TC001 is an ESP32 under the hood but sold as a finished
        // product — surface the brand instead of the raw board name.
        case "ulanzi_tc001": return "Ulanzi TC001"
        case .some(let b) where !b.isEmpty: return "ESP32 · \(b)"
        default: return "ESP32"
        }
    }
}

// MARK: - Row primitives

private enum RailStatus {
    case ok, warn, error, dim

    var color: Color {
        switch self {
        case .ok:    return MenuBarTopologyList.Pal.ok
        case .warn:  return MenuBarTopologyList.Pal.warn
        case .error: return MenuBarTopologyList.Pal.error
        case .dim:   return MenuBarTopologyList.Pal.dim
        }
    }

    /// Outline glyph for `.dim` so "inactive / stopped" reads differently
    /// from "live but unhealthy" at a glance.
    var filled: Bool {
        switch self {
        case .dim: return false
        default:   return true
        }
    }
}

private struct RailRow: View {
    let status: RailStatus
    let name: String
    let subtitle: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            statusDot
                .frame(width: 8, height: 8)
                .padding(.top, 2)
            Text(name)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundColor(MenuBarTopologyList.Pal.text)
                .frame(minWidth: 58, alignment: .leading)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(MenuBarTopologyList.Pal.subtext)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var statusDot: some View {
        if status.filled {
            Circle().fill(status.color)
        } else {
            Circle()
                .stroke(status.color, lineWidth: 1)
        }
    }
}

#endif
