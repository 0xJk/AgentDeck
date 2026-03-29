#if os(macOS)
// PixooRenderer.swift — State → 64x64 RGB pixel frame for Pixoo64
// Ported from bridge/src/pixoo/pixoo-renderer.ts (core rendering)

import Foundation

/// Renders daemon state to a 64x64 RGB pixel buffer for Pixoo64 LED matrix.
enum PixooRenderer {
    static let width = 64
    static let height = 64
    static let pixelCount = width * height

    // Colors (RGB)
    static let bgColor: (UInt8, UInt8, UInt8) = (15, 23, 42)       // #0f172a
    static let textColor: (UInt8, UInt8, UInt8) = (148, 163, 184)   // #94a3b8
    static let accentIdle: (UInt8, UInt8, UInt8) = (34, 197, 94)    // green
    static let accentProcessing: (UInt8, UInt8, UInt8) = (59, 130, 246) // blue
    static let accentAwaiting: (UInt8, UInt8, UInt8) = (234, 179, 8)    // amber
    static let accentError: (UInt8, UInt8, UInt8) = (239, 68, 68)       // red

    /// Render a full frame from daemon state
    static func render(state: String, projectName: String?, modelName: String?,
                       currentTool: String?, sessions: [[String: Any]],
                       fiveHourPercent: Double?, sevenDayPercent: Double?) -> Data {
        var pixels = [UInt8](repeating: 0, count: pixelCount * 3)

        // Fill background
        for i in 0..<pixelCount {
            pixels[i * 3] = bgColor.0
            pixels[i * 3 + 1] = bgColor.1
            pixels[i * 3 + 2] = bgColor.2
        }

        // Status accent bar (top 2 rows)
        let accent = accentForState(state)
        for y in 0..<2 {
            for x in 0..<width {
                setPixel(&pixels, x: x, y: y, color: accent)
            }
        }

        // Project name (simplified 3x5 font, top area)
        if let name = projectName {
            drawText(&pixels, text: String(name.prefix(10)), x: 2, y: 4, color: textColor)
        }

        // State indicator (middle area)
        drawText(&pixels, text: stateLabel(state), x: 2, y: 12, color: accent)

        // Model name
        if let model = modelName {
            let short = model.replacingOccurrences(of: "Claude ", with: "")
            drawText(&pixels, text: String(short.prefix(10)), x: 2, y: 20, color: textColor)
        }

        // Current tool
        if let tool = currentTool {
            drawText(&pixels, text: String(tool.prefix(10)), x: 2, y: 28, color: (100, 116, 139))
        }

        // Usage gauges (bottom area)
        if let pct5h = fiveHourPercent {
            drawGauge(&pixels, y: 40, percent: pct5h, label: "5h", color: gaugeColor(pct5h))
        }
        if let pct7d = sevenDayPercent {
            drawGauge(&pixels, y: 48, percent: pct7d, label: "7d", color: gaugeColor(pct7d))
        }

        // Session count (bottom-right)
        let sessionCount = sessions.filter { $0["alive"] as? Bool == true }.count
        if sessionCount > 0 {
            drawText(&pixels, text: "\(sessionCount)s", x: 52, y: 56, color: textColor)
        }

        // Bottom accent bar
        for y in (height - 2)..<height {
            for x in 0..<width {
                setPixel(&pixels, x: x, y: y, color: accent)
            }
        }

        return Data(pixels)
    }

    /// Convert RGB pixel data to base64 string for Pixoo HTTP API
    static func pixelsToBase64(_ pixels: Data) -> String {
        pixels.base64EncodedString()
    }

    // MARK: - Pixel Helpers

    private static func setPixel(_ pixels: inout [UInt8], x: Int, y: Int, color: (UInt8, UInt8, UInt8)) {
        guard x >= 0 && x < width && y >= 0 && y < height else { return }
        let idx = (y * width + x) * 3
        pixels[idx] = color.0
        pixels[idx + 1] = color.1
        pixels[idx + 2] = color.2
    }

    // MARK: - Simplified 3x5 Pixel Font

    private static func drawText(_ pixels: inout [UInt8], text: String, x: Int, y: Int,
                                  color: (UInt8, UInt8, UInt8)) {
        var cx = x
        for char in text.lowercased() {
            if let glyph = font3x5[char] {
                for (row, bits) in glyph.enumerated() {
                    for col in 0..<3 {
                        if bits & (1 << (2 - col)) != 0 {
                            setPixel(&pixels, x: cx + col, y: y + row, color: color)
                        }
                    }
                }
                cx += 4 // 3px char + 1px gap
            } else {
                cx += 4
            }
        }
    }

