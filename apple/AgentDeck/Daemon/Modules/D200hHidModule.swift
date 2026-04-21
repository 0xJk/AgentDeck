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
import CoreText
import ImageIO
import Security
import UniformTypeIdentifiers

// MARK: - HID Protocol Constants

private let D200H_VID: Int32 = 0x2207
private let D200H_PID: Int32 = 0x0019
private let CONSUMER_USAGE_PAGE: Int32 = 12
private let KEYBOARD_USAGE_PAGE: Int32 = 1
private let PACKET_SIZE = 1024
private let ICON_SIZE = 196

private let POLL_INTERVAL: UInt64 = 500_000_000   // 500ms device detection
private let KEEPALIVE_INTERVAL: TimeInterval = 15  // 15s keep-alive (D200H reverts to default after ~30s)
private let D200H_RENDERER_REV = "stock-safe-v20"

// HID Commands
private let CMD_SET_BUTTONS: UInt16    = 0x0001
private let CMD_PARTIAL_UPDATE: UInt16 = 0x000d
private let CMD_SET_SMALL_WINDOW: UInt16 = 0x0006
private let CMD_SET_BRIGHTNESS: UInt16 = 0x000a
private let CMD_IN_BUTTON: UInt16      = 0x0101
private let CMD_IN_DEVICE_INFO: UInt16 = 0x0303

private let ANIM_INTERVAL: UInt64 = 250_000_000  // 250ms = 4fps animation
private let PRESS_FLASH_DURATION: UInt64 = 90_000_000

private func d200hBakeSessionTextEnabled() -> Bool {
    AppPreferences.shared.d200hBakeSessionText
}

private func d200hHideNativeSessionLabelsEnabled() -> Bool {
    d200hBakeSessionTextEnabled() && AppPreferences.shared.d200hHideNativeSessionLabels
}

private func d200hStableStockHidEnabled() -> Bool {
    true
}

/// Dedicated background thread running an NSRunLoop. Used as the target for
/// `IOHIDManagerScheduleWithRunLoop` so device match/removal/input-report callbacks
/// (and the synchronous `IOHIDManagerOpen` / `IOHIDDeviceOpen` work that fires from
/// them during wake recovery) don't execute on the main thread. Switching to
/// `IOHIDManagerSetDispatchQueue` was tried first but conflicts with the Open/Close
/// lifecycle (dispatch-queue-scheduled managers require Activate/Cancel and an async
/// cancel handler, which would force a larger rewrite); pinning the existing runloop
/// API to a background thread achieves the same "off-main" goal with zero lifecycle
/// changes.
private final class HIDRunLoopThread: @unchecked Sendable {
    static let shared = HIDRunLoopThread()

    let runLoop: CFRunLoop

    private init() {
        let ready = DispatchSemaphore(value: 0)
        var captured: CFRunLoop?
        let thread = Thread {
            captured = CFRunLoopGetCurrent()
            ready.signal()
            // Keep the runloop alive indefinitely. NSMachPort is a permanent source
            // that prevents the runloop from returning from `run()`.
            let port = NSMachPort()
            RunLoop.current.add(port, forMode: .default)
            while !Thread.current.isCancelled {
                RunLoop.current.run(mode: .default, before: .distantFuture)
            }
        }
        thread.name = "bound.serendipity.agentdeck.d200h-hid-runloop"
        thread.qualityOfService = .userInitiated
        thread.start()
        ready.wait()
        self.runLoop = captured!
    }
}

// MARK: - D200hHidModule

final class D200hHidModule: DeviceModule, @unchecked Sendable {
    let name = "d200h"

    nonisolated(unsafe) var commandHandler: (([String: Any]) -> Void)?

    private var hidManager: IOHIDManager?
    private var consumerDevice: IOHIDDevice?
    private var keyboardDevice: IOHIDDevice?
    private var connected = false
    private var managerOpened = false
    private var lastStateHash = ""
    private var displaySuppressed = false

    private var pollTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var animationTask: Task<Void, Never>?

    // Cached state for rendering
    nonisolated(unsafe) private var cachedStateEvent: [String: Any]?
    nonisolated(unsafe) private var cachedUsageEvent: [String: Any]?
    nonisolated(unsafe) private var cachedSessionsList: [[String: Any]] = []

    // Display mode
    private enum DisplayMode { case sessionList, optionSelect }
    private var currentMode: DisplayMode = .sessionList
    private var focusedSessionId: String?
    private var animFrame: Int = 0
    private var needsAnimation = false
    private var sessionPage: Int = 0
    private var optionPage: Int = 0
    private var buttonPressCount: Int = 0
    private var lastButtonIndex: Int = -1
    private var lastButtonPressUptimeNs: UInt64 = 0
    private var hidReportCount: Int = 0
    private var writeSuccessCount: Int = 0
    private var writeFailCount: Int = 0
    private var lastWriteError: Int32 = 0
    private var lastOpenError: Int32 = 0
    private var lastDumpedSetButtonsZip = Data()
    private var lastDumpedPartialZip = Data()
    private var lastPartialDumpAt = Date.distantPast
    private var lastFullSlots: [ButtonSlot] = []  // cache for partial update diff
    private var animatedButtonIds: [Int] = []      // buttons needing animation
    private var partialUpdateSupported = true       // fallback if PARTIAL_UPDATE fails
    private var pressDispatchTasks: [Int: Task<Void, Never>] = [:]
    private var lastLabelStyleShowTitle: Bool?
    private var keyboardWarnedMissing = false
    private var consumerInputBuffer: UnsafeMutablePointer<UInt8>?
    private var keyboardInputBuffer: UnsafeMutablePointer<UInt8>?
    private lazy var usbEntitlementPresent: Bool = Self.hasEntitlement("com.apple.security.device.usb")
    private lazy var sandboxEnabled: Bool = Self.hasEntitlement("com.apple.security.app-sandbox")

    // MARK: - DeviceModule

    func start() async {
        DaemonLogger.shared.info("D200H HID module starting")
        if sandboxEnabled && !usbEntitlementPresent {
            DaemonLogger.shared.info("""
            D200H HID module started without embedded USB entitlement.
            Swift daemon can enumerate the HID service but will not be permitted to open it.
            Current practical fallback for D200H is the non-sandboxed Node.js daemon.
            """)
        }

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

        // Schedule callbacks on a dedicated background runloop thread — NOT the main
        // runloop. This keeps device match/removal/input-report delivery + the
        // synchronous IOHIDManagerOpen/IOHIDDeviceOpen work that runs inside them
        // off the main thread, so the Dashboard WS pipeline isn't blocked during
        // wake recovery's ~5s manager restart.
        IOHIDManagerScheduleWithRunLoop(manager, HIDRunLoopThread.shared.runLoop, CFRunLoopMode.defaultMode.rawValue)

        // IOHIDManager must be opened for device matching callbacks to fire for
        // already-present devices. Without this, the schedule + matching dict is
        // configured but no enumeration callback ever runs, leaving connected=false
        // even when a D200H is plugged in.
        let openResult = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        if openResult == kIOReturnSuccess {
            managerOpened = true
            DaemonLogger.shared.info("D200H IOHIDManagerOpen succeeded (sandbox=\(sandboxEnabled), usbEntitlement=\(usbEntitlementPresent))")
        } else {
            lastOpenError = openResult
            managerOpened = false
            if openResult == kIOReturnNotPermitted {
                DaemonLogger.shared.info("""
                D200H IOHIDManagerOpen denied (kIOReturnNotPermitted, 0x\(String(openResult, radix: 16))).
                Sandboxed build lacks usable USB/HID authorization — falling back to stock firmware.
                """)
            } else {
                DaemonLogger.shared.info("D200H IOHIDManagerOpen failed: 0x\(String(openResult, radix: 16)) (\(openResult))")
            }
        }

        // Enumeration diagnostic: list every HID device IOKit currently sees,
        // then filter to D200H VID/PID. This distinguishes "no D200H plugged
        // in" from "IOKit sees it but matching callback never fired".
        if let devicesSet = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> {
            var allCount = 0
            var d200hCount = 0
            for device in devicesSet {
                allCount += 1
                let vid = hidDeviceProperty(device, kIOHIDVendorIDKey) ?? 0
                let pid = hidDeviceProperty(device, kIOHIDProductIDKey) ?? 0
                if vid == D200H_VID && pid == D200H_PID {
                    d200hCount += 1
                    let usagePage = hidDeviceProperty(device, kIOHIDPrimaryUsagePageKey) ?? 0
                    DaemonLogger.shared.info("D200H IOKit device found: VID=0x\(String(vid, radix: 16)) PID=0x\(String(pid, radix: 16)) usagePage=\(usagePage)")
                }
            }
            DaemonLogger.shared.info("D200H IOKit enumeration: matched=\(allCount) (D200H=\(d200hCount)). If D200H=0 but device is physically plugged in, the sandbox is blocking enumeration or USB enumeration itself failed.")
        } else {
            DaemonLogger.shared.info("D200H IOKit enumeration returned no devices (IOHIDManagerCopyDevices=nil) — nothing matches VID=0x\(String(D200H_VID, radix: 16))/PID=0x\(String(D200H_PID, radix: 16))")
        }

        // If device was already attached during scheduling, run deferred initialization now
        if connected {
            initializeDevice()
        }

        // Heartbeat timer starts in initializeDevice() when device connects
        DaemonLogger.shared.info("D200H HID module started — watching for device")
    }

    func stop() async {
        pollTask?.cancel()
        heartbeatTask?.cancel()
        animationTask?.cancel()
        pressDispatchTasks.values.forEach { $0.cancel() }
        pressDispatchTasks.removeAll()
        disconnect()

        if let manager = hidManager {
            IOHIDManagerUnscheduleFromRunLoop(manager, HIDRunLoopThread.shared.runLoop, CFRunLoopMode.defaultMode.rawValue)
            IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        hidManager = nil
        DaemonLogger.shared.debug("D200H", "Module stopped")
    }

    func handleWake() async {
        guard hidManager != nil else { return }
        DaemonLogger.shared.info("D200H wake recovery — full teardown + restart")

        // Fully destroy IOHIDManager — unschedule/re-schedule alone doesn't
        // re-fire matching callbacks for already-matched devices
        await stop()

        // Wait for D200H firmware to boot into HID mode (~4s after USB re-power)
        try? await Task.sleep(for: .seconds(5))

        // Create fresh IOHIDManager with new callbacks
        await start()

        if connected {
            DaemonLogger.shared.info("D200H reconnected after wake")
        } else {
            // Retry once more — USB re-enumeration can be slow after deep sleep
            DaemonLogger.shared.info("D200H not found after wake, retrying...")
            await stop()
            try? await Task.sleep(for: .seconds(3))
            await start()
            DaemonLogger.shared.info("D200H wake retry result: connected=\(connected)")
        }
    }

    // MARK: - Broadcast Handler

    func handleBroadcast(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "state_update":
            cachedStateEvent = event
            updateDisplay()
        case "usage_update":
            cachedUsageEvent = event
            updateDisplay()
        case "sessions_list":
            let sessions = event["sessions"] as? [[String: Any]] ?? []
            debugLog("BROADCAST sessions_list: \(sessions.count) sessions")
            cachedSessionsList = sessions
            updateDisplay()
        case "display_state":
            let displayOn = event["displayOn"] as? Bool ?? true
            applyDisplayState(displayOn: displayOn)
        default: break
        }
    }

    private func applyDisplayState(displayOn: Bool) {
        let shouldSuppress = !displayOn
        guard shouldSuppress != displaySuppressed else { return }
        displaySuppressed = shouldSuppress

        guard connected, managerOpened else {
            debugLog("display_state=\(displayOn) deferred (not connected)")
            return
        }

        if shouldSuppress {
            writePacket(buildBrightnessPacket(0))
            DaemonLogger.shared.debug("D200H", "Display sleep → brightness 0")
        } else {
            writePacket(buildBrightnessPacket(100))
            lastStateHash = ""
            lastFullSlots = []
            updateDisplay()
            DaemonLogger.shared.debug("D200H", "Display wake → brightness 100 + full refresh")
        }
    }

    func forceFullRefresh(reason: String) -> [String: Any] {
        debugLog("Force full refresh requested: \(reason)")
        guard !cachedSessionsList.isEmpty || !lastFullSlots.isEmpty else {
            var snapshot = statusSnapshot()
            snapshot["refreshSkipped"] = "no_cached_sessions"
            debugLog("Force full refresh skipped: no cached sessions")
            return snapshot
        }
        lastStateHash = ""
        lastFullSlots = []
        syncLabelStyleIfNeeded(force: true)
        updateDisplay()
        return statusSnapshot()
    }

    func statusSnapshot() -> [String: Any] {
        [
            "connected": connected,
            "managerOpened": managerOpened,
            "hasConsumerDevice": consumerDevice != nil,
            "hasKeyboardDevice": keyboardDevice != nil,
            "sandboxEnabled": sandboxEnabled,
            "usbEntitlementPresent": usbEntitlementPresent,
            "buttonPressCount": buttonPressCount,
            "lastButtonIndex": lastButtonIndex,
            "hidReportCount": hidReportCount,
            "writeOK": writeSuccessCount,
            "writeFail": writeFailCount,
            "lastWriteError": lastWriteError,
            "lastOpenError": lastOpenError,
            "nativeLabelsVisible": shouldShowNativeLabels(for: currentMode),
            "bakeSessionText": d200hBakeSessionTextEnabled(),
            "stableStockHid": d200hStableStockHidEnabled(),
            "partialUpdatesEnabled": !d200hStableStockHidEnabled() && partialUpdateSupported,
            "rendererRev": D200H_RENDERER_REV,
            "mode": currentMode == .sessionList ? "sessions" : "options",
            "sessionsCount": cachedSessionsList.count,
            "lastStateHash": lastStateHash,
            "animFrame": animFrame,
            "needsAnimation": needsAnimation,
        ]
    }

    // MARK: - Device Attach/Remove (IOKit callbacks, run loop thread)

    private func hidDeviceProperty(_ device: IOHIDDevice, _ key: String) -> Int32? {
        if let val = IOHIDDeviceGetProperty(device, key as CFString) {
            if let num = val as? NSNumber { return num.int32Value }
        }
        return nil
    }

    private func logOpenFailure(_ interfaceName: String, result: IOReturn, extraHint: String) {
        lastOpenError = result
        if result == kIOReturnNotPermitted {
            DaemonLogger.shared.info("""
            D200H \(interfaceName) open denied (kIOReturnNotPermitted).
            This usually means the current macOS app build does not have usable USB/HID authorization for D200H.
            If the embedded app entitlements omit USB access, Swift HID control will stay disconnected and D200H will fall back to stock firmware.
            \(extraHint)
            """)
        } else {
            // Promoted from debug → info: a silent open failure here (especially on the
            // keyboard interface) produces the "display works, buttons dead" symptom
            // with no visible signal, and it recurs often enough that the debug level
            // was hiding it from operators.
            DaemonLogger.shared.info("D200H \(interfaceName) open failed: 0x\(String(result, radix: 16)) (\(result)) — \(extraHint)")
        }
    }

