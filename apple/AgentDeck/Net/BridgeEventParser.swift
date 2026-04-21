// BridgeEventParser.swift — JSON type discriminator for bridge messages

import Foundation

enum BridgeEventParser {
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    /// Parse raw JSON text into a typed BridgeEvent
    static func parse(_ text: String) -> BridgeEvent? {
        guard let data = text.data(using: .utf8) else { return nil }

        // Extract "type" field first
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return nil
        }

        // Use a lenient decoder that ignores unknown keys
        let lenient = JSONDecoder()

        do {
            switch type {
            case "state_update":
                var event = try lenient.decode(StateUpdateEvent.self, from: data)
                event.moduleHealth = parseModuleHealth(json["moduleHealth"] as? [String: Any])
                return .stateUpdate(event)
            case "usage_update":
                return .usageUpdate(try lenient.decode(UsageEvent.self, from: data))
            case "connection":
                return .connection(try lenient.decode(ConnectionEvent.self, from: data))
            case "voice_state":
                return .voiceState(try lenient.decode(VoiceStateEvent.self, from: data))
            case "display_state":
                return .displayState(try lenient.decode(DisplayStateEvent.self, from: data))
            case "sessions_list":
                return .sessionsList(try lenient.decode(SessionsListEvent.self, from: data))
            case "prompt_options":
                return .promptOptions(try lenient.decode(PromptOptionsEvent.self, from: data))
            case "button_state":
                return .buttonState(try lenient.decode(ButtonStateEvent.self, from: data))
            case "encoder_state":
                return .encoderState(try lenient.decode(EncoderStateEvent.self, from: data))
            case "deck_slot_map":
                return .deckSlotMap(try lenient.decode(DeckSlotMapEvent.self, from: data))
            case "user_prompt":
                return .userPrompt(try lenient.decode(UserPromptEvent.self, from: data))
            case "timeline_event":
                return .timelineEvent(try lenient.decode(TimelineEventMsg.self, from: data))
            case "timeline_history":
                return .timelineHistory(try lenient.decode(TimelineHistoryMsg.self, from: data))
            default:
                print("[BridgeEventParser] Unknown event type: \(type)")
                return nil
            }
        } catch {
            print("[BridgeEventParser] Decode error for \(type): \(error)")
            return nil
        }
    }

    // MARK: - Module Health Parser

    private static func parseModuleHealth(_ raw: [String: Any]?) -> ModuleHealthState? {
        guard let raw else { return nil }
        var health = ModuleHealthState()

        if let adb = raw["adb"] as? [String: Any] {
            var classified: [ClassifiedDevice] = []
            if let arr = adb["classifiedDevices"] as? [[String: Any]] {
                for entry in arr {
                    guard let serial = entry["serial"] as? String else { continue }
                    classified.append(ClassifiedDevice(
                        serial: serial,
                        manufacturer: entry["manufacturer"] as? String,
                        model: entry["model"] as? String,
                        deviceClass: (entry["class"] as? String) ?? "android.tablet"
                    ))
                }
            }
            health.adb = AdbHealth(
                available: adb["available"] as? Bool ?? false,
                devices: adb["devices"] as? [String] ?? [],
                classifiedDevices: classified,
                reverseReadyCount: adb["reverseReadyCount"] as? Int ?? 0,
                lastError: adb["lastError"] as? String
            )
        }

        if let d200h = raw["d200h"] as? [String: Any] {
            health.d200h = D200hHealth(
                connected: d200h["connected"] as? Bool ?? false,
                managerOpened: d200h["managerOpened"] as? Bool ?? false,
                sandboxEnabled: d200h["sandboxEnabled"] as? Bool ?? false,
                usbEntitlementPresent: d200h["usbEntitlementPresent"] as? Bool ?? false,
                buttonPressCount: d200h["buttonPressCount"] as? Int ?? 0,
                hidReportCount: d200h["hidReportCount"] as? Int ?? 0,
                writeOK: d200h["writeOK"] as? Int ?? 0,
                writeFail: d200h["writeFail"] as? Int ?? 0,
                lastWriteError: d200h["lastWriteError"] as? String,
                lastOpenError: d200h["lastOpenError"] as? String
            )
        }

        if let pixoo = raw["pixoo"] as? [String: Any] {
            var pixooDevices: [PixooDeviceHealth] = []
            if let devArr = pixoo["devices"] as? [[String: Any]] {
                for dev in devArr {
                    pixooDevices.append(PixooDeviceHealth(
                        ip: dev["ip"] as? String ?? "",
                        online: dev["online"] as? Bool ?? false,
                        failures: dev["failures"] as? Int ?? 0,
                        backedOff: dev["backedOff"] as? Bool ?? false
                    ))
                }
            }
            health.pixoo = PixooHealth(
                configuredDeviceCount: pixoo["configuredDeviceCount"] as? Int ?? 0,
                deviceIps: pixoo["deviceIps"] as? [String] ?? [],
                hasFrame: pixoo["hasFrame"] as? Bool ?? false,
                displayDimmed: pixoo["displayDimmed"] as? Bool ?? false,
                lastPushError: pixoo["lastPushError"] as? String,
                devices: pixooDevices
            )
        }

        if let sd = raw["streamDeck"] as? [String: Any] {
            var sdDevices: [StreamDeckDeviceInfo] = []
            if let arr = sd["devices"] as? [[String: Any]] {
                for d in arr {
                    sdDevices.append(StreamDeckDeviceInfo(
                        id: d["id"] as? String ?? "",
                        name: d["name"] as? String ?? "",
                        family: d["family"] as? String,
                        columns: d["columns"] as? Int,
                        rows: d["rows"] as? Int
                    ))
                }
            }
            health.streamDeck = StreamDeckHealth(devices: sdDevices)
        }

        if let serial = raw["serial"] as? [String: Any] {
            var boards: [SerialPortInfo] = []
            var ports: [String] = []
            if let connections = serial["connections"] as? [[String: Any]] {
                for conn in connections {
                    guard conn["connected"] as? Bool == true,
                          let port = conn["port"] as? String else { continue }
                    let info = conn["deviceInfo"] as? [String: Any]
                    boards.append(SerialPortInfo(
                        port: port,
                        board: info?["board"] as? String,
                        firmwareVersion: info?["version"] as? String
                    ))
                    ports.append(port)
                }
            }
            if ports.isEmpty, let legacy = serial["connectedPorts"] as? [String] {
                ports = legacy
                boards = legacy.map { SerialPortInfo(port: $0, board: nil, firmwareVersion: nil) }
            }
            health.serial = SerialHealth(
                connectedPorts: ports,
                connectedBoards: boards,
                lastError: serial["lastError"] as? String
            )
        }

        return health
    }
}
