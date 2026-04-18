// TankStatusPanel.swift — Rate limits + model/runtime subscriptions panel

import SwiftUI

struct TankStatusPanel: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences

    var body: some View {
        let staleSuffix = stateHolder.state.usageStale == true ? " !" : ""

        VStack(alignment: .leading, spacing: 6) {
            Text("∿ TANK STATUS")
                .font(.system(size: 13, weight: .bold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext)

            if stateHolder.state.fiveHourPercent != nil || stateHolder.state.sevenDayPercent != nil {
                HStack {
                    Spacer()
                    if let pct = stateHolder.state.fiveHourPercent {
                        WaterGauge(
                            label: "5h\(staleSuffix)",
                            percent: pct,
                            resetTime: formatResetTime(stateHolder.state.fiveHourResetsAt)
                        )
                    }
                    if let pct = stateHolder.state.sevenDayPercent {
                        WaterGauge(
                            label: "7d\(staleSuffix)",
                            percent: pct,
                            resetTime: formatResetTime(stateHolder.state.sevenDayResetsAt)
                        )
                    }
                    Spacer()
                }
            }

            EngineSection(
                title: "OpenClaw",
                lines: preferences.showOpenClawSection ? openClawLines : [],
                highlightedLine: preferences.showOpenClawSection ? openClawPrimaryLine : nil
            )
            EngineSection(title: "MLX", lines: preferences.showMLXSection ? mlxLines : [])
            EngineSection(title: "OLLAMA", lines: preferences.showOllamaSection ? ollamaLines : [])
            EngineSection(title: "Antigravity", lines: preferences.showAntigravitySection ? antigravityLines : [])
            EngineSection(title: "Subscriptions", lines: preferences.showSubscriptionsSection ? subscriptionLines : [])
        }
        .padding(10)
        .background(TerrariumHUD.bg, in: RoundedRectangle(cornerRadius: 8))
        .opacity(stateHolder.state.bridgeConnected ? 1.0 : 0.6)
    }

    private var openClawLines: [String] {
        let catalogLines = DashboardDataRules.openClawDisplayLines(stateHolder.state.modelCatalog)
        if !catalogLines.isEmpty { return catalogLines }
        guard stateHolder.state.gatewayAvailable else { return [] }
        if stateHolder.state.gatewayHasError { return ["Gateway error"] }
        if !stateHolder.state.gatewayConnected {
            switch stateHolder.state.gatewayAuthStatus {
            case "approval_pending":
                return ["Approval pending", "Approve in OpenClaw"]
            case "pairing_required":
                return ["Pairing required", "Run openclaw devices list"]
            case "auth_failed", "token_mismatch", "device_auth_invalid":
                return ["Auth failed", "Re-approve AgentDeck"]
            case "unsupported_protocol":
                return ["Unsupported Gateway", "Update OpenClaw"]
            default:
                return ["Gateway reachable", "Waiting for OpenClaw pairing"]
            }
        }
        return ["Connected", "Waiting for model catalog"]
    }

    private var ollamaLines: [String] {
        guard let ollama = stateHolder.state.ollamaStatus, ollama.available else { return [] }
        let running = ollama.models.filter { $0.sizeVram > 0 }
        let source = running.isEmpty ? ollama.models : running
        let names = source.map { model in
            let bytes = model.sizeVram > 0 ? model.sizeVram : model.size
            let suffix = bytes > 0 ? " \(formatBytes(bytes))" : ""
            return "\(model.name)\(suffix)"
        }
        return names.isEmpty ? [] : [names.joined(separator: ", ")]
    }

    private var mlxLines: [String] {
        stateHolder.state.mlxModels.isEmpty ? [] : stateHolder.state.mlxModels
    }

    private var subscriptionLines: [String] {
        stateHolder.state.subscriptions.map { item in
            if let until = formatSubscriptionDate(item.until) {
                return "\(item.name) · \(until)"
            }
            return item.name
        }
    }

    private var antigravityLines: [String] {
        guard let status = stateHolder.state.antigravityStatus else { return [] }
        guard let planName = status.planName, !planName.isEmpty else { return [] }
        return [planName]
    }

    private var openClawPrimaryLine: String? {
        DashboardDataRules.openClawDisplayLines(stateHolder.state.modelCatalog).first
    }
}

private struct EngineSection: View {
    let title: String
    let lines: [String]
    var highlightedLine: String? = nil

    var body: some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)

                ForEach(lines, id: \.self) { line in
                    Text(line)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(line == highlightedLine ? TerrariumHUD.ledAmber : TerrariumHUD.text)
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
            }
            .padding(.top, 2)
        }
    }
}

struct WaterGauge: View {
    let label: String
    let percent: Double
    var resetTime: String? = nil

    private var fillColor: Color {
        if percent >= 90 { return TerrariumHUD.ledRed }
        if percent >= 70 { return TerrariumHUD.ledAmber }
        return TerrariumHUD.ledGreen
    }

    var body: some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext)

            ZStack(alignment: .center) {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.white.opacity(0.12))
                    .frame(width: 76, height: 76)

                VStack(spacing: 0) {
                    Spacer()
                    Rectangle()
                        .fill(fillColor.opacity(0.5))
                        .frame(height: 68 * min(percent / 100, 1))
                }
                .frame(width: 68, height: 68)
                .clipShape(RoundedRectangle(cornerRadius: 4))

                Text("\(Int(percent))%")
                    .font(.system(size: 18, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
            }
            .frame(width: 76, height: 76)

            if let reset = resetTime {
                Text("⟲ \(reset)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
            }
        }
    }
}

private func formatSubscriptionDate(_ iso: String?) -> String? {
    guard let iso, !iso.isEmpty else { return nil }

    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]

    guard let date = fractional.date(from: iso) ?? plain.date(from: iso) else {
        return iso
    }

    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
}
