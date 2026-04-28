#if os(macOS)
// UsageAPIClient.swift — OAuth token management + API usage fetch
// Ported from bridge/src/usage-api.ts

import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private final class UsageCacheDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?

    func set(_ data: Data?) {
        lock.lock()
        self.data = data
        lock.unlock()
    }

    func get() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}

struct ApiUsageData: Sendable {
    var fiveHourPercent: Double?
    var fiveHourResetsAt: String?
    var sevenDayPercent: Double?
    var sevenDayResetsAt: String?
    var extraUsageEnabled: Bool = false
    var extraUsageMonthlyLimit: Double?
    var extraUsageUsedCredits: Double?
    var extraUsageUtilization: Double?
    var inferredBillingType: String?  // "subscription" | "api" | nil
    var fetchedAt: Double?
    var stale: Bool = false
}

struct CodexAuthStatus: Sendable {
    var authMode: String?
    var webAuthConnected: Bool = false
    var accessTokenPresent: Bool = false
    var planType: String?
    var accountId: String?
    var subscriptionActiveUntil: String?
    var lastRefreshAt: String?
}

struct AntigravityStatus: Sendable {
    var planName: String?
    var availableCredits: Int?
    var minimumCreditAmountForUsage: Int?
}

enum TokenStatus: String, Sendable {
    case valid, expired, missing, unknown
}

/// Fetches API usage from Anthropic OAuth endpoint, with caching and backoff.
final class UsageAPIClient: Sendable {
    static let shared = UsageAPIClient()

    private static let usageAPIURL = "https://api.anthropic.com/api/oauth/usage"
    private static let keychainService = "Claude Code-credentials"
    private static let cacheFile = AuthManager.agentDeckDir.appendingPathComponent("usage-cache.json")
    private static let fileCacheTTL: TimeInterval = 120  // seconds
    private static let tokenExpiryMargin: TimeInterval = 600  // 10 minutes
    // .userInteractive: fetchUsage()/fetchUsageRelayed() are reachable from
    // main-actor entry points (DaemonServer initial usage task, query_usage
    // command handler) that sync-wait via DispatchSemaphore. Anything below
    // User-interactive (incl. .userInitiated) leaves a one-step priority
    // inversion that TPC flags. The work is a single Data(contentsOf:)
    // bounded by a 700 ms timeout, so the elevated QoS is bounded.
    private static let cacheIOQueue = DispatchQueue(label: "dev.agentdeck.usage.cache-io", qos: .userInteractive)
    private static let cacheReadTimeout: DispatchTimeInterval = .milliseconds(700)

    /// Real home directory, resolved once at process start via the reentrant
    /// `getpwuid_r`. The non-reentrant `getpwuid` returns a pointer into a
    /// thread-shared static buffer, so calling it from multiple threads
    /// (main + ESP32 heartbeat + usage polling) corrupts the result and
    /// crashes during ARC cleanup of the returned struct. `getuid()` is
    /// invariant for the process lifetime, so one-shot resolution is safe.
    private static let resolvedHomeDir: String = {
        var pwd = passwd()
        var result: UnsafeMutablePointer<passwd>?
        var buffer = [CChar](repeating: 0, count: 16 * 1024)
        let rc = getpwuid_r(getuid(), &pwd, &buffer, buffer.count, &result)
        if rc == 0, result != nil {
            return String(cString: pwd.pw_dir)
        }
        return NSHomeDirectory()
    }()

    /// Serializes the Codex auth read path. `readRawCodexAuthStatus` hits
    /// the filesystem and decodes JWTs; under concurrent access the ARC
    /// release of the returned optional race-crashed (`_CFRelease.cold.1`).
    /// A single serial queue is enough — this is a polling path, not hot.
    private let codexAuthQueue = DispatchQueue(
        label: "bound.serendipity.agentdeck.usage.codex-auth"
    )

