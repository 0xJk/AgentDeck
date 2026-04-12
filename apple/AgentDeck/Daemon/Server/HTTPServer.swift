#if os(macOS)
// HTTPServer.swift — Lightweight HTTP server for /health, /status, /shutdown, hooks
// Uses Network.framework (no external dependencies)

import Foundation
import Network

actor HTTPServer {
    private var listener: NWListener?
    private(set) var boundPort: UInt16?
    private var routes: [(method: String, path: String, handler: @Sendable (HTTPRequest) async -> HTTPResponse)] = []
    private var streamRoutes: [(method: String, path: String, handler: @Sendable (HTTPRequest, StreamConnection) async -> Void)] = []

    struct HTTPRequest: Sendable {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data?
        let queryParams: [String: String]
        let remoteIP: String
    }

    struct HTTPResponse: Sendable {
        let status: Int
        let headers: [String: String]
        let body: Data?

        static func json(_ obj: Any, status: Int = 200) -> HTTPResponse {
            let data = try? JSONSerialization.data(withJSONObject: obj)
            return HTTPResponse(
                status: status,
                headers: ["Content-Type": "application/json"],
                body: data
            )
        }

        static func text(_ str: String, status: Int = 200) -> HTTPResponse {
            HTTPResponse(
                status: status,
                headers: ["Content-Type": "text/plain"],
                body: Data(str.utf8)
            )
        }

        static let notFound = HTTPResponse(status: 404, headers: [:], body: Data("Not Found".utf8))
    }

    final class StreamConnection: @unchecked Sendable {
        fileprivate let raw: NWConnection

        fileprivate init(raw: NWConnection) {
            self.raw = raw
        }

        func send(_ data: Data, completion: @escaping @Sendable (Bool) -> Void) {
            raw.send(content: data, completion: .contentProcessed { error in
                completion(error == nil)
            })
        }

        func cancel() {
            raw.cancel()
        }
    }

    // MARK: - Route Registration

    func get(_ path: String, handler: @escaping @Sendable (HTTPRequest) async -> HTTPResponse) {
        routes.append((method: "GET", path: path, handler: handler))
    }

    func post(_ path: String, handler: @escaping @Sendable (HTTPRequest) async -> HTTPResponse) {
        routes.append((method: "POST", path: path, handler: handler))
    }

    func stream(_ path: String, handler: @escaping @Sendable (HTTPRequest, StreamConnection) async -> Void) {
        streamRoutes.append((method: "GET", path: path, handler: handler))
    }

    // MARK: - Lifecycle

    func start(port: UInt16) throws {
        let params = NWParameters.tcp
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(domain: "HTTPServer", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid port \(port)"])
        }
        let listener = try NWListener(using: params, on: nwPort)
        self.listener = listener
        self.boundPort = port

        listener.newConnectionHandler = { [weak self] conn in
            Task { await self?.handleConnection(conn) }
        }

        listener.stateUpdateHandler = { state in
            if case .ready = state {
                DaemonLogger.shared.debug("HTTP", "Server listening on port \(port)")
            }
        }

        listener.start(queue: .main)
    }

    func stop() {
        listener?.cancel()
    }

    // MARK: - Connection Handling

    private func handleConnection(_ conn: NWConnection) {
        conn.start(queue: .main)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, error in
            guard let data, error == nil else {
                conn.cancel()
                return
            }
            Task {
                guard let self else { return }
                let request = Self.parseHTTPRequest(data, remoteIP: conn.endpoint.debugDescription)
                let handled = await self.handle(request, on: conn)
                if !handled {
                    conn.cancel()
                }
            }
        }
    }

    /// Route a request, including long-lived stream routes. Returns true if handled.
    func handle(_ request: HTTPRequest, on conn: NWConnection) async -> Bool {
        for route in streamRoutes where route.method == request.method && route.path == request.path {
            await route.handler(request, StreamConnection(raw: conn))
            return true
        }

        let response = await route(request)
        let raw = Self.formatHTTPResponse(response)
        conn.send(content: raw, completion: .contentProcessed({ _ in
            conn.cancel()
        }))
        return true
    }

    /// Route a request to matching handler (used by WebSocketServer for HTTP delegation).
    /// Supports both exact match and prefix match (paths ending with "*").
    func route(_ request: HTTPRequest) async -> HTTPResponse {
        // Exact match first
        for route in routes {
            if route.method == request.method && route.path == request.path {
                return await route.handler(request)
            }
        }
        // Prefix match (e.g., "/hooks/*" matches "/hooks/PreToolUse")
        for route in routes {
            if route.method == request.method && route.path.hasSuffix("*") {
                let prefix = String(route.path.dropLast()) // remove "*"
                if request.path.hasPrefix(prefix) {
                    return await route.handler(request)
                }
            }
        }
        return .notFound
    }

    // MARK: - HTTP Parsing (static — used by WebSocketServer for unified handling)

    static func parseHTTPRequest(_ data: Data, remoteIP: String) -> HTTPRequest {
        let text = String(data: data, encoding: .utf8) ?? ""
        let separator = "\r\n"
        let lines = text.components(separatedBy: separator)

        guard let requestLine = lines.first else {
            return HTTPRequest(method: "GET", path: "/", headers: [:], body: nil, queryParams: [:], remoteIP: remoteIP)
        }

        let parts = requestLine.split(separator: " ", maxSplits: 2)
        let method = parts.count > 0 ? String(parts[0]) : "GET"
        let fullPath = parts.count > 1 ? String(parts[1]) : "/"

        // Parse path and query params
        let pathComponents = fullPath.split(separator: "?", maxSplits: 1)
        let path = String(pathComponents[0])
        var queryParams: [String: String] = [:]
        if pathComponents.count > 1 {
            for param in pathComponents[1].split(separator: "&") {
                let kv = param.split(separator: "=", maxSplits: 1)
                if kv.count == 2 {
                    queryParams[String(kv[0])] = String(kv[1])
                }
            }
        }

        // Parse headers
        var headers: [String: String] = [:]
        var bodyStart = 0
        for (i, line) in lines.dropFirst().enumerated() {
            if line.isEmpty {
                bodyStart = i + 2
                break
            }
            let hParts = line.split(separator: ":", maxSplits: 1)
            if hParts.count == 2 {
                headers[String(hParts[0]).lowercased()] = String(hParts[1]).trimmingCharacters(in: .whitespaces)
            }
        }

        // Body
        let body: Data?
        if bodyStart > 0 && bodyStart < lines.count {
            body = lines[bodyStart...].joined(separator: separator).data(using: .utf8)
        } else {
            body = nil
        }

        return HTTPRequest(method: method, path: path, headers: headers, body: body, queryParams: queryParams, remoteIP: remoteIP)
    }

    static func formatHTTPResponse(_ response: HTTPResponse) -> Data {
        var header = formatHTTPHeaders(status: response.status, headers: response.headers)
        let bodyData = response.body ?? Data()
        header += "Content-Length: \(bodyData.count)\r\n"
        header += "Connection: close\r\n"
        header += "\r\n"

        var result = Data(header.utf8)
        result.append(bodyData)
        return result
    }

    static func formatHTTPHeaders(status: Int, headers: [String: String]) -> String {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 204: statusText = "No Content"
        case 400: statusText = "Bad Request"
        case 401: statusText = "Unauthorized"
        case 404: statusText = "Not Found"
        case 500: statusText = "Internal Server Error"
        case 501: statusText = "Not Implemented"
        case 503: statusText = "Service Unavailable"
        default: statusText = "Unknown"
        }

        var header = "HTTP/1.1 \(status) \(statusText)\r\n"
        header += "Access-Control-Allow-Origin: *\r\n"
        for (key, value) in headers {
            header += "\(key): \(value)\r\n"
        }
        return header
    }
}
#endif
