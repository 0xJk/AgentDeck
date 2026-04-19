// TopologyRail.swift — Right-rail topology visualization for the dashboard HUD
//
// Replaces the previous `TankStatusPanel` + `DeviceDiagnosticPanel` stack with a
// single top-to-bottom flow:
//
//      ┌─ UPSTREAM ─────────────┐
//      │ ● Claude  · OAuth      │
//      │   [▓▓▓▓░░ 62%  2h14]🦑│  ← rate gauge + consumer creature dots
//      │ ● OpenClaw :18789  🦀  │
//      │ ● MLX · Qwen3.5-30B    │
//      │ ○ Ollama · stopped     │
//      ├────────────────────────┤
//      │      ▼                 │
//      │  ⎔ AgentDeck :9120     │  ← hub node (stacked-deck mark, neon cyan)
//      │      ▼                 │
//      ├─ DOWNSTREAM ───────────┤
//      │ ● Stream Deck+  8 keys │
//      │ ● D200H         14 keys│
//      │ ● Pixoo64       64×64  │
//      │ ◐ ESP32         reconn │
//      └────────────────────────┘
//
// Reads as "sessions pull capacity from upstream providers, flow through the
// AgentDeck hub, and are dispatched to downstream devices." Preserves the
// terrarium dark-glass HUD palette (`TerrariumHUD.*`) so it sits on top of the
// aquarium without clashing.

import SwiftUI

