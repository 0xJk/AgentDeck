#if os(macOS)
// UsageAPIClient.swift — OAuth token management + API usage fetch
// Ported from bridge/src/usage-api.ts

import Foundation

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

    nonisolated(unsafe) private var consecutiveFailures = 0
    nonisolated(unsafe) private var lastTokenStatus: TokenStatus = .unknown

    var tokenStatus: TokenStatus { lastTokenStatus }

    // MARK: - Fetch

    func fetchUsage() async -> ApiUsageData? {
        // Check file cache first
        if let cached = readFileCache() {
            let age = Date().timeIntervalSince1970 - cached.fetchedAt
            if age < Self.fileCacheTTL {
                return cached.data
            }
        }

        // Check backoff
        if consecutiveFailures > 0 {
            let backoff = getBackoffSeconds()
            if backoff > 0 { return nil } // Still in backoff
        }

        // Get OAuth token from Keychain
        guard let token = getOAuthToken() else {
            lastTokenStatus = .missing
            return nil
        }

        // Check token expiry
        if let creds = getOAuthCredentials(), let expiresAt = creds.expiresAt {
            if Date().timeIntervalSince1970 > (Double(expiresAt) / 1000.0 - Self.tokenExpiryMargin) {
                lastTokenStatus = .expired
                return nil
            }
        }

        // Fetch from API
        var request = URLRequest(url: URL(string: Self.usageAPIURL)!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }

            if http.statusCode == 200,
               let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                lastTokenStatus = .valid
                consecutiveFailures = 0

                let usage = parseUsageResponse(json)
                writeFileCache(usage)
                return usage
            } else {
                consecutiveFailures += 1
                if http.statusCode == 401 { lastTokenStatus = .expired }
                return nil
            }
        } catch {
            consecutiveFailures += 1
            return nil
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
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-s", Self.keychainService, "-w"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let raw = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard let data = raw.data(using: .utf8),
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let oauth = json["claudeAiOauth"] as? [String: Any],
                  let token = oauth["accessToken"] as? String else { return nil }
            return OAuthCredentials(accessToken: token, expiresAt: oauth["expiresAt"] as? Int)
        } catch {
            return nil
        }
    }

    private func getOAuthToken() -> String? {
        getOAuthCredentials()?.accessToken
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
        guard let data = try? Data(contentsOf: Self.cacheFile),
              let cache = try? JSONDecoder().decode(CacheFile.self, from: data) else { return nil }
        let usage = ApiUsageData(
            fiveHourPercent: cache.data.fiveHourPercent,
            fiveHourResetsAt: cache.data.fiveHourResetsAt,
            sevenDayPercent: cache.data.sevenDayPercent,
            sevenDayResetsAt: cache.data.sevenDayResetsAt,
            extraUsageEnabled: cache.data.extraUsageEnabled ?? false,
            extraUsageMonthlyLimit: cache.data.extraUsageMonthlyLimit,
            extraUsageUsedCredits: cache.data.extraUsageUsedCredits,
            extraUsageUtilization: cache.data.extraUsageUtilization
        )
        return (usage, cache.fetchedAt)
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
            try? data.write(to: Self.cacheFile)
        }
    }

    // MARK: - Parse Response

    private func parseUsageResponse(_ json: [String: Any]) -> ApiUsageData {
        var usage = ApiUsageData()
        if let limits = json["rateLimits"] as? [String: Any] {
            if let fiveHour = limits["fiveHour"] as? [String: Any] {
                usage.fiveHourPercent = fiveHour["percentUsed"] as? Double
                usage.fiveHourResetsAt = fiveHour["resetsAt"] as? String
            }
            if let sevenDay = limits["sevenDay"] as? [String: Any] {
                usage.sevenDayPercent = sevenDay["percentUsed"] as? Double
                usage.sevenDayResetsAt = sevenDay["resetsAt"] as? String
            }
        }
        if let extra = json["extraUsage"] as? [String: Any] {
            usage.extraUsageEnabled = extra["enabled"] as? Bool ?? false
            usage.extraUsageMonthlyLimit = extra["monthlyLimit"] as? Double
            usage.extraUsageUsedCredits = extra["usedCredits"] as? Double
            usage.extraUsageUtilization = extra["utilization"] as? Double
        }
        usage.inferredBillingType = usage.fiveHourPercent != nil ? "subscription" : "api"
        return usage
    }

    // MARK: - Backoff

    private func getBackoffSeconds() -> TimeInterval {
        guard consecutiveFailures > 0 else { return 0 }
        let intervals: [TimeInterval] = [45, 90, 180, 300]
        return intervals[min(consecutiveFailures - 1, intervals.count - 1)]
    }
}
#endif
