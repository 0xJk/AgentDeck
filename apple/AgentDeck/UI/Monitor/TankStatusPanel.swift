// TankStatusPanel.swift — Rate limits + models panel (matches Android EnginePanel.kt)

import SwiftUI

struct TankStatusPanel: View {
    @Environment(AgentStateHolder.self) private var stateHolder

    var body: some View {
        let staleSuffix = stateHolder.state.usageStale == true ? " !" : ""

        VStack(alignment: .leading, spacing: 4) {
            // Header (13sp bold mono)
            Text("∿ TANK STATUS")
                .font(.system(size: 13, weight: .bold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext)

            // Water Gauges: 5h + 7d side by side
            if stateHolder.state.fiveHourPercent != nil || stateHolder.state.sevenDayPercent != nil {
                HStack {
                    Spacer()
                    if let pct = stateHolder.state.fiveHourPercent {
                        WaterGauge(label: "5h\(staleSuffix)", percent: pct,
                                   resetTime: formatResetTime(stateHolder.state.fiveHourResetsAt))
                    }
                    if let pct = stateHolder.state.sevenDayPercent {
                        WaterGauge(label: "7d\(staleSuffix)", percent: pct,
                                   resetTime: formatResetTime(stateHolder.state.sevenDayResetsAt))
                    }
                    Spacer()
                }
            }

            // MODEL section
            if stateHolder.state.modelName != nil || !stateHolder.state.modelCatalog.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("MODELS")
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext)

                    if let model = stateHolder.state.modelName {
                        Text(model)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundStyle(TerrariumHUD.text)
                    }

                    let otherModels = stateHolder.state.modelCatalog
                        .filter { $0.available && $0.name != stateHolder.state.modelName }
                        .map(\.name)
                    if !otherModels.isEmpty {
                        Text(otherModels.joined(separator: " · "))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(TerrariumHUD.subtext)
                    }
                }
            }

            // OLLAMA section
            if let ollama = stateHolder.state.ollamaStatus, ollama.available, !ollama.models.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("OLLAMA")
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext)

                    ForEach(ollama.models, id: \.name) { model in
                        let vram = model.sizeVram > 0 ? model.sizeVram : model.size
                        let vramText = vram > 0 ? " \(formatBytes(vram))" : ""
                        HStack(spacing: 3) {
                            Circle()
                                .fill(TerrariumHUD.ledGreen)
                                .frame(width: 6, height: 6)
                            Text("\(model.name)\(vramText)")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(TerrariumHUD.text)
                        }
                    }
                }
            }

            // Connection dots (7dp, matches Android)
            HStack(spacing: 8) {
                if let oauth = stateHolder.state.oauthConnected {
                    HStack(spacing: 3) {
                        Circle()
                            .fill(oauth ? TerrariumHUD.ledGreen : TerrariumHUD.ledRed.opacity(0.6))
                            .frame(width: 7, height: 7)
                        Text("OAuth")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(TerrariumHUD.subtext)
                    }
                }

                HStack(spacing: 3) {
                    Circle()
                        .fill(stateHolder.state.ollamaStatus?.available == true
                              ? TerrariumHUD.ledGreen : TerrariumHUD.subtext.opacity(0.4))
                        .frame(width: 7, height: 7)
                    Text("Ollama")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext)
                }
            }
        }
        .padding(10)
        .background(TerrariumHUD.bg, in: RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Water Gauge (76×76, label on top, matches Android)

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
            // Label on top (12sp bold mono — matches Android)
            Text(label)
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext)

            // Glass container (76×76)
            ZStack(alignment: .center) {
                // Container bg
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.white.opacity(0.12))
                    .frame(width: 76, height: 76)

                // Water fill (bottom-up)
                VStack(spacing: 0) {
                    Spacer()
                    Rectangle()
                        .fill(fillColor.opacity(0.5))
                        .frame(height: 68 * min(percent / 100, 1))
                }
                .frame(width: 68, height: 68)
                .clipShape(RoundedRectangle(cornerRadius: 4))

                // Percent text (18sp bold mono + %)
                Text("\(Int(percent))%")
                    .font(.system(size: 18, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
            }
            .frame(width: 76, height: 76)

            // Reset time (11sp)
            if let reset = resetTime {
                Text("⟲ \(reset)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
            }
        }
    }
}
