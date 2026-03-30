// D200hHidModule.swift — Ulanzi D200H HID protocol module (IOKit)
// Communicates via stock HID protocol (VID 0x2207, PID 0x0019).
// No ADB, no firmware modification, no on-device agent.
//
// Ported from bridge/src/d200h/ (hid-protocol.ts + image-renderer.ts + d200h-module.ts)

import Foundation

#if os(macOS)
import IOKit
import IOKit.hid
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// MARK: - HID Protocol Constants

private let D200H_VID: Int32 = 0x2207
private let D200H_PID: Int32 = 0x0019
private let CONSUMER_USAGE_PAGE: Int32 = 12
private let KEYBOARD_USAGE_PAGE: Int32 = 1
private let PACKET_SIZE = 1024
private let ICON_SIZE = 196

private let POLL_INTERVAL: UInt64 = 500_000_000   // 500ms device detection
private let KEEPALIVE_INTERVAL: TimeInterval = 30  // 30s keep-alive

// HID Commands
private let CMD_SET_BUTTONS: UInt16    = 0x0001
private let CMD_SET_SMALL_WINDOW: UInt16 = 0x0006
private let CMD_SET_BRIGHTNESS: UInt16 = 0x000a
private let CMD_IN_BUTTON: UInt16      = 0x0101
private let CMD_IN_DEVICE_INFO: UInt16 = 0x0303

// Button index -> AgentDeck command mapping
private let BUTTON_COMMANDS: [Int: SendableDict] = [
    0: SendableDict(["type": "mode_toggle"]),
    1: SendableDict(["type": "session_switch"]),
    2: SendableDict(["type": "usage_toggle"]),
    3: SendableDict(["type": "select_option", "index": 0]),
    4: SendableDict(["type": "select_option", "index": 1]),
    5: SendableDict(["type": "select_option", "index": 2]),
    6: SendableDict(["type": "select_option", "index": 3]),
    10: SendableDict(["type": "interrupt"]),
]

// MARK: - D200hHidModule

final class D200hHidModule: DeviceModule, @unchecked Sendable {
    let name = "d200h"

    nonisolated(unsafe) var commandHandler: (([String: Any]) -> Void)?

    private var hidManager: IOHIDManager?
    private var consumerDevice: IOHIDDevice?
    private var keyboardDevice: IOHIDDevice?
    private var connected = false
    private var lastStateHash = ""

    private var pollTask: Task<Void, Never>?
    private var keepAliveTask: Task<Void, Never>?

    // Cached state for rendering
    nonisolated(unsafe) private var cachedStateEvent: [String: Any]?
    nonisolated(unsafe) private var cachedUsageEvent: [String: Any]?

    // MARK: - DeviceModule

