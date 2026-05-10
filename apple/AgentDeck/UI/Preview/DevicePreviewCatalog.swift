// DevicePreviewCatalog.swift — enum of previewable device types + the view factory.
//
// Device Preview lets users see what AgentDeck looks like on each supported
// device without owning the hardware. The full catalog has 16 representative
// entries; the standalone App Store app shows the 12 entries it can drive
// without an external desktop bridge, and the 4 ADB-tier entries reappear
// automatically when such a bridge is connected.
//
// We intentionally merged the two Apple Watch sizes (46mm / 42mm) into a single
// `appleWatch` entry. The device mockup respects `selection.sessionCount` but
// does not distinguish the 4mm rim difference — users evaluating sizing should
// rely on Apple's Watch simulator, not on this preview.

import SwiftUI

/// A single previewable device. `rawValue` is the stable UI id; `displayName`
/// is what appears in the sidebar.
enum PreviewDevice: String, CaseIterable, Identifiable {
    case streamDeckKey
    case streamDeckPlus
    case d200hKey
    case d200hDeck
    case appleWatch
    case iPadLandscape
    case androidTablet
    case einkMono
    case einkColor
    case esp32_86box
    case esp32_35Landscape
    case esp32_35Portrait
    case esp32Round
    case ulanziMatrix
    case pixoo64
    case terminalTerrarium

    var id: String { rawValue }

    enum Category: String, CaseIterable, Identifiable {
        case desk, wearable, tablet, eink, esp32, matrix, terminal

        var id: String { rawValue }

        var displayName: String {
            switch self {
            case .desk:     return "Desk"
            case .wearable: return "Wearable"
            case .tablet:   return "Tablet"
            case .eink:     return "E-ink"
            case .esp32:    return "ESP32"
            case .matrix:   return "Matrix"
            case .terminal: return "Terminal"
            }
        }
    }

    var category: Category {
        switch self {
        case .streamDeckKey, .streamDeckPlus, .d200hKey, .d200hDeck:            return .desk
        case .appleWatch:                                        return .wearable
        case .iPadLandscape, .androidTablet:                     return .tablet
        case .einkMono, .einkColor:                              return .eink
        case .esp32_86box, .esp32_35Landscape,
             .esp32_35Portrait, .esp32Round:                     return .esp32
        case .ulanziMatrix, .pixoo64:                                    return .matrix
        case .terminalTerrarium:                                 return .terminal
        }
    }

    var displayName: String {
        switch self {
        case .streamDeckKey:      return "Stream Deck Key"
        case .streamDeckPlus:     return "Stream Deck+ Session"
        case .d200hKey:           return "Ulanzi D200H Key"
        case .d200hDeck:          return "Ulanzi D200H Deck"
        case .appleWatch:         return "Apple Watch Series 11"
        case .iPadLandscape:      return "iPad (Landscape)"
        case .androidTablet:      return "Android Tablet"
        case .einkMono:           return "E-ink Mono (CremaS)"
        case .einkColor:          return "E-ink Color (Pantone6)"
        case .esp32_86box:        return "ESP32 86Box 1.28\""
        case .esp32_35Landscape:  return "ESP32 IPS 3.5\" Landscape"
        case .esp32_35Portrait:   return "ESP32 IPS 3.5\" Portrait"
        case .esp32Round:         return "ESP32 Round AMOLED 1.6\""
        case .ulanziMatrix:       return "Ulanzi TC001 Matrix"
        case .pixoo64:            return "Pixoo 64"
        case .terminalTerrarium:  return "Terminal Terrarium (TUI)"
        }
    }

    /// True when the device only reaches AgentDeck through an external
    /// desktop bridge (ADB-tunneled). The standalone app hides these
    /// from the picker so the catalog matches what it can actually drive
    /// — they reappear automatically once the bridge is connected.
    var requiresDesktopBridge: Bool {
        switch self {
        case .androidTablet, .einkMono, .einkColor, .ulanziMatrix: return true
        default: return false
        }
    }

    /// Short byline for the main-canvas header.
    var byline: String {
        switch self {
        case .streamDeckKey:      return "72×72 default Stream Deck key."
        case .streamDeckPlus:     return "144×144 session button, driven by the plugin."
        case .d200hKey:           return "One of 14 HID-addressed key tiles, 120×120."
        case .d200hDeck:          return "Full 14-key deck — top strip + 3×4 grid + encoders."
        case .appleWatch:         return "Complication-sized creature + state glyph."
        case .iPadLandscape:      return "Dashboard-style aquarium — sidebar + terrarium + HUD."
        case .androidTablet:      return "Compose canvas (Lenovo / generic tablet)."
        case .einkMono:           return "Dithered silhouette + name tag. Kobo / CremaS."
        case .einkColor:          return "Pantone6 colour e-ink — brand-tinted creature."
        case .esp32_86box:        return "1.28\" round LCD — creature + 2-line HUD."
        case .esp32_35Landscape:  return "3.5\" IPS landscape — wide canvas, LVGL."
        case .esp32_35Portrait:   return "3.5\" IPS portrait — split HUD + creature."
        case .esp32Round:         return "1.6\" round AMOLED — dial-style HUD."
        case .ulanziMatrix:       return "8×32 WS2812B matrix — ultra-minimal HUD."
        case .pixoo64:            return "64×64 pixel art canvas, dot-matrix simplified."
        case .terminalTerrarium:  return "agentdeck dashboard TUI — characters-only aquarium."
        }
    }
}

// MARK: - Selection value object

/// The toolbar picker state plus which device is being shown.
struct DevicePreviewSelection {
    var agent: PixooPreviewAgent
    var state: PixooPreviewState
    /// Must be one of {0, 1, 2, 4}. The screen clamps the picker to this set.
    var sessionCount: Int
    var device: PreviewDevice
    var animationFrame: Int = 0
}