    /// Short-lived cache for the fully-stabilized Codex auth status so the
    /// hot polling path (ESP32 heartbeat at ~1 Hz) doesn't re-read auth.json
    /// every call.
    nonisolated(unsafe) private var codexAuthCacheEntry: (timestamp: Date, value: CodexAuthStatus?)?
    private static let codexAuthCacheTTL: TimeInterval = 5

    nonisolated(unsafe) private var consecutiveFailures = 0
    nonisolated(unsafe) private var lastTokenStatus: TokenStatus = .unknown
    nonisolated(unsafe) private var lastBackoffStart: Date = .distantPast
    nonisolated(unsafe) private var lastStableCodexAuthStatus: CodexAuthStatus?

    var tokenStatus: TokenStatus { lastTokenStatus }
    var codexAuthStatus: CodexAuthStatus? {
        codexAuthQueue.sync {
            if let cached = codexAuthCacheEntry,
               Date().timeIntervalSince(cached.timestamp) < Self.codexAuthCacheTTL {
                return cached.value
            }
            let merged = Self.stabilizeCodexAuthStatus(
                previous: lastStableCodexAuthStatus,
                current: readRawCodexAuthStatusLocked()
            )
            lastStableCodexAuthStatus = merged
            codexAuthCacheEntry = (Date(), merged)
            return merged
        }
    }
    var antigravityStatus: AntigravityStatus? { readAntigravityStatus() }

    // MARK: - Fetch