    private func handleDeviceAttached(_ device: IOHIDDevice) {
        let usagePage = hidDeviceProperty(device, kIOHIDPrimaryUsagePageKey) ?? 0

        if usagePage == CONSUMER_USAGE_PAGE {
            // Open consumer device individually — needed for IOHIDDeviceSetReport (display writes)
            let openResult = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
            if openResult != kIOReturnSuccess {
                logOpenFailure("Consumer Control", result: openResult,
                               extraHint: "Verify USB entitlement is honored for this device.")
                return
            }
            consumerDevice = device
            DaemonLogger.shared.info("D200H Consumer Control interface attached")
            registerInputCallback(device, interfaceRole: .consumer)
        } else if usagePage == KEYBOARD_USAGE_PAGE {
            // Open keyboard device — seize not required for D200H custom HID protocol
            // (D200H button reports use 0x7C7C framing, not standard keyboard usage, so hidd doesn't intercept)
            let openResult = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
            if openResult != kIOReturnSuccess {
                logOpenFailure("Keyboard", result: openResult,
                               extraHint: "Verify Input Monitoring permission and USB entitlement.")
                return
            }
            keyboardDevice = device
            keyboardWarnedMissing = false
            DaemonLogger.shared.info("D200H Keyboard interface attached (button events)")

            // Register input report callback for button events
            registerInputCallback(device, interfaceRole: .keyboard)
        }

        if consumerDevice != nil {
            if !connected {
                connected = true
                DaemonLogger.shared.info("D200H connected via HID")

                // Initial setup deferred if manager not yet open (callback fires during scheduling)
                if managerOpened {
                    initializeDevice()
                }
            }
            // Keyboard interface often enumerates a few milliseconds after the consumer
            // one; button reports only arrive on the keyboard interface, so we schedule
            // a one-shot warning if it's still missing after 2s. This exposes the
            // "display renders but keys are dead" half-connected state that otherwise
            // looks identical to a fully healthy device in snapshots and UI badges.
            if keyboardDevice == nil, !keyboardWarnedMissing {
                keyboardWarnedMissing = true
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard let self, self.connected, self.keyboardDevice == nil else { return }
                    DaemonLogger.shared.info("""
                    D200H connected on Consumer Control interface but Keyboard interface is still absent.
                    The device will render buttons but will not relay presses back. Likely causes: Input Monitoring
                    permission, another process holding the keyboard interface, or the 4s ADB→HID transition
                    hasn't completed yet.
                    """)
                }
            }
        }
    }

    private static func hasEntitlement(_ key: String) -> Bool {
        guard let task = SecTaskCreateFromSelf(nil),
              let value = SecTaskCopyValueForEntitlement(task, key as CFString, nil) else {
            return false
        }
        return (value as? Bool) == true
    }

    private func initializeDevice() {
        // Respect host-display state at (re)connect — if the Mac monitor is off or
        // locked, bring the device up dim so we don't flash the dashboard.
        let initialBrightness = displaySuppressed ? 0 : 100
        writePacket(buildBrightnessPacket(initialBrightness))
        syncLabelStyleIfNeeded(force: true)

        // Force full render (clear hash so updateDisplay always sends).
        // updateDisplay() is itself a no-op when displaySuppressed is true.
        lastStateHash = ""
        updateDisplay()

        // Note: an earlier iteration called sendKeepAlive() here to try to
        // overwrite the stock firmware's small-window layer with our own
        // usage text. In practice D200H renders the manifest `3_2` icon AND
        // the small-window layer on the same coordinates, so pushing a
        // second SET_SMALL_WINDOW on top produced the "two overlapping
        // readouts" symptom. Suppressing the small-window layer is handled
        // purely through the manifest (`clearAction: true` on the `3_2`
        // entry) — see DEVELOPMENT_LOG 2026-04-12 "usage manifest empty
        // action clears clock widget overlay".
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)  // 15s
                guard let self, self.connected, self.managerOpened else { continue }
                self.lastStateHash = ""  // force re-render
                self.updateDisplay()
            }
        }
    }

    private func handleDeviceRemoved(_ device: IOHIDDevice) {
        if device === consumerDevice {
            // Close device to clean up resources and stop callbacks
            IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
            consumerDevice = nil
            DaemonLogger.shared.info("D200H Consumer Control interface removed")
        }
        if device === keyboardDevice {
            // Close device to clean up resources and stop callbacks
            IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
            keyboardDevice = nil
            DaemonLogger.shared.info("D200H Keyboard interface removed")
        }

        if consumerDevice == nil {
            connected = false
            lastStateHash = ""
            heartbeatTask?.cancel()
            heartbeatTask = nil
            DaemonLogger.shared.info("D200H disconnected — heartbeat stopped")
        }
    }

    // MARK: - Input Report (Button Events)

    private enum InterfaceRole { case consumer, keyboard }

    /// IOKit requires a caller-owned buffer whose lifetime extends for as long
    /// as the callback is registered. Previously a fresh `UnsafeMutablePointer`
    /// was allocated on every attach without a matching deallocate, so each
    /// wake/reattach cycle leaked one buffer; disconnect() now releases them.
    private func registerInputCallback(_ device: IOHIDDevice, interfaceRole: InterfaceRole) {
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: PACKET_SIZE)
        switch interfaceRole {
        case .consumer:
            consumerInputBuffer?.deallocate()
            consumerInputBuffer = buffer
        case .keyboard:
            keyboardInputBuffer?.deallocate()
            keyboardInputBuffer = buffer
        }
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()

        IOHIDDeviceRegisterInputReportCallback(
            device,
            buffer,
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
        hidReportCount += 1
        guard data.count >= 8, data[0] == 0x7C, data[1] == 0x7C else { return }

        let command = UInt16(data[2]) << 8 | UInt16(data[3])

        if command == CMD_IN_BUTTON && data.count >= 12 {
            let buttonIndex = Int(data[9])
            let pressed = data[11] == 0x01

            if pressed {
                let now = DispatchTime.now().uptimeNanoseconds
                let duplicatePress = buttonIndex == lastButtonIndex && (now - lastButtonPressUptimeNs) < 120_000_000
                if duplicatePress {
                    DaemonLogger.shared.debug("D200H", "Button \(buttonIndex) duplicate press ignored")
                    return
                }
                buttonPressCount += 1
                lastButtonIndex = buttonIndex
                lastButtonPressUptimeNs = now
                scheduleButtonDispatch(buttonIndex)
            }
        } else if command == CMD_IN_DEVICE_INFO {
            if let jsonStr = String(data: data[8...], encoding: .ascii)?.components(separatedBy: "\0").first,
               let jsonData = jsonStr.data(using: .utf8),
               let info = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
                DaemonLogger.shared.debug("D200H", "Device: \(info["DeviceType"] ?? "") fw=\(info["Dversion"] ?? "") hw=\(info["HardwareVersion"] ?? "")")
            }
        }
    }

    // MARK: - Dynamic Button Command Resolution

    private func resolveButtonCommand(_ index: Int) -> ButtonResolution {
        let sessions = buildSessionList()

        switch currentMode {
        case .sessionList:
            // Slot 13 = usage monitor (big merged button, no action)
            if index == 13 { return .unmapped }
            // Slots 0-12 are sessions (13 per page)
            guard index <= 12 else { return .unmapped }
            let startIdx = sessionPage * 13
            let sessionIdx = startIdx + index
            guard sessionIdx < sessions.count else { return .unmapped }
            let session = sessions[sessionIdx]

            // Focus this session and enter detail view
            focusedSessionId = session.id
            currentMode = .optionSelect
            optionPage = 0
            lastStateHash = ""  // force re-render on mode change
            debugLog("BUTTON \(index) → optionSelect session=\(session.id)")
            updateDisplay()
            if session.isVirtualGateway {
                return .handled(note: "option_select_virtual_gateway")
            }
            return .command(AgentCommand.focusSession(sessionId: session.id).dictionary)

        case .optionSelect:
            guard let focusId = focusedSessionId,
                  let session = sessions.first(where: { $0.id == focusId }) else {
                currentMode = .sessionList
                lastStateHash = ""
                updateDisplay()
                return .handled(note: "reset_to_sessions")
            }

            switch index {
            case 0, 13:  // BACK (slot 0 + big merged button)
                currentMode = .sessionList
                lastStateHash = ""
                updateDisplay()
                return .handled(note: "back")

            case 1:  // Info display, no action
                return .handled(note: "info")

            case 2...9:  // Option buttons or Quick Actions
                if session.options.isEmpty && session.isIdle {
                    // Quick actions: GO ON, REVIEW, COMMIT, CLEAR
                    let actions = ["go on", "/review", "/commit", "/clear"]
                    let qaIdx = index - 2
                    guard qaIdx < actions.count else { return .unmapped }
                    return .command(AgentCommand.sendPrompt(text: actions[qaIdx]).dictionary)
                }

                let optIdx = optionPage * 8 + (index - 2)
                guard optIdx < session.options.count else { return .unmapped }
                let opt = session.options[optIdx]
                let shortcut = opt["shortcut"] as? String ?? ""
                let label = opt["label"] as? String ?? ""

                currentMode = .sessionList
                lastStateHash = ""
                updateDisplay()

                if session.navigable {
                    return .command(AgentCommand.selectOption(index: optIdx).dictionary)
                } else {
                    let key = shortcut.isEmpty ? String(label.prefix(1)).lowercased() : shortcut
                    return .command(AgentCommand.respond(value: key).dictionary)
                }

            case 10:  // STOP/ESC combined
                if session.isProcessing {
                    return .command(AgentCommand.interrupt.dictionary)
                } else {
                    currentMode = .sessionList
                    lastStateHash = ""
                    updateDisplay()
                    return .command(AgentCommand.escape.dictionary)
                }

            case 11:  // MORE
                let totalOptPages = max(1, (session.options.count + 7) / 8)
                optionPage = (optionPage + 1) % totalOptPages
                updateDisplay()
                return .handled(note: "more")
            default:
                return .unmapped
            }
        }
    }

    // MARK: - Display Update (Hybrid: full SET_BUTTONS + partial PARTIAL_UPDATE for animation)

    private func debugLog(_ msg: String) {
        DaemonLogger.shared.debug("D200H", msg)
    }

    private func shouldShowNativeLabels(for mode: DisplayMode) -> Bool {
        switch mode {
        case .sessionList:
            return !d200hHideNativeSessionLabelsEnabled()
        case .optionSelect:
            return true
        }
    }

    private func syncLabelStyleIfNeeded(force: Bool = false) {
        let showTitle = shouldShowNativeLabels(for: currentMode)
        guard force || lastLabelStyleShowTitle != showTitle else { return }
        writePacket(buildLabelStylePacket(showTitle: showTitle))
        lastLabelStyleShowTitle = showTitle
    }

    private struct DisplayRenderState {
        let sessions: [D200hSessionInfo]
        let slots: [ButtonSlot]
        let animatedButtonIds: [Int]
    }

    private func currentDisplayRenderState() -> DisplayRenderState {
        let allSessions = buildSessionList()

        var slots: [ButtonSlot]
        var animButtonIds: [Int] = []

        switch currentMode {
        case .sessionList:
            let (computedSlots, _) = D200hRenderer.computeSessionListSlots(
                sessions: allSessions,
                stateEvent: cachedStateEvent,
                usageEvent: cachedUsageEvent,
                page: sessionPage,
                animFrame: animFrame
            )
            slots = computedSlots
            if !d200hStableStockHidEnabled() {
                let startIdx = sessionPage * 13
                for i in 0..<13 {
                    let sessionIdx = startIdx + i
                    guard sessionIdx < allSessions.count else { break }
                    if allSessions[sessionIdx].isAwaiting || allSessions[sessionIdx].isProcessing {
                        animButtonIds.append(i)
                    }
                }
            }

        case .optionSelect:
            if let focusId = focusedSessionId,
               let session = allSessions.first(where: { $0.id == focusId }) {
                slots = D200hRenderer.computeOptionSelectSlots(session: session, page: optionPage)
            } else {
                slots = [ButtonSlot](repeating: .dim, count: 14)
                slots[0] = ButtonSlot(title: "← BACK", subtitle: "", bg: D200hRenderer.cDark, enabled: true, borderStyle: .none, icon: .back, iconColor: rgb(226, 232, 240))
                slots[10] = ButtonSlot(title: "✖ ESC", subtitle: "", bg: D200hRenderer.cEscActive, enabled: true, borderStyle: .none, icon: .back, iconColor: rgb(226, 232, 240))
            }
        }

        return DisplayRenderState(sessions: allSessions, slots: slots, animatedButtonIds: animButtonIds)
    }

    private func sendPartialUpdate(slots: [ButtonSlot], buttonIds: [Int], sessions: [D200hSessionInfo]) {
        guard connected, managerOpened, partialUpdateSupported, !d200hStableStockHidEnabled() else { return }
        let zip = D200hRenderer.renderPartialZip(
            slots: slots,
            buttonIds: buttonIds,
            optionMode: currentMode == .optionSelect,
            sessions: sessions,
            sessionPage: sessionPage,
            focusedSessionId: focusedSessionId
        )
        if zip.isEmpty {
            debugLog("SKIP partial send: renderPartialZip returned empty (boundary-invalid)")
            return
        }
        dumpZipForAnalysisIfNeeded(zip, command: "partial_update", mode: currentMode, slots: slots)
        let packets = buildZipPackets(zip, command: CMD_PARTIAL_UPDATE)
        for packet in packets { writePacket(packet) }
    }

    private func scheduleButtonDispatch(_ buttonIndex: Int) {
        if !d200hStableStockHidEnabled() {
            sendPressFlash(buttonIndex)
        }

        pressDispatchTasks[buttonIndex]?.cancel()
        pressDispatchTasks[buttonIndex] = Task { [weak self] in
            if !d200hStableStockHidEnabled() {
                try? await Task.sleep(nanoseconds: PRESS_FLASH_DURATION)
            }
            guard let self, !Task.isCancelled else { return }

            let modeBefore = self.currentMode
            let focusBefore = self.focusedSessionId
            let sessionPageBefore = self.sessionPage
            let optionPageBefore = self.optionPage

            switch self.resolveButtonCommand(buttonIndex) {
            case .command(let cmd):
                DaemonLogger.shared.debug("D200H", "Button \(buttonIndex) pressed -> \(cmd["type"] ?? "")")
                self.commandHandler?(cmd)
            case .handled(let note):
                DaemonLogger.shared.debug("D200H", "Button \(buttonIndex) handled locally -> \(note)")
            case .unmapped:
                DaemonLogger.shared.debug("D200H", "Button \(buttonIndex) pressed (unmapped)")
            }

            let displayChanged = modeBefore != self.currentMode
                || focusBefore != self.focusedSessionId
                || sessionPageBefore != self.sessionPage
                || optionPageBefore != self.optionPage

            if !displayChanged && !d200hStableStockHidEnabled() {
                self.restoreButtonAfterFlash(buttonIndex)
            }

            self.pressDispatchTasks[buttonIndex] = nil
        }
    }

    private func sendPressFlash(_ buttonIndex: Int) {
        let state = currentDisplayRenderState()
        guard buttonIndex < state.slots.count else { return }
        guard state.slots[buttonIndex].enabled else { return }
        if buttonIndex == 13 && currentMode != .optionSelect { return }

        var flashSlots = state.slots
        flashSlots[buttonIndex] = flashSlots[buttonIndex].pressedFlash()
        sendPartialUpdate(slots: flashSlots, buttonIds: [buttonIndex], sessions: state.sessions)
    }

    private func restoreButtonAfterFlash(_ buttonIndex: Int) {
        let state = currentDisplayRenderState()
        guard buttonIndex < state.slots.count else { return }
        if buttonIndex == 13 && currentMode != .optionSelect { return }
        sendPartialUpdate(slots: state.slots, buttonIds: [buttonIndex], sessions: state.sessions)
    }

    private func updateDisplay(animationOnly: Bool = false) {
        guard connected, managerOpened else {
            debugLog("updateDisplay SKIP: connected=\(connected) managerOpened=\(managerOpened)")
            return
        }
        if displaySuppressed {
            debugLog("updateDisplay SKIP: display suppressed (host monitor off/locked)")
            return
        }

        syncLabelStyleIfNeeded()

        let renderState = currentDisplayRenderState()
        let allSessions = renderState.sessions
        let slots = renderState.slots
        animatedButtonIds = renderState.animatedButtonIds
        updateAnimationTimer(needsAnimation: !animatedButtonIds.isEmpty)

        // Decide: full update or partial animation
        if animationOnly && partialUpdateSupported && !d200hStableStockHidEnabled() && !animatedButtonIds.isEmpty && !lastFullSlots.isEmpty {
            sendPartialUpdate(slots: slots, buttonIds: animatedButtonIds, sessions: allSessions)
        } else {
            // Skip if content unchanged (prevents flooding device with repeated ZIPs)
            let modeKey = currentMode == .sessionList ? "L" : "O"
            let contentKey = "\(modeKey)|rev=\(D200H_RENDERER_REV)|labels=\(shouldShowNativeLabels(for: currentMode) ? 1 : 0)|baked=\(d200hBakeSessionTextEnabled() ? 1 : 0)|\(slots.map(\.cacheKey).joined(separator: ","))"
            if contentKey == lastStateHash { return }
            lastStateHash = contentKey

            let zip = D200hRenderer.renderFullZip(
                slots: slots,
                sessions: allSessions,
                stateEvent: cachedStateEvent,
                usageEvent: cachedUsageEvent,
                optionMode: currentMode == .optionSelect,
                sessionPage: sessionPage,
                focusedSessionId: focusedSessionId
            )
            // buildValidatedZip returns empty when the D200H boundary-byte padding
            // search fails to converge. Writing a malformed ZIP to the device is
            // what produces the "partial creatures + dead keys + stock clock"
            // regression cycle, so we drop and let the next state transition
            // retry with different bytes instead.
            if zip.isEmpty {
                lastStateHash = ""
                debugLog("SKIP full send: renderFullZip returned empty (boundary-invalid)")
                return
            }
            dumpZipForAnalysisIfNeeded(zip, command: "set_buttons", mode: currentMode, slots: slots)
            let packets = buildZipPackets(zip)
            for packet in packets { writePacket(packet) }
            lastFullSlots = slots
            debugLog("SENT \(zip.count)b \(packets.count)pkt mode=\(modeKey) slot0=\(slots[0].title)")
        }
    }

    private func buildSessionList() -> [D200hSessionInfo] {
        // sessions_list from daemon already sorted by sortSessions().
        // Apply display name deduplication (matching SD+ plugin's assignDisplayNames).
        var parsed = cachedSessionsList.map { D200hSessionInfo.parse($0) }
        // Count duplicates by (projectName, agentType) pair
        var counts: [String: Int] = [:]
        for s in parsed {
            let key = "\(s.projectName):\(s.agentType)"
            counts[key, default: 0] += 1
        }
        // Assign sequential suffixes to duplicates
        var seq: [String: Int] = [:]
        for i in parsed.indices {
            let key = "\(parsed[i].projectName):\(parsed[i].agentType)"
            let n = (seq[key] ?? 0) + 1
            seq[key] = n
            if (counts[key] ?? 1) > 1 {
                parsed[i] = parsed[i].withDisplayName("\(parsed[i].projectName) #\(n)")
            }
        }
        return parsed
    }

    // MARK: - Animation Timer

    private func updateAnimationTimer(needsAnimation: Bool) {
        if d200hStableStockHidEnabled() {
            self.needsAnimation = false
            animationTask?.cancel()
            animationTask = nil
            return
        }
        self.needsAnimation = needsAnimation
        if needsAnimation && animationTask == nil {
            animationTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: ANIM_INTERVAL)
                    guard let self, self.needsAnimation, self.connected else { continue }
                    self.animFrame += 1
                    self.updateDisplay(animationOnly: true)  // partial update for animation frames
                }
            }
        } else if !needsAnimation {
            animationTask?.cancel()
            animationTask = nil
        }
    }

    // MARK: - HID Write

    // NOTE: sendKeepAlive() used to live here and push CMD_SET_SMALL_WINDOW
    // every 15 seconds. It was deleted on 2026-04-19 because the D200H firmware
    // does NOT use SMALL_WINDOW as a "redraw the bottom-right area" primitive
    // — it composites a separate clock-widget layer on top of the manifest
    // icon at the same coordinates. Writing anything via SET_SMALL_WINDOW adds
    // an extra overlapping readout rather than replacing the clock.
    // See DEVELOPMENT_LOG 2026-04-19 "D200H clock overlay — reproduced and
    // permanently suppressed". Do not reintroduce this function; stock-clock
    // suppression is handled entirely by the manifest `3_2` Action="" escape
    // hatch in `manifestEntry` / `renderFullZip`.


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

        if result == kIOReturnSuccess || result == kIOReturnUnderrun {
            writeSuccessCount += 1
        } else {
            writeFailCount += 1
            lastWriteError = result
        }
    }

    private func disconnect() {
        if let dev = consumerDevice { IOHIDDeviceClose(dev, IOOptionBits(kIOHIDOptionsTypeNone)) }
        if let dev = keyboardDevice { IOHIDDeviceClose(dev, IOOptionBits(kIOHIDOptionsTypeNone)) }
        consumerDevice = nil
        keyboardDevice = nil
        consumerInputBuffer?.deallocate()
        consumerInputBuffer = nil
        keyboardInputBuffer?.deallocate()
        keyboardInputBuffer = nil
        connected = false
        keyboardWarnedMissing = false
        lastStateHash = ""
        lastLabelStyleShowTitle = nil
        heartbeatTask?.cancel()
        heartbeatTask = nil
    }

    private func dumpZipForAnalysisIfNeeded(_ zip: Data, command: String, mode: DisplayMode, slots: [ButtonSlot]) {
        guard !zip.isEmpty else { return }

        let now = Date()
        if command == "set_buttons" {
            guard zip != lastDumpedSetButtonsZip else { return }
            lastDumpedSetButtonsZip = zip
        } else {
            guard zip != lastDumpedPartialZip else { return }
            guard now.timeIntervalSince(lastPartialDumpAt) >= 5 else { return }
            lastDumpedPartialZip = zip
            lastPartialDumpAt = now
        }

        let fm = FileManager.default
        let dumpDir = AuthManager.agentDeckDir.appendingPathComponent("d200h-dumps", isDirectory: true)
        try? fm.createDirectory(at: dumpDir, withIntermediateDirectories: true)

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss-SSS"

        let stamp = formatter.string(from: now)
        let modeKey = mode == .sessionList ? "L" : "O"
        let slotPreview = slots
            .prefix(4)
            .map { sanitizeDumpName($0.title.isEmpty ? "_" : $0.title) }
            .joined(separator: "_")
        let baseName = "\(stamp)-\(command)-\(modeKey)-\(zip.count)b-\(slotPreview)"
        let zipURL = dumpDir.appendingPathComponent("\(baseName).zip")
        let metaURL = dumpDir.appendingPathComponent("\(baseName).json")

        try? zip.write(to: zipURL, options: .atomic)

        let boundaryInfo: [[String: Any]] = stride(from: 1016, to: zip.count, by: PACKET_SIZE).map { offset in
            [
                "offset": offset,
                "byte": zip[offset],
                "hex": String(format: "0x%02X", zip[offset]),
            ]
        }

        let metadata: [String: Any] = [
            "command": command,
            "mode": modeKey,
            "zipBytes": zip.count,
            "packetCount": buildZipPackets(zip, command: command == "partial_update" ? CMD_PARTIAL_UPDATE : CMD_SET_BUTTONS).count,
            "slotTitles": slots.map(\.title),
            "boundaryBytes": boundaryInfo,
            "createdAt": ISO8601DateFormatter().string(from: now),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: metadata, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: metaURL, options: .atomic)
        }

        pruneDumpFiles(in: dumpDir, keepingMostRecentSetButtons: 12, keepingMostRecentPartial: 24)
        DaemonLogger.shared.debug("D200H", "Dumped \(command) ZIP for analysis: \(zipURL.path)")
    }

    private func sanitizeDumpName(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let mapped = value.uppercased().map { ch -> Character in
            let scalar = String(ch).unicodeScalars.first!
            return allowed.contains(scalar) ? ch : "_"
        }
        let joined = String(mapped).replacingOccurrences(of: "__+", with: "_", options: .regularExpression)
        return String(joined.prefix(36)).trimmingCharacters(in: CharacterSet(charactersIn: "_"))
    }

    private func pruneDumpFiles(
        in dir: URL,
        keepingMostRecentSetButtons setButtonsLimit: Int,
        keepingMostRecentPartial partialLimit: Int
    ) {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        let grouped = Dictionary(grouping: urls) { url in
            url.deletingPathExtension().lastPathComponent
        }

        func newestDate(in group: [URL]) -> Date {
            group
                .compactMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }
                .max() ?? .distantPast
        }

        func prune(_ groups: [[URL]], keeping limit: Int) {
            let orderedGroups = groups.sorted { newestDate(in: $0) > newestDate(in: $1) }
            guard orderedGroups.count > limit else { return }
            for group in orderedGroups.suffix(from: limit) {
                for url in group {
                    try? FileManager.default.removeItem(at: url)
                }
            }
        }

        prune(
            grouped.values.filter { $0.first?.lastPathComponent.contains("-set_buttons-") == true },
            keeping: setButtonsLimit
        )
        prune(
            grouped.values.filter { $0.first?.lastPathComponent.contains("-partial_update-") == true },
            keeping: partialLimit
        )
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