    func start() async {
        DaemonLogger.shared.info("D200H HID module starting")

        // Create IOHIDManager
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        hidManager = manager

        // Match D200H device (VID/PID)
        let matchDict: [[String: Any]] = [
            [
                kIOHIDVendorIDKey as String: D200H_VID,
                kIOHIDProductIDKey as String: D200H_PID,
            ]
        ]
        IOHIDManagerSetDeviceMatchingMultiple(manager, matchDict as CFArray)

        // Register device attach/remove callbacks
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()

        IOHIDManagerRegisterDeviceMatchingCallback(manager, { context, _, _, device in
            guard let context else { return }
            let module = Unmanaged<D200hHidModule>.fromOpaque(context).takeUnretainedValue()
            module.handleDeviceAttached(device)
        }, selfPtr)

        IOHIDManagerRegisterDeviceRemovalCallback(manager, { context, _, _, device in
            guard let context else { return }
            let module = Unmanaged<D200hHidModule>.fromOpaque(context).takeUnretainedValue()
            module.handleDeviceRemoved(device)
        }, selfPtr)

        // Schedule on main run loop
        IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
        let result = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
        if result != kIOReturnSuccess {
            DaemonLogger.shared.debug("D200H", "IOHIDManager open failed: \(result) — trying without seize")
            // Retry without seize (for Consumer Control which doesn't need exclusive access)
            let result2 = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
            if result2 != kIOReturnSuccess {
                DaemonLogger.shared.debug("D200H", "IOHIDManager open failed: \(result2)")
                return
            }
        }

        // Keep-alive timer
        keepAliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(KEEPALIVE_INTERVAL))
                self?.sendKeepAlive()
            }
        }

        DaemonLogger.shared.info("D200H HID module started — watching for device")
    }

    func stop() async {
        pollTask?.cancel()
        keepAliveTask?.cancel()
        disconnect()

        if let manager = hidManager {
            IOHIDManagerUnscheduleFromRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
            IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        hidManager = nil
        DaemonLogger.shared.debug("D200H", "Module stopped")
    }

    // MARK: - Broadcast Handler

    func handleBroadcast(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        if type == "state_update" {
            cachedStateEvent = event
            updateDisplay()
        } else if type == "usage_update" {
            cachedUsageEvent = event
            updateDisplay()
        }
    }

    // MARK: - Device Attach/Remove (IOKit callbacks, run loop thread)

    private func hidDeviceProperty(_ device: IOHIDDevice, _ key: String) -> Int32? {
        if let val = IOHIDDeviceGetProperty(device, key as CFString) {
            if let num = val as? NSNumber { return num.int32Value }
        }
        return nil
    }

    private func handleDeviceAttached(_ device: IOHIDDevice) {
        let usagePage = hidDeviceProperty(device, kIOHIDPrimaryUsagePageKey) ?? 0

        if usagePage == CONSUMER_USAGE_PAGE {
            consumerDevice = device
            DaemonLogger.shared.info("D200H Consumer Control interface attached")
        } else if usagePage == KEYBOARD_USAGE_PAGE {
            keyboardDevice = device
            DaemonLogger.shared.info("D200H Keyboard interface attached (button events)")

            // Register input report callback for button events
            registerInputCallback(device)
        }

        if consumerDevice != nil {
            if !connected {
                connected = true
                DaemonLogger.shared.info("D200H connected via HID")

                // Set brightness
                writePacket(buildBrightnessPacket(100))

                // Register input callback on consumer device too (for device info responses)
                if let cd = consumerDevice {
                    registerInputCallback(cd)
                }

                // Send current state
                updateDisplay()
            }
        }
    }

    private func handleDeviceRemoved(_ device: IOHIDDevice) {
        if device === consumerDevice {
            consumerDevice = nil
            DaemonLogger.shared.info("D200H Consumer Control interface removed")
        }
        if device === keyboardDevice {
            keyboardDevice = nil
            DaemonLogger.shared.info("D200H Keyboard interface removed")
        }

        if consumerDevice == nil {
            connected = false
            lastStateHash = ""
            DaemonLogger.shared.info("D200H disconnected")
        }
    }

    // MARK: - Input Report (Button Events)

    private func registerInputCallback(_ device: IOHIDDevice) {
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()

        IOHIDDeviceRegisterInputReportCallback(
            device,
            UnsafeMutablePointer<UInt8>.allocate(capacity: PACKET_SIZE),
            PACKET_SIZE,
            { context, _, _, _, _, report, reportLength in
                guard let context else { return }
                let module = Unmanaged<D200hHidModule>.fromOpaque(context).takeUnretainedValue()
                let data = Data(bytes: report, count: reportLength)
                module.handleInputReport(data)
            },
            selfPtr
        )
    }

    private func handleInputReport(_ data: Data) {
        guard data.count >= 8, data[0] == 0x7C, data[1] == 0x7C else { return }

        let command = UInt16(data[2]) << 8 | UInt16(data[3])

        if command == CMD_IN_BUTTON && data.count >= 12 {
            let buttonIndex = Int(data[9])
            let pressed = data[11] == 0x01

            if pressed {
                if let cmd = BUTTON_COMMANDS[buttonIndex] {
                    DaemonLogger.shared.debug("D200H", "Button \(buttonIndex) pressed -> \(cmd.value["type"] ?? "")")
                    commandHandler?(cmd.value)
                } else {
                    DaemonLogger.shared.debug("D200H", "Button \(buttonIndex) pressed (unmapped)")
                }
            }
        } else if command == CMD_IN_DEVICE_INFO {
            if let jsonStr = String(data: data[8...], encoding: .ascii)?.components(separatedBy: "\0").first,
               let jsonData = jsonStr.data(using: .utf8),
               let info = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
                DaemonLogger.shared.debug("D200H", "Device: \(info["DeviceType"] ?? "") fw=\(info["Dversion"] ?? "") hw=\(info["HardwareVersion"] ?? "")")
            }
        }
    }

    // MARK: - Display Update

    private func updateDisplay() {
        guard connected, let stateEvent = cachedStateEvent else { return }

        let state = DashState.parse(stateEvent, usage: cachedUsageEvent)
        let hash = state.hash
        guard hash != lastStateHash else { return }
        lastStateHash = hash

        // Render ZIP and send
        let zip = D200hRenderer.renderDashboardZip(state)
        let packets = buildZipPackets(zip)

        for packet in packets {
            writePacket(packet)
        }

        DaemonLogger.shared.debug("D200H", "Display updated: \(zip.count) bytes, \(packets.count) packets")
    }

    // MARK: - Keep-alive

    private func sendKeepAlive() {
        guard connected else { return }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        let timeStr = formatter.string(from: Date())
        let packet = buildSmallWindowPacket(mode: 1, cpu: 0, mem: 0, time: timeStr, gpu: 0)
        writePacket(packet)
    }

    // MARK: - HID Write

    private func writePacket(_ data: Data) {
        guard let device = consumerDevice else { return }

        // IOKit HID setReport for output
        let result = data.withUnsafeBytes { (ptr: UnsafeRawBufferPointer) -> IOReturn in
            guard let base = ptr.baseAddress else { return kIOReturnBadArgument }
            return IOHIDDeviceSetReport(
                device,
                kIOHIDReportTypeOutput,
                0,  // report ID
                base.assumingMemoryBound(to: UInt8.self),
                data.count
            )
        }

        if result != kIOReturnSuccess && result != kIOReturnUnderrun {
            DaemonLogger.shared.debug("D200H", "Write failed: \(result)")
        }
    }

    private func disconnect() {
        consumerDevice = nil
        keyboardDevice = nil
        connected = false
        lastStateHash = ""
    }
}