struct TopologyRail: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
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
        .background(TerrariumHUD.bg, in: RoundedRectangle(cornerRadius: 8))
        .opacity(stateHolder.state.bridgeConnected ? 1.0 : 0.6)
    }

    // MARK: - Header / arrows / hub

    private func sectionHeader(_ title: String) -> some View {
        HStack(spacing: 4) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .kerning(1.4)
                .foregroundStyle(TerrariumHUD.subtext)
            Rectangle()
                .fill(TerrariumHUD.tetraNeon.opacity(0.25))
                .frame(height: 0.5)
        }
        .padding(.bottom, 4)
    }

    private var flowArrow: some View {
        Text("▼")
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(TerrariumHUD.tetraNeon.opacity(0.55))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 3)
    }

    private var hubNode: some View {
        HStack(spacing: 6) {
            AgentDeckLogo(size: 18, color: TerrariumHUD.tetraNeon)
            VStack(alignment: .leading, spacing: 0) {
                Text("AgentDeck")
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
                Text(":\(daemonPortText)")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color.black.opacity(0.45))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(TerrariumHUD.tetraNeon.opacity(0.55), lineWidth: 1)
                )
        )
    }

    /// Hub port surfaces in descending order of trust: explicit daemonService
    /// port (populated when the Swift daemon is in-process) is unavailable
    /// from this view (daemonService is only exposed to the menubar panel),
    /// so we fall back to the state-level session port when we have one.
    private var daemonPortText: String {
        if let port = stateHolder.state.daemonPort, port > 0 {
            return String(port)
        }
        if let url = stateHolder.connection.url,
           let parsed = URL(string: url),
           let port = parsed.port {
            return String(port)
        }
        return String(AppPreferences.defaultDaemonPort)
    }

    // MARK: - Upstream rows

    private var upstreamRows: some View {
        VStack(alignment: .leading, spacing: 5) {
            claudeRow
            openClawRow
            mlxRow
            ollamaRow
            antigravityRow
            if !stateHolder.state.subscriptions.isEmpty {
                subscriptionsFooter
            }
        }
    }

    /// Subtitles carry real info (model lists, plan names) — the LED dot
    /// already conveys status, so text like "OAuth" / "Gateway" is
    /// redundant chrome and gets dropped. Only surface a status string as
    /// the subtitle when there's no better content to show (e.g. Claude
    /// isn't connected yet → "Not connected"; OpenClaw waiting for auth →
    /// short reason from `gatewayAuthStatus`).

    /// Which provider "owns" the current `modelCatalog`. The catalog is
    /// published by the primary session's state_update — it contains the
    /// models visible to THAT session only, so we must gate catalog-backed
    /// subtitles on the primary agentType or we'll mislabel models under
    /// the wrong row. Bug caught when `claude-opus` rendered under the
    /// "OpenClaw" row because `openClawDisplayLines` was reading a Claude
    /// session's catalog.
    ///
    /// Conservative mapping — only the two agent types we know ship a
    /// provider-scoped catalog. Codex / OpenCode may or may not publish
    /// their model list via the same field; treat them as unknown rather
    /// than risk mis-attribution.
    private var catalogOwner: ProviderKey {
        switch stateHolder.state.agentType {
        case "claude-code": return .claude
        case "openclaw":    return .openclaw
        default:            return .unknown
        }
    }

    private var claudeRow: some View {
        let status: LEDStatus = {
            if stateHolder.state.oauthConnected == true { return .ok }
            if stateHolder.state.oauthConnected == false { return .warn }
            return .dim
        }()
        // Only read `modelCatalog` here when the primary session is a
        // Claude session — otherwise the catalog belongs to some other
        // provider and spilling it into the Claude row is actively wrong.
        let claudeModels: [String] = {
            guard catalogOwner == .claude else { return [] }
            return DashboardDataRules.sortedModelCatalog(stateHolder.state.modelCatalog)
                .filter(\.available)
                .map { shortClaudeModel($0.name) }
        }()
        let subtitle: String? = {
            if !claudeModels.isEmpty {
                return claudeModels.joined(separator: ", ")
            }
            if stateHolder.state.oauthConnected == false { return "Not connected" }
            return nil
        }()
        return ProviderRow(
            name: "Claude",
            status: status,
            subtitle: subtitle,
            rateLimits: rateLimitChips,
            consumers: consumerCreatures(for: .claude)
        )
    }

    private var openClawRow: some View {
        guard stateHolder.state.gatewayAvailable || stateHolder.state.gatewayHasError else {
            return AnyView(EmptyView())
        }
        let status: LEDStatus = stateHolder.state.gatewayHasError ? .error
            : (stateHolder.state.gatewayConnected ? .ok : .warn)
        // Same catalog-ownership gate as Claude — only surface the catalog
        // under OpenClaw when an OpenClaw-hosted session is primary.
        let lines: [String] = {
            guard catalogOwner == .openclaw else { return [] }
            return DashboardDataRules.openClawDisplayLines(stateHolder.state.modelCatalog)
        }()
        let subtitle: String? = {
            if !lines.isEmpty { return lines.joined(separator: ", ") }
            // Fall back to a pairing/approval hint so the user knows why
            // the row is amber instead of green — the single most common
            // reason when `modelCatalog` is empty is waiting on OpenClaw
            // approval / pairing.
            switch stateHolder.state.gatewayAuthStatus {
            case "approval_pending":  return "Approve in OpenClaw"
            case "pairing_required":  return "Pairing required"
            case "gateway_token_missing": return "Gateway token required"
            case "auth_failed",
                 "token_mismatch",
                 "device_auth_invalid": return "Auth failed — re-approve"
            case "unsupported_protocol": return "Unsupported — update OpenClaw"
            default:
                return stateHolder.state.gatewayHasError ? "Gateway error" : nil
            }
        }()
        return AnyView(
            ProviderRow(
                name: "OpenClaw",
                status: status,
                subtitle: subtitle,
                rateLimits: [],
                consumers: consumerCreatures(for: .openclaw)
            )
        )
    }

    private var mlxRow: some View {
        guard !stateHolder.state.mlxModels.isEmpty else { return AnyView(EmptyView()) }
        let selected = stateHolder.state.mlxModels.joined(separator: ", ")
        let extraCount = max(0, stateHolder.state.mlxModelCatalog.count - stateHolder.state.mlxModels.count)
        let subtitle = extraCount > 0 ? "\(selected) · +\(extraCount) available" : selected
        return AnyView(
            ProviderRow(
                name: "MLX",
                status: .ok,
                subtitle: subtitle,
                rateLimits: [],
                consumers: consumerCreatures(for: .mlx)
            )
        )
    }

    private var ollamaRow: some View {
        guard let ollama = stateHolder.state.ollamaStatus else { return AnyView(EmptyView()) }
        let status: LEDStatus = ollama.available ? .ok : .dim
        // Prefer "running" models (those with VRAM allocated) — these are
        // the ones sessions can actually use without a cold-load delay. Fall
        // back to the full installed list so the row is never empty when
        // Ollama is available but idle, matching the old `TankStatusPanel`
        // behavior.
        let running = ollama.models.filter { $0.sizeVram > 0 }
        let source = running.isEmpty ? ollama.models : running
        let subtitle: String? = {
            if !source.isEmpty { return source.map(\.name).joined(separator: ", ") }
            if ollama.available { return "installed, no models loaded" }
            return "stopped"
        }()
        return AnyView(
            ProviderRow(
                name: "Ollama",
                status: status,
                subtitle: subtitle,
                rateLimits: [],
                consumers: consumerCreatures(for: .ollama)
            )
        )
    }

    /// Antigravity is a Google-hosted model product — when the bridge
    /// surfaces an active plan, it belongs in the upstream rail alongside
    /// Claude/OpenClaw/MLX/Ollama. Hidden when `planName` is nil or blank.
    private var antigravityRow: some View {
        guard let status = stateHolder.state.antigravityStatus,
              let plan = status.planName, !plan.isEmpty else {
            return AnyView(EmptyView())
        }
        return AnyView(
            ProviderRow(
                name: "Antigravity",
                status: .ok,
                subtitle: plan,
                rateLimits: [],
                consumers: []  // no session → antigravity mapping yet
            )
        )
    }

    /// Strip long Claude model prefixes/date suffixes so the compact
    /// subtitle row can fit 3 model names horizontally.
    private func shortClaudeModel(_ name: String) -> String {
        var s = name
        if s.hasPrefix("claude-") { s = String(s.dropFirst("claude-".count)) }
        if let r = s.range(of: #"-\d{8}$"#, options: .regularExpression) {
            s = String(s[s.startIndex..<r.lowerBound])
        }
        return s
    }

    private var subscriptionsFooter: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("SUBSCRIPTIONS")
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .kerning(0.8)
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.8))
            ForEach(Array(stateHolder.state.subscriptions.enumerated()), id: \.offset) { _, sub in
                HStack(spacing: 4) {
                    Text(sub.name)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.text)
                    if let until = sub.until {
                        Spacer(minLength: 4)
                        Text(formatShortDate(until))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(TerrariumHUD.subtext)
                    }
                }
            }
        }
        .padding(.top, 4)
    }

    // MARK: - Downstream rows
    //
    // Behaviour across build variants:
    //
    //   * App Store build — ADB is the only module compiled out (spawning
    //     `adb` violates Apple 2.5.2). D200H / Pixoo / ESP32-serial all
    //     run: `device.usb` and `device.serial` entitlements are granted,
    //     and serial I/O + Wi-Fi provisioning to ESP32 go through direct
    //     FileHandle writes (no Process()). So `moduleHealth.adb` is nil
    //     but `.serial`, `.d200h`, `.pixoo` are all populated.
    //
    //   * Node CLI / unsigned dev build — every module runs, including
    //     ADB, so Android / Ulanzi TC001 devices become visible too.

    /// True when at least one downstream module is going to render a row.
    /// Computed up-front so the empty-state placeholder only appears when
    /// nothing real is present.
    private var hasAnyDownstreamRow: Bool {
        guard let health = stateHolder.state.moduleHealth else { return false }
        if let adb = health.adb, (adb.available || !adb.devices.isEmpty || adb.lastError != nil) {
            return true
        }
        if health.d200h != nil { return true }
        if let pixoo = health.pixoo, pixoo.configuredDeviceCount > 0 { return true }
        if let serial = health.serial, !serial.connectedBoards.isEmpty { return true }
        return false
    }

    /// Downstream devices grouped by transport / physical family. The
    /// sub-headers ("USB HID", "Wi-Fi LED", …) make the taxonomy legible
    /// at a glance — previously every device was a flat row and a user
    /// with both a Pixoo and an AMOLED ESP32 couldn't tell at first
    /// glance which was which. Headers only appear when a section has
    /// content, so sparse setups stay tight.
    private var downstreamRows: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let health = stateHolder.state.moduleHealth {
                usbHidSection(health: health)
                pixelDisplaySection(health: health)
                usbSerialSection(health: health)
                androidSection(health: health)
            }
            if !hasAnyDownstreamRow {
                emptyDownstreamPlaceholder
            }
        }
    }

    @ViewBuilder
    private func usbHidSection(health: ModuleHealthState) -> some View {
        if let d200h = health.d200h {
            VStack(alignment: .leading, spacing: 3) {
                downstreamSubheader("USB HID")
                DeviceRailRow(
                    name: "D200H",
                    status: d200h.connected
                        ? .ok
                        : (d200h.managerOpened ? .warn : .dim),
                    detail: d200h.connected
                        ? "HID · 14 keys"
                        : (d200h.lastOpenError
                           ?? (d200h.usbEntitlementPresent ? "Disconnected" : "No USB entitlement"))
                )
            }
        }
    }

    /// LED matrix / pixel displays — Pixoo (Wi-Fi HTTP) and Ulanzi TC001
    /// (USB-bridged via ADB reverse). Grouped together because they're
    /// both "pixel art" outputs, not general-purpose displays. The user
    /// thinks of them as the same family even though one goes over Wi-Fi
    /// and the other rides ADB.
    @ViewBuilder
    private func pixelDisplaySection(health: ModuleHealthState) -> some View {
        let pixooActive = (health.pixoo?.configuredDeviceCount ?? 0) > 0
        let tc001Devices = health.adb?.classifiedDevices.filter {
            $0.deviceClass == AdbDeviceClass.ulanziTc001.rawValue
        } ?? []
        if pixooActive || !tc001Devices.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                downstreamSubheader("Pixel displays")
                if let pixoo = health.pixoo, pixoo.configuredDeviceCount > 0 {
                    ForEach(pixoo.devices, id: \.ip) { dev in
                        DeviceRailRow(
                            name: "Pixoo",
                            status: dev.online ? .ok : (dev.backedOff ? .warn : .dim),
                            detail: dev.online
                                ? (pixoo.hasFrame ? "streaming · \(dev.ip)" : dev.ip)
                                : "fail \(dev.failures)\(dev.backedOff ? " backed off" : "")"
                        )
                    }
                }
                ForEach(tc001Devices, id: \.serial) { dev in
                    DeviceRailRow(
                        name: "TC001",
                        status: .ok,
                        detail: dev.model.map { "\($0) · \(dev.serial)" } ?? dev.serial
                    )
                }
            }
        }
    }

    @ViewBuilder
    private func usbSerialSection(health: ModuleHealthState) -> some View {
        if let serial = health.serial, !serial.connectedBoards.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                downstreamSubheader("USB serial")
                ForEach(serial.connectedBoards, id: \.port) { info in
                    let short = info.port.components(separatedBy: "/").last ?? info.port
                    DeviceRailRow(
                        name: esp32DisplayName(for: info.board),
                        status: .ok,
                        detail: info.firmwareVersion.map { "\($0) · \(short)" } ?? short
                    )
                }
            }
        }
    }

    /// Android section — split into e-ink readers (Crema / Pantone /
    /// Kobo, which need slow low-contrast rendering) and tablets
    /// (Lenovo + generic, which get normal Android UI). TC001 is
    /// excluded here — it renders under Pixel displays instead. Only
    /// present when the module was loaded (CLI build or unsigned dev);
    /// App Store build has `.adb` == nil so this whole section
    /// vanishes, which is correct.
    @ViewBuilder
    private func androidSection(health: ModuleHealthState) -> some View {
        if let adb = health.adb {
            let eInk = adb.classifiedDevices.filter { $0.deviceClass.hasPrefix("e-ink.") }
            let tablets = adb.classifiedDevices.filter { $0.deviceClass == AdbDeviceClass.androidTablet.rawValue }
            // Fallback "ADB" aggregate row: when we have a signal
            // (available / lastError) but no per-device classification yet
            // — e.g. older daemons or the 1-2s window before `getprop`
            // completes for the first time.
            let needsAggregate = adb.classifiedDevices.isEmpty
                && (adb.available || !adb.devices.isEmpty || adb.lastError != nil)

            if !eInk.isEmpty || !tablets.isEmpty || needsAggregate {
                VStack(alignment: .leading, spacing: 3) {
                    downstreamSubheader("Android")
                    ForEach(eInk, id: \.serial) { dev in
                        DeviceRailRow(
                            name: eInkRowName(for: dev.deviceClass),
                            status: .ok,
                            detail: dev.model ?? dev.serial
                        )
                    }
                    ForEach(tablets, id: \.serial) { dev in
                        let label = [dev.manufacturer, dev.model].compactMap { $0 }.joined(separator: " ")
                        DeviceRailRow(
                            name: "Tablet",
                            status: .ok,
                            detail: label.isEmpty ? dev.serial : label
                        )
                    }
                    if needsAggregate {
                        DeviceRailRow(
                            name: "ADB",
                            status: adb.available ? .ok : (adb.lastError != nil ? .warn : .dim),
                            detail: {
                                if !adb.devices.isEmpty {
                                    let devLabel = "\(adb.devices.count) device\(adb.devices.count == 1 ? "" : "s")"
                                    let reverse = adb.reverseReadyCount > 0
                                        ? " · \(adb.reverseReadyCount) reverse"
                                        : ""
                                    return devLabel + reverse
                                }
                                if let err = adb.lastError, !err.isEmpty { return err }
                                return "No devices"
                            }()
                        )
                    }
                }
            }
        }
    }

    private func eInkRowName(for deviceClass: String) -> String {
        switch deviceClass {
        case AdbDeviceClass.eInkCrema.rawValue: return "Crema"
        case AdbDeviceClass.eInkPantone.rawValue: return "Pantone"
        case AdbDeviceClass.eInkKobo.rawValue: return "Kobo"
        default: return "E-ink"
        }
    }

    /// Subtle mid-weight header for the downstream sub-sections. Sits
    /// below the main DOWNSTREAM divider so the visual hierarchy reads
    /// as: DOWNSTREAM > transport family > device row.
    private func downstreamSubheader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 9, weight: .medium, design: .monospaced))
            .kerning(1.0)
            .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
    }

    /// App-Store-aware empty state. Lists the kinds of devices the current
    /// build CAN surface, so the user knows what to plug in vs. what
    /// requires a different install.
    private var emptyDownstreamPlaceholder: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("no devices connected")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.8))
            #if AGENTDECK_APP_STORE
            Text("App Store build · D200H (USB) · Pixoo (Wi-Fi) · ESP32 (USB serial)")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.55))
            Text("Android / Ulanzi TC001 are unavailable in the App Store build")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.55))
            #else
            Text("D200H · Pixoo · ESP32 serial · ADB (Android / TC001)")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.55))
            #endif
        }
        .padding(.vertical, 4)
    }

    // MARK: - Rate-limit chips (inline under Claude row)

    /// Compact chips for 5h/7d usage. Rendered inline under the Claude row
    /// because Claude is the only provider that reports rate limits today.
    ///
    /// `stale` flag: surfaced prominently because stale usage data is the
    /// single most common source of "the number is wrong" confusion. When
    /// `state.usageStale == true` (bridge hasn't fetched fresh usage for >
    /// 10 min — e.g. API backoff, sandbox OAuth blocked, daemon just woke
    /// from sleep) we show `stale` in the reset slot instead of hiding
    /// reset info silently. Either the chip becomes a loud marker of
    /// "don't trust this yet" or it shows fresh data with a real reset
    /// timer — no silent middle state.
    private var rateLimitChips: [RateChip] {
        var chips: [RateChip] = []
        let isStale = stateHolder.state.usageStale == true
        if let pct = stateHolder.state.fiveHourPercent {
            chips.append(.init(
                label: "5h",
                percent: pct,
                reset: formatResetTime(stateHolder.state.fiveHourResetsAt),
                stale: isStale
            ))
        }
        if let pct = stateHolder.state.sevenDayPercent {
            chips.append(.init(
                label: "7d",
                percent: pct,
                reset: formatResetTime(stateHolder.state.sevenDayResetsAt),
                stale: isStale
            ))
        }
        return chips
    }

    // MARK: - Consumer creatures (session ↔ provider mapping)

    /// Return the agent brand color of every alive session whose model maps
    /// to the given provider. Rendered as dots on the right edge of the
    /// provider row so "who's using Claude right now" is visible at a
    /// glance. De-duped by agentType to avoid two claude sessions eating two
    /// dots on the Claude row.
    private func consumerCreatures(for provider: ProviderKey) -> [ConsumerBadge] {
        var seen = Set<String>()
        var out: [ConsumerBadge] = []
        for session in stateHolder.state.siblingSessions where session.alive {
            let key = Self.providerFor(
                modelName: session.modelName,
                mlxModels: stateHolder.state.mlxModels,
                ollama: stateHolder.state.ollamaStatus
            )
            guard key == provider else { continue }
            let dedupKey = session.agentType ?? session.id
            if seen.contains(dedupKey) { continue }
            seen.insert(dedupKey)
            out.append(ConsumerBadge(
                id: dedupKey,
                color: SessionBrand.color(for: session.agentType)
            ))
        }
        return out
    }

    // MARK: - Provider inference

    enum ProviderKey: Equatable {
        case claude, openclaw, mlx, ollama, unknown
    }

    /// Best-effort mapping from a session's `modelName` to a provider row.
    /// Intentionally conservative — unknowns fall through so we don't
    /// mis-attribute a creature badge to the wrong reef.
    static func providerFor(
        modelName: String?,
        mlxModels: [String],
        ollama: OllamaStatus?
    ) -> ProviderKey {
        guard let raw = modelName?.lowercased(), !raw.isEmpty else { return .unknown }
        if raw.hasPrefix("claude-") || raw.hasPrefix("opus") || raw.hasPrefix("sonnet") || raw.hasPrefix("haiku") {
            return .claude
        }
        if raw.hasPrefix("glm") || raw.contains("qwen-plus") || raw.contains("deepseek") || raw.hasPrefix("z-") {
            return .openclaw
        }
        if raw.hasPrefix("gpt-") || raw.hasPrefix("o1-") || raw.hasPrefix("o3-") {
            return .openclaw
        }
        for m in mlxModels where raw.contains(m.lowercased()) || m.lowercased().contains(raw) {
            return .mlx
        }
        if let ollama, ollama.models.contains(where: { raw.contains($0.name.lowercased()) }) {
            return .ollama
        }
        return .unknown
    }

    // MARK: - Formatting helpers

    /// Human-friendly label for an ESP32 board string coming off the wire
    /// (`DeviceInfoMessage.board`). Unknown or missing boards fall back to
    /// a plain "ESP32" so the row still renders during the ~2s window
    /// before the firmware's first `device_info` frame arrives.
    private func esp32DisplayName(for board: String?) -> String {
        switch board {
        case "ips_35": return "ESP32 · IPS 3.5\""
        case "round_amoled": return "ESP32 · AMOLED"
        case "86box": return "ESP32 · 86box"
        case .some(let b) where !b.isEmpty: return "ESP32 · \(b)"
        default: return "ESP32"
        }
    }

    private func formatShortDate(_ input: String) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed = iso.date(from: input) ?? ISO8601DateFormatter().date(from: input)
        guard let date = parsed else { return input }
        let fmt = DateFormatter()
        fmt.dateFormat = "MMM d"
        return fmt.string(from: date)
    }
}

