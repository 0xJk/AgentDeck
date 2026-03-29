#if os(macOS)
// DisplayMonitor.swift — macOS display sleep/wake detection
// Replaces bridge/src/display-monitor.ts (python3 CoreGraphics → native Swift)

import Foundation
import CoreGraphics

/// Monitors display sleep/wake state using native CoreGraphics API.
/// No python3 dependency.
actor DisplayMonitor {
    private var isDisplayOn = true
    private var pollTask: Task<Void, Never>?
    private var _onStateChanged: (@Sendable (Bool) -> Void)?

    func setOnStateChanged(_ handler: @escaping @Sendable (Bool) -> Void) {
        _onStateChanged = handler
    }

    func start() {
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await self?.checkDisplayState()
            }
        }
        DaemonLogger.shared.debug("Display", "Monitor started (native CoreGraphics)")
    }

    func stop() {
        pollTask?.cancel()
    }

    var displayOn: Bool { isDisplayOn }

    private func checkDisplayState() {
        let mainDisplay = CGMainDisplayID()
        let isAsleep = CGDisplayIsAsleep(mainDisplay) != 0
        let newState = !isAsleep

        if newState != isDisplayOn {
            isDisplayOn = newState
            DaemonLogger.shared.debug("Display", "State changed: \(newState ? "ON" : "OFF")")
            _onStateChanged?(newState)
        }
    }
}
#endif