    // 3x5 font bitmaps (3 bits per row, MSB=left)
    private static let font3x5: [Character: [UInt8]] = [
        "a": [0b010, 0b101, 0b111, 0b101, 0b101],
        "b": [0b110, 0b101, 0b110, 0b101, 0b110],
        "c": [0b011, 0b100, 0b100, 0b100, 0b011],
        "d": [0b110, 0b101, 0b101, 0b101, 0b110],
        "e": [0b111, 0b100, 0b110, 0b100, 0b111],
        "f": [0b111, 0b100, 0b110, 0b100, 0b100],
        "g": [0b011, 0b100, 0b101, 0b101, 0b011],
        "h": [0b101, 0b101, 0b111, 0b101, 0b101],
        "i": [0b111, 0b010, 0b010, 0b010, 0b111],
        "j": [0b001, 0b001, 0b001, 0b101, 0b010],
        "k": [0b101, 0b110, 0b100, 0b110, 0b101],
        "l": [0b100, 0b100, 0b100, 0b100, 0b111],
        "m": [0b101, 0b111, 0b111, 0b101, 0b101],
        "n": [0b101, 0b111, 0b111, 0b101, 0b101],
        "o": [0b010, 0b101, 0b101, 0b101, 0b010],
        "p": [0b110, 0b101, 0b110, 0b100, 0b100],
        "q": [0b010, 0b101, 0b101, 0b011, 0b001],
        "r": [0b110, 0b101, 0b110, 0b101, 0b101],
        "s": [0b011, 0b100, 0b010, 0b001, 0b110],
        "t": [0b111, 0b010, 0b010, 0b010, 0b010],
        "u": [0b101, 0b101, 0b101, 0b101, 0b010],
        "v": [0b101, 0b101, 0b101, 0b010, 0b010],
        "w": [0b101, 0b101, 0b111, 0b111, 0b101],
        "x": [0b101, 0b101, 0b010, 0b101, 0b101],
        "y": [0b101, 0b101, 0b010, 0b010, 0b010],
        "z": [0b111, 0b001, 0b010, 0b100, 0b111],
        "0": [0b010, 0b101, 0b101, 0b101, 0b010],
        "1": [0b010, 0b110, 0b010, 0b010, 0b111],
        "2": [0b110, 0b001, 0b010, 0b100, 0b111],
        "3": [0b110, 0b001, 0b010, 0b001, 0b110],
        "4": [0b101, 0b101, 0b111, 0b001, 0b001],
        "5": [0b111, 0b100, 0b110, 0b001, 0b110],
        "6": [0b011, 0b100, 0b110, 0b101, 0b010],
        "7": [0b111, 0b001, 0b010, 0b100, 0b100],
        "8": [0b010, 0b101, 0b010, 0b101, 0b010],
        "9": [0b010, 0b101, 0b011, 0b001, 0b110],
        " ": [0b000, 0b000, 0b000, 0b000, 0b000],
        ".": [0b000, 0b000, 0b000, 0b000, 0b010],
        "-": [0b000, 0b000, 0b111, 0b000, 0b000],
        "%": [0b101, 0b001, 0b010, 0b100, 0b101],
    ]

    // MARK: - Gauges

    private static func drawGauge(_ pixels: inout [UInt8], y: Int, percent: Double,
                                   label: String, color: (UInt8, UInt8, UInt8)) {
        // Label (2 chars)
        drawText(&pixels, text: label, x: 2, y: y, color: textColor)

        // Bar background
        let barX = 14
        let barWidth = 46
        let barHeight = 5
        for by in y..<(y + barHeight) {
            for bx in barX..<(barX + barWidth) {
                setPixel(&pixels, x: bx, y: by, color: (30, 41, 59))
            }
        }

        // Bar fill
        let fillWidth = Int(Double(barWidth) * min(1, max(0, percent / 100)))
        for by in y..<(y + barHeight) {
            for bx in barX..<(barX + fillWidth) {
                setPixel(&pixels, x: bx, y: by, color: color)
            }
        }
    }

    private static func gaugeColor(_ percent: Double) -> (UInt8, UInt8, UInt8) {
        if percent >= 90 { return (239, 68, 68) }      // red
        if percent >= 70 { return (234, 179, 8) }       // amber
        return (34, 197, 94)                              // green
    }

    // MARK: - State Helpers

    private static func accentForState(_ state: String) -> (UInt8, UInt8, UInt8) {
        switch state {
        case "idle": return accentIdle
        case "processing": return accentProcessing
        case "awaiting_permission", "awaiting_option", "awaiting_diff": return accentAwaiting
        case "disconnected": return accentError
        default: return textColor
        }
    }

    private static func stateLabel(_ state: String) -> String {
        switch state {
        case "idle": return "idle"
        case "processing": return "working"
        case "awaiting_permission": return "permit?"
        case "awaiting_option": return "select?"
        case "awaiting_diff": return "diff?"
        case "disconnected": return "off"
        default: return state
        }
    }
}
#endif