private func buildZipPackets(_ zipData: Data, command: UInt16 = CMD_SET_BUTTONS) -> [Data] {
    var packets: [Data] = []
    let fileSize = UInt32(zipData.count)

    // First packet: header(8) + first chunk
    let firstChunkSize = PACKET_SIZE - 8
    let firstChunk = zipData.prefix(firstChunkSize)
    packets.append(buildPacket(command: command, payload: firstChunk, totalLength: fileSize))

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

private let CMD_SET_LABEL_STYLE: UInt16 = 0x000b

private func buildLabelStylePacket(showTitle: Bool) -> Data {
    let style: [String: Any] = [
        "Align": "bottom",
        "Color": 0xFFFFFF,
        "FontName": "Roboto",
        "ShowTitle": showTitle ? 1 : 0,
        "Size": 14,
        "Weight": 72,
    ]
    guard let json = try? JSONSerialization.data(withJSONObject: style) else { return Data() }
    return buildPacket(command: CMD_SET_LABEL_STYLE, payload: json)
}

/// TRAP: do NOT call from the steady-state rendering path.
///
/// D200H firmware composites the SMALL_WINDOW layer **on top of** the
/// manifest icon at the same slot-13 coordinates, so sending a packet here
/// produces "two overlapping readouts" rather than replacing the stock
/// clock. Stock-clock suppression is achieved by setting the manifest
/// `3_2` entry's `Action` to `""` (see `manifestEntry(clearAction:)`), not
/// by writing content through this layer.
///
/// This function is retained only for protocol documentation and ad-hoc
/// reverse-engineering experiments. If you reach for it in production code,
/// read DEVELOPMENT_LOG 2026-04-19 first.
private func buildSmallWindowPacket(mode: Int, cpu: Int, mem: Int, time: String, gpu: Int) -> Data {
    let str = "\(mode)|\(cpu)|\(mem)|\(time)|\(gpu)"
    return buildPacket(command: CMD_SET_SMALL_WINDOW, payload: Data(str.utf8))
}

private enum ButtonResolution {
    case command([String: Any])
    case handled(note: String)
    case unmapped
}

// MARK: - Session Data

private struct D200hSessionInfo {
    let id: String
    let projectName: String
    let displayName: String  // projectName with #N suffix if duplicated
    let agentType: String
    let state: String
    let port: Int
    let currentTool: String
    let options: [[String: Any]]
    let navigable: Bool
    let modelName: String
    let isVirtualGateway: Bool

    var isIdle: Bool { state == "idle" }
    var isProcessing: Bool { state == "processing" }
    var isAwaiting: Bool { state.hasPrefix("awaiting") }

    func withDisplayName(_ name: String) -> D200hSessionInfo {
        D200hSessionInfo(
            id: id, projectName: projectName, displayName: name, agentType: agentType,
            state: state, port: port, currentTool: currentTool, options: options,
            navigable: navigable, modelName: modelName, isVirtualGateway: isVirtualGateway
        )
    }

    static func parse(_ dict: [String: Any]) -> D200hSessionInfo {
        let id = dict["id"] as? String ?? ""
        let rawProjectName = dict["projectName"] as? String ?? dict["agentType"] as? String ?? ""
        let isVirtualGateway = id == "openclaw-gateway"
        let normalizedProjectName: String
        if isVirtualGateway && (rawProjectName.isEmpty || rawProjectName.caseInsensitiveCompare("Gateway") == .orderedSame) {
            normalizedProjectName = "OpenClaw"
        } else {
            normalizedProjectName = rawProjectName
        }
        return D200hSessionInfo(
            id: id,
            projectName: normalizedProjectName,
            displayName: normalizedProjectName,
            agentType: dict["agentType"] as? String ?? "",
            state: dict["state"] as? String ?? "idle",
            port: dict["port"] as? Int ?? 0,
            currentTool: dict["currentTool"] as? String ?? "",
            options: dict["options"] as? [[String: Any]] ?? [],
            navigable: dict["navigable"] as? Bool ?? false,
            modelName: dict["modelName"] as? String ?? "",
            isVirtualGateway: isVirtualGateway
        )
    }
}

// MARK: - Button Slot Definition

private struct ButtonSlot {
    enum TextOverlayStyle {
        case none
        case sessionTile
        case usageStat
    }

    let title: String
    let subtitle: String
    let bg: CGColor
    let enabled: Bool
    let borderStyle: BorderStyle
    let icon: IconGlyph
    let iconColor: CGColor?
    let statusColor: CGColor?
    let textOverlay: TextOverlayStyle
    // Native text candidates for manifest ViewParam.Text
    let agentLabel: String    // "CLAUDE CODE", "OPENCLAW" etc.
    let modelName: String     // "opus-4", "gpt-4o" etc.
    let stateLabel: String    // "WORKING", "IDLE" etc.
    let resetTime: String     // "2h15m", "now" — for usage stat overlay

    init(title: String, subtitle: String, bg: CGColor, enabled: Bool, borderStyle: BorderStyle,
         icon: IconGlyph, iconColor: CGColor?, statusColor: CGColor? = nil, textOverlay: TextOverlayStyle = .none,
         agentLabel: String = "", modelName: String = "", stateLabel: String = "", resetTime: String = "") {
        self.title = title; self.subtitle = subtitle; self.bg = bg
        self.enabled = enabled; self.borderStyle = borderStyle
        self.icon = icon; self.iconColor = iconColor
        self.statusColor = statusColor
        self.textOverlay = textOverlay
        self.agentLabel = agentLabel; self.modelName = modelName; self.stateLabel = stateLabel
        self.resetTime = resetTime
    }

    enum BorderStyle {
        case none
        case awaitingPulse(color: CGColor, frame: Int)    // glow pulse
        case processingDash(color: CGColor, frame: Int)   // flowing dash
        case processingSolid(color: CGColor)              // static "working" (animation disabled)
        case solid(color: CGColor)                        // static hint border
    }

    enum IconGlyph {
        case none
        case claudeCode
        case codexCli
        case openCode
        case openClaw
        case usage
        case back
        case stop
        case more
        case goOn
        case review
        case commit
        case clear
        case tool
    }

    static let dim = ButtonSlot(title: "", subtitle: "", bg: rgb(17, 17, 17), enabled: false, borderStyle: .none, icon: .none, iconColor: nil)

    var cacheKey: String {
        let borderKey: String
        switch borderStyle {
        case .none: borderKey = "n"
        case .awaitingPulse: borderKey = "a"
        case .processingDash: borderKey = "p"
        case .processingSolid: borderKey = "ps"
        case .solid: borderKey = "s"
        }

        let overlayKey: String
        switch textOverlay {
        case .none: overlayKey = "n"
        case .sessionTile: overlayKey = "t"
        case .usageStat: overlayKey = "u"
        }

        return "\(title)|\(subtitle)|\(modelName)|\(stateLabel)|\(resetTime)|\(enabled ? 1 : 0)|\(borderKey)|\(overlayKey)"
    }

    func pressedFlash() -> ButtonSlot {
        let baseBorderColor: CGColor
        switch borderStyle {
        case .awaitingPulse(let color, _), .processingDash(let color, _),
             .processingSolid(let color), .solid(let color):
            baseBorderColor = blendColor(color, toward: (1, 1, 1), ratio: 0.45)
        case .none:
            baseBorderColor = rgb(248, 250, 252)
        }

        return ButtonSlot(
            title: title,
            subtitle: subtitle,
            bg: blendColor(bg, toward: (1, 1, 1), ratio: 0.18),
            enabled: enabled,
            borderStyle: .solid(color: baseBorderColor),
            icon: icon,
            iconColor: iconColor.map { blendColor($0, toward: (1, 1, 1), ratio: 0.18) },
            statusColor: statusColor.map { blendColor($0, toward: (1, 1, 1), ratio: 0.10) },
            textOverlay: textOverlay,
            agentLabel: agentLabel,
            modelName: modelName,
            stateLabel: stateLabel,
            resetTime: resetTime
        )
    }
}

// MARK: - Agent Controller Renderer (SD+ Style)

private enum D200hRenderer {
    // === SD+ Exact Color Palette ===
    // Backgrounds
    static let cEmpty       = rgb(17, 17, 17)      // #111111 empty slot
    static let cSessionDef  = rgb(26, 26, 46)       // #1a1a2e session default
    static let cSessionAct  = rgb(30, 58, 95)       // #1e3a5f active session
    static let cSessionAwt  = rgb(45, 24, 16)       // #2d1810 awaiting session
    static let cDetailBg    = rgb(15, 23, 42)       // #0f172a detail/info bg
    static let cDark        = rgb(26, 26, 26)       // #1a1a1a nav buttons

    // State indicator colors — canonical palette from shared/src/state-colors.ts
    static let cStateIdle   = rgb(34, 197, 94)       // #22c55e green
    static let cStateProc   = rgb(59, 130, 246)      // #3b82f6 blue
    static let cStateAwait  = rgb(245, 158, 11)      // #f59e0b amber
    static let cStatePerm   = rgb(245, 158, 11)      // #f59e0b amber
    static let cStateDisco  = rgb(107, 114, 128)     // #6b7280 gray

    // UI elements
    static let cActiveBar   = rgb(59, 130, 246)      // #3b82f6 blue-500 left indicator
    static let cPageNav     = rgb(96, 165, 250)      // #60a5fa blue-400

    // Option buttons
    static let cOptBlue     = rgb(30, 64, 175)       // #1e40af blue-800
    static let cOptRed      = rgb(153, 27, 27)       // #991b1b red-900
    static let cOptGreen    = rgb(22, 101, 52)       // #166534 green-700
    static let cOptTeal     = rgb(30, 58, 95)        // #1e3a5f blue-900

    // Control buttons
    static let cStopActive  = rgb(45, 16, 16)        // #2d1010
    static let cStopInact   = rgb(26, 10, 10)        // #1a0a0a
    static let cEscActive   = rgb(45, 24, 16)        // #2d1810
    static let cEscInact    = rgb(26, 19, 8)         // #1a1308
    static var sessionTextOverlayEnabled: Bool { d200hBakeSessionTextEnabled() }
    static var hidesNativeSessionLabels: Bool { d200hHideNativeSessionLabelsEnabled() }

    // State → indicator color (no agent-type overrides — purely semantic)
    static func stateColor(_ state: String, agent: String = "") -> CGColor {
        switch state {
        case "idle": return cStateIdle
        case "processing": return cStateProc
        case "awaiting_permission": return cStatePerm
        case "awaiting_option", "awaiting_diff": return cStateAwait
        default: return cStateDisco
        }
    }

    // Agent brand color (mirrors shared/src/state-colors.ts and Stream Deck renderer)
    static func agentBrandColor(_ agent: String) -> CGColor {
        switch agent {
        case "openclaw": return rgb(255, 77, 77)
        case "codex-cli": return rgb(99, 102, 241)
        case "opencode": return rgb(241, 236, 236)
        default: return rgb(192, 112, 88)
        }
    }

    // State → session button background
    static func sessionBg(_ state: String) -> CGColor {
        switch state {
        case "idle", "processing": return cSessionAct
        case _ where state.hasPrefix("awaiting"): return cSessionAwt
        default: return cSessionDef
        }
    }

    // Option label → background color
    static func optionBgColor(label: String, shortcut: String) -> CGColor {
        let lower = label.lowercased()
        let sc = shortcut.lowercased()
        if lower.hasPrefix("always") || lower.contains("don't ask") || lower.contains("allow all") { return cOptBlue }
        if sc == "n" || sc == "d" || lower.hasPrefix("no") || lower.hasPrefix("deny") { return cOptRed }
        if sc == "y" || sc == "a" || lower.hasPrefix("yes") || lower.hasPrefix("apply") { return cOptGreen }
        return cOptTeal
    }

    // Cycling option background colors (SD+ pattern)
    static let optionBgCycle: [CGColor] = [
        rgb(30, 58, 95), rgb(30, 58, 74), rgb(42, 30, 74), rgb(30, 74, 58), rgb(58, 30, 42),
    ]

    struct KeyDef { let id: Int; let col: Int; let row: Int }
    static let keyDefs: [KeyDef] = [
        KeyDef(id: 0, col: 0, row: 0), KeyDef(id: 1, col: 1, row: 0),
        KeyDef(id: 2, col: 2, row: 0), KeyDef(id: 3, col: 3, row: 0),
        KeyDef(id: 4, col: 4, row: 0), KeyDef(id: 5, col: 0, row: 1),
        KeyDef(id: 6, col: 1, row: 1), KeyDef(id: 7, col: 2, row: 1),
        KeyDef(id: 8, col: 3, row: 1), KeyDef(id: 9, col: 4, row: 1),
        KeyDef(id: 10, col: 0, row: 2), KeyDef(id: 11, col: 1, row: 2),
        KeyDef(id: 12, col: 2, row: 2), KeyDef(id: 13, col: 3, row: 2),
    ]

    // MARK: - Mode A: Session List

    static func computeSessionListSlots(
        sessions: [D200hSessionInfo], stateEvent: [String: Any]?, usageEvent: [String: Any]?,
        page: Int, animFrame: Int
    ) -> ([ButtonSlot], Bool) {
        var slots = [ButtonSlot](repeating: .dim, count: 14)
        var needsAnim = false

        // Slots 0-12: sessions (13 per page), slot 13: usage monitor (big merged button)
        let startIdx = page * 13
        for i in 0..<13 {
            let sessionIdx = startIdx + i
            guard sessionIdx < sessions.count else { break }
            let session = sessions[sessionIdx]

            let bg = sessionBg(session.state)
            let sColor = stateColor(session.state, agent: session.agentType)
            let brandColor = agentBrandColor(session.agentType)
            let projName = session.displayName.isEmpty ? session.agentType : String(session.displayName.prefix(14))

            let border: ButtonSlot.BorderStyle
            let isStable = d200hStableStockHidEnabled()
            // In stable-stock mode the animation loop is forcibly disabled
            // (see setNeedsAnimation). Pin the pulse frame to a sin-peak so the
            // frozen snapshot renders bright instead of landing on a dim phase.
            // For processing, swap the flowing-dash border for a solid glow:
            // a frozen dasharray reads as "broken animation" instead of
            // "working", while a solid bright amber ring reads cleanly as
            // active.
            let pulseFrame = isStable ? 5 : animFrame  // sin(5*0.3) ≈ 0.997
            if session.isAwaiting {
                border = .awaitingPulse(color: sColor, frame: pulseFrame)
                needsAnim = needsAnim || !isStable
            } else if session.isProcessing {
                border = isStable
                    ? .processingSolid(color: sColor)
                    : .processingDash(color: sColor, frame: animFrame)
                needsAnim = needsAnim || !isStable
            } else {
                border = .none
            }

            let agentLbl: String
            switch session.agentType {
            case "openclaw": agentLbl = "OPENCLAW"
            case "codex-cli": agentLbl = "CODEX CLI"
            case "opencode": agentLbl = "OPENCODE"
            default: agentLbl = "CLAUDE CODE"
            }

            let stateLbl: String
            switch session.state {
            case "processing":
                stateLbl = session.agentType == "openclaw" ? "ROUTING" : "WORKING"
            case "awaiting_permission", "awaiting_option", "awaiting_diff":
                stateLbl = "AWAITING"
            case "idle":
                stateLbl = session.agentType == "openclaw" ? "STANDBY" : "IDLE"
            default: stateLbl = ""
            }

            slots[i] = ButtonSlot(
                title: projName, subtitle: "",
                bg: bg, enabled: true, borderStyle: border,
                icon: sessionGlyph(for: session.agentType),
                iconColor: brandColor,
                statusColor: sColor,
                textOverlay: sessionTextOverlayEnabled ? .sessionTile : .none,
                agentLabel: agentLbl,
                modelName: String(session.modelName.prefix(14)),
                stateLabel: stateLbl
            )
        }

        // Slot 13: Usage monitor (big merged button at col3+col4, row2)
        // Rendered separately as two-cell-wide PNG in renderFullZip/renderPartialZip.
        // Keep slot data for reference but it won't go through renderButtonPng.
        slots[13] = .dim

        return (slots, needsAnim)
    }

    // MARK: - Reset Time Formatting

    private static func formatResetTime(_ iso: String?) -> String {
        guard let iso, !iso.isEmpty else { return "" }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fmt.date(from: iso) ?? {
            let basic = ISO8601DateFormatter()
            basic.formatOptions = [.withInternetDateTime]
            return basic.date(from: iso)
        }()
        guard let d = date else { return "" }
        let diff = d.timeIntervalSinceNow
        if diff <= 0 { return "now" }
        let totalMinutes = max(1, Int(ceil(diff / 60)))
        let hours = totalMinutes / 60
        let days = hours / 24
        let remainingHours = hours % 24
        let minutes = totalMinutes % 60
        if days > 0 && remainingHours > 0 { return "\(days)d\(remainingHours)h" }
        if days > 0 { return "\(days)d" }
        if hours > 0 && minutes > 0 { return "\(hours)h\(minutes)m" }
        if hours > 0 { return "\(hours)h" }
        return "\(minutes)m"
    }

    // MARK: - Mode B: Option Select

    static func computeOptionSelectSlots(
        session: D200hSessionInfo, page: Int
    ) -> [ButtonSlot] {
        var slots = [ButtonSlot](repeating: .dim, count: 14)

        // Slot 0: ← BACK
        slots[0] = ButtonSlot(title: "← BACK", subtitle: "", bg: cDark, enabled: true, borderStyle: .none, icon: .back, iconColor: rgb(226, 232, 240))

        // Slot 1: Session info (full tile with creature icon + model + state, matching SD+ renderDetailInfo)
        let name = session.displayName.isEmpty ? session.agentType : String(session.displayName.prefix(12))
        let sColor = stateColor(session.state, agent: session.agentType)
        let brandColor = agentBrandColor(session.agentType)
        let tool = session.currentTool.isEmpty ? "" : "▶ \(session.currentTool)"
        let detailStateLbl: String
        switch session.state {
        case "processing": detailStateLbl = session.agentType == "openclaw" ? "ROUTING" : "WORKING"
        case _ where session.state.hasPrefix("awaiting"): detailStateLbl = "AWAITING"
        case "idle": detailStateLbl = session.agentType == "openclaw" ? "STANDBY" : "IDLE"
        default: detailStateLbl = ""
        }
        slots[1] = ButtonSlot(title: name, subtitle: tool,
                              bg: cDetailBg, enabled: false,
                              borderStyle: .solid(color: sColor),
                              icon: sessionGlyph(for: session.agentType),
                              iconColor: brandColor,
                              statusColor: sColor,
                              textOverlay: .sessionTile,
                              modelName: String(session.modelName.prefix(14)),
                              stateLabel: detailStateLbl)

        // Slots 2-9: Options or Quick Actions
        let options = session.options
        if options.isEmpty && session.isIdle {
            // IDLE: show default quick actions
            let quickActions: [(title: String, bg: CGColor)] = [
                ("GO ON",   rgb(30, 58, 47)),    // green-dark
                ("REVIEW",  cSessionAct),
                ("COMMIT",  cSessionAct),
                ("CLEAR",   cSessionAct),
            ]
            let quickActionGlyphs: [ButtonSlot.IconGlyph] = [.goOn, .review, .commit, .clear]
            for (i, qa) in quickActions.enumerated() {
                slots[2 + i] = ButtonSlot(
                    title: qa.title,
                    subtitle: "",
                    bg: qa.bg,
                    enabled: true,
                    borderStyle: .none,
                    icon: quickActionGlyphs[i],
                    iconColor: rgb(241, 245, 249)
                )
            }
        } else if options.isEmpty && session.isProcessing {
            // PROCESSING: show current tool info, no actions
            if !session.currentTool.isEmpty {
                slots[2] = ButtonSlot(title: "▶ \(session.currentTool)", subtitle: "", bg: cSessionAct, enabled: false, borderStyle: .none, icon: .tool, iconColor: rgb(191, 219, 254))
            }
        } else {
            // AWAITING: show actual options
            let startIdx = page * 8
            for i in 0..<8 {
                let optIdx = startIdx + i
                guard optIdx < options.count else { break }
                let opt = options[optIdx]
                let label = opt["label"] as? String ?? ""
                let shortcut = opt["shortcut"] as? String ?? ""
                let recommended = opt["recommended"] as? Bool ?? false
                let bg = optionBgColor(label: label, shortcut: shortcut)
                let displayLabel = label.count <= 12 ? label.uppercased() : String(label.prefix(14))
                let badge = recommended ? "★ " : ""

                slots[2 + i] = ButtonSlot(
                    title: "\(badge)\(displayLabel)", subtitle: "",
                    bg: bg, enabled: true, borderStyle: .none,
                    icon: .review,
                    iconColor: recommended ? rgb(250, 204, 21) : rgb(226, 232, 240)
                )
            }
        }

        // Slot 10: STOP/ESC combined (bottom-left)
        if session.isProcessing {
            slots[10] = ButtonSlot(title: "■ STOP", subtitle: "", bg: cStopActive, enabled: true, borderStyle: .none, icon: .stop, iconColor: rgb(254, 226, 226))
        } else {
            slots[10] = ButtonSlot(title: "✖ ESC", subtitle: "", bg: cEscActive, enabled: true, borderStyle: .none, icon: .back, iconColor: rgb(226, 232, 240))
        }

        // Slot 11: MORE (if overflow)
        if options.count > (page + 1) * 8 {
            slots[11] = ButtonSlot(title: "▶ MORE", subtitle: "", bg: cSessionDef, enabled: true, borderStyle: .none, icon: .more, iconColor: rgb(226, 232, 240))
        }

        // Slot 13: ← BACK (big merged button)
        slots[13] = ButtonSlot(title: "← BACK", subtitle: "", bg: cDark, enabled: true, borderStyle: .none, icon: .back, iconColor: rgb(226, 232, 240))

        return slots
    }

    private static func sessionGlyph(for agentType: String) -> ButtonSlot.IconGlyph {
        switch agentType {
        case "codex-cli": return .codexCli
        case "opencode": return .openCode
        case "openclaw": return .openClaw
        default: return .claudeCode
        }
    }

    // MARK: - Render ZIP

    /// Full dashboard ZIP (all 13 buttons) — used for layout changes
    static func renderFullZip(
        slots: [ButtonSlot], sessions: [D200hSessionInfo],
        stateEvent: [String: Any]?, usageEvent: [String: Any]?,
        optionMode: Bool, sessionPage: Int, focusedSessionId: String?
    ) -> Data {
        var manifest: [String: Any] = [:]
        var files: [(name: String, data: Data)] = []

        for (i, key) in keyDefs.enumerated() {
            if i == 13 { continue } // Slot 13 handled below as merged button
            let slot = slots[i]
            let colRow = "\(key.col)_\(key.row)"
            let png = renderButtonPng(slot)
            let iconPath = iconFilePath(slotId: key.id, data: png)
            let label = manifestText(for: slot, optionMode: optionMode, slotId: key.id)
            let actionPath = actionPath(for: slot, slotId: key.id, optionMode: optionMode, sessions: sessions, sessionPage: sessionPage, focusedSessionId: focusedSessionId)
            manifest[colRow] = manifestEntry(text: label, iconPath: iconPath, actionPath: actionPath)
            files.append((iconPath, png))
        }

        if !optionMode {
            // Slot 13: big merged usage button spans col3+col4 at row2.
            // When upstream has no live Claude usage (in-process daemon with
            // no CLI relay, OAuth missing, stale flag set) render a neutral
            // blank tile instead of gauge+"STALE" text — a frozen number
            // reads as current, even with a stale marker. Matches the
            // blank-when-nil behavior on every other AgentDeck surface.
            let pct5Opt = usageEvent?["fiveHourPercent"] as? Double ?? stateEvent?["fiveHourPercent"] as? Double
            let pct7Opt = usageEvent?["sevenDayPercent"] as? Double ?? stateEvent?["sevenDayPercent"] as? Double
            let usageStale = usageEvent?["usageStale"] as? Bool ?? stateEvent?["usageStale"] as? Bool ?? false
            let usageLive = !usageStale && (pct5Opt != nil || pct7Opt != nil)

            let png: Data
            let label: String
            if usageLive {
                let pct5 = pct5Opt ?? 0
                let pct7 = pct7Opt ?? 0
                let reset5 = usageEvent?["fiveHourResetsAt"] as? String ?? stateEvent?["fiveHourResetsAt"] as? String
                let reset7 = usageEvent?["sevenDayResetsAt"] as? String ?? stateEvent?["sevenDayResetsAt"] as? String
                let renewal = billingSummary(from: usageEvent) ?? billingSummary(from: stateEvent)
                png = renderUsageWideButton(pct5: pct5, pct7: pct7, reset5: reset5, reset7: reset7, renewal: renewal, stale: false)
                label = hidesNativeSessionLabels ? "" : usageText(window: "5H", percent: pct5)
            } else {
                png = renderBlankWideButton()
                label = ""
            }

            let iconPath = iconFilePath(slotId: 13, suffix: "wide", data: png)
            manifest["3_2"] = manifestEntry(text: label, iconPath: iconPath, clearAction: true)
            files.append((iconPath, png))
        } else {
            // Option-select mode: slot 13 is the BACK affordance, rendered as a
            // wide 392x196 tile. The back navigation is handled locally in
            // `resolveButtonCommand` via the Keyboard HID input report, so the
            // manifest `Action` field is only used by the stock firmware to
            // route taps — and any non-stock value there makes the firmware
            // fall back to rendering its stock smallwindow clock layer on the
            // same coordinates, producing the overlapping-clock symptom. Use
            // `clearAction: true` (Action="") which is the documented escape
            // hatch (DEVELOPMENT_LOG 2026-04-12 "usage manifest empty action
            // clears clock widget overlay") and matches what the session-list
            // branch above already does.
            let mergedSlot = slots[13]
            let png = renderWideButton(left: mergedSlot, right: mergedSlot)
            let iconPath = iconFilePath(slotId: 13, suffix: "wide", data: png)
            manifest["3_2"] = manifestEntry(
                text: manifestText(for: mergedSlot, optionMode: optionMode, slotId: 13),
                iconPath: iconPath,
                clearAction: true
            )
            files.append((iconPath, png))
        }

        if let manifestData = try? JSONSerialization.data(withJSONObject: manifest) {
            files.append(("manifest.json", manifestData))
        }
        return buildValidatedZip(files)
    }

    /// Partial ZIP (only specified buttons) — used for animation frames
    static func renderPartialZip(
        slots: [ButtonSlot], buttonIds: [Int],
        optionMode: Bool, sessions: [D200hSessionInfo], sessionPage: Int, focusedSessionId: String?
    ) -> Data {
        var manifest: [String: Any] = [:]
        var files: [(name: String, data: Data)] = []

        for btnId in buttonIds {
            if btnId == 13 {
                guard optionMode, btnId < slots.count else { continue }
                let mergedSlot = slots[13]
                let png = renderWideButton(left: mergedSlot, right: mergedSlot)
                let iconPath = iconFilePath(slotId: 13, suffix: "wide", data: png)
                manifest["3_2"] = manifestEntry(
                    text: manifestText(for: mergedSlot, optionMode: optionMode, slotId: 13),
                    iconPath: iconPath,
                    clearAction: true
                )
                files.append((iconPath, png))
                continue
            }
            guard btnId < keyDefs.count, btnId < slots.count else { continue }
            let key = keyDefs[btnId]
            let slot = slots[btnId]
            let colRow = "\(key.col)_\(key.row)"
            let png = renderButtonPng(slot)
            let iconPath = iconFilePath(slotId: key.id, data: png)
            let label = manifestText(for: slot, optionMode: optionMode, slotId: key.id)
            let actionPath = actionPath(for: slot, slotId: key.id, optionMode: optionMode, sessions: sessions, sessionPage: sessionPage, focusedSessionId: focusedSessionId)
            manifest[colRow] = manifestEntry(text: label, iconPath: iconPath, actionPath: actionPath)
            files.append((iconPath, png))
        }

        if let manifestData = try? JSONSerialization.data(withJSONObject: manifest) {
            files.append(("manifest.json", manifestData))
        }
        return buildValidatedZip(files)
    }

    // MARK: - Usage Merged Button (slot 13, 2 columns wide)

    /// Render the merged 5H/7D window as one 392x196 image, matching the D200H simulator.
    /// Neutral empty wide tile for slot 13 when Claude usage data isn't
    /// live. Just the dark card background — no gauges, no text, no stale
    /// marker. Firmware still gets a valid PNG so it doesn't fall back to
    /// the stock clock overlay on that slot.
    private static func renderBlankWideButton() -> Data {
        let width = ICON_SIZE * 2
        let height = ICON_SIZE
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return Data() }
        let w = CGFloat(width)
        let h = CGFloat(height)
        drawInTopDownCoordinates(ctx, canvasHeight: h) {
            ctx.setFillColor(rgb(15, 23, 42))
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        }
        return pngImage(ctx)
    }

    private static func renderUsageWideButton(
        pct5: Double, pct7: Double,
        reset5: String? = nil, reset7: String? = nil,
        renewal: String? = nil,
        stale: Bool = false
    ) -> Data {
        let width = ICON_SIZE * 2
        let height = ICON_SIZE
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return Data() }

        let w = CGFloat(width)
        let h = CGFloat(height)
        let color5 = stale ? rgb(100, 116, 139) : pctColor(pct5)
        let color7 = stale ? rgb(100, 116, 139) : pctColor(pct7)
        let reset5Str = formatResetTime(reset5)
        let reset7Str = formatResetTime(reset7)
        let billing = sanitizeNativeText(renewal ?? "")

        drawInTopDownCoordinates(ctx, canvasHeight: h) {
            ctx.setFillColor(rgb(15, 23, 42))
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))

            drawUsageSegmentGauge(ctx, x: 78, y: 53, pct: pct5, color: color5)
            drawUsageSegmentGauge(ctx, x: 78, y: 105, pct: pct7, color: color7)
        }

        drawText(stale ? "USAGE STALE" : "USAGE", ctx: ctx, y: 22, color: stale ? rgb(245, 158, 11) : rgb(148, 163, 184), font: ctFont(22, bold: true), leftBound: 0, rightBound: w, alignLeft: false, canvasHeight: h)

        drawText("5H", ctx: ctx, y: 49, color: rgb(148, 163, 184), font: ctFont(22, bold: true), leftBound: 34, rightBound: 68, alignLeft: true, canvasHeight: h)
        drawText("\(Int(pct5.rounded()))%", ctx: ctx, y: 44, color: rgb(255, 255, 255), font: ctFont(26, bold: true), leftBound: 302, rightBound: 366, alignLeft: false, canvasHeight: h)
        if !reset5Str.isEmpty {
            drawText(reset5Str, ctx: ctx, y: 74, color: rgb(148, 163, 184), font: ctFont(17, bold: true), leftBound: 288, rightBound: 366, alignLeft: false, canvasHeight: h)
        }

        drawText("7D", ctx: ctx, y: 101, color: rgb(148, 163, 184), font: ctFont(22, bold: true), leftBound: 34, rightBound: 68, alignLeft: true, canvasHeight: h)
        drawText("\(Int(pct7.rounded()))%", ctx: ctx, y: 96, color: rgb(255, 255, 255), font: ctFont(26, bold: true), leftBound: 302, rightBound: 366, alignLeft: false, canvasHeight: h)
        if !reset7Str.isEmpty {
            drawText(reset7Str, ctx: ctx, y: 126, color: rgb(148, 163, 184), font: ctFont(17, bold: true), leftBound: 288, rightBound: 366, alignLeft: false, canvasHeight: h)
        }

        if stale {
            drawText("cached Claude usage", ctx: ctx, y: 140, color: rgb(245, 158, 11), font: ctFont(16, bold: true), leftBound: 24, rightBound: w - 24, alignLeft: false, canvasHeight: h)
        } else if !billing.isEmpty {
            drawText(String(billing.prefix(30)), ctx: ctx, y: 140, color: rgb(100, 116, 139), font: ctFont(16, bold: true), leftBound: 24, rightBound: w - 24, alignLeft: false, canvasHeight: h)
        }

        return pngImage(ctx)
    }

    private static func drawUsageSegmentGauge(_ ctx: CGContext, x: CGFloat, y: CGFloat, pct: Double, color: CGColor) {
        let segments = 8
        let segmentWidth: CGFloat = 20
        let segmentHeight: CGFloat = 18
        let gap: CGFloat = 5
        let filled = Int(round(max(0, min(100, pct)) / 100 * Double(segments)))
        for i in 0..<segments {
            let rect = CGRect(x: x + CGFloat(i) * (segmentWidth + gap), y: y, width: segmentWidth, height: segmentHeight)
            ctx.setFillColor(i < filled ? color : rgb(30, 41, 59))
            ctx.setAlpha(i < filled ? 0.88 : 0.78)
            ctx.addPath(CGPath(roundedRect: rect, cornerWidth: 4, cornerHeight: 4, transform: nil))
            ctx.fillPath()
        }
        ctx.setAlpha(1)
    }

    private static func drawUsageLimitRow(
        _ ctx: CGContext, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat = 18,
        pct: Double, color: CGColor, minFill: CGFloat? = nil, fillAlpha: CGFloat = 0.82, strokeAlpha: CGFloat = 0.28
    ) {
        let fillW = max(minFill ?? height, width * CGFloat(max(0, min(100, pct))) / 100)
        let rect = CGRect(x: x, y: y, width: width, height: height)
        let fillRect = CGRect(x: x, y: y, width: fillW, height: height)
        ctx.setAlpha(1.0)
        ctx.setFillColor(rgb(12, 13, 18))
        ctx.addPath(CGPath(roundedRect: rect, cornerWidth: height / 2, cornerHeight: height / 2, transform: nil))
        ctx.fillPath()
        ctx.setAlpha(fillAlpha)
        ctx.setFillColor(color)
        ctx.addPath(CGPath(roundedRect: fillRect, cornerWidth: height / 2, cornerHeight: height / 2, transform: nil))
        ctx.fillPath()
        if strokeAlpha > 0 {
            ctx.setAlpha(strokeAlpha)
            ctx.setStrokeColor(color)
            ctx.setLineWidth(1)
            ctx.addPath(CGPath(roundedRect: rect, cornerWidth: height / 2, cornerHeight: height / 2, transform: nil))
            ctx.strokePath()
        }
        ctx.setAlpha(1.0)
    }

    /// Render usage as two buttons with percentage, gauge color, and reset time.
    private static func renderUsageMergedButton(
        pct5: Double, pct7: Double,
        reset5: String? = nil, reset7: String? = nil
    ) -> (left: Data, right: Data) {
        let color5 = pctColor(pct5)
        let color7 = pctColor(pct7)
        let reset5Str = formatResetTime(reset5)
        let reset7Str = formatResetTime(reset7)
        let leftSlot = ButtonSlot(
            title: "5H",
            subtitle: "\(Int(pct5.rounded()))%",
            bg: cDetailBg,
            enabled: false,
            borderStyle: .solid(color: color5),
            icon: .usage,
            iconColor: color5,
            statusColor: color5,
            textOverlay: .usageStat,
            resetTime: reset5Str
        )
        let rightSlot = ButtonSlot(
            title: "7D",
            subtitle: "\(Int(pct7.rounded()))%",
            bg: cDetailBg,
            enabled: false,
            borderStyle: .solid(color: color7),
            icon: .usage,
            iconColor: color7,
            statusColor: color7,
            textOverlay: .usageStat,
            resetTime: reset7Str
        )
        return (renderButtonPng(leftSlot), renderButtonPng(rightSlot))
    }

    private static func pctColor(_ pct: Double) -> CGColor {
        if pct > 80 { return rgb(239, 68, 68) }
        if pct > 50 { return rgb(234, 179, 8) }
        return rgb(34, 197, 94)
    }

    private static func usageText(window: String, percent: Double) -> String {
        "\(window) \(Int(percent.rounded()))%"
    }

    private static func billingSummary(from event: [String: Any]?) -> String? {
        guard let event else { return nil }
        if let subscriptions = event["subscriptions"] as? [[String: Any]] {
            let parts = subscriptions.compactMap { sub -> String? in
                guard let name = sub["name"] as? String,
                      let until = sub["until"] as? String,
                      let date = formatBillingDate(until) else { return nil }
                return "\(name) \(date)"
            }
            if !parts.isEmpty { return parts.joined(separator: " · ") }
        }
        if let plan = event["codexPlanType"] as? String,
           let until = event["codexSubscriptionActiveUntil"] as? String,
           let date = formatBillingDate(until) {
            return "\(chatGptPlanDisplay(plan)) \(date)"
        }
        return nil
    }

    private static func chatGptPlanDisplay(_ raw: String) -> String {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "plus": return "ChatGPT Plus"
        case "pro": return "ChatGPT Pro"
        case "team": return "ChatGPT Team"
        case "enterprise": return "ChatGPT Enterprise"
        default: return "ChatGPT \(raw)"
        }
    }

    private static func formatBillingDate(_ raw: String) -> String? {
        let date: Date?
        if raw.contains("T") {
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            date = fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        } else {
            let parser = DateFormatter()
            parser.locale = Locale(identifier: "en_US_POSIX")
            parser.dateFormat = "yyyy-MM-dd"
            date = parser.date(from: raw)
        }
        guard let date else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d"
        return formatter.string(from: date)
    }

    private static func manifestText(for slot: ButtonSlot, optionMode: Bool, slotId: Int) -> String {
        if slot.textOverlay != .none {
            return ""
        }
        let rawCandidates: [String]
        if optionMode {
            rawCandidates = slotId == 13 ? [slot.title] : [slot.title, slot.subtitle]
        } else {
            rawCandidates = [slot.title]
        }

        for raw in rawCandidates where !raw.isEmpty {
            let sanitized = sanitizeNativeText(raw)
            if !sanitized.isEmpty {
                return String(sanitized.prefix(18))
            }
        }
        return ""
    }

    /// Builds a stock-firmware manifest entry.
    ///
    /// CRITICAL INVARIANT for the merged usage slot `3_2`: always pass
    /// `clearAction: true`. Any other value (including `actionPath: nil`
    /// which produces an entry with no Action field at all, and any custom
    /// `agentdeck://...` URI) causes the D200H firmware to fall back to
    /// rendering its stock smallwindow clock widget on the same
    /// coordinates as our usage icon, producing the "overlapping clock"
    /// regression that keeps resurfacing whenever this code is touched.
    /// The empty-string `Action=""` is the only reliably tested escape
    /// hatch (DEVELOPMENT_LOG 2026-04-12 and 2026-04-19).
    private static func manifestEntry(
        text: String, iconPath: String, actionPath: String? = nil, clearAction: Bool = false
    ) -> [String: Any] {
        var entry: [String: Any] = [
            "State": 0,
            "ViewParam": [[
                "Text": text,
                "Icon": iconPath,
            ]],
        ]
        if clearAction {
            entry["Action"] = ""
        } else {
            if let actionPath {
                entry["Action"] = "com.ulanzi.ulanzideck.system.open"
                entry["ActionParam"] = ["Path": actionPath]
            }
        }
        return entry
    }

    private static func actionPath(
        for slot: ButtonSlot, slotId: Int, optionMode: Bool,
        sessions: [D200hSessionInfo], sessionPage: Int, focusedSessionId: String?
    ) -> String? {
        if !optionMode {
            guard slot.enabled else { return nil }
            let sessionIdx = sessionPage * 13 + slotId
            guard sessionIdx < sessions.count else { return nil }
            return "agentdeck://session/\(sessions[sessionIdx].id)"
        } else {
            guard slot.enabled else { return nil }
            switch slotId {
            case 0, 13:
                return "agentdeck://back"
            case 1:
                return nil
            case 2...9:
                return "agentdeck://option/\(focusedSessionId ?? "session")/\(slotId)"
            case 10:
                return slot.title.contains("STOP") ? "agentdeck://interrupt" : "agentdeck://escape"
            case 11:
                return "agentdeck://more"
            default:
                return nil
            }
        }
    }

    private static func renderMirroredMergedButton(_ slot: ButtonSlot) -> (left: Data, right: Data) {
        let png = renderButtonPng(slot)
        return (png, png)
    }

    private static func renderWideButton(left: ButtonSlot, right: ButtonSlot) -> Data {
        let width = ICON_SIZE * 2
        let height = ICON_SIZE
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return Data() }
        guard let leftImage = CGImageSourceCreateWithData(renderButtonPng(left) as CFData, nil).flatMap({ CGImageSourceCreateImageAtIndex($0, 0, nil) }),
              let rightImage = CGImageSourceCreateWithData(renderButtonPng(right) as CFData, nil).flatMap({ CGImageSourceCreateImageAtIndex($0, 0, nil) }) else {
            return Data()
        }
        ctx.draw(leftImage, in: CGRect(x: 0, y: 0, width: ICON_SIZE, height: ICON_SIZE))
        ctx.draw(rightImage, in: CGRect(x: ICON_SIZE, y: 0, width: ICON_SIZE, height: ICON_SIZE))
        return pngImage(ctx)
    }

    private static func iconFilePath(slotId: Int, suffix: String? = nil, data: Data) -> String {
        let middle = suffix.map { "-\($0)" } ?? ""
        return "icons/btn\(slotId)\(middle)-\(D200H_RENDERER_REV)-\(fnv1a32Hex(data)).png"
    }

    private static func fnv1a32Hex(_ data: Data) -> String {
        var hash: UInt32 = 0x811c9dc5
        for byte in data {
            hash ^= UInt32(byte)
            hash = hash &* 0x01000193
        }
        return String(format: "%08x", hash)
    }

    private static func pngImage(_ ctx: CGContext) -> Data {
        guard let image = ctx.makeImage() else { return Data() }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else { return Data() }
        CGImageDestinationAddImage(dest, image, nil)
        CGImageDestinationFinalize(dest)
        return data as Data
    }

    private static func sanitizeNativeText(_ raw: String) -> String {
        let ascii = String(raw.unicodeScalars.filter { scalar in
            scalar.value >= 0x20 && scalar.value <= 0x7E
        })
        let collapsed = ascii.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return collapsed.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Builds a D200H-compatible ZIP where no packet boundary (offsets 1016,
    /// 2040, 3064, ...) falls on a 0x00 or 0x7C byte — the firmware treats
    /// those bytes at those offsets as framing sentinels and rejects the
    /// whole payload, reverting the display to its stock UI (clock visible,
    /// buttons blank or partially rendered). Returns an empty `Data` when
    /// the padding search fails to converge, which the caller MUST treat as
    /// "drop this frame" rather than writing a malformed ZIP to the device
    /// — the latter is exactly the failure mode that shows up as half-drawn
    /// creatures with unresponsive keys and is a significant contributor to
    /// the recurring regression cycle reflected in `stock-safe-v19`.
    private static func buildValidatedZip(_ files: [(name: String, data: Data)]) -> Data {
        var extraLengths = [Int](repeating: 0, count: files.count)

        for _ in 0..<256 {
            let artifact = createZipInMemory(files, extraLengths: extraLengths)
            guard let invalidOffset = firstInvalidZipBoundaryOffset(artifact.data) else {
                return artifact.data
            }
            guard let targetIndex = artifact.layouts.lastIndex(where: { $0.extraInsertOffset <= invalidOffset }) else {
                return artifact.data
            }

            let layout = artifact.layouts[targetIndex]
            let currentExtra = extraLengths[targetIndex]
            var shift = 1
            while true {
                if invalidOffset < layout.extraInsertOffset + currentExtra + shift { break }
                let candidate = artifact.data[invalidOffset - shift]
                if candidate != 0x00 && candidate != 0x7C { break }
                shift += 1
                if shift > 512 { break }
            }
            extraLengths[targetIndex] = normalizedZipExtraLength(extraLengths[targetIndex] + shift)
        }

        DaemonLogger.shared.info("D200H ZIP boundary validation failed after 256 padding iterations — dropping this frame to avoid sending a malformed payload to the device")
        return Data()
    }
}

// MARK: - Color Helper

private func rgb(_ r: Int, _ g: Int, _ b: Int) -> CGColor {
    CGColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1.0)
}