    func fetchUsage() async -> ApiUsageData? {
        // Check file cache first — keep stale data as fallback for network failures
        var staleFallback: ApiUsageData?
        if let cached = readFileCache() {
            let age = Date().timeIntervalSince1970 - cached.fetchedAt
            if age < Self.fileCacheTTL {
                DaemonLogger.shared.debug("UsageAPI", "File cache hit (age \(Int(age))s)")
                var data = cached.data
                data.fetchedAt = cached.fetchedAt
                data.stale = false
                return data
            }
            DaemonLogger.shared.debug("UsageAPI", "File cache stale (age \(Int(age))s)")
            var fallback = cached.data
            fallback.fetchedAt = cached.fetchedAt
            fallback.stale = true
            staleFallback = fallback
        }

        // Check backoff
        if consecutiveFailures > 0 {
            let backoff = getBackoffSeconds()
            if backoff > 0 {
                DaemonLogger.shared.debug("UsageAPI", "Backoff active (\(consecutiveFailures) failures, \(Int(backoff))s remaining)")
                return staleFallback
            }
        }

        // Get OAuth token from Keychain
        guard let token = getOAuthToken() else {
            lastTokenStatus = .missing
            DaemonLogger.shared.debug("UsageAPI", "OAuth token missing (keychain lookup failed)")
            return staleFallback
        }

        // Check token expiry
        if let creds = getOAuthCredentials(), let expiresAt = creds.expiresAt {
            if Date().timeIntervalSince1970 > (Double(expiresAt) / 1000.0 - Self.tokenExpiryMargin) {
                lastTokenStatus = .expired
                DaemonLogger.shared.debug("UsageAPI", "OAuth token expired")
                return staleFallback
            }
        }

        // Fetch from API
        guard let apiURL = URL(string: Self.usageAPIURL) else { return staleFallback }
        var request = URLRequest(url: apiURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return staleFallback }

            if http.statusCode == 200,
               let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                lastTokenStatus = .valid
                consecutiveFailures = 0

                // Opt-in raw body dump for diagnosing 0% reports. Enable via
                // `AGENTDECK_DEBUG_USAGE_RAW=1` in the app's launch environment.
                if ProcessInfo.processInfo.environment["AGENTDECK_DEBUG_USAGE_RAW"] != nil,
                   let raw = String(data: data, encoding: .utf8) {
                    DaemonLogger.shared.debug("UsageAPI", "raw: \(raw)")
                }

                var usage = parseUsageResponse(json)
                usage.fetchedAt = Date().timeIntervalSince1970
                usage.stale = false
                writeFileCache(usage)
                DaemonLogger.shared.debug("UsageAPI", "API fetch OK: 5h=\(usage.fiveHourPercent ?? -1)% 7d=\(usage.sevenDayPercent ?? -1)%")
                return usage
            } else if http.statusCode == 429 {
                // Rate limited — respect Retry-After header
                consecutiveFailures += 1
                lastBackoffStart = Date()
                if let retryAfter = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After"),
                   let retrySec = Int(retryAfter), retrySec > 0 {
                    // Push file cache fetchedAt forward so TTL covers Retry-After
                    if let cached = readFileCache() {
                        let syntheticCache = CacheFile(
                            data: CacheFile.CodableUsage(
                                fiveHourPercent: cached.data.fiveHourPercent,
                                fiveHourResetsAt: cached.data.fiveHourResetsAt,
                                sevenDayPercent: cached.data.sevenDayPercent,
                                sevenDayResetsAt: cached.data.sevenDayResetsAt,
                                extraUsageEnabled: cached.data.extraUsageEnabled,
                                extraUsageMonthlyLimit: cached.data.extraUsageMonthlyLimit,
                                extraUsageUsedCredits: cached.data.extraUsageUsedCredits,
                                extraUsageUtilization: cached.data.extraUsageUtilization
                            ),
                            fetchedAt: Date().timeIntervalSince1970 + Double(retrySec) - Self.fileCacheTTL
                        )
                        if let cacheData = try? JSONEncoder().encode(syntheticCache) {
                            try? cacheData.write(to: Self.cacheFile)
                        }
                    }
                    DaemonLogger.shared.debug("UsageAPI", "Rate limited (429), Retry-After: \(retrySec)s")
                }
                return staleFallback
            } else {
                consecutiveFailures += 1
                lastBackoffStart = Date()
                if http.statusCode == 401 || http.statusCode == 403 { lastTokenStatus = .expired }
                DaemonLogger.shared.debug("UsageAPI", "API fetch failed: HTTP \(http.statusCode)")
                return staleFallback
            }
        } catch {
            consecutiveFailures += 1
            lastBackoffStart = Date()
            DaemonLogger.shared.debug("UsageAPI", "API fetch error: \(error.localizedDescription)")
            return staleFallback
        }
    }

    func hasOAuthToken() -> Bool {
        getOAuthToken() != nil
    }

    // MARK: - Keychain

    private struct OAuthCredentials {
        let accessToken: String
        var expiresAt: Int?
    }

    private func getOAuthCredentials() -> OAuthCredentials? {
        // Claude Code OAuth credentials live in the user's own keychain and
        // would require a shared Keychain Access Group (which Anthropic does
        // not publish) for SecItemCopyMatching to read them from this app.
        // Usage polling falls back to the network probe path that doesn't
        // need OAuth state.
        return nil
    }

    private func getOAuthToken() -> String? {
        getOAuthCredentials()?.accessToken
    }

    // MARK: - Codex Web Auth

    /// Must only be invoked inside `codexAuthQueue.sync { ... }`. Split out
    /// so the serialized `codexAuthStatus` getter has a clearly-locked
    /// version and so tests can exercise the raw read path directly.
    private func readRawCodexAuthStatusLocked() -> CodexAuthStatus? {
        let authFile = URL(fileURLWithPath: Self.resolvedHomeDir)
            .appendingPathComponent(".codex/auth.json")
        guard let data = try? Data(contentsOf: authFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        let tokens = json["tokens"] as? [String: Any]
        let accessTokenPresent = string(tokens, key: "access_token") != nil
        let accessPayload = decodeJWT(string(tokens, key: "access_token"))
        let idPayload = decodeJWT(string(tokens, key: "id_token"))
        let accessAuth = authNamespace(accessPayload)
        let idAuth = authNamespace(idPayload)
        let authMode = string(json, key: "auth_mode")

        return CodexAuthStatus(
            authMode: authMode,
            webAuthConnected: authMode == "chatgpt" && accessTokenPresent,
            accessTokenPresent: accessTokenPresent,
            planType: firstString([
                string(json, key: "chatgpt_plan_type"),
                string(accessAuth, key: "chatgpt_plan_type"),
                string(idAuth, key: "chatgpt_plan_type"),
                string(accessPayload, key: "chatgpt_plan_type"),
                string(idPayload, key: "chatgpt_plan_type"),
                string(accessPayload, key: "plan_type"),
                string(idPayload, key: "plan_type"),
            ]),
            accountId: firstString([
                string(json, key: "chatgpt_account_id"),
                string(accessAuth, key: "chatgpt_account_id"),
                string(idAuth, key: "chatgpt_account_id"),
                string(accessPayload, key: "chatgpt_account_id"),
                string(idPayload, key: "chatgpt_account_id"),
                string(accessAuth, key: "account_id"),
                string(idAuth, key: "account_id"),
                string(accessPayload, key: "account_id"),
                string(idPayload, key: "account_id"),
                string(json, key: "account_id"),
            ]),
            subscriptionActiveUntil: firstString([
                string(json, key: "chatgpt_subscription_active_until"),
                string(accessAuth, key: "chatgpt_subscription_active_until"),
                string(idAuth, key: "chatgpt_subscription_active_until"),
                string(accessPayload, key: "chatgpt_subscription_active_until"),
                string(idPayload, key: "chatgpt_subscription_active_until"),
                string(accessPayload, key: "subscription_active_until"),
                string(idPayload, key: "subscription_active_until"),
            ]),
            lastRefreshAt: string(json, key: "last_refresh")
        )
    }

    static func stabilizeCodexAuthStatus(previous: CodexAuthStatus?, current: CodexAuthStatus?) -> CodexAuthStatus? {
        guard let current else { return previous }
        guard let previous else { return current }

        let normalizedMode = current.authMode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let stillChatGpt = normalizedMode == "chatgpt" || (normalizedMode == nil && current.accessTokenPresent)
        if normalizedMode != nil, normalizedMode != "chatgpt", !current.accessTokenPresent {
            return current
        }
        if !stillChatGpt {
            return current
        }

        return CodexAuthStatus(
            authMode: current.authMode ?? previous.authMode,
            webAuthConnected: current.webAuthConnected || previous.webAuthConnected,
            accessTokenPresent: current.accessTokenPresent || previous.accessTokenPresent,
            planType: current.planType ?? previous.planType,
            accountId: current.accountId ?? previous.accountId,
            subscriptionActiveUntil: current.subscriptionActiveUntil ?? previous.subscriptionActiveUntil,
            lastRefreshAt: current.lastRefreshAt ?? previous.lastRefreshAt
        )
    }

    private func decodeJWT(_ token: String?) -> [String: Any]? {
        guard let token else { return nil }
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = payload.count % 4
        if remainder > 0 {
            payload += String(repeating: "=", count: 4 - remainder)
        }
        guard let data = Data(base64Encoded: payload),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json
    }

    private func authNamespace(_ dict: [String: Any]?) -> [String: Any]? {
        dict?["https://api.openai.com/auth"] as? [String: Any]
    }

    private func string(_ dict: [String: Any]?, key: String) -> String? {
        guard let raw = dict?[key] as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func firstString(_ values: [String?]) -> String? {
        values.first(where: { $0?.isEmpty == false }) ?? nil
    }

    // MARK: - Antigravity Local Status

    private func readAntigravityStatus() -> AntigravityStatus? {
        AppPreferences.shared.withAntigravityDatabaseAccess { dbURL in
            guard FileManager.default.fileExists(atPath: dbURL.path) else { return nil }

            let authStatusText = sqliteValue(forKey: "antigravityAuthStatus", dbURL: dbURL)
            guard let planName = parseAntigravityPlanName(authStatusText) else { return nil }

            let creditsText = sqliteValue(forKey: "antigravityUnifiedStateSync.modelCredits", dbURL: dbURL)
            let credits = parseAntigravityModelCredits(creditsText)

            return AntigravityStatus(
                planName: planName,
                availableCredits: credits.available,
                minimumCreditAmountForUsage: credits.minimum
            )
        }
    }

    private func sqliteValue(forKey key: String, dbURL: URL) -> String? {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbURL.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
            if let db { sqlite3_close(db) }
            return sqliteValueViaShell(forKey: key, dbURL: dbURL)
        }
        defer { sqlite3_close(db) }

        var stmt: OpaquePointer?
        let sql = "SELECT value FROM ItemTable WHERE key = ? LIMIT 1"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            if let stmt { sqlite3_finalize(stmt) }
            return nil
        }
        defer { sqlite3_finalize(stmt) }

        let bindResult = key.withCString { cString in
            sqlite3_bind_text(stmt, 1, cString, -1, SQLITE_TRANSIENT)
        }
        guard bindResult == SQLITE_OK else {
            return sqliteValueViaShell(forKey: key, dbURL: dbURL)
        }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }

        if let blob = sqlite3_column_blob(stmt, 0) {
            let len = Int(sqlite3_column_bytes(stmt, 0))
            let data = Data(bytes: blob, count: len)
            return String(data: data, encoding: .utf8)
        }
        return nil
    }

    private func sqliteValueViaShell(forKey key: String, dbURL: URL) -> String? {
        // The sqlite3 C API path above handles 99% of queries. Spawning
        // `/usr/bin/sqlite3` is not allowed under Apple Review Guideline
        // 2.5.2, so the rare bind-failure case returns nil instead.
        _ = key; _ = dbURL
        return nil
    }

    private func parseAntigravityPlanName(_ authStatusText: String?) -> String? {
        guard let authStatusText,
              let data = authStatusText.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let protoB64 = json["userStatusProtoBinaryBase64"] as? String,
              let proto = Data(base64Encoded: protoB64)
        else {
            return nil
        }

        let ascii = extractASCIIStrings(from: proto)
        let preferred = [
            "Google AI Ultra",
            "Google AI Pro",
            "Google AI Standard",
            "Google AI Free",
        ]
        for match in preferred where ascii.contains(match) {
            return match
        }
        return ascii.first(where: { $0.hasPrefix("Google AI ") })
    }

    private struct ProtoField {
        let field: Int
        let wire: Int
        let varint: UInt64?
        let bytes: Data?
    }

    private func readVarint(_ buf: Data, at offset: Int) -> (value: UInt64, next: Int)? {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        var index = offset
        while index < buf.count {
            let byte = buf[index]
            index += 1
            result |= UInt64(byte & 0x7f) << shift
            if (byte & 0x80) == 0 { return (result, index) }
            shift += 7
            if shift > 63 { return nil }
        }
        return nil
    }

    private func parseProto(_ buf: Data) -> [ProtoField] {
        var out: [ProtoField] = []
        var index = 0
        while index < buf.count {
            guard let key = readVarint(buf, at: index) else { break }
            index = key.next
            let field = Int(key.value >> 3)
            let wire = Int(key.value & 0x07)
            if wire == 0 {
                guard let value = readVarint(buf, at: index) else { break }
                out.append(ProtoField(field: field, wire: wire, varint: value.value, bytes: nil))
                index = value.next
            } else if wire == 2 {
                guard let length = readVarint(buf, at: index) else { break }
                index = length.next
                let end = index + Int(length.value)
                guard end <= buf.count else { break }
                out.append(ProtoField(field: field, wire: wire, varint: nil, bytes: buf.subdata(in: index..<end)))
                index = end
            } else {
                break
            }
        }
        return out
    }

    private func protoFirstString(_ fields: [ProtoField], field: Int) -> String? {
        guard let hit = fields.first(where: { $0.field == field && $0.wire == 2 }),
              let bytes = hit.bytes else { return nil }
        return String(data: bytes, encoding: .utf8)
    }

    private func protoFirstBytes(_ fields: [ProtoField], field: Int) -> Data? {
        fields.first(where: { $0.field == field && $0.wire == 2 })?.bytes
    }

    private func protoFirstVarint(_ fields: [ProtoField], field: Int) -> UInt64? {
        fields.first(where: { $0.field == field && $0.wire == 0 })?.varint
    }

    /// Mirrors `bridge/src/antigravity-local.ts:parseModelCredits`. The DB
    /// value at `antigravityUnifiedStateSync.modelCredits` is a base64-wrapped
    /// protobuf map; each entry's value is itself a base64 protobuf wrapping
    /// the actual integer in field 1 (with field 2 as a fallback).
    private func parseAntigravityModelCredits(_ text: String?) -> (available: Int?, minimum: Int?) {
        guard let text,
              let outer = Data(base64Encoded: text) else {
            return (nil, nil)
        }
        var available: Int?
        var minimum: Int?
        for entry in parseProto(outer) where entry.field == 1 && entry.wire == 2 {
            guard let entryBytes = entry.bytes else { continue }
            let pair = parseProto(entryBytes)
            guard let key = protoFirstString(pair, field: 1),
                  let wrapped = protoFirstBytes(pair, field: 2) else { continue }
            guard let wrappedB64 = protoFirstString(parseProto(wrapped), field: 1),
                  let inner = Data(base64Encoded: wrappedB64) else { continue }
            let innerFields = parseProto(inner)
            guard let raw = protoFirstVarint(innerFields, field: 1)
                ?? protoFirstVarint(innerFields, field: 2) else { continue }
            let value = Int(raw)
            if key == "availableCreditsSentinelKey" { available = value }
            if key == "minimumCreditAmountForUsageKey" { minimum = value }
        }
        return (available, minimum)
    }

    private func extractASCIIStrings(from data: Data, minimumLength: Int = 6) -> [String] {
        let bytes = [UInt8](data)
        var buffer: [UInt8] = []
        var strings: [String] = []

        func flush() {
            defer { buffer.removeAll(keepingCapacity: true) }
            guard buffer.count >= minimumLength,
                  let string = String(bytes: buffer, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                  !string.isEmpty else { return }
            strings.append(string)
        }

        for byte in bytes {
            if (32...126).contains(byte) {
                buffer.append(byte)
            } else {
                flush()
            }
        }
        flush()
        return strings
    }

    // MARK: - File Cache

    private struct CacheFile: Codable {
        let data: CodableUsage
        let fetchedAt: Double

        struct CodableUsage: Codable {
            var fiveHourPercent: Double?
            var fiveHourResetsAt: String?
            var sevenDayPercent: Double?
            var sevenDayResetsAt: String?
            var extraUsageEnabled: Bool?
            var extraUsageMonthlyLimit: Double?
            var extraUsageUsedCredits: Double?
            var extraUsageUtilization: Double?
        }
    }

    private func readFileCache() -> (data: ApiUsageData, fetchedAt: Double)? {
        guard let data = readCacheDataBounded(),
              let cache = try? JSONDecoder().decode(CacheFile.self, from: data) else { return nil }
        // Auto-detect ms vs s: Node.js bridge writes Date.now() (ms), Swift writes timeIntervalSince1970 (s)
        let fetchedAt = cache.fetchedAt > 1e12 ? cache.fetchedAt / 1000.0 : cache.fetchedAt
        let usage = ApiUsageData(
            fiveHourPercent: cache.data.fiveHourPercent,
            fiveHourResetsAt: cache.data.fiveHourResetsAt,
            sevenDayPercent: cache.data.sevenDayPercent,
            sevenDayResetsAt: cache.data.sevenDayResetsAt,
            extraUsageEnabled: cache.data.extraUsageEnabled ?? false,
            extraUsageMonthlyLimit: cache.data.extraUsageMonthlyLimit,
            extraUsageUsedCredits: cache.data.extraUsageUsedCredits,
            extraUsageUtilization: cache.data.extraUsageUtilization,
            fetchedAt: fetchedAt,
            stale: false
        )
        return (usage, fetchedAt)
    }

    private func readCacheDataBounded() -> Data? {
        let box = UsageCacheDataBox()
        let semaphore = DispatchSemaphore(value: 0)
        Self.cacheIOQueue.async {
            box.set(try? Data(contentsOf: Self.cacheFile))
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + Self.cacheReadTimeout) == .success else {
            DaemonLogger.shared.debug("UsageAPI", "File cache read timed out; skipping cache")
            return nil
        }
        return box.get()
    }

    private func writeFileCache(_ usage: ApiUsageData) {
        let cache = CacheFile(
            data: CacheFile.CodableUsage(
                fiveHourPercent: usage.fiveHourPercent,
                fiveHourResetsAt: usage.fiveHourResetsAt,
                sevenDayPercent: usage.sevenDayPercent,
                sevenDayResetsAt: usage.sevenDayResetsAt,
                extraUsageEnabled: usage.extraUsageEnabled,
                extraUsageMonthlyLimit: usage.extraUsageMonthlyLimit,
                extraUsageUsedCredits: usage.extraUsageUsedCredits,
                extraUsageUtilization: usage.extraUsageUtilization
            ),
            fetchedAt: Date().timeIntervalSince1970
        )
        if let data = try? JSONEncoder().encode(cache) {
            Self.cacheIOQueue.async {
                try? data.write(to: Self.cacheFile)
            }
        }
    }

    // MARK: - Parse Response

    private func parseUsageResponse(_ json: [String: Any]) -> ApiUsageData {
        var usage = ApiUsageData()

        func getDouble(_ val: Any?) -> Double? {
            if let d = val as? Double { return d }
            if let i = val as? Int { return Double(i) }
            return nil
        }

        func getUtilization(_ obj: Any?) -> Double? {
            if let val = getDouble(obj) { return val }
            guard let dict = obj as? [String: Any] else { return nil }
            return getDouble(dict["utilization"]) ?? getDouble(dict["percentUsed"]) ?? getDouble(dict["percentage"]) ?? getDouble(dict["percent"]) ?? getDouble(dict["usage"])
        }

        func getResetsAt(_ obj: Any?) -> String? {
            guard let dict = obj as? [String: Any] else { return nil }
            return (dict["resets_at"] as? String) ?? (dict["resetsAt"] as? String) ?? (dict["reset_at"] as? String) ?? (dict["expires_at"] as? String)
        }

        // 1. Five Hour
        let fiveHour = json["five_hour"] ?? json["fiveHour"] ?? (json["rateLimits"] as? [String: Any])?["fiveHour"]
        usage.fiveHourPercent = getUtilization(fiveHour)
        usage.fiveHourResetsAt = getResetsAt(fiveHour)

        // 2. Seven Day
        let sevenDay = json["seven_day"] ?? json["sevenDay"] ?? (json["rateLimits"] as? [String: Any])?["sevenDay"]
        usage.sevenDayPercent = getUtilization(sevenDay)
        usage.sevenDayResetsAt = getResetsAt(sevenDay)

        // 3. Extra Usage
        let extra = json["extra_usage"] ?? json["extraUsage"]
        if let extraDict = extra as? [String: Any] {
            usage.extraUsageEnabled = (extraDict["is_enabled"] as? Bool) ?? (extraDict["enabled"] as? Bool) ?? false
            usage.extraUsageMonthlyLimit = getDouble(extraDict["monthly_limit"]) ?? getDouble(extraDict["monthlyLimit"])
            usage.extraUsageUsedCredits = getDouble(extraDict["used_credits"]) ?? getDouble(extraDict["usedCredits"])
            usage.extraUsageUtilization = getUtilization(extra)
        }

        usage.inferredBillingType = usage.fiveHourPercent != nil ? "subscription" : "api"
        return usage
    }

    // MARK: - Backoff

    private func getBackoffSeconds() -> TimeInterval {
        guard consecutiveFailures > 0 else { return 0 }
        let intervals: [TimeInterval] = [45, 90, 180, 300]
        let backoff = intervals[min(consecutiveFailures - 1, intervals.count - 1)]
        let elapsed = Date().timeIntervalSince(lastBackoffStart)
        return max(0, backoff - elapsed)
    }
}
#endif
