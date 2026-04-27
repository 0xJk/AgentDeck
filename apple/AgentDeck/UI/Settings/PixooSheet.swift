#if os(macOS)
// PixooSheet.swift — User-facing Pixoo LED matrix device manager.
//
// Divoom Pixoo devices (64×64 or 16×16 matrix displays) expose an HTTP API
// on their local IP (port 80) with commands like `Device.GetDeviceList`
// and `Draw.SendHttpGif`. There's no Bonjour advertisement from the device
// itself, so discovery via mDNS won't find them — we fall back to manual
// IP entry with a "Ping" test button.
//
// Device list persistence lives in `~/.agentdeck/settings.json` under
// `pixooDevices`. The PixooModule hot-reloads this array while the daemon is
// running, so adding or removing a display takes effect without a restart.

import SwiftUI
import AppKit

struct PixooSheet: View {
    @Environment(\.dismiss) private var dismiss

    @State private var ipInput: String = ""
    @State private var nameInput: String = ""
    @State private var devices: [PixooDeviceEntry] = []
    @State private var testing: Bool = false
    @State private var testResult: TestResult?
    @State private var savingError: String?

    private enum TestResult {
        case reachable(deviceName: String?)
        case unreachable(String)
    }

    struct PixooDeviceEntry: Identifiable, Hashable {
        let id = UUID()
        let ip: String
        let name: String?
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            Divider()
            listSection
            Divider()
            addSection
            Spacer()
            Divider()
            footer
        }
        .padding(20)
        .frame(width: 520, height: 520)
        .aquariumSurface()
        .onAppear(perform: loadDevices)
    }

    // MARK: - Sections

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "square.grid.3x3.fill")
                .font(.system(size: 18))
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text("Pixoo Matrix Devices")
                    .font(.system(size: 16, weight: .semibold))
                Text("Add your Divoom Pixoo displays by IP. AgentDeck will render session state on them.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var listSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Configured Devices")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
            if devices.isEmpty {
                Text("No devices yet. Add one below and AgentDeck will start rendering automatically.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                ForEach(devices) { device in
                    deviceRow(device)
                }
            }
        }
    }

    private func deviceRow(_ device: PixooDeviceEntry) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "square.grid.3x3.middle.filled")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(device.name ?? "Pixoo")
                    .font(.system(size: 12, weight: .medium))
                Text(device.ip)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                removeDevice(device)
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            }
            .buttonStyle(.borderless)
            .help("Remove this device")
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color.secondary.opacity(0.06))
        )
    }

    private var addSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Add Device")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)

            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("IP address").font(.system(size: 10)).foregroundStyle(.secondary)
                    TextField("192.168.1.50", text: $ipInput)
                        .textFieldStyle(.roundedBorder)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text("Name (optional)").font(.system(size: 10)).foregroundStyle(.secondary)
                    TextField("Desk Pixoo", text: $nameInput)
                        .textFieldStyle(.roundedBorder)
                }
            }

            HStack(spacing: 8) {
                Button {
                    testDevice()
                } label: {
                    if testing {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("Testing…")
                        }
                    } else {
                        Text("Test Connection")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(testing || !isValidIP(ipInput))

                Button("Add") { addDevice() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canAdd)
            }

            if let testResult {
                switch testResult {
                case .reachable(let name):
                    Label {
                        Text(name.map { "Found: \($0)" } ?? "Device is reachable")
                            .font(.system(size: 11))
                    } icon: {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                case .unreachable(let msg):
                    Label {
                        Text(msg).font(.system(size: 11))
                    } icon: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.red)
                    }
                }
            }

            if let savingError {
                Text(savingError)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            }
        }
    }

    private var footer: some View {
        HStack {
            Text("Changes are picked up automatically by the local daemon.")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            Spacer()
            Button("Close") { dismiss() }
                .keyboardShortcut(.cancelAction)
        }
    }

    // MARK: - Computed

    private var canAdd: Bool {
        isValidIP(ipInput)
            && !devices.contains(where: { $0.ip == ipInput.trimmingCharacters(in: .whitespacesAndNewlines) })
    }

    private func isValidIP(_ s: String) -> Bool {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: ".")
        guard parts.count == 4 else { return false }
        return parts.allSatisfy { part in
            guard let n = Int(part) else { return false }
            return n >= 0 && n <= 255
        }
    }

    // MARK: - I/O

    private func loadDevices() {
        let url = AgentDeckPaths.settingsJson
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = json["pixooDevices"] as? [[String: Any]] else {
            devices = []
            return
        }
        devices = arr.compactMap { d in
            guard let ip = d["ip"] as? String else { return nil }
            return PixooDeviceEntry(ip: ip, name: d["name"] as? String)
        }
    }

    private func addDevice() {
        let ip = ipInput.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = nameInput.trimmingCharacters(in: .whitespacesAndNewlines)
        let entry = PixooDeviceEntry(ip: ip, name: name.isEmpty ? nil : name)
        devices.append(entry)
        if !saveDevices() {
            devices.removeLast()
            return
        }
        ipInput = ""
        nameInput = ""
        testResult = nil
    }

    private func removeDevice(_ device: PixooDeviceEntry) {
        let before = devices
        devices.removeAll { $0.id == device.id }
        if !saveDevices() {
            devices = before
        }
    }

    /// Persist `devices` into the shared settings.json under `pixooDevices`.
    /// Merges non-destructively with whatever else lives in the file.
    @discardableResult
    private func saveDevices() -> Bool {
        let url = AgentDeckPaths.settingsJson
        var root: [String: Any] = [:]
        if let data = try? Data(contentsOf: url),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            root = parsed
        }
        let arr: [[String: Any]] = devices.map { d in
            var obj: [String: Any] = ["ip": d.ip]
            if let name = d.name { obj["name"] = name }
            return obj
        }
        root["pixooDevices"] = arr
        do {
            let out = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
            try out.write(to: url, options: [.atomic])
            savingError = nil
            return true
        } catch {
            savingError = "Couldn't save: \(error.localizedDescription)"
            return false
        }
    }

    // MARK: - Network test

    private func testDevice() {
        testing = true
        testResult = nil
        let ip = ipInput.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            let result = await pingPixoo(ip: ip)
            await MainActor.run {
                testing = false
                testResult = result
            }
        }
    }

    /// POST `{"Command":"Device.GetDeviceList"}` to the Pixoo's LAN endpoint
    /// and wait up to 3s for a JSON response with a `DeviceList` array.
    /// Any HTTP response counts as "device is there"; a parseable device
    /// list gives us the friendly name for the success toast.
    private func pingPixoo(ip: String) async -> TestResult {
        guard let url = URL(string: "http://\(ip):80/post") else {
            return .unreachable("Invalid URL")
        }
        var req = URLRequest(url: url, timeoutInterval: 3)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["Command": "Device.GetDeviceList"])
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return .unreachable("Got \(response) — not a Pixoo?")
            }
            if let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let list = parsed["DeviceList"] as? [[String: Any]],
               let first = list.first,
               let name = first["DeviceName"] as? String {
                return .reachable(deviceName: name)
            }
            return .reachable(deviceName: nil)
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }
}
#endif