// MARK: - CoreText Helper (SD+ quality text rendering)

private func ctFont(_ size: CGFloat, bold: Bool = false) -> CTFont {
    let name = bold ? "HelveticaNeue-Bold" as CFString : "HelveticaNeue" as CFString
    return CTFontCreateWithName(name, size, nil)
}

/// Draw CoreText string horizontally within [leftBound, rightBound], at given y (top-down, auto-flipped)
private func drawText(
    _ text: String, ctx: CGContext, y: CGFloat, color: CGColor,
    font: CTFont, leftBound: CGFloat = 14, rightBound: CGFloat = 182, alpha: CGFloat = 1.0, alignLeft: Bool = false,
    canvasHeight: CGFloat = CGFloat(ICON_SIZE)
) {
    let s = canvasHeight
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: color,
    ]
    let attrStr = NSAttributedString(string: text, attributes: attrs)
    let line = CTLineCreateWithAttributedString(attrStr)
    let bounds = CTLineGetBoundsWithOptions(line, [])
    let maxW = rightBound - leftBound
    let textW = min(bounds.width, maxW)
    let tx = alignLeft ? leftBound : leftBound + (maxW - textW) / 2
    let flippedY = s - y - bounds.height
    ctx.saveGState()
    if alpha < 1.0 { ctx.setAlpha(alpha) }
    // Clip to available width to avoid overflow
    ctx.clip(to: CGRect(x: leftBound, y: 0, width: maxW, height: s))
    ctx.textPosition = CGPoint(x: tx, y: flippedY)
    CTLineDraw(line, ctx)
    ctx.restoreGState()
}

