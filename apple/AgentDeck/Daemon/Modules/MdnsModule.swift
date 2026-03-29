#if os(macOS)
// MdnsModule.swift — mDNS/Bonjour service advertisement
// Ported from bridge/src/modules/mdns-module.ts + bridge/src/mdns.ts

import Foundation
import Network

final class MdnsModule: DeviceModule, @unchecked Sendable {
    let name = "mdns"
    private var listener: NWListener?
    private let port: UInt16
    private let projectName: String
    private let agentType: String
    private let token: String

    init(port: UInt16, projectName: String = "daemon", agentType: String = "daemon", token: String) {
        self.port = port
        self.projectName = projectName
        self.agentType = agentType
        self.token = token
    }

    func start() async {
        do {
            let params = NWParameters.tcp
            let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)

            // Advertise Bonjour service
            let txtRecord = NWTXTRecord([
                "project": projectName,
                "agent": agentType,
                "port": "\(port)",
                "ip": AuthManager.getLanIP() ?? "127.0.0.1",
                "token": token,
                "v": "3",
            ])

            listener.service = NWListener.Service(
                name: "\(projectName)-\(port)",
                type: "_agentdeck._tcp",
                txtRecord: txtRecord
            )

            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    DaemonLogger.shared.info("mDNS: Advertising _agentdeck._tcp on port \(self.port)")
                case .failed(let error):
                    DaemonLogger.shared.error("mDNS failed: \(error)")
                default:
                    break
                }
            }

            // We don't need to accept connections on this listener — it's just for Bonjour
            listener.newConnectionHandler = { conn in
                conn.cancel() // Reject — WS server handles actual connections
            }

            listener.start(queue: .global(qos: .utility))
            self.listener = listener
        } catch {
            DaemonLogger.shared.error("mDNS: Failed to start: \(error)")
        }
    }

    func stop() async {
        listener?.cancel()
        listener = nil
    }

    /// Re-advertise after network change (IP change, VPN toggle, sleep/wake)
    func republish() async {
        await stop()
        await start()
    }
}
#endif
