#if os(macOS)
// ESP32ProvisionSheet.swift — User-facing Wi-Fi provisioning for ESP32 boards.
//
// Before this sheet, users had to edit `~/.agentdeck/wifi-config.json` by
// hand or run `agentdeck wifi-setup` from a terminal. Neither works from
// the App Store build. This sheet gives a 3-step flow:
//
//   1. Detect a connected ESP32 over USB serial.
//   2. Take SSID + password from the user (Wi-Fi picker would require
//      CoreWLAN + Location Services, so we stay on plain text input —
//      App Sandbox blocks `networksetup`/`security` subprocess calls
//      anyway).
//   3. Write a newline-delimited JSON config frame to the serial port and
//      show the result.
//
// Serial writes go through Darwin POSIX `open/write/close` at 115200 baud
// — App Sandbox's `com.apple.security.device.serial` entitlement allows
// this. We don't open the ESP32Serial actor here; the running daemon owns
// that port and would race with our write. Instead we lean on the fact
// that the daemon reopens the port after a disconnect, so we briefly own
// the port for the provisioning write and let the daemon reclaim it
// afterward.

import SwiftUI
import AppKit
import Darwin

struct ESP32ProvisionSheet: View {
    @Environment(\.dismiss) private var dismiss

    @State private var step: Step = .detecting
    @State private var detectedPort: String?
    @State private var ssid: String = ""
    @State private var password: String = ""
    @State private var sending: Bool = false
    @State private var errorMessage: String?
    @State private var successMessage: String?

    private enum Step: Equatable {
        case detecting
        case enterCredentials
        case sending
        case success
        case failure
    }

    private enum WriteResult: Sendable {
        case success
        case failure(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            Divider()
            content
            Spacer()
            Divider()
            footer
        }
        .padding(20)
        .frame(width: 480, height: 440)
        .aquariumSurface()
        .onAppear(perform: detectPort)
    }