// MARK: - SD+ Style Rich Button PNG Rendering

private func renderButtonPng(_ slot: ButtonSlot) -> Data {
    let size = ICON_SIZE  // 196
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil, width: size, height: size,
        bitsPerComponent: 8, bytesPerRow: size * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { return Data() }

    let s = CGFloat(size)
    let isBrandTile = isSessionBrandGlyph(slot.icon)
    let pad: CGFloat = isBrandTile ? 18 : 4
    let cornerR: CGFloat = isBrandTile ? 13 : 16
    let innerRect = CGRect(x: pad, y: pad, width: s - pad * 2, height: s - pad * 2)
    let innerPath = CGPath(roundedRect: innerRect, cornerWidth: cornerR, cornerHeight: cornerR, transform: nil)
    let buttonBg = isBrandTile ? rgb(28, 28, 30) : slot.bg

    // 1. Dark canvas background
    ctx.setFillColor(isBrandTile ? rgb(13, 13, 18) : rgb(13, 13, 18))
    ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

    // 2. Rounded rect button background with a slight depth band, but no large gradients
    // so the PNG remains firmware-safe and highly compressible.
    ctx.saveGState()
    ctx.addPath(innerPath)
    ctx.clip()
    ctx.setFillColor(buttonBg)
    ctx.fill(innerRect)
    ctx.setFillColor(blendColor(buttonBg, toward: (1, 1, 1), ratio: 0.16))
    ctx.setAlpha(0.08)
    ctx.fill(CGRect(x: innerRect.minX, y: innerRect.minY, width: innerRect.width, height: 34))
    ctx.setFillColor(blendColor(buttonBg, toward: (0, 0, 0), ratio: 0.34))
    ctx.setAlpha(0.12)
    ctx.fill(CGRect(x: innerRect.minX, y: innerRect.maxY - 44, width: innerRect.width, height: 44))
    ctx.setAlpha(1.0)
    ctx.restoreGState()

    // 3. Border animation
    switch slot.borderStyle {
    case .awaitingPulse(let color, let frame):
        let opacity = 0.3 + 0.65 * abs(sin(Double(frame) * 0.3))
        ctx.setShadow(offset: .zero, blur: 8, color: color.copy(alpha: CGFloat(opacity) * 0.55))
        ctx.setStrokeColor(color)
        ctx.setAlpha(CGFloat(opacity) * 0.8)
        ctx.setLineWidth(5.5)
        ctx.addPath(innerPath)
        ctx.strokePath()
        ctx.setAlpha(CGFloat(opacity) * 0.45)
        ctx.setLineWidth(2.5)
        ctx.addPath(innerPath)
        ctx.strokePath()
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        ctx.setAlpha(1.0)

    case .processingDash(let color, let frame):
        let perim = 2 * (s - pad * 2) + 2 * (s - pad * 2)
        let offset = CGFloat((frame * 25) % Int(perim))
        // Outer soft glow pass — gives the "flowing light" impression even
        // when animation is frozen (stable-stock mode).
        ctx.setShadow(offset: .zero, blur: 8, color: color.copy(alpha: 0.55))
        ctx.setStrokeColor(color)
        ctx.setAlpha(0.85)
        ctx.setLineWidth(5)
        ctx.setLineDash(phase: offset, lengths: [50, 70])
        ctx.addPath(innerPath)
        ctx.strokePath()
        // Crisp inner highlight pass
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        ctx.setAlpha(0.95)
        ctx.setLineWidth(2)
        ctx.addPath(innerPath)
        ctx.strokePath()
        ctx.setAlpha(1.0)
        ctx.setLineDash(phase: 0, lengths: [])

    case .processingSolid(let color):
        // Static "WORKING" variant for when the animation loop is disabled
        // (stable-stock mode). Solid glowing ring reads as "active" via color
        // alone — the frozen dashes in `.processingDash` looked awkward when
        // the tick wasn't advancing.
        ctx.setShadow(offset: .zero, blur: 8, color: color.copy(alpha: 0.60))
        ctx.setStrokeColor(color)
        ctx.setAlpha(0.95)
        ctx.setLineWidth(5.5)
        ctx.addPath(innerPath)
        ctx.strokePath()
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        ctx.setAlpha(1.0)
        ctx.setLineWidth(2)
        ctx.addPath(innerPath)
        ctx.strokePath()
        ctx.setAlpha(1.0)

    case .solid(let color):
        ctx.setStrokeColor(color)
        ctx.setAlpha(0.6)
        ctx.setLineWidth(2)
        ctx.addPath(innerPath)
        ctx.strokePath()
        ctx.setAlpha(1.0)

    case .none:
        break
    }

    // 4. Stream Deck-style thin left indicator for session tiles only.
    if slot.enabled && isBrandTile {
        let stripColor: CGColor
        switch slot.borderStyle {
        case .awaitingPulse, .processingDash, .processingSolid, .solid:
            stripColor = slot.statusColor ?? rgb(59, 130, 246)
        case .none:
            stripColor = slot.iconColor ?? rgb(59, 130, 246)
        }
        drawInTopDownCoordinates(ctx) {
            ctx.setFillColor(stripColor)
            ctx.setAlpha(0.78)
            ctx.fill(CGRect(x: pad + 3, y: pad + 34, width: 5, height: s - pad * 2 - 68))
            ctx.setAlpha(1.0)
        }
    }

    // 5. Port the Stream Deck icon language. Text overlays remain opt-in because
    // D200H stock firmware can be selective about rich PNG payloads.
    if slot.icon != .none {
        let iconColor = slot.iconColor ?? rgb(241, 245, 249)
        let iconRect: CGRect
        if isBrandTile {
            iconRect = CGRect(x: 27, y: 29, width: 76, height: 76)
        } else if slot.textOverlay == .usageStat {
            iconRect = CGRect(x: 58, y: 18, width: s - 116, height: 52)
        } else {
            iconRect = CGRect(x: 48, y: 56, width: s - 96, height: 64)
        }
        drawButtonIcon(
            ctx,
            glyph: slot.icon,
            color: iconColor,
            rect: iconRect
        )
    }

    switch slot.textOverlay {
    case .sessionTile:
        drawSessionTextOverlay(ctx, slot: slot)
    case .usageStat:
        drawUsageTextOverlay(ctx, slot: slot)
    case .none:
        break
    }

    // 6. Status dot at Top Right
    if slot.enabled && isBrandTile {
        let dotR: CGFloat = 8
        let dotX: CGFloat = 163
        let dotY: CGFloat = 33
        let dotColor = slot.statusColor ?? rgb(148, 163, 184)

        drawInTopDownCoordinates(ctx) {
            ctx.setFillColor(dotColor)
            ctx.fillEllipse(in: CGRect(x: dotX - dotR, y: dotY - dotR, width: dotR * 2, height: dotR * 2))
        }
    }

    guard let image = ctx.makeImage() else { return Data() }

    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else { return Data() }
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)

    let pngData = data as Data

    // Debug: save first few button PNGs to /tmp for inspection
    if !slot.title.isEmpty {
        struct DebugState { nonisolated(unsafe) static var count = 0 }
        if DebugState.count < 3 {
            try? pngData.write(to: URL(fileURLWithPath: "/tmp/d200h_btn_\(DebugState.count).png"))
            DaemonLogger.shared.debug("D200H", "PNG[\(DebugState.count)] '\(slot.title)' = \(pngData.count) bytes")
            DebugState.count += 1
        }
    }

    return pngData
}