// MARK: - HID Packet Building

private func buildPacket(command: UInt16, payload: Data, totalLength: UInt32? = nil) -> Data {
    var pkt = Data(count: PACKET_SIZE)
    // Header
    pkt[0] = 0x7C
    pkt[1] = 0x7C
    // Command (big-endian uint16)
    pkt[2] = UInt8(command >> 8)
    pkt[3] = UInt8(command & 0xFF)
    // Length (little-endian uint32)
    let len = totalLength ?? UInt32(payload.count)
    pkt[4] = UInt8(len & 0xFF)
    pkt[5] = UInt8((len >> 8) & 0xFF)
    pkt[6] = UInt8((len >> 16) & 0xFF)
    pkt[7] = UInt8((len >> 24) & 0xFF)
    // Payload
    let copyLen = min(payload.count, PACKET_SIZE - 8)
    if copyLen > 0 {
        pkt.replaceSubrange(8..<(8 + copyLen), with: payload[0..<copyLen])
    }
    return pkt
}

private func buildZipPackets(_ zipData: Data) -> [Data] {
    var packets: [Data] = []
    let fileSize = UInt32(zipData.count)

    // First packet: header(8) + first chunk
    let firstChunkSize = PACKET_SIZE - 8
    let firstChunk = zipData.prefix(firstChunkSize)
    packets.append(buildPacket(command: CMD_SET_BUTTONS, payload: firstChunk, totalLength: fileSize))

    // Remaining chunks (raw, no header)
    var offset = firstChunkSize
    while offset < zipData.count {
        var chunk = Data(count: PACKET_SIZE)
        let remaining = min(PACKET_SIZE, zipData.count - offset)
        chunk.replaceSubrange(0..<remaining, with: zipData[offset..<(offset + remaining)])
        packets.append(chunk)
        offset += PACKET_SIZE
    }

    return packets
}

private func buildBrightnessPacket(_ brightness: Int) -> Data {
    let val = max(0, min(100, brightness))
    let payload = Data(String(val).utf8)
    return buildPacket(command: CMD_SET_BRIGHTNESS, payload: payload)
}

private func buildSmallWindowPacket(mode: Int, cpu: Int, mem: Int, time: String, gpu: Int) -> Data {
    let str = "\(mode)|\(cpu)|\(mem)|\(time)|\(gpu)"
    return buildPacket(command: CMD_SET_SMALL_WINDOW, payload: Data(str.utf8))
}