// MARK: - LED status

/// Four-level LED status shared by upstream and downstream rows. Maps to
/// `TerrariumHUD` palette so the dashboard reads consistently.
enum LEDStatus {
    case ok, warn, error, dim

    var color: Color {
        switch self {
        case .ok:    return TerrariumHUD.ledGreen
        case .warn:  return TerrariumHUD.ledAmber
        case .error: return TerrariumHUD.ledRed
        case .dim:   return TerrariumHUD.subtext.opacity(0.5)
        }
    }

    var glyph: String {
        switch self {
        case .ok, .warn, .error: return "●"
        case .dim:               return "○"
        }
    }
}

// MARK: - Provider row

struct RateChip: Identifiable {
    let id = UUID()
    let label: String
    let percent: Double
    let reset: String?
    /// Data-is-stale marker (derived from `DashboardState.usageStale`).
    /// Renders a loud "stale" tag in place of the reset time and dims the
    /// bar so the user doesn't mistake cached numbers for current ones.
    var stale: Bool = false
}

struct ConsumerBadge: Identifiable {
    let id: String
    let color: Color
}

private struct ProviderRow: View {
    let name: String
    let status: LEDStatus
    let subtitle: String?
    let rateLimits: [RateChip]
    let consumers: [ConsumerBadge]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(status.glyph)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(status.color)
                Text(name)
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
                Spacer(minLength: 4)
                ForEach(consumers.prefix(3)) { badge in
                    Circle()
                        .fill(badge.color)
                        .frame(width: 7, height: 7)
                        .overlay(
                            Circle()
                                .stroke(Color.black.opacity(0.35), lineWidth: 0.5)
                        )
                }
                if consumers.count > 3 {
                    Text("+\(consumers.count - 3)")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext)
                }
            }
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 14)
            }
            if !rateLimits.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(rateLimits) { chip in
                        RateChipView(chip: chip)
                    }
                }
                .padding(.leading, 14)
                .padding(.top, 2)
            }
        }
    }
}