    // MARK: - Sections

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 18))
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text("ESP32 Wi-Fi Setup")
                    .font(.system(size: 16, weight: .semibold))
                Text("Send Wi-Fi credentials to your ESP32 over USB.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .detecting: detectingView
        case .enterCredentials: credentialsView
        case .sending: sendingView
        case .success: successView
        case .failure: failureView
        }
    }

    private var detectingView: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Looking for a connected ESP32…")
                    .font(.system(size: 13))
            }
            Text("Plug your ESP32 into this Mac with a USB cable. CP210x/CH340/native USB are all supported.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Try Again") { detectPort() }
                    .buttonStyle(.bordered)
            }
        }
    }

    private var credentialsView: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let port = detectedPort {
                HStack(spacing: 6) {
                    Circle().fill(.green).frame(width: 8, height: 8)
                    Text("Found ESP32 at \(port)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Wi-Fi SSID")
                    .font(.system(size: 12, weight: .medium))
                TextField("MyNetwork", text: $ssid)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Wi-Fi Password")
                    .font(.system(size: 12, weight: .medium))
                SecureField("••••••••", text: $password)
                    .textFieldStyle(.roundedBorder)
            }

            Text("Type the network name and password you normally use for this Mac.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var sendingView: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Sending configuration…")
                    .font(.system(size: 13))
            }
            Text("Writing JSON frame to \(detectedPort ?? "the ESP32") at 115200 baud. The board should reboot and join your Wi-Fi network within a few seconds.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var successView: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                Text("Configuration sent")
                    .font(.system(size: 14, weight: .semibold))
            }
            Text(successMessage ?? "Your ESP32 should join your Wi-Fi network and appear in the session list shortly.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var failureView: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text("Couldn't send configuration")
                    .font(.system(size: 14, weight: .semibold))
            }
            Text(errorMessage ?? "Unknown error.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var footer: some View {
        HStack {
            Spacer()
            switch step {
            case .detecting:
                Button("Close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            case .enterCredentials:
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Send") { send() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(ssid.isEmpty || password.count < 8 || detectedPort == nil)
            case .sending:
                EmptyView()
            case .success:
                Button("Done") { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            case .failure:
                Button("Retry") { step = .enterCredentials; errorMessage = nil }
                    .buttonStyle(.bordered)
                Button("Close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
        }
    }

    // MARK: - Actions

    private func detectPort() {
        step = .detecting
        errorMessage = nil
        Task {
            let port = await Task.detached(priority: .userInitiated) {
                Self.findESP32Port()
            }.value
            if let port {
                detectedPort = port
                step = .enterCredentials
            } else {
                // Stay on detecting step so user can retry; no error
                // message needed — the copy already says "plug it in".
                detectedPort = nil
            }
        }
    }

    private func send() {
        step = .sending
        errorMessage = nil
        let payload: [String: String] = [
            "type": "wifi.config",
            "ssid": ssid,
            "password": password,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let payloadLine = String(data: data, encoding: .utf8)
        else {
            errorMessage = "Couldn't serialize config."
            step = .failure
            return
        }
        let frame = payloadLine + "\n"
        let portPath = detectedPort ?? ""
        Task {
            let result = await Task.detached(priority: .userInitiated) {
                Self.writeSerial(port: portPath, line: frame)
            }.value
            switch result {
            case .success:
                successMessage = nil
                step = .success
            case .failure(let message):
                errorMessage = message
                step = .failure
            }
        }
    }

    // MARK: - Port discovery

    /// Scan `/dev/cu.*` for paths matching known ESP32 USB-UART identifiers.
    /// CP210x → `cu.usbserial-*`, CH340 → `cu.wchusbserial*`, native USB →
    /// `cu.usbmodem*`. Mirrors ESP32Serial's portPatterns but as a pure
    /// function so the sheet can use it without poking at an actor.
    private nonisolated static func findESP32Port() -> String? {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: "/dev") else { return nil }
        let regexes: [NSRegularExpression] = [
            "usbserial-", "wchusbserial", "usbmodem",
        ].compactMap { try? NSRegularExpression(pattern: $0) }
        for name in entries where name.hasPrefix("cu.") {
            let leaf = String(name.dropFirst(3))
            let range = NSRange(leaf.startIndex..., in: leaf)
            for rx in regexes where rx.firstMatch(in: leaf, range: range) != nil {
                return "/dev/\(name)"
            }
        }
        return nil
    }

    // MARK: - Serial write

    /// Open the serial port non-blocking, set 115200 baud, write the frame,
    /// close. Kept intentionally small — no termios canonical mode config,
    /// no read-back. The ESP32 firmware re-configures itself and reboots on
    /// receiving `wifi.config`; verification happens via mDNS rediscovery.
    private nonisolated static func writeSerial(port: String, line: String) -> WriteResult {
        let fd = Darwin.open(port, O_RDWR | O_NOCTTY | O_NONBLOCK)
        if fd < 0 {
            return .failure("Couldn't open \(port): errno \(errno). Is the daemon holding the port? Try closing AgentDeck fully and reopening.")
        }
        defer { Darwin.close(fd) }
        // Clear O_NONBLOCK for a synchronous write.
        _ = fcntl(fd, F_SETFL, 0)
        // Set 115200 baud + 8N1 raw mode via termios.
        var tio = termios()
        if tcgetattr(fd, &tio) == 0 {
            cfmakeraw(&tio)
            cfsetispeed(&tio, speed_t(115200))
            cfsetospeed(&tio, speed_t(115200))
            _ = tcsetattr(fd, TCSANOW, &tio)
        }
        let bytes = Array(line.utf8)
        let written = bytes.withUnsafeBufferPointer { buf in
            Darwin.write(fd, buf.baseAddress, buf.count)
        }
        if written == bytes.count {
            return .success
        }
        return .failure("Wrote only \(written)/\(bytes.count) bytes (errno \(errno)).")
    }
}
#endif