// MARK: - Dashboard State

private struct DashState {
    let state: String
    let projectName: String
    let modelName: String
    let mode: String
    let fiveHourPercent: Double
    let sevenDayPercent: Double
    let totalTokens: Int
    let totalCost: Double
    let options: [String]
    let currentTool: String

    var hash: String {
        "\(state)|\(mode)|\(projectName)|\(modelName)|\(Int(fiveHourPercent))|\(Int(sevenDayPercent))|\(totalTokens)|\(totalCost)|\(options.joined(separator: ","))|\(currentTool)"
    }

    static func parse(_ evt: [String: Any], usage: [String: Any]?) -> DashState {
        let options = (evt["options"] as? [[String: Any]])?.compactMap { $0["label"] as? String } ?? []
        return DashState(
            state: (evt["state"] as? String ?? "disconnected").uppercased(),
            projectName: evt["projectName"] as? String ?? "",
            modelName: evt["modelName"] as? String ?? "",
            mode: evt["permissionMode"] as? String ?? "default",
            fiveHourPercent: usage?["fiveHourPercent"] as? Double ?? evt["fiveHourPercent"] as? Double ?? 0,
            sevenDayPercent: usage?["sevenDayPercent"] as? Double ?? evt["sevenDayPercent"] as? Double ?? 0,
            totalTokens: evt["totalTokens"] as? Int ?? 0,
            totalCost: evt["totalCost"] as? Double ?? 0,
            options: options,
            currentTool: evt["currentTool"] as? String ?? ""
        )
    }
}

// MARK: - Dashboard Renderer

private enum D200hRenderer {
    // Colors (RGB)
    static let colorBg: (UInt8, UInt8, UInt8) = (20, 20, 25)
    static let colorIdle: (UInt8, UInt8, UInt8) = (40, 50, 60)
    static let colorProcessing: (UInt8, UInt8, UInt8) = (20, 80, 160)
    static let colorAwaiting: (UInt8, UInt8, UInt8) = (200, 140, 30)
    static let colorError: (UInt8, UInt8, UInt8) = (180, 40, 40)
    static let colorAccent: (UInt8, UInt8, UInt8) = (40, 140, 200)
    static let colorBar5h: (UInt8, UInt8, UInt8) = (40, 160, 180)
    static let colorBar7d: (UInt8, UInt8, UInt8) = (40, 80, 160)
    static let colorStop: (UInt8, UInt8, UInt8) = (200, 50, 50)

    struct KeyDef {
        let id: Int
        let col: Int
        let row: Int
        let label: String
    }

    static let keyDefs: [KeyDef] = [
        KeyDef(id: 0, col: 0, row: 0, label: "MODE"),
        KeyDef(id: 1, col: 1, row: 0, label: "SESSION"),
        KeyDef(id: 2, col: 2, row: 0, label: "USAGE"),
        KeyDef(id: 3, col: 3, row: 0, label: "QA 1"),
        KeyDef(id: 4, col: 4, row: 0, label: "QA 2"),
        KeyDef(id: 5, col: 0, row: 1, label: "QA 3"),
        KeyDef(id: 6, col: 1, row: 1, label: "QA 4"),
        KeyDef(id: 7, col: 2, row: 1, label: "MODEL"),
        KeyDef(id: 8, col: 3, row: 1, label: "5H"),
        KeyDef(id: 9, col: 4, row: 1, label: "7D"),
        KeyDef(id: 10, col: 0, row: 2, label: "STOP"),
        KeyDef(id: 11, col: 1, row: 2, label: "TOKENS"),
        KeyDef(id: 12, col: 2, row: 2, label: "COST"),
    ]

    static func stateColor(_ state: String) -> (UInt8, UInt8, UInt8) {
        switch state {
        case "PROCESSING": return colorProcessing
        case "AWAITING_PERMISSION", "AWAITING_INPUT", "AWAITING_PROMPT": return colorAwaiting
        case "ERROR": return colorError
        default: return colorIdle
        }
    }