private func drawInTopDownCoordinates(_ ctx: CGContext, canvasHeight: CGFloat = CGFloat(ICON_SIZE), _ draw: () -> Void) {
    let s = canvasHeight
    ctx.saveGState()
    ctx.translateBy(x: 0, y: s)
    ctx.scaleBy(x: 1, y: -1)
    draw()
    ctx.restoreGState()
}

private func drawSessionTextOverlay(_ ctx: CGContext, slot: ButtonSlot) {
    let projectName = String(slot.title.prefix(14))
    let model = String(slot.modelName.prefix(16))
    let state = String(slot.stateLabel.prefix(18))
    let projectFont = ctFont(projectName.count >= 8 ? 20 : 22, bold: true)
    let hasModel = !model.isEmpty
    let leftEdge: CGFloat = 34
    let rightEdge: CGFloat = 174

    drawText(projectName, ctx: ctx, y: hasModel ? 104 : 112, color: rgb(255, 255, 255), font: projectFont, leftBound: leftEdge, rightBound: rightEdge, alignLeft: true)
    
    if hasModel {
        drawText(model, ctx: ctx, y: 126, color: rgb(148, 163, 184), font: ctFont(15, bold: true), leftBound: leftEdge, rightBound: rightEdge, alpha: 0.96, alignLeft: true)
    }
    
    if !state.isEmpty {
        let stateColor = slot.statusColor ?? rgb(148, 163, 184)
        drawText(state, ctx: ctx, y: hasModel ? 148 : 140, color: stateColor, font: ctFont(14, bold: true), leftBound: leftEdge, rightBound: rightEdge, alignLeft: true)
    }
}