private struct RateChipView: View {
    let chip: RateChip

    private var fillColor: Color {
        if chip.percent >= 90 { return TerrariumHUD.ledRed }
        if chip.percent >= 70 { return TerrariumHUD.ledAmber }
        return TerrariumHUD.ledGreen
    }

    /// Visual opacity — dimmed when the underlying data is marked stale
    /// so the row reads as "don't trust this yet" without user having to
    /// decode the text tag.
    private var barOpacity: Double {
        chip.stale ? 0.35 : 0.65
    }

    /// The rightmost slot shows either the live reset countdown or a
    /// "stale" marker when the data is known to be out of date. Cannot be
    /// both — if data is stale the reset timestamp is almost certainly
    /// stale too, so showing both would be double-noise.
    @ViewBuilder
    private var rightSlot: some View {
        if chip.stale {
            Text("stale")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.ledAmber)
                .frame(width: 42, alignment: .trailing)
        } else if let reset = chip.reset {
            Text(reset)
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.75))
                .frame(width: 42, alignment: .trailing)
        } else {
            // Reset timestamp parses to "past-grace" (> 1h after the
            // stored reset). Treat it as a data-staleness signal too —
            // the bridge hasn't caught up with the new window yet.
            Text("—")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.4))
                .frame(width: 42, alignment: .trailing)
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(chip.label)
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext)
                .frame(width: 16, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.white.opacity(0.10))
                    RoundedRectangle(cornerRadius: 2)
                        .fill(fillColor.opacity(barOpacity))
                        .frame(width: max(0, min(1, chip.percent / 100)) * geo.size.width)
                }
            }
            .frame(height: 5)

            Text("\(Int(chip.percent))%")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(chip.stale ? TerrariumHUD.subtext : fillColor)
                .frame(width: 32, alignment: .trailing)

            rightSlot
        }
    }
}

// MARK: - Device row

private struct DeviceRailRow: View {
    let name: String
    let status: LEDStatus
    let detail: String

    var body: some View {
        HStack(spacing: 6) {
            Text(status.glyph)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(status.color)
            Text(name)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.text)
                .frame(minWidth: 60, alignment: .leading)
            Text(detail)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
    }
}
