// BridgeDiscovery.swift — mDNS discovery for AgentDeck bridges
// Uses Network.framework NWBrowser (Apple native Bonjour)

import Foundation
import Network

struct DiscoveredBridge: Identifiable, Sendable {
    let name: String
    let host: String
    let port: Int
    let token: String?
    var project: String?
    var agentType: String?

    var id: String { "\(host):\(port)" }

    var wsUrl: String {
        var url = "ws://\(host):\(port)"
        if let token { url += "?token=\(token)" }
        return url
    }
}

@Observable
final class BridgeDiscovery: @unchecked Sendable {
    private(set) var bridges: [DiscoveredBridge] = []
    private(set) var isSearching = false

    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "dev.agentdeck.discovery")

    // MARK: - Start/Stop

    func startSearching() {
        guard browser == nil else { return }

        let params = NWParameters()
        params.includePeerToPeer = true

        let browser = NWBrowser(for: .bonjour(type: "_agentdeck._tcp", domain: nil), using: params)
        self.browser = browser

        browser.stateUpdateHandler = { [weak self] state in
            print("[Discovery] browser state: \(state)")
            DispatchQueue.main.async {
                switch state {
                case .ready:
                    self?.isSearching = true
                case .failed(let error):
                    print("[Discovery] browser failed: \(error)")
                    self?.isSearching = false
                case .cancelled:
                    self?.isSearching = false
                default:
                    break
                }
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            print("[Discovery] browseResults changed: \(results.count) results")
            for r in results {
                print("[Discovery]   endpoint=\(r.endpoint) metadata=\(r.metadata)")
            }
            self?.handleResults(results)
        }

        browser.start(queue: queue)
    }

    func stopSearching() {
        browser?.cancel()
        browser = nil
        DispatchQueue.main.async {
            self.isSearching = false
            self.bridges.removeAll()
        }
    }

    // MARK: - Result Handling

    private func handleResults(_ results: Set<NWBrowser.Result>) {
        var newBridges: [DiscoveredBridge] = []
        var needsResolve: [(name: String, endpoint: NWEndpoint, port: Int, token: String?, project: String?, agentType: String?)] = []

        for result in results {
            guard case .service(let name, _, _, _) = result.endpoint else { continue }

            // Extract TXT metadata
            var token: String?
            var project: String?
            var agentType: String?
            var host: String?
            var port: Int?

            if case .bonjour(let txtRecord) = result.metadata {
                token = txtRecord.getDictionaryValue(for: "token")
                project = txtRecord.getDictionaryValue(for: "project")
                agentType = txtRecord.getDictionaryValue(for: "agent")
                host = txtRecord.getDictionaryValue(for: "ip")
                if let portStr = txtRecord.getDictionaryValue(for: "port") {
                    port = Int(portStr)
                }
                print("[Discovery] TXT for \(name): ip=\(host ?? "nil") port=\(port ?? -1) token=\(token != nil)")
            } else {
                // No metadata yet — parse port from service name (e.g., "AgentDeck-Project-9121")
                let parts = name.split(separator: "-")
                if let last = parts.last, let parsedPort = Int(last) {
                    port = parsedPort
                }
                print("[Discovery] no TXT for \(name), parsed port=\(port ?? -1)")
            }
            port = port ?? 9120

            // If TXT has explicit IP, use it directly
            if let resolvedHost = host, !resolvedHost.hasPrefix("169.254.") {
                print("[Discovery] found bridge via TXT: \(resolvedHost):\(port!) token=\(token != nil)")
                newBridges.append(DiscoveredBridge(
                    name: name,
                    host: resolvedHost,
                    port: port!,
                    token: token,
                    project: project,
                    agentType: agentType
                ))
            } else {
                needsResolve.append((name, result.endpoint, port!, token, project, agentType))
            }
        }

        // Resolve endpoints that didn't have IP in TXT
        for item in needsResolve {
            resolveEndpoint(item.endpoint) { [weak self] resolvedHost in
                guard let resolvedHost, !resolvedHost.hasPrefix("169.254.") else {
                    print("[Discovery] resolve failed or link-local for \(item.name)")
                    return
                }
                // If we have no token from TXT, try to fetch it from /health
                let token = item.token
                let port = item.port
                let name = item.name
                let project = item.project
                let agent = item.agentType

                if token == nil {
                    // Fetch token from bridge /health endpoint
                    self?.fetchTokenFromBridge(host: resolvedHost, port: port) { [weak self] fetchedToken in
                        print("[Discovery] resolved \(name) to \(resolvedHost):\(port) token=\(fetchedToken != nil ? "fetched" : "nil")")
    DispatchQueue.main.async {
                            guard let self else { return }
                            let bridge = DiscoveredBridge(
                                name: name,
                                host: resolvedHost,
                                port: port,
                                token: fetchedToken,
                                project: project,
                                agentType: agent
                            )
                            if !self.bridges.contains(where: { $0.id == bridge.id }) {
                                self.bridges.append(bridge)
                            }
                        }
                    }
                } else {
                    print("[Discovery] resolved \(name) to \(resolvedHost):\(port) token=yes")
                    DispatchQueue.main.async { [weak self] in
                        guard let self else { return }
                        let bridge = DiscoveredBridge(
                            name: name,
                            host: resolvedHost,
                            port: port,
                            token: token,
                            project: project,
                            agentType: agent
                        )
                        if !self.bridges.contains(where: { $0.id == bridge.id }) {
                            self.bridges.append(bridge)
                        }
                    }
                }
            }
        }

        DispatchQueue.main.async {
            // Merge: keep async-resolved bridges that aren't in the new set
            let newIds = Set(newBridges.map(\.id))
            let asyncResolved = self.bridges.filter { !newIds.contains($0.id) }
            self.bridges = newBridges + asyncResolved
        }
    }

    // MARK: - Token Fetch

    /// Try to read the auth token from the bridge's pairing info endpoint
    private func fetchTokenFromBridge(host: String, port: Int, completion: @escaping @Sendable (String?) -> Void) {
        // Read auth-token from ~/.agentdeck/auth-token (only works on macOS)
        #if os(macOS)
        let tokenPath = NSHomeDirectory() + "/.agentdeck/auth-token"
        if let token = try? String(contentsOfFile: tokenPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) {
            completion(token)
            return
        }
        #endif

        // For iOS: try bridge's /health endpoint which doesn't require auth
        let url = URL(string: "http://\(host):\(port)/health")!
        var request = URLRequest(url: url, timeoutInterval: 3)
        request.httpMethod = "GET"
        print("[Discovery] fetching token from http://\(host):\(port)/health")
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                print("[Discovery] /health fetch error: \(error.localizedDescription)")
                completion(nil)
                return
            }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = json["pairingToken"] as? String else {
                print("[Discovery] /health parse failed, data=\(data.map { String(data: $0, encoding: .utf8) ?? "?" } ?? "nil")")
                completion(nil)
                return
            }
            print("[Discovery] /health got token: \(token.prefix(8))...")
            completion(token)
        }.resume()
    }

    // MARK: - Endpoint Resolution

    private func resolveEndpoint(_ endpoint: NWEndpoint, completion: @escaping @Sendable (String?) -> Void) {
        let connection = NWConnection(to: endpoint, using: .tcp)
        let guard_ = ResolveGuard()

        connection.stateUpdateHandler = { state in
            guard guard_.tryComplete() else { return }
            switch state {
            case .ready:
                // Extract resolved IP from the connection's current path
                if let path = connection.currentPath,
                   let remoteEndpoint = path.remoteEndpoint,
                   case .hostPort(let host, _) = remoteEndpoint {
                    let hostStr = "\(host)"
                    // Strip interface suffix (e.g. "%en0")
                    let clean = hostStr.components(separatedBy: "%").first ?? hostStr
                    completion(clean)
                } else {
                    completion(nil)
                }
                connection.cancel()
            case .failed, .cancelled:
                completion(nil)
            default:
                guard_.reset()  // Not a terminal state, allow retry
            }
        }

        connection.start(queue: queue)

        // Timeout after 3 seconds
        queue.asyncAfter(deadline: .now() + 3) {
            guard guard_.tryComplete() else { return }
            completion(nil)
            connection.cancel()
        }
    }
}

// MARK: - Thread-safe completion guard

private final class ResolveGuard: @unchecked Sendable {
    private let lock = NSLock()
    private var _completed = false

    /// Returns true if this is the first call (i.e., we "won" the race).
    func tryComplete() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if _completed { return false }
        _completed = true
        return true
    }

    func reset() {
        lock.lock()
        defer { lock.unlock() }
        _completed = false
    }
}

// MARK: - NWTXTRecord helper

extension NWTXTRecord {
    func getDictionaryValue(for key: String) -> String? {
        guard let entry = getEntry(for: key) else { return nil }
        if case .string(let str) = entry {
            // entry is "key=value" format
            if let eqIdx = str.firstIndex(of: "=") {
                return String(str[str.index(after: eqIdx)...])
            }
            return str
        }
        return nil
    }
}
