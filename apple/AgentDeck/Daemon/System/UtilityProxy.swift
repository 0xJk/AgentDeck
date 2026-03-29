#if os(macOS)
// UtilityProxy.swift — macOS volume/mute/brightness control
// Replaces bridge/src/utility-proxy.ts (osascript → native CoreAudio/IOKit)

import Foundation
import CoreAudio
import AudioToolbox
import IOKit.graphics

/// Native macOS utility control. No osascript dependency.
@MainActor
final class UtilityProxy {

    // MARK: - Volume (CoreAudio)

    func getVolume() -> Int {
        var defaultOutputDeviceID = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &defaultOutputDeviceID
        )
        guard status == noErr else { return 50 }

        var volume: Float32 = 0
        size = UInt32(MemoryLayout<Float32>.size)
        address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )

        let volStatus = AudioObjectGetPropertyData(defaultOutputDeviceID, &address, 0, nil, &size, &volume)
        guard volStatus == noErr else { return 50 }
        return Int(volume * 100)
    }

    func setVolume(_ percent: Int) {
        var defaultOutputDeviceID = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &defaultOutputDeviceID
        )
        guard status == noErr else { return }

        var volume = Float32(max(0, min(100, percent))) / 100.0
        size = UInt32(MemoryLayout<Float32>.size)
        address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )

        AudioObjectSetPropertyData(defaultOutputDeviceID, &address, 0, nil, size, &volume)
    }

    func isMuted() -> Bool {
        var defaultOutputDeviceID = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &defaultOutputDeviceID
        )
        guard status == noErr else { return false }

        var muted: UInt32 = 0
        size = UInt32(MemoryLayout<UInt32>.size)
        address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyMute,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )

        let muteStatus = AudioObjectGetPropertyData(defaultOutputDeviceID, &address, 0, nil, &size, &muted)
        guard muteStatus == noErr else { return false }
        return muted != 0
    }

    func toggleMute() {
        var defaultOutputDeviceID = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &defaultOutputDeviceID
        )
        guard status == noErr else { return }

        var muted: UInt32 = isMuted() ? 0 : 1
        size = UInt32(MemoryLayout<UInt32>.size)
        address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyMute,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )

        AudioObjectSetPropertyData(defaultOutputDeviceID, &address, 0, nil, size, &muted)
    }

    // MARK: - Brightness (IOKit)
    // Note: IOKit brightness control may require specific entitlements in sandbox.
    // Falls back gracefully if unavailable.

    func getBrightness() -> Double? {
        // IODisplayGetFloatParameter approach
        var iterator: io_iterator_t = 0
        let matching = IOServiceMatching("IODisplayConnect")
        guard IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator) == KERN_SUCCESS else {
            return nil
        }
        defer { IOObjectRelease(iterator) }

        var service = IOIteratorNext(iterator)
        while service != 0 {
            var brightness: Float = 0
            let result = IODisplayGetFloatParameter(service, 0, kIODisplayBrightnessKey as CFString, &brightness)
            IOObjectRelease(service)
            if result == KERN_SUCCESS {
                return Double(brightness)
            }
            service = IOIteratorNext(iterator)
        }
        return nil
    }

    func setBrightness(_ value: Double) {
        var iterator: io_iterator_t = 0
        let matching = IOServiceMatching("IODisplayConnect")
        guard IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator) == KERN_SUCCESS else {
            return
        }
        defer { IOObjectRelease(iterator) }

        var service = IOIteratorNext(iterator)
        while service != 0 {
            IODisplaySetFloatParameter(service, 0, kIODisplayBrightnessKey as CFString, Float(max(0, min(1, value))))
            IOObjectRelease(service)
            service = IOIteratorNext(iterator)
        }
    }

    // MARK: - Handle Utility Command

    func handleCommand(_ action: String, value: Int?) {
        switch action {
        case "adjust_volume":
            if let v = value { setVolume(getVolume() + v) }
        case "toggle_mute":
            toggleMute()
        case "adjust_brightness":
            if let v = value, let current = getBrightness() {
                setBrightness(current + Double(v) / 100.0)
            }
        default:
            DaemonLogger.shared.debug("Utility", "Unknown action: \(action)")
        }
    }
}
#endif