    static func renderKeyIcon(_ key: KeyDef, state: DashState) -> (png: Data, label: String) {
        var bgColor: (UInt8, UInt8, UInt8)
        var label = key.label

        switch key.id {
        case 0: // MODE
            bgColor = colorIdle
            label = state.mode.uppercased()
        case 1: // SESSION
            bgColor = stateColor(state.state)
            label = String(state.projectName.prefix(10)).isEmpty ? "SESSION" : String(state.projectName.prefix(10))
        case 2: // USAGE
            bgColor = colorIdle
        case 3, 4, 5, 6: // Quick Actions
            let qaIdx = key.id - 3
            if qaIdx < state.options.count {
                bgColor = colorAccent
                label = String(state.options[qaIdx].prefix(12))
            } else {
                bgColor = colorIdle
            }
        case 7: // MODEL
            bgColor = colorIdle
            label = String(state.modelName.prefix(10)).isEmpty ? "MODEL" : String(state.modelName.prefix(10))
        case 8: // 5H
            bgColor = colorBar5h
            label = "5H \(Int(state.fiveHourPercent))%"
        case 9: // 7D
            bgColor = colorBar7d
            label = "7D \(Int(state.sevenDayPercent))%"
        case 10: // STOP
            bgColor = state.state == "PROCESSING" ? colorStop : colorIdle
        case 11: // TOKENS
            bgColor = colorIdle
            let tk = state.totalTokens > 1000 ? "\(state.totalTokens / 1000)K" : "\(state.totalTokens)"
            label = "TK \(tk)"
        case 12: // COST
            bgColor = colorIdle
            label = String(format: "$%.2f", state.totalCost)
        default:
            bgColor = colorIdle
        }

        let png = createSolidPng(width: ICON_SIZE, height: ICON_SIZE, r: bgColor.0, g: bgColor.1, b: bgColor.2)
        return (png, label)
    }

    /// Render the full dashboard as a ZIP for SET_BUTTONS
    static func renderDashboardZip(_ state: DashState) -> Data {
        var manifest: [String: Any] = [:]
        var files: [(name: String, data: Data)] = []

        for key in keyDefs {
            let (png, label) = renderKeyIcon(key, state: state)
            let iconPath = "icons/btn\(key.id).png"
            let colRow = "\(key.col)_\(key.row)"

            manifest[colRow] = [
                "State": 0,
                "ViewParam": [["Text": label, "Icon": iconPath]],
            ] as [String: Any]

            files.append((iconPath, png))
        }

        // Small window slot (3_2)
        manifest["3_2"] = [
            "Action": "com.ulanzi.ulanzideck.smallwindow.window",
            "ActionParam": [:] as [String: Any],
            "State": 0,
            "ViewParam": [["Text": state.state]],
        ] as [String: Any]

        if let manifestData = try? JSONSerialization.data(withJSONObject: manifest) {
            files.append(("manifest.json", manifestData))
        }

        // Build ZIP with boundary validation
        for attempt in 0..<20 {
            var allFiles = files
            if attempt > 0 {
                let dummy = "AgentDeck " + UUID().uuidString + String(repeating: "x", count: attempt * 8)
                allFiles.append(("dummy.txt", Data(dummy.utf8)))
            }

            let zip = createZipInMemory(allFiles)
            if validateZipBoundaries(zip) {
                return zip
            }
        }

        // Fallback
        return createZipInMemory(files)
    }
}

// MARK: - PNG Generation (Core Graphics)

private func createSolidPng(width: Int, height: Int, r: UInt8, g: UInt8, b: UInt8) -> Data {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil,
        width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { return Data() }

    ctx.setFillColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1.0)
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

    guard let image = ctx.makeImage() else { return Data() }

    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else { return Data() }
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)

    return data as Data
}

// MARK: - ZIP Creation (in-memory, Store compression)

