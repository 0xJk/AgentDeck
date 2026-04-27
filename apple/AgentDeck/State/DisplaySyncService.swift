// DisplaySyncService.swift — Sync device brightness with host Mac display sleep/wake
//
// When the Mac display sleeps (hostDisplayOn=false), dims the device screen.
// When it wakes (hostDisplayOn=true), restores the previous brightness.
// Safety: auto-restores after timeout to prevent permanently dimmed screen.

import Foundation
import Combine
#if canImport(UIKit)
import UIKit
#endif

final class DisplaySyncService: ObservableObject, @unchecked Sendable {
    @Published var enabled = true

    #if os(iOS)
    private var savedBrightness: CGFloat?
    private var pendingDim = false
    private var dimTimer: Timer?
    /// Maximum time to keep screen dimmed (safety net — prevents stuck dim)
    private static let maxDimDuration: TimeInterval = 300  // 5 minutes
    #endif

    /// Call when hostDisplayOn changes
    func handleDisplayState(displayOn: Bool) {
        guard enabled else { return }

        #if os(iOS)
        Task { @MainActor [weak self] in
            self?.applyDisplayState(displayOn: displayOn)
        }
        #endif
    }

    #if os(iOS)
    /// Call when app returns to foreground
    func handleForegroundReturn(hostDisplayOn: Bool) {
        guard enabled else { return }
        Task { @MainActor [weak self] in
            self?.applyForegroundReturn(hostDisplayOn: hostDisplayOn)
        }
    }

    /// Restore brightness on disconnect (safety net)
    func restoreOnDisconnect() {
        Task { @MainActor [weak self] in
            self?.cancelDimTimer()
            self?.pendingDim = false
            self?.restoreBrightness()
        }
    }

    @MainActor
    private func applyDisplayState(displayOn: Bool) {
        if !displayOn {
            let current = UIScreen.main.brightness
            // Don't save if already dimmed (avoid saving 0.0 as the "original")
            if current > 0.01 {
                savedBrightness = current
            }
            UIScreen.main.brightness = 0.0
            pendingDim = false
            startDimTimer()
        } else {
            cancelDimTimer()
            pendingDim = false
            restoreBrightness()
        }
    }

    @MainActor
    private func applyForegroundReturn(hostDisplayOn: Bool) {
        if pendingDim && !hostDisplayOn {
            let current = UIScreen.main.brightness
            if current > 0.01 {
                savedBrightness = current
            }
            UIScreen.main.brightness = 0.0
            pendingDim = false
            startDimTimer()
        }
    }

    @MainActor
    private func restoreBrightness() {
        if let saved = savedBrightness {
            UIScreen.main.brightness = saved
            savedBrightness = nil
        }
    }

    /// Safety timer — auto-restore brightness after maxDimDuration
    @MainActor
    private func startDimTimer() {
        cancelDimTimer()
        dimTimer = Timer.scheduledTimer(withTimeInterval: Self.maxDimDuration, repeats: false) { [weak self] _ in
            print("[DisplaySync] safety timeout — restoring brightness")
            Task { @MainActor in
                self?.restoreBrightness()
            }
        }
    }

    @MainActor
    private func cancelDimTimer() {
        dimTimer?.invalidate()
        dimTimer = nil
    }
    #endif
}
