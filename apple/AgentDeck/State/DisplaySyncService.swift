// DisplaySyncService.swift — Sync device brightness with host Mac display sleep/wake
//
// When the Mac display sleeps (hostDisplayOn=false), dims the device screen.
// When it wakes (hostDisplayOn=true), restores the previous brightness.

import Foundation
#if canImport(UIKit)
import UIKit
#endif

@Observable
final class DisplaySyncService {
    var enabled = true

    #if os(iOS)
    private var savedBrightness: CGFloat?
    private var pendingDim = false
    #endif

    /// Call when hostDisplayOn changes
    func handleDisplayState(displayOn: Bool, isAppActive: Bool) {
        guard enabled else { return }

        #if os(iOS)
        if !displayOn {
            if isAppActive {
                // App is foreground — dim immediately
                savedBrightness = UIScreen.main.brightness
                UIScreen.main.brightness = 0.0
                pendingDim = false
            } else {
                // App is backgrounded — queue dim for when we return
                pendingDim = true
            }
        } else {
            pendingDim = false
            if let saved = savedBrightness {
                UIScreen.main.brightness = saved
                savedBrightness = nil
            }
        }
        #endif
        // macOS: no system brightness API for third-party apps.
        // The host Mac is the one sleeping anyway — no action needed.
    }

    #if os(iOS)
    /// Call when app returns to foreground
    func handleForegroundReturn(hostDisplayOn: Bool) {
        guard enabled else { return }
        if pendingDim && !hostDisplayOn {
            savedBrightness = UIScreen.main.brightness
            UIScreen.main.brightness = 0.0
            pendingDim = false
        }
    }

    /// Restore brightness on disconnect (safety net)
    func restoreOnDisconnect() {
        pendingDim = false
        if let saved = savedBrightness {
            UIScreen.main.brightness = saved
            savedBrightness = nil
        }
    }
    #endif
}