private func createZipInMemory(_ files: [(name: String, data: Data)]) -> Data {
    var localParts = Data()
    var centralDir = Data()
    var offset: UInt32 = 0

    for (name, fileData) in files {
        let nameBytes = Data(name.utf8)
        let crc = crc32(fileData)

        // Local file header (30 + name length)
        var local = Data(count: 30 + nameBytes.count)
        local.writeUInt32LE(0x04034b50, at: 0)  // signature
        local.writeUInt16LE(20, at: 4)            // version needed
        local.writeUInt16LE(0, at: 6)             // flags
        local.writeUInt16LE(0, at: 8)             // compression: store
        local.writeUInt16LE(0, at: 10)            // mod time
        local.writeUInt16LE(0, at: 12)            // mod date
        local.writeUInt32LE(crc, at: 14)
        local.writeUInt32LE(UInt32(fileData.count), at: 18)  // compressed
        local.writeUInt32LE(UInt32(fileData.count), at: 22)  // uncompressed
        local.writeUInt16LE(UInt16(nameBytes.count), at: 26)
        local.writeUInt16LE(0, at: 28)            // extra field
        local.replaceSubrange(30..<(30 + nameBytes.count), with: nameBytes)

        // Central directory header (46 + name length)
        var central = Data(count: 46 + nameBytes.count)
        central.writeUInt32LE(0x02014b50, at: 0)
        central.writeUInt16LE(20, at: 4)
        central.writeUInt16LE(20, at: 6)
        central.writeUInt16LE(0, at: 8)
        central.writeUInt16LE(0, at: 10)
        central.writeUInt16LE(0, at: 12)
        central.writeUInt16LE(0, at: 14)
        central.writeUInt32LE(crc, at: 16)
        central.writeUInt32LE(UInt32(fileData.count), at: 20)
        central.writeUInt32LE(UInt32(fileData.count), at: 24)
        central.writeUInt16LE(UInt16(nameBytes.count), at: 28)
        central.writeUInt16LE(0, at: 30)
        central.writeUInt16LE(0, at: 32)
        central.writeUInt16LE(0, at: 34)
        central.writeUInt16LE(0, at: 36)
        central.writeUInt32LE(0, at: 38)
        central.writeUInt32LE(offset, at: 42)
        central.replaceSubrange(46..<(46 + nameBytes.count), with: nameBytes)

        localParts.append(local)
        localParts.append(fileData)
        centralDir.append(central)
        offset += UInt32(local.count + fileData.count)
    }

    // End of central directory
    var eocd = Data(count: 22)
    eocd.writeUInt32LE(0x06054b50, at: 0)
    eocd.writeUInt16LE(0, at: 4)
    eocd.writeUInt16LE(0, at: 6)
    eocd.writeUInt16LE(UInt16(files.count), at: 8)
    eocd.writeUInt16LE(UInt16(files.count), at: 10)
    eocd.writeUInt32LE(UInt32(centralDir.count), at: 12)
    eocd.writeUInt32LE(offset, at: 16)
    eocd.writeUInt16LE(0, at: 20)

    var result = localParts
    result.append(centralDir)
    result.append(eocd)
    return result
}

/// Validate ZIP boundary bytes (offsets 1016, 2040, 3064... must not be 0x00 or 0x7C)
private func validateZipBoundaries(_ data: Data) -> Bool {
    var i = 1016
    while i < data.count {
        let byte = data[i]
        if byte == 0x00 || byte == 0x7C { return false }
        i += PACKET_SIZE
    }
    return true
}

// MARK: - CRC32

private let crcTable: [UInt32] = {
    var table = [UInt32](repeating: 0, count: 256)
    for n in 0..<256 {
        var c = UInt32(n)
        for _ in 0..<8 {
            if c & 1 != 0 {
                c = 0xEDB88320 ^ (c >> 1)
            } else {
                c = c >> 1
            }
        }
        table[n] = c
    }
    return table
}()

private func crc32(_ data: Data) -> UInt32 {
    var crc: UInt32 = 0xFFFFFFFF
    for byte in data {
        crc = crcTable[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
    }
    return crc ^ 0xFFFFFFFF
}

// MARK: - Data Extensions (LE writes)

private extension Data {
    mutating func writeUInt16LE(_ value: UInt16, at offset: Int) {
        self[offset] = UInt8(value & 0xFF)
        self[offset + 1] = UInt8((value >> 8) & 0xFF)
    }

    mutating func writeUInt32LE(_ value: UInt32, at offset: Int) {
        self[offset] = UInt8(value & 0xFF)
        self[offset + 1] = UInt8((value >> 8) & 0xFF)
        self[offset + 2] = UInt8((value >> 16) & 0xFF)
        self[offset + 3] = UInt8((value >> 24) & 0xFF)
    }
}
#else
/// No-op stub for non-macOS targets so shared references remain resolvable in Xcode.
final class D200hHidModule {
    init() {}
}
#endif