private func drawUsageTextOverlay(_ ctx: CGContext, slot: ButtonSlot) {
    let title = String(slot.title.prefix(4))
    let value = String(slot.subtitle.prefix(8))
    let accent = slot.statusColor ?? rgb(34, 197, 94)

    if !title.isEmpty {
        drawText(title, ctx: ctx, y: 100, color: rgb(148, 163, 184), font: ctFont(13, bold: true), leftBound: 28, rightBound: 168)
    }
    if !value.isEmpty {
        drawText(value, ctx: ctx, y: 130, color: accent, font: ctFont(22, bold: true), leftBound: 24, rightBound: 172)
    }
    if !slot.resetTime.isEmpty {
        drawText("↻ \(slot.resetTime)", ctx: ctx, y: 158, color: rgb(100, 116, 139), font: ctFont(11), leftBound: 28, rightBound: 168)
    }
}

private func drawButtonIcon(_ ctx: CGContext, glyph: ButtonSlot.IconGlyph, color: CGColor, rect: CGRect) {
    drawInTopDownCoordinates(ctx) {
        if isSessionBrandGlyph(glyph) {
            drawBrandGlyph(ctx, glyph: glyph, color: color, rect: rect)
            return
        }

        ctx.saveGState()
        ctx.setStrokeColor(color)
        ctx.setFillColor(color)
        ctx.setLineWidth(4)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)

        let midX = rect.midX
        let midY = rect.midY

        switch glyph {
        case .none:
            break
        case .claudeCode, .codexCli, .openCode, .openClaw:
            break
        case .usage:
            let barW: CGFloat = 10
            let spacing: CGFloat = 9
            let startX = midX - (barW * 1.5 + spacing)
            let heights: [CGFloat] = [12, 22, 32]
            for (index, barH) in heights.enumerated() {
                let x = startX + CGFloat(index) * (barW + spacing)
                let barRect = CGRect(x: x, y: midY - 16, width: barW, height: barH)
                ctx.addPath(CGPath(roundedRect: barRect, cornerWidth: 2, cornerHeight: 2, transform: nil))
                ctx.fillPath()
            }
        case .back:
            ctx.move(to: CGPoint(x: midX - 20, y: midY))
            ctx.addLine(to: CGPoint(x: midX + 16, y: midY))
            ctx.move(to: CGPoint(x: midX - 20, y: midY))
            ctx.addLine(to: CGPoint(x: midX - 6, y: midY + 14))
            ctx.move(to: CGPoint(x: midX - 20, y: midY))
            ctx.addLine(to: CGPoint(x: midX - 6, y: midY - 14))
            ctx.strokePath()
        case .stop:
            ctx.fill(CGRect(x: midX - 15, y: midY - 15, width: 30, height: 30))
        case .more:
            ctx.move(to: CGPoint(x: midX - 16, y: midY + 12))
            ctx.addLine(to: CGPoint(x: midX - 2, y: midY))
            ctx.addLine(to: CGPoint(x: midX - 16, y: midY - 12))
            ctx.move(to: CGPoint(x: midX + 2, y: midY + 12))
            ctx.addLine(to: CGPoint(x: midX + 16, y: midY))
            ctx.addLine(to: CGPoint(x: midX + 2, y: midY - 12))
            ctx.strokePath()
        case .goOn:
            ctx.move(to: CGPoint(x: midX - 10, y: midY - 18))
            ctx.addLine(to: CGPoint(x: midX + 18, y: midY))
            ctx.addLine(to: CGPoint(x: midX - 10, y: midY + 18))
            ctx.closePath()
            ctx.fillPath()
        case .review:
            ctx.setLineWidth(2.5)
            ctx.stroke(CGRect(x: midX - 18, y: midY - 22, width: 36, height: 44))
            ctx.setAlpha(0.6)
            ctx.move(to: CGPoint(x: midX - 10, y: midY - 10))
            ctx.addLine(to: CGPoint(x: midX + 10, y: midY - 10))
            ctx.move(to: CGPoint(x: midX - 10, y: midY))
            ctx.addLine(to: CGPoint(x: midX + 6, y: midY))
            ctx.move(to: CGPoint(x: midX - 10, y: midY + 10))
            ctx.addLine(to: CGPoint(x: midX + 2, y: midY + 10))
            ctx.setAlpha(1.0)
            ctx.strokePath()
        case .commit:
            ctx.setLineWidth(2.5)
            ctx.strokeEllipse(in: CGRect(x: midX - 22, y: midY - 22, width: 44, height: 44))
            ctx.move(to: CGPoint(x: midX - 10, y: midY + 1))
            ctx.addLine(to: CGPoint(x: midX - 2, y: midY + 9))
            ctx.addLine(to: CGPoint(x: midX + 12, y: midY - 8))
            ctx.strokePath()
        case .clear:
            ctx.move(to: CGPoint(x: midX - 16, y: midY - 16))
            ctx.addLine(to: CGPoint(x: midX + 16, y: midY + 16))
            ctx.move(to: CGPoint(x: midX + 16, y: midY - 16))
            ctx.addLine(to: CGPoint(x: midX - 16, y: midY + 16))
            ctx.strokePath()
        case .tool:
            ctx.move(to: CGPoint(x: midX - 18, y: midY - 10))
            ctx.addLine(to: CGPoint(x: midX - 2, y: midY + 6))
            ctx.strokePath()
            ctx.strokeEllipse(in: CGRect(x: midX - 26, y: midY - 18, width: 16, height: 16))
            ctx.fillEllipse(in: CGRect(x: midX + 6, y: midY + 2, width: 14, height: 14))
        }

        ctx.restoreGState()
    }
}

private func isSessionBrandGlyph(_ glyph: ButtonSlot.IconGlyph) -> Bool {
    switch glyph {
    case .claudeCode, .codexCli, .openCode, .openClaw:
        return true
    default:
        return false
    }
}

private func drawSessionBadge(_ ctx: CGContext, rect: CGRect, brandColor: CGColor, backgroundColor: CGColor) {
    let badgePath = CGPath(roundedRect: rect, cornerWidth: 18, cornerHeight: 18, transform: nil)
    ctx.saveGState()
    ctx.addPath(badgePath)
    ctx.clip()
    ctx.setFillColor(blendColor(backgroundColor, toward: rgbComponents(brandColor), ratio: 0.22))
    ctx.setAlpha(0.22)
    ctx.fill(rect)
    ctx.setFillColor(blendColor(brandColor, toward: (1, 1, 1), ratio: 0.32))
    ctx.setAlpha(0.10)
    ctx.fill(CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height * 0.42))
    ctx.setAlpha(1.0)
    ctx.restoreGState()

    ctx.setStrokeColor(blendColor(brandColor, toward: (1, 1, 1), ratio: 0.16))
    ctx.setAlpha(0.22)
    ctx.setLineWidth(1.5)
    ctx.addPath(badgePath)
    ctx.strokePath()
    ctx.setAlpha(1.0)
}

private func drawBrandGlyph(_ ctx: CGContext, glyph: ButtonSlot.IconGlyph, color: CGColor, rect: CGRect) {
    switch glyph {
    case .claudeCode:
        fillSvgPath(
            ctx,
            path: D200hBrandAssets.claudePath,
            viewBox: CGRect(x: 0, y: 0, width: 24, height: 24),
            rect: rect,
            fillColor: color,
            eoFill: true
        )
    case .codexCli:
        fillSvgPathGradient(
            ctx,
            path: D200hBrandAssets.codexPath,
            viewBox: CGRect(x: 0, y: 0, width: 24, height: 24),
            rect: rect,
            colors: [rgb(177, 167, 255), rgb(122, 157, 255), color],
            locations: [0.0, 0.48, 1.0],
            start: CGPoint(x: 12, y: 0),
            end: CGPoint(x: 12, y: 24)
        )
    case .openCode:
        fillSvgPath(
            ctx,
            path: D200hBrandAssets.openCodePath,
            viewBox: CGRect(x: 0, y: 0, width: 24, height: 24),
            rect: rect,
            fillColor: color,
            eoFill: true
        )
    case .openClaw:
        let viewBox = CGRect(x: 0, y: 0, width: 120, height: 120)
        let gradientColors = [rgb(255, 77, 77), rgb(153, 27, 27)]
        fillSvgPathGradient(
            ctx,
            path: D200hBrandAssets.openClawBody,
            viewBox: viewBox,
            rect: rect,
            colors: gradientColors,
            locations: [0.0, 1.0],
            start: CGPoint(x: 0, y: 0),
            end: CGPoint(x: 120, y: 120)
        )
        fillSvgPathGradient(
            ctx,
            path: D200hBrandAssets.openClawClawL,
            viewBox: viewBox,
            rect: rect,
            colors: gradientColors,
            locations: [0.0, 1.0],
            start: CGPoint(x: 0, y: 0),
            end: CGPoint(x: 120, y: 120)
        )
        fillSvgPathGradient(
            ctx,
            path: D200hBrandAssets.openClawClawR,
            viewBox: viewBox,
            rect: rect,
            colors: gradientColors,
            locations: [0.0, 1.0],
            start: CGPoint(x: 0, y: 0),
            end: CGPoint(x: 120, y: 120)
        )
        strokeSvgPath(
            ctx,
            path: D200hBrandAssets.openClawAntennaL,
            viewBox: viewBox,
            rect: rect,
            color: color,
            lineWidth: 3
        )
        strokeSvgPath(
            ctx,
            path: D200hBrandAssets.openClawAntennaR,
            viewBox: viewBox,
            rect: rect,
            color: color,
            lineWidth: 3
        )
        fillSvgCircle(ctx, rect: rect, viewBox: viewBox, center: CGPoint(x: 45, y: 35), radius: 6, color: rgb(10, 10, 20))
        fillSvgCircle(ctx, rect: rect, viewBox: viewBox, center: CGPoint(x: 75, y: 35), radius: 6, color: rgb(10, 10, 20))
        fillSvgCircle(ctx, rect: rect, viewBox: viewBox, center: CGPoint(x: 46, y: 34), radius: 2.5, color: rgb(0, 229, 204))
        fillSvgCircle(ctx, rect: rect, viewBox: viewBox, center: CGPoint(x: 76, y: 34), radius: 2.5, color: rgb(0, 229, 204))
    default:
        break
    }
}

private enum D200hBrandAssets {
    // Mirrors plugin/src/renderers/agent-logos.ts so D200H can follow the same brand language.
    nonisolated(unsafe) static let claudePath = parseSvgPathToCGPath(
        "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
    )
    nonisolated(unsafe) static let codexPath = parseSvgPathToCGPath(
        "M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388z"
    )
    nonisolated(unsafe) static let openCodePath = parseSvgPathToCGPath(
        "M18 19.2H6V9.6H18V19.2ZM18 4.8H6V19.2H18V4.8ZM24 24H0V0H24V24Z"
    )
    nonisolated(unsafe) static let openClawBody = parseSvgPathToCGPath(
        "M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"
    )
    nonisolated(unsafe) static let openClawClawL = parseSvgPathToCGPath(
        "M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"
    )
    nonisolated(unsafe) static let openClawClawR = parseSvgPathToCGPath(
        "M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"
    )
    nonisolated(unsafe) static let openClawAntennaL = parseSvgPathToCGPath("M45 15 Q35 5 30 8")
    nonisolated(unsafe) static let openClawAntennaR = parseSvgPathToCGPath("M75 15 Q85 5 90 8")
}

private func fillSvgPath(
    _ ctx: CGContext,
    path: CGPath,
    viewBox: CGRect,
    rect: CGRect,
    fillColor: CGColor,
    eoFill: Bool = false
) {
    ctx.saveGState()
    ctx.concatenate(makeAspectFitTransform(viewBox: viewBox, in: rect))
    ctx.addPath(path)
    ctx.setFillColor(fillColor)
    ctx.drawPath(using: eoFill ? .eoFill : .fill)
    ctx.restoreGState()
}

private func fillSvgPathGradient(
    _ ctx: CGContext,
    path: CGPath,
    viewBox: CGRect,
    rect: CGRect,
    colors: [CGColor],
    locations: [CGFloat],
    start: CGPoint,
    end: CGPoint,
    eoFill: Bool = false
) {
    guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: locations) else {
        fillSvgPath(ctx, path: path, viewBox: viewBox, rect: rect, fillColor: colors.last ?? rgb(255, 255, 255), eoFill: eoFill)
        return
    }
    ctx.saveGState()
    ctx.concatenate(makeAspectFitTransform(viewBox: viewBox, in: rect))
    ctx.addPath(path)
    if eoFill {
        ctx.clip(using: .evenOdd)
    } else {
        ctx.clip()
    }
    ctx.drawLinearGradient(gradient, start: start, end: end, options: [])
    ctx.restoreGState()
}

