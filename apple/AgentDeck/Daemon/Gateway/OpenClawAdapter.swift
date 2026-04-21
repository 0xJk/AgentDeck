#if os(macOS)
// OpenClawAdapter.swift — OpenClaw Gateway WebSocket client
// Ported from bridge/src/adapters/openclaw.ts

import Foundation
import CryptoKit
import Security

enum OpenClawGatewayTokenStore {
    private static let service = "bound.serendipity.agentdeck.dashboard.openclaw.gateway-token"
    private static let account = "default"

    static func loadToken() -> String? {
        var query = keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    static func saveToken(_ token: String) throws {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            try deleteToken()
            return
        }
        let data = Data(trimmed.utf8)
        let query = keychainQuery()
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(addStatus), userInfo: nil)
        }
    }

    static func deleteToken() throws {
        let status = SecItemDelete(keychainQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
        }
    }

    private static func keychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// Connects to OpenClaw Gateway via WebSocket, handles Ed25519 auth handshake,
/// and relays events to the daemon.
actor OpenClawAdapter {
    private struct DeviceIdentity {
        let deviceId: String
        let publicKeyBase64Url: String
        let privateKey: Curve25519.Signing.PrivateKey
    }

    private struct DeviceAuthToken {
        let token: String
        let role: String
        let scopes: [String]
    }

    private var wsTask: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private var sessionsPollTask: Task<Void, Never>?
    private let gatewayUrl: String
    private var isConnected = false
    private var isStopping = false
    private var pairingRequired = false
    private var sessionsSubscribed = false
    private var reconnectDelay: TimeInterval = 1
    private let maxReconnectDelay: TimeInterval = 30
    private let protocolVersion = 3

    private var currentSessionKey: String?
    private var currentRunId: String?
    private var promptCapturedForRunId: String? // guard: emit prompt entry once per runId
    private var pendingApprovalId: String?
    private struct RPCResponse: @unchecked Sendable {
        let ok: Bool
        let payload: [String: Any]?
        let error: [String: Any]?
    }
    private struct PendingRPC {
        let method: String
        let continuation: CheckedContinuation<RPCResponse, Never>?
    }
    private var pendingMethods: [String: PendingRPC] = [:]
    private var deviceIdentity: DeviceIdentity?
    private var deviceAuthToken: DeviceAuthToken?
    private let clientId = "gateway-client"
    private let clientDisplayName = "AgentDeck Dashboard"
    private let clientMode = "backend"
    private let clientPlatform = "darwin"
    private let clientDeviceFamily = "mac"
    private let defaultRole = "operator"
    private let defaultScopes = ["operator.read", "operator.write", "operator.approvals"]

    private var _onEvent: (@Sendable ([String: Any]) -> Void)?
    private var _onConnectionChanged: (@Sendable (Bool) -> Void)?

    func setOnEvent(_ handler: @escaping @Sendable ([String: Any]) -> Void) { _onEvent = handler }
    func setOnConnectionChanged(_ handler: @escaping @Sendable (Bool) -> Void) { _onConnectionChanged = handler }

    var isConnectedSnapshot: Bool { isConnected }

    /// Snapshot of the locally-generated Ed25519 public-key SHA-256 hex that
    /// identifies this Mac to the Gateway's pairing flow. Dashboard surfaces
    /// the first few hex chars when auth is stuck on "device signature
    /// invalid" so the user knows which deviceId to approve in the OpenClaw
    /// Web UI. Returns nil when the identity has not been loaded yet.
    func currentDeviceId() -> String? { deviceIdentity?.deviceId }

    init(gatewayUrl: String = "ws://127.0.0.1:18789") {
        self.gatewayUrl = gatewayUrl
    }

    func start() {
        isStopping = false
        pairingRequired = false
        loadDeviceIdentity()
        connect()
    }

    func stop() {
        isStopping = true
        reconnectTask?.cancel()
        reconnectTask = nil
        sessionsPollTask?.cancel()
        sessionsPollTask = nil
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        let wasConnected = isConnected
        isConnected = false
        sessionsSubscribed = false
        promptCapturedForRunId = nil
        if wasConnected {
            self._onConnectionChanged?(false)
        }
    }

    // MARK: - Connection

    private func connect() {
        guard let url = URL(string: gatewayUrl) else { return }
        reconnectTask?.cancel()
        reconnectTask = nil
        let task = URLSession.shared.webSocketTask(with: url)
        self.wsTask = task
        task.resume()

        receiveLoop(task)

        // Wait a moment then attempt handshake
        Task {
            try? await Task.sleep(for: .milliseconds(500))
            performHandshake()
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task {
                guard let self else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        await self.handleMessage(text)
                    default:
                        break
                    }
                    await self.receiveLoop(task)
                case .failure:
                    await self.handleDisconnect()
                }
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        // Envelope parse via generated ADGatewayFrame — this anchors the Swift
        // adapter to shared/src/gateway-protocol.ts. Field extraction still
        // reads the raw dict because quicktype flattens the payload union,
        // but `.type` / `.event` come from the generated enums so any rename
        // in the single source fails compilation here.
        let frame = try? JSONDecoder().decode(ADGatewayFrame.self, from: data)

        switch frame?.type {
        case .event:
            handleGatewayEvent(frame?.event, rawEvent: json["event"] as? String,
                               payload: json["payload"] as? [String: Any] ?? [:])
        case .res:
            handleResponse(json)
        case .req, .none:
            break
        }
    }

    private func handleGatewayEvent(_ event: ADGatewayEventName?, rawEvent: String?, payload: [String: Any]) {
        let eventName = rawEvent ?? event?.rawValue ?? ""
        switch eventName {
        case ADGatewayEventName.connectChallenge.rawValue:
            guard let nonce = payload["nonce"] as? String, !nonce.isEmpty else {
                DaemonLogger.shared.debug("OpenClaw", "connect.challenge missing nonce")
                return
            }
            DaemonLogger.shared.debug("OpenClaw", "Challenge nonce: \(String(nonce.prefix(8)))...")
            sendConnectRequest(nonce: nonce)
        case ADGatewayEventName.chat.rawValue:
            if let runId = payload["runId"] as? String, !runId.isEmpty {
                currentRunId = runId
            }
            if let sessionKey = payload["sessionKey"] as? String, !sessionKey.isEmpty {
                currentSessionKey = sessionKey
            }
            let chatState = payload["state"] as? String

            // Gateway echoes the user's prompt in the first delta's `prompt` field.
            // Capture it here so timeline shows the actual text regardless of whether
            // sessions.messages.subscribe is working.
            if let prompt = payload["prompt"] as? String, !prompt.isEmpty,
               promptCapturedForRunId != currentRunId {
                promptCapturedForRunId = currentRunId
                let entry = DaemonTimelineEntry(
                    ts: Self.payloadTimestamp(payload),
                    type: "model_call",
                    raw: String(prompt.prefix(200)),
                    detail: prompt,
                    approvalId: nil, status: nil,
                    agentType: "openclaw", repeatCount: nil, automated: nil,
                    runId: currentRunId
                )
                emitTimelineEntry(entry)
            }

            // Capture full assembled response on final so timeline shows real content.
            if chatState == "final", let response = payload["response"] as? String, !response.isEmpty {
                let entry = DaemonTimelineEntry(
                    ts: Self.payloadTimestamp(payload),
                    type: "model_response",
                    raw: String(response.prefix(200)),
                    detail: response,
                    approvalId: nil, status: nil,
                    agentType: "openclaw", repeatCount: nil, automated: nil,
                    runId: currentRunId
                )
                emitTimelineEntry(entry)
            }

            // Chat events (delta, final, aborted, error).
            // runId is promoted to the top level so DaemonServer can route it
            // to the APME collector without unwrapping the nested payload.
            var chatEvent: [String: Any] = ["type": "gateway_chat", "event": eventName, "payload": payload]
            if let runId = currentRunId { chatEvent["runId"] = runId }
            self._onEvent?(chatEvent)
        case ADGatewayEventName.execApprovalRequested.rawValue:
            pendingApprovalId = payload["id"] as? String
            self._onEvent?(["type": "gateway_approval", "payload": payload])
        case ADGatewayEventName.execApprovalResolved.rawValue:
            pendingApprovalId = nil
            self._onEvent?(["type": "gateway_approval_resolved", "payload": payload])
        case ADGatewayEventName.presence.rawValue, ADGatewayEventName.systemPresence.rawValue:
            self._onEvent?(["type": "gateway_presence", "payload": payload])
        case ADGatewayEventName.health.rawValue:
            self._onEvent?(["type": "gateway_health", "payload": payload])
        case ADGatewayEventName.sessionsChanged.rawValue:
            requestSessionsList()
        case ADGatewayEventName.sessionMessage.rawValue:
            emitTimelineEntry(fromSessionMessage: payload)
        case ADGatewayEventName.sessionTool.rawValue:
            emitTimelineEntry(fromSessionTool: payload)
        case ADGatewayEventName.tick.rawValue:
            break // Heartbeat, ignore
        case ADGatewayEventName.shutdown.rawValue:
            handleDisconnect()
        default:
            break
        }
    }

    private func handleResponse(_ json: [String: Any]) {
        let responseId = json["id"] as? String ?? "unknown"
        let pending = pendingMethods.removeValue(forKey: responseId)
        let method = pending?.method
        let ok = json["ok"] as? Bool ?? false
        let payload = json["payload"] as? [String: Any]
        let errorInfo = json["error"] as? [String: Any]
        pending?.continuation?.resume(returning: RPCResponse(ok: ok, payload: payload, error: errorInfo))

        DaemonLogger.shared.debug("OpenClaw", "Response: \(responseId) method=\(method ?? "?") ok=\(ok)")

        guard ok else {
            if method == "connect" {
                let errorCode = errorInfo?["code"] as? String
                    ?? (errorInfo?["details"] as? [String: Any])?["code"] as? String
                DaemonLogger.shared.error("OpenClaw handshake failed: \(json["error"] ?? "unknown" as Any)")

                let authStatus = classifyAuthFailure(errorCode: errorCode, error: errorInfo)
                // Block reconnect only for states that require action in the Gateway Web UI.
                // Token config errors (missing/mismatch) are fixable from Settings — let the
                // adapter keep reconnecting so saving the token takes effect automatically.
                let requiresWebUIAction = ["pairing_required", "device_auth_invalid",
                                           "approval_pending", "unsupported_protocol"]
                    .contains(authStatus.status)
                if requiresWebUIAction {
                    pairingRequired = true
                }
                emitAuthStatus(authStatus.status, requestId: authStatus.requestId, message: authStatus.message)
                DaemonLogger.shared.error("OpenClaw: auth status \(authStatus.status) — reconnect \(requiresWebUIAction ? "blocked" : "allowed")")
                wsTask?.cancel(with: .goingAway, reason: nil)
                wsTask = nil
            } else {
                DaemonLogger.shared.error("OpenClaw RPC '\(method ?? "?")' failed: \(errorInfo?["code"] as? String ?? errorInfo?["message"] as? String ?? "unknown")")
            }
            return
        }

        switch method {
        case "connect":
            guard validateHelloOk(payload) else {
                pairingRequired = true
                emitAuthStatus("unsupported_protocol", requestId: nil, message: "OpenClaw Gateway version not supported")
                wsTask?.cancel(with: .goingAway, reason: nil)
                wsTask = nil
                return
            }
            persistHelloAuth(payload)
            markConnectedIfNeeded()
            emitAuthStatus("connected", requestId: nil, message: nil)
            requestBaselineState()
            requestSessionsList()
            Task { await self.emitModelCatalog() }
        case "sessions.subscribe":
            let subscribed = payload?["subscribed"] as? Bool ?? false
            sessionsSubscribed = subscribed
            DaemonLogger.shared.debug("OpenClaw", "sessions.subscribe: subscribed=\(subscribed)")
            if !subscribed {
                // Gateway didn't acknowledge subscription — fall back to periodic polling
                // so session changes are still detected (e.g., shared-token mode without
                // device auth may limit subscription access).
                startSessionsPolling()
            }
        case "sessions.list":
            if let payload {
                applySessionsPayload(payload)
            }
        case "health":
            if let payload {
                self._onEvent?(["type": "gateway_health", "payload": payload])
            }
        default:
            break
        }
    }

    private func handleDisconnect() {
        let wasConnected = isConnected
        isConnected = false
        wsTask = nil
        sessionsSubscribed = false
        sessionsPollTask?.cancel()
        sessionsPollTask = nil

        if wasConnected {
            self._onConnectionChanged?(false)
        }

        guard !isStopping else { return }

        guard !pairingRequired else {
            return
        }

        // Reconnect with exponential backoff
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, maxReconnectDelay)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.connect()
        }
    }

    // MARK: - Ed25519 Handshake

    private func performHandshake() {
        // Handshake starts only when Gateway emits connect.challenge.
        // Keep this method to document that the connection is intentionally idle until challenged.
        DaemonLogger.shared.debug("OpenClaw", "WebSocket opened, awaiting connect.challenge")
    }

    private func markConnectedIfNeeded() {
        guard !isConnected else { return }
        isConnected = true
        reconnectDelay = 1
        self._onConnectionChanged?(true)
    }

    private func loadDeviceIdentity() {
        loadAppStoreDeviceIdentity()
    }

    private struct StoredAppStoreIdentity: Codable {
        var privateKey: String
        var deviceId: String
        var deviceToken: String?
        var role: String?
        var scopes: [String]?
    }

    private static let appStoreIdentityService = "bound.serendipity.agentdeck.dashboard.openclaw.identity"
    private static let appStoreIdentityAccount = "default"

    private func loadAppStoreDeviceIdentity() {
        do {
            let stored = try loadOrCreateStoredAppStoreIdentity()
            guard let rawPrivateKey = Data(base64Encoded: stored.privateKey) else {
                throw NSError(domain: "OpenClawIdentityStore", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid stored private key"])
            }
            let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: rawPrivateKey)
            let publicKeyRaw = privateKey.publicKey.rawRepresentation
            let deviceId = Data(SHA256.hash(data: publicKeyRaw)).hexString
            let canonical = StoredAppStoreIdentity(
                privateKey: stored.privateKey,
                deviceId: deviceId,
                deviceToken: stored.deviceToken,
                role: stored.role,
                scopes: stored.scopes
            )
            if canonical.deviceId != stored.deviceId {
                try saveStoredAppStoreIdentity(canonical)
            }
            deviceIdentity = DeviceIdentity(
                deviceId: deviceId,
                publicKeyBase64Url: publicKeyRaw.base64URLEncodedString(),
                privateKey: privateKey
            )
            if let token = canonical.deviceToken, !token.isEmpty {
                deviceAuthToken = DeviceAuthToken(
                    token: token,
                    role: canonical.role ?? defaultRole,
                    scopes: canonical.scopes?.isEmpty == false ? canonical.scopes ?? defaultScopes : defaultScopes
                )
            } else {
                deviceAuthToken = nil
            }
            DaemonLogger.shared.debug("OpenClaw", "App Store identity ready: \(String(deviceId.prefix(16)))...")
        } catch {
            deviceIdentity = nil
            deviceAuthToken = nil
            emitAuthStatus("auth_failed", requestId: nil, message: "OpenClaw identity unavailable")
            DaemonLogger.shared.error("OpenClaw App Store identity load failed: \(error)")
        }
    }

    private func loadOrCreateStoredAppStoreIdentity() throws -> StoredAppStoreIdentity {
        if let stored = try loadStoredAppStoreIdentity() {
            return stored
        }
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKeyRaw = privateKey.publicKey.rawRepresentation
        let stored = StoredAppStoreIdentity(
            privateKey: privateKey.rawRepresentation.base64EncodedString(),
            deviceId: Data(SHA256.hash(data: publicKeyRaw)).hexString,
            deviceToken: nil,
            role: defaultRole,
            scopes: defaultScopes
        )
        try saveStoredAppStoreIdentity(stored)
        return stored
    }

    private func loadStoredAppStoreIdentity() throws -> StoredAppStoreIdentity? {
        var query = Self.appStoreKeychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
        }
        return try JSONDecoder().decode(StoredAppStoreIdentity.self, from: data)
    }

    private func saveStoredAppStoreIdentity(_ stored: StoredAppStoreIdentity) throws {
        let data = try JSONEncoder().encode(stored)
        let query = Self.appStoreKeychainQuery()
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
        }
    }

    private static func appStoreKeychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: appStoreIdentityService,
            kSecAttrAccount as String: appStoreIdentityAccount,
        ]
    }

    // MARK: - RPC

    func sendRPC(method: String, params: [String: Any]) {
        sendRPC(method: method, params: params, continuation: nil)
    }

    private func rpcRequest(method: String, params: [String: Any]) async -> RPCResponse {
        await withCheckedContinuation { continuation in
            sendRPC(method: method, params: params, continuation: continuation)
        }
    }

    private func sendRPC(
        method: String,
        params: [String: Any],
        continuation: CheckedContinuation<RPCResponse, Never>?
    ) {
        guard let wsTask else {
            DaemonLogger.shared.debug("OpenClaw", "Skipping RPC \(method): gateway socket is not connected")
            continuation?.resume(returning: RPCResponse(
                ok: false,
                payload: nil,
                error: ["code": "NOT_CONNECTED", "message": "gateway socket is not connected"]
            ))
            return
        }
        var resolvedParams = params
        switch method {
        case "chat.send":
            if resolvedParams["sessionKey"] == nil, let sessionKey = currentSessionKey {
                resolvedParams["sessionKey"] = sessionKey
            }
            if resolvedParams["idempotencyKey"] == nil {
                resolvedParams["idempotencyKey"] = UUID().uuidString
            }
        case "chat.abort":
            if resolvedParams["sessionKey"] == nil, let sessionKey = currentSessionKey {
                resolvedParams["sessionKey"] = sessionKey
            }
            if resolvedParams["runId"] == nil, let runId = currentRunId {
                resolvedParams["runId"] = runId
            }
        case "exec.approval.resolve":
            if resolvedParams["id"] == nil, let pendingApprovalId {
                resolvedParams["id"] = pendingApprovalId
            }
        default:
            break
        }

        if method == "sessions.messages.subscribe",
           resolvedParams["key"] == nil,
           let sessionKey = currentSessionKey {
            resolvedParams["key"] = sessionKey
        }

        let requestId = UUID().uuidString
        let frame: [String: Any] = [
            "type": "req",
            "id": requestId,
            "method": method,
            "params": resolvedParams,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8) else { return }
        pendingMethods[requestId] = PendingRPC(method: method, continuation: continuation)
        wsTask.send(.string(text)) { error in
            if let error {
                DaemonLogger.shared.debug("OpenClaw", "RPC \(method) send failed: \(error)")
                Task { await self.completeRPCSendFailure(requestId: requestId, message: String(describing: error)) }
            }
        }
    }

    private func completeRPCSendFailure(requestId: String, message: String) {
        guard let pending = pendingMethods.removeValue(forKey: requestId) else { return }
        pending.continuation?.resume(returning: RPCResponse(
            ok: false,
            payload: nil,
            error: ["code": "SEND_FAILED", "message": message]
        ))
    }

    private func sendConnectRequest(nonce: String) {
        var scopes = deviceAuthToken?.scopes ?? defaultScopes
        if scopes.isEmpty {
            scopes = defaultScopes
        }

        var params: [String: Any] = [
            "minProtocol": protocolVersion,
            "maxProtocol": protocolVersion,
            "client": [
                "id": clientId,
                "displayName": clientDisplayName,
                "version": "0.3.0",
                "platform": clientPlatform,
                "deviceFamily": clientDeviceFamily,
                "mode": clientMode,
            ],
            "role": defaultRole,
            "scopes": scopes,
            "caps": ["tool-events"],
        ]

        let sharedToken = OpenClawGatewayTokenStore.loadToken()
        let hasSharedToken = sharedToken.map { !$0.isEmpty } ?? false
        let hasDeviceToken = deviceAuthToken.map { !$0.token.isEmpty } ?? false

        // Send device auth only when:
        //  a) we already have a device-specific token from a previous pairing, OR
        //  b) no shared token is configured — Gateway must issue a device token via
        //     the pairing flow (approve in Web UI).
        // When only a shared token is present (first launch), sending device auth
        // causes the Gateway to reject the unknown Ed25519 key as DEVICE_AUTH_INVALID
        // even though the shared token alone is sufficient.
        let shouldSendDeviceAuth = hasDeviceToken || !hasSharedToken
        if shouldSendDeviceAuth, let device = buildDeviceAuth(nonce: nonce, requestScopes: scopes) {
            params["device"] = device
        }

        var auth: [String: Any] = [:]
        if let token = sharedToken, !token.isEmpty {
            auth["token"] = token
        }
        if let deviceToken = deviceAuthToken?.token, !deviceToken.isEmpty {
            auth["deviceToken"] = deviceToken
        }
        if !auth.isEmpty {
            params["auth"] = auth
        }

        sendRPC(method: "connect", params: params)
    }

    private func requestSessionsList() {
        sendRPC(method: "sessions.list", params: [:])
    }

    private func startSessionsPolling() {
        sessionsPollTask?.cancel()
        sessionsPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { break }
                await self?.requestSessionsList()
            }
        }
    }

    private func requestBaselineState() {
        sendRPC(method: "sessions.subscribe", params: [:])
        sendRPC(method: "health", params: [:])
        sendRPC(method: "system-presence", params: [:])
        Task { await requestInitialLogTail() }
    }

    private func applySessionsPayload(_ payload: [String: Any]) {
        guard let sessions = payload["sessions"] as? [[String: Any]], !sessions.isEmpty else {
            DaemonLogger.shared.debug("OpenClaw", "No sessions available")
            return
        }

        let sorted = sessions.sorted { lhs, rhs in
            let left = (lhs["updatedAt"] as? NSNumber)?.doubleValue ?? (lhs["updatedAt"] as? Double) ?? 0
            let right = (rhs["updatedAt"] as? NSNumber)?.doubleValue ?? (rhs["updatedAt"] as? Double) ?? 0
            return left > right
        }
        currentSessionKey = sorted.first?["key"] as? String
        DaemonLogger.shared.debug("OpenClaw", "Active session: \(currentSessionKey ?? "nil")")
        if let currentSessionKey {
            sendRPC(method: "sessions.messages.subscribe", params: ["key": currentSessionKey])
        }
    }

    private func buildDeviceAuth(nonce: String, requestScopes: [String]) -> [String: Any]? {
        guard let deviceIdentity else { return nil }
        let signedAt = Int(Date().timeIntervalSince1970 * 1000)
        let scopes = requestScopes.joined(separator: ",")

        let token = deviceAuthToken?.token ?? ""
        let payload = [
            "v3",
            deviceIdentity.deviceId,
            clientId,
            clientMode,
            defaultRole,
            scopes,
            String(signedAt),
            token,
            nonce,
            clientPlatform,
            clientDeviceFamily,
        ].joined(separator: "|")

        guard let signature = try? deviceIdentity.privateKey.signature(for: Data(payload.utf8)) else {
            DaemonLogger.shared.error("OpenClaw: device auth signing failed")
            return nil
        }

        return [
            "id": deviceIdentity.deviceId,
            "publicKey": deviceIdentity.publicKeyBase64Url,
            "signature": signature.base64URLEncodedString(),
            "signedAt": signedAt,
            "nonce": nonce,
        ]
    }

    private func validateHelloOk(_ payload: [String: Any]?) -> Bool {
        guard let payload else { return false }
        let protocolNumber = (payload["protocol"] as? NSNumber)?.intValue ?? payload["protocol"] as? Int
        if let protocolNumber, protocolNumber > protocolVersion {
            return false
        }
        guard let features = payload["features"] as? [String: Any],
              let methods = features["methods"] as? [String] else {
            return true
        }
        let required = ["health", "models.list", "logs.tail", "sessions.list", "sessions.subscribe", "sessions.messages.subscribe"]
        return required.allSatisfy { methods.contains($0) }
    }

    private func persistHelloAuth(_ payload: [String: Any]?) {
        guard let auth = payload?["auth"] as? [String: Any],
              let token = auth["deviceToken"] as? String,
              !token.isEmpty else { return }
        let role = auth["role"] as? String ?? defaultRole
        let scopes = (auth["scopes"] as? [String]) ?? defaultScopes
        deviceAuthToken = DeviceAuthToken(token: token, role: role, scopes: scopes)

        do {
            guard var stored = try loadStoredAppStoreIdentity() else { return }
            stored.deviceToken = token
            stored.role = role
            stored.scopes = scopes
            try saveStoredAppStoreIdentity(stored)
        } catch {
            DaemonLogger.shared.error("OpenClaw device token persist failed: \(error)")
        }
    }

    private func classifyAuthFailure(
        errorCode: String?,
        error: [String: Any]?
    ) -> (status: String, requestId: String?, message: String?) {
        let details = error?["details"] as? [String: Any]
        let detailCode = (details?["code"] as? String ?? errorCode ?? "").uppercased()
        let requestId = details?["requestId"] as? String
            ?? details?["pendingRequestId"] as? String
            ?? details?["pairingRequestId"] as? String
        let message = error?["message"] as? String
        if detailCode.contains("PAIRING") || detailCode == "NOT_PAIRED" || detailCode == "DEVICE_IDENTITY_REQUIRED" {
            if let requestId, !requestId.isEmpty {
                return ("approval_pending", requestId, message)
            }
            return ("pairing_required", requestId, message)
        }
        if detailCode.contains("TOKEN_MISMATCH") {
            return ("token_mismatch", requestId, message)
        }
        if detailCode.contains("TOKEN_MISSING") || (message ?? "").localizedCaseInsensitiveContains("gateway token missing") {
            return ("gateway_token_missing", requestId, message)
        }
        if detailCode.contains("DEVICE_AUTH") {
            return ("device_auth_invalid", requestId, message)
        }
        if detailCode.contains("PROTOCOL") {
            return ("unsupported_protocol", requestId, message)
        }
        return ("auth_failed", requestId, message)
    }

    private func emitAuthStatus(_ status: String, requestId: String?, message: String?) {
        var event: [String: Any] = ["type": "gateway_auth", "status": status]
        if let requestId, !requestId.isEmpty { event["requestId"] = requestId }
        if let message, !message.isEmpty { event["message"] = message }
        _onEvent?(event)
    }

    private func emitModelCatalog(retry: Bool = true) async {
        guard let (entries, defaultModel) = await fetchModelCatalog() else {
            if retry && !isStopping {
                DaemonLogger.shared.debug("OpenClaw", "Model catalog empty — retrying in 10s")
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled, !isStopping else { return }
                await emitModelCatalog(retry: false)
            }
            return
        }
        _onEvent?([
            "type": "model_catalog",
            "models": entries,
            "defaultModel": defaultModel as Any,
        ])
    }

    private func fetchModelCatalog() async -> ([[String: Any]], String?)? {
        let response = await rpcRequest(method: "models.list", params: [:])
        guard response.ok, let payload = response.payload,
              let models = payload["models"] as? [[String: Any]] else {
            DaemonLogger.shared.debug("OpenClaw", "Model catalog RPC failed: \(response.error ?? [:])")
            return nil
        }
        let entries = models.compactMap { model -> [String: Any]? in
            let key = model["key"] as? String
                ?? model["id"] as? String
                ?? [model["provider"] as? String, model["name"] as? String].compactMap { $0 }.joined(separator: "/")
            let name = model["name"] as? String
                ?? model["title"] as? String
                ?? model["id"] as? String
                ?? key
            guard !key.isEmpty, !name.isEmpty else { return nil }
            let tags = model["tags"] as? [String] ?? []
            let missing = model["missing"] as? Bool ?? false
            let available = (model["available"] as? Bool ?? true) && !missing
            return [
                "key": key,
                "name": name,
                "role": Self.parseModelRole(tags: tags),
                "available": available,
            ]
        }
        let defaultModel = entries.first(where: { ($0["role"] as? String) == "default" })?["name"] as? String
            ?? entries.first(where: { ($0["available"] as? Bool) != false })?["name"] as? String
        return (entries, defaultModel)
    }

    func fetchHealthHasError() async -> Bool? {
        let response = await rpcRequest(method: "health", params: [:])
        guard response.ok, let payload = response.payload else {
            return nil
        }
        _onEvent?(["type": "gateway_health", "payload": payload])
        if let ok = payload["ok"] as? Bool {
            return !ok
        }
        if let checks = payload["checks"] as? [[String: Any]] {
            return checks.contains {
                let status = ($0["status"] as? String)?.lowercased()
                return status == "error" || status == "warn" || status == "degraded"
            }
        }
        if let status = (payload["status"] as? String)?.lowercased() {
            return status == "error" || status == "warn" || status == "degraded" || status == "unhealthy"
        }
        return false
    }

    private func requestInitialLogTail() async {
        let response = await rpcRequest(method: "logs.tail", params: ["limit": 80, "maxBytes": 64_000])
        guard response.ok,
              let payload = response.payload,
              let lines = payload["lines"] as? [String] else { return }
        for line in lines {
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data),
                  let entry = BridgeLogStream.parseLogLine(json) else { continue }
            emitTimelineEntry(entry)
        }
    }

    private func emitTimelineEntry(fromSessionMessage payload: [String: Any]) {
        let text = payload["text"] as? String
            ?? payload["content"] as? String
            ?? (payload["message"] as? [String: Any])?["text"] as? String
            ?? (payload["message"] as? [String: Any])?["content"] as? String
            ?? ""
        guard !text.isEmpty else { return }
        let role = payload["role"] as? String ?? "message"
        let entry = DaemonTimelineEntry(
            ts: Self.payloadTimestamp(payload),
            type: role == "assistant" ? "model_response" : "model_call",
            raw: String(text.prefix(200)),
            detail: text,
            approvalId: nil,
            status: nil,
            agentType: "openclaw",
            repeatCount: nil,
            automated: nil,
            runId: currentRunId
        )
        emitTimelineEntry(entry)
    }

    private func emitTimelineEntry(fromSessionTool payload: [String: Any]) {
        let toolName = payload["name"] as? String ?? payload["tool"] as? String ?? "tool"
        let status = payload["status"] as? String
        // Include tool input summary in detail so the timeline row shows what
        // the tool was actually called with, not just its name.
        let inputSummary: String? = {
            guard let input = payload["input"] else { return nil }
            let s = String(describing: input)
            return s.isEmpty ? nil : String(s.prefix(300))
        }()
        let detail: String? = [status, inputSummary].compactMap { $0 }.joined(separator: " | ").nonEmpty
        let entry = DaemonTimelineEntry(
            ts: Self.payloadTimestamp(payload),
            type: "tool_exec",
            raw: String(toolName.prefix(200)),
            detail: detail,
            approvalId: nil,
            status: status,
            agentType: "openclaw",
            repeatCount: nil,
            automated: nil,
            runId: currentRunId
        )
        emitTimelineEntry(entry)
    }

    private func emitTimelineEntry(_ entry: DaemonTimelineEntry) {
        var entryDict: [String: Any] = [
            "ts": entry.ts,
            "type": entry.type,
            "raw": entry.raw,
        ]
        if let detail = entry.detail { entryDict["detail"] = detail }
        if let approvalId = entry.approvalId { entryDict["approvalId"] = approvalId }
        if let status = entry.status { entryDict["status"] = status }
        if let agentType = entry.agentType { entryDict["agentType"] = agentType }
        if let repeatCount = entry.repeatCount { entryDict["repeatCount"] = repeatCount }
        if let automated = entry.automated { entryDict["automated"] = automated }
        if let runId = entry.runId { entryDict["runId"] = runId }
        _onEvent?([
            "type": "gateway_timeline_entry",
            "entry": entryDict,
        ])
    }

    private static func payloadTimestamp(_ payload: [String: Any]) -> Double {
        if let ts = payload["ts"] as? NSNumber { return ts.doubleValue }
        if let ts = payload["ts"] as? Double { return ts }
        if let ts = payload["timestamp"] as? NSNumber { return ts.doubleValue }
        return Date().timeIntervalSince1970 * 1000
    }

    private static func parseModelRole(tags: [String]) -> String {
        if tags.contains("default") { return "default" }
        for tag in tags {
            if let suffix = tag.split(separator: "#").last, tag.hasPrefix("fallback#") {
                return "fallback-\(suffix)"
            }
        }
        return "configured"
    }
}

private extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
#endif
