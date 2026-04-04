// StatusBadge.swift — State indicator badge

import SwiftUI

struct StatusBadge: View {
    let state: AgentConnectionState

    // Canonical palette from shared/src/state-colors.ts
    private var color: Color {
        switch state {
        case .disconnected: Color(red: 0.42, green: 0.45, blue: 0.50)  // #6b7280 gray
        case .idle: .green                                               // #22c55e
        case .processing: Color(red: 0.23, green: 0.51, blue: 0.96)    // #3b82f6 blue
        case .awaitingPermission: Color(red: 0.96, green: 0.62, blue: 0.04)  // #f59e0b amber
        case .awaitingOption: Color(red: 0.96, green: 0.62, blue: 0.04)      // #f59e0b amber
        case .awaitingDiff: Color(red: 0.96, green: 0.62, blue: 0.04)        // #f59e0b amber
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(state.displayLabel)
                .font(.caption.bold())
                .foregroundStyle(color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(color.opacity(0.15), in: Capsule())
    }
}