private func strokeSvgPath(
    _ ctx: CGContext,
    path: CGPath,
    viewBox: CGRect,
    rect: CGRect,
    color: CGColor,
    lineWidth: CGFloat
) {
    ctx.saveGState()
    ctx.concatenate(makeAspectFitTransform(viewBox: viewBox, in: rect))
    ctx.addPath(path)
    ctx.setStrokeColor(color)
    ctx.setLineWidth(lineWidth)
    ctx.setLineCap(.round)
    ctx.strokePath()
    ctx.restoreGState()
}

private func fillSvgCircle(
    _ ctx: CGContext,
    rect: CGRect,
    viewBox: CGRect,
    center: CGPoint,
    radius: CGFloat,
    color: CGColor
) {
    let transform = makeAspectFitTransform(viewBox: viewBox, in: rect)
    let scaledRadius = radius * min(abs(transform.a), abs(transform.d))
    let transformedCenter = center.applying(transform)
    ctx.saveGState()
    ctx.setFillColor(color)
    ctx.fillEllipse(in: CGRect(
        x: transformedCenter.x - scaledRadius,
        y: transformedCenter.y - scaledRadius,
        width: scaledRadius * 2,
        height: scaledRadius * 2
    ))
    ctx.restoreGState()
}

private func makeAspectFitTransform(viewBox: CGRect, in rect: CGRect) -> CGAffineTransform {
    let scale = min(rect.width / viewBox.width, rect.height / viewBox.height)
    let dx = rect.minX + (rect.width - viewBox.width * scale) / 2
    let dy = rect.minY + (rect.height - viewBox.height * scale) / 2
    var transform = CGAffineTransform.identity
    transform = transform.translatedBy(x: dx, y: dy)
    transform = transform.scaledBy(x: scale, y: scale)
    transform = transform.translatedBy(x: -viewBox.minX, y: -viewBox.minY)
    return transform
}

private func rgbComponents(_ color: CGColor) -> (CGFloat, CGFloat, CGFloat) {
    guard let converted = color.converted(to: CGColorSpaceCreateDeviceRGB(), intent: .defaultIntent, options: nil),
          let comps = converted.components, comps.count >= 3 else {
        return (1, 1, 1)
    }
    return (comps[0], comps[1], comps[2])
}

private func blendColor(_ color: CGColor, toward target: (CGFloat, CGFloat, CGFloat), ratio: CGFloat) -> CGColor {
    let (r, g, b) = rgbComponents(color)
    let clamped = max(0, min(1, ratio))
    let nr = r + (target.0 - r) * clamped
    let ng = g + (target.1 - g) * clamped
    let nb = b + (target.2 - b) * clamped
    return CGColor(red: nr, green: ng, blue: nb, alpha: 1.0)
}

private func parseSvgPathToCGPath(_ data: String) -> CGPath {
    let path = CGMutablePath()
    let chars = Array(data)
    var idx = 0
    var currentX: CGFloat = 0
    var currentY: CGFloat = 0
    var startX: CGFloat = 0
    var startY: CGFloat = 0
    var lastCmd: Character = " "
    var lastCPX: CGFloat = 0
    var lastCPY: CGFloat = 0

    func skipWhitespaceAndCommas() {
        while idx < chars.count && (chars[idx] == " " || chars[idx] == "," || chars[idx] == "\n" || chars[idx] == "\r" || chars[idx] == "\t") {
            idx += 1
        }
    }

    func parseNumber() -> CGFloat? {
        skipWhitespaceAndCommas()
        guard idx < chars.count else { return nil }
        var numStr = ""
        if idx < chars.count && (chars[idx] == "-" || chars[idx] == "+") {
            numStr.append(chars[idx])
            idx += 1
        }
        var hasDot = false
        while idx < chars.count && (chars[idx].isNumber || (chars[idx] == "." && !hasDot)) {
            if chars[idx] == "." { hasDot = true }
            numStr.append(chars[idx])
            idx += 1
        }
        if idx < chars.count && (chars[idx] == "e" || chars[idx] == "E") {
            numStr.append(chars[idx])
            idx += 1
            if idx < chars.count && (chars[idx] == "-" || chars[idx] == "+") {
                numStr.append(chars[idx])
                idx += 1
            }
            while idx < chars.count && chars[idx].isNumber {
                numStr.append(chars[idx])
                idx += 1
            }
        }
        return numStr.isEmpty ? nil : CGFloat(Double(numStr) ?? 0)
    }

    while idx < chars.count {
        skipWhitespaceAndCommas()
        guard idx < chars.count else { break }

        var cmd = chars[idx]
        if cmd.isLetter {
            idx += 1
            lastCmd = cmd
        } else {
            cmd = lastCmd
        }

        switch cmd {
        case "M":
            guard let x = parseNumber(), let y = parseNumber() else { break }
            currentX = x; currentY = y; startX = x; startY = y
            path.move(to: CGPoint(x: x, y: y))
            lastCmd = "L"
        case "m":
            guard let dx = parseNumber(), let dy = parseNumber() else { break }
            currentX += dx; currentY += dy; startX = currentX; startY = currentY
            path.move(to: CGPoint(x: currentX, y: currentY))
            lastCmd = "l"
        case "L":
            guard let x = parseNumber(), let y = parseNumber() else { break }
            currentX = x; currentY = y
            path.addLine(to: CGPoint(x: x, y: y))
        case "l":
            guard let dx = parseNumber(), let dy = parseNumber() else { break }
            currentX += dx; currentY += dy
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "H":
            guard let x = parseNumber() else { break }
            currentX = x
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "h":
            guard let dx = parseNumber() else { break }
            currentX += dx
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "V":
            guard let y = parseNumber() else { break }
            currentY = y
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "v":
            guard let dy = parseNumber() else { break }
            currentY += dy
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "C":
            guard let x1 = parseNumber(), let y1 = parseNumber(),
                  let x2 = parseNumber(), let y2 = parseNumber(),
                  let x = parseNumber(), let y = parseNumber() else { break }
            path.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
            lastCPX = x2; lastCPY = y2
            currentX = x; currentY = y
        case "c":
            guard let dx1 = parseNumber(), let dy1 = parseNumber(),
                  let dx2 = parseNumber(), let dy2 = parseNumber(),
                  let dx = parseNumber(), let dy = parseNumber() else { break }
            let x1 = currentX + dx1, y1 = currentY + dy1
            let x2 = currentX + dx2, y2 = currentY + dy2
            let x = currentX + dx, y = currentY + dy
            path.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
            lastCPX = x2; lastCPY = y2
            currentX = x; currentY = y
        case "S":
            guard let x2 = parseNumber(), let y2 = parseNumber(),
                  let x = parseNumber(), let y = parseNumber() else { break }
            let x1 = 2 * currentX - lastCPX
            let y1 = 2 * currentY - lastCPY
            path.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
            lastCPX = x2; lastCPY = y2
            currentX = x; currentY = y
        case "s":
            guard let dx2 = parseNumber(), let dy2 = parseNumber(),
                  let dx = parseNumber(), let dy = parseNumber() else { break }
            let x1 = 2 * currentX - lastCPX
            let y1 = 2 * currentY - lastCPY
            let x2 = currentX + dx2, y2 = currentY + dy2
            let x = currentX + dx, y = currentY + dy
            path.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
            lastCPX = x2; lastCPY = y2
            currentX = x; currentY = y
        case "Q":
            guard let cx = parseNumber(), let cy = parseNumber(),
                  let x = parseNumber(), let y = parseNumber() else { break }
            path.addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: cx, y: cy))
            lastCPX = cx; lastCPY = cy
            currentX = x; currentY = y
        case "q":
            guard let dcx = parseNumber(), let dcy = parseNumber(),
                  let dx = parseNumber(), let dy = parseNumber() else { break }
            let cx = currentX + dcx, cy = currentY + dcy
            let x = currentX + dx, y = currentY + dy
            path.addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: cx, y: cy))
            lastCPX = cx; lastCPY = cy
            currentX = x; currentY = y
        case "A", "a":
            let isRelative = cmd == "a"
            while let rx = parseNumber(), let ry = parseNumber(),
                  let xRotation = parseNumber(), let largeArcFlag = parseNumber(),
                  let sweepFlag = parseNumber(), let rawX = parseNumber(), let rawY = parseNumber() {
                let endX = isRelative ? currentX + rawX : rawX
                let endY = isRelative ? currentY + rawY : rawY
                appendSvgArcToBeziers(
                    path,
                    cx: currentX, cy: currentY,
                    rx: abs(rx), ry: abs(ry),
                    xRotationDeg: xRotation,
                    largeArc: largeArcFlag != 0, sweep: sweepFlag != 0,
                    ex: endX, ey: endY
                )
                currentX = endX; currentY = endY
            }
        case "Z", "z":
            path.closeSubpath()
            currentX = startX; currentY = startY
        default:
            idx += 1
        }
    }

    return path
}

private func appendSvgArcToBeziers(
    _ path: CGMutablePath,
    cx: CGFloat, cy: CGFloat,
    rx inputRx: CGFloat, ry inputRy: CGFloat,
    xRotationDeg: CGFloat,
    largeArc: Bool, sweep: Bool,
    ex: CGFloat, ey: CGFloat
) {
    var rx = inputRx
    var ry = inputRy
    guard rx > 0 && ry > 0 else {
        path.addLine(to: CGPoint(x: ex, y: ey))
        return
    }
    if cx == ex && cy == ey { return }

    let phi = xRotationDeg * .pi / 180
    let cosPhi = cos(phi)
    let sinPhi = sin(phi)

    let dx2 = (cx - ex) / 2
    let dy2 = (cy - ey) / 2
    let x1p = cosPhi * dx2 + sinPhi * dy2
    let y1p = -sinPhi * dx2 + cosPhi * dy2

    let x1pSq = x1p * x1p
    let y1pSq = y1p * y1p
    var rxSq = rx * rx
    var rySq = ry * ry
    let lambda = x1pSq / rxSq + y1pSq / rySq
    if lambda > 1 {
        let s = sqrt(lambda)
        rx *= s
        ry *= s
        rxSq = rx * rx
        rySq = ry * ry
    }

    var sq = (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq)
    if sq < 0 { sq = 0 }
    var root = sqrt(sq)
    if largeArc == sweep { root = -root }
    let cxp = root * rx * y1p / ry
    let cyp = -root * ry * x1p / rx

    let centerX = cosPhi * cxp - sinPhi * cyp + (cx + ex) / 2
    let centerY = sinPhi * cxp + cosPhi * cyp + (cy + ey) / 2

    func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
        let dot = ux * vx + uy * vy
        let len = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
        var a = acos(max(-1, min(1, dot / len)))
        if ux * vy - uy * vx < 0 { a = -a }
        return a
    }

    let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    var dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if !sweep && dtheta > 0 { dtheta -= 2 * .pi }
    if sweep && dtheta < 0 { dtheta += 2 * .pi }

    let segments = max(1, Int(ceil(abs(dtheta) / (.pi / 2))))
    let segAngle = dtheta / CGFloat(segments)

    for i in 0..<segments {
        let t1 = theta1 + CGFloat(i) * segAngle
        let t2 = t1 + segAngle
        let alpha = sin(segAngle) * (sqrt(4 + 3 * pow(tan(segAngle / 2), 2)) - 1) / 3

        let cos1 = cos(t1), sin1 = sin(t1)
        let cos2 = cos(t2), sin2 = sin(t2)

        let ep1x = rx * cos1, ep1y = ry * sin1
        let ep2x = rx * cos2, ep2y = ry * sin2

        let cp1x = cosPhi * (ep1x - alpha * rx * sin1) - sinPhi * (ep1y + alpha * ry * cos1) + centerX
        let cp1y = sinPhi * (ep1x - alpha * rx * sin1) + cosPhi * (ep1y + alpha * ry * cos1) + centerY
        let cp2x = cosPhi * (ep2x + alpha * rx * sin2) - sinPhi * (ep2y - alpha * ry * cos2) + centerX
        let cp2y = sinPhi * (ep2x + alpha * rx * sin2) + cosPhi * (ep2y - alpha * ry * cos2) + centerY
        let endPx = cosPhi * ep2x - sinPhi * ep2y + centerX
        let endPy = sinPhi * ep2x + cosPhi * ep2y + centerY

        path.addCurve(
            to: CGPoint(x: endPx, y: endPy),
            control1: CGPoint(x: cp1x, y: cp1y),
            control2: CGPoint(x: cp2x, y: cp2y)
        )
    }
}

// MARK: - ZIP Creation (in-memory, Store compression)

private struct ZipLayoutEntry {
    let extraInsertOffset: Int
}

private struct ZipBuildArtifact {
    let data: Data
    let layouts: [ZipLayoutEntry]
}

private func normalizedZipExtraLength(_ length: Int) -> Int {
    guard length > 0 else { return 0 }
    return max(4, length)
}

private func makeZipExtraField(length: Int) -> Data {
    let normalized = normalizedZipExtraLength(length)
    guard normalized > 0 else { return Data() }

    var extra = Data(repeating: 0x41, count: normalized)
    extra.writeUInt16LE(0x4141, at: 0)
    extra.writeUInt16LE(UInt16(max(0, normalized - 4)), at: 2)
    return extra
}

private func createZipInMemory(_ files: [(name: String, data: Data)], extraLengths: [Int] = []) -> ZipBuildArtifact {
    var localParts = Data()
    var centralDir = Data()
    var offset: UInt32 = 0
    var layouts: [ZipLayoutEntry] = []

    for (index, file) in files.enumerated() {
        let name = file.name
        let fileData = file.data
        let nameBytes = Data(name.utf8)
        let crc = crc32(fileData)
        let extraLen = index < extraLengths.count ? normalizedZipExtraLength(extraLengths[index]) : 0
        let extraBytes = makeZipExtraField(length: extraLen)

        // Local file header (30 + name length)
        let localExtraOffset = Int(offset) + 30 + nameBytes.count
        var local = Data(count: 30 + nameBytes.count + extraBytes.count)
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
        local.writeUInt16LE(UInt16(extraBytes.count), at: 28) // extra field
        local.replaceSubrange(30..<(30 + nameBytes.count), with: nameBytes)
        if !extraBytes.isEmpty {
            local.replaceSubrange((30 + nameBytes.count)..<(30 + nameBytes.count + extraBytes.count), with: extraBytes)
        }

        // Central directory header (46 + name length)
        var central = Data(count: 46 + nameBytes.count + extraBytes.count)
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
        central.writeUInt16LE(UInt16(extraBytes.count), at: 30)
        central.writeUInt16LE(0, at: 32)
        central.writeUInt16LE(0, at: 34)
        central.writeUInt16LE(0, at: 36)
        central.writeUInt32LE(0, at: 38)
        central.writeUInt32LE(offset, at: 42)
        central.replaceSubrange(46..<(46 + nameBytes.count), with: nameBytes)
        if !extraBytes.isEmpty {
            central.replaceSubrange((46 + nameBytes.count)..<(46 + nameBytes.count + extraBytes.count), with: extraBytes)
        }

        localParts.append(local)
        localParts.append(fileData)
        centralDir.append(central)
        layouts.append(ZipLayoutEntry(extraInsertOffset: localExtraOffset))
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
    return ZipBuildArtifact(data: result, layouts: layouts)
}

/// Validate ZIP boundary bytes (offsets 1016, 2040, 3064... must not be 0x00 or 0x7C)
private func validateZipBoundaries(_ data: Data) -> Bool {
    firstInvalidZipBoundaryOffset(data) == nil
}

private func firstInvalidZipBoundaryOffset(_ data: Data) -> Int? {
    var i = 1016
    while i < data.count {
        let byte = data[i]
        if byte == 0x00 || byte == 0x7C { return i }
        i += PACKET_SIZE
    }
    return nil
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
