#if os(macOS)
// TimelineSummarizer.swift — LLM-based response summarization
// Ported from bridge/src/timeline-summarizer.ts

import Foundation

enum TimelineSummarizer {
    private static let mlxPort = 8800
    private static let ollamaPort = 11434
    private static let maxChars = 80

    /// Final fallback when neither llm.mlx pin nor the /v1/models catalog
    /// yield a usable model. Mirrors shared/src/llm-settings.ts MLX_FALLBACK_MODEL.
    private static let mlxFallbackModel = "mlx-community/Qwen3.6-35B-A3B-4bit"

    /// Cached first model id from /v1/models, refreshed on staleness. Avoids
    /// hitting the catalog endpoint on every summarization.
    nonisolated(unsafe) private static var probedFirstModel: String?
    nonisolated(unsafe) private static var probedAt: Date = .distantPast
    private static let probeCacheTTL: TimeInterval = 60

    private static func resolveMlxModel() async -> String {
        if let pin = ApmeSettings.loadMlxConfig().model {
            return pin
        }
        if probedFirstModel == nil || Date().timeIntervalSince(probedAt) > probeCacheTTL {
            probedFirstModel = await fetchFirstMlxModel()
            probedAt = Date()
        }
        return probedFirstModel ?? mlxFallbackModel
    }

    private static func fetchFirstMlxModel() async -> String? {
        let base = ApmeSettings.loadMlxConfig().endpoint
        for path in ["/v1/models", "/models"] {
            guard let url = URL(string: base + path) else { continue }
            var req = URLRequest(url: url)
            req.timeoutInterval = 2
            guard let (data, response) = try? await URLSession.shared.data(for: req),
                  let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rows = json["data"] as? [[String: Any]]
            else { continue }
            for row in rows {
                if let id = row["id"] as? String,
                   !id.isEmpty,
                   !id.lowercased().contains("nanollava") {
                    return id
                }
            }
        }
        return nil
    }

    /// Summarize a response text using local LLM (MLX → Ollama fallback → heuristic)
    static func summarize(_ text: String) async -> String? {
        // Try MLX qwen server first
        if let result = await queryMLX(text) { return result }

        // Fallback to Ollama
        if let result = await queryOllama(text) { return result }

        // Heuristic fallback
        return extractTopicHint(text)
    }

    // MARK: - MLX (port 8800)

    private static func queryMLX(_ text: String) async -> String? {
        let base = ApmeSettings.loadMlxConfig().endpoint
        guard let url = URL(string: base + "/chat/completions") else { return nil }
        let truncated = String(text.prefix(2000))
        let model = await resolveMlxModel()
        let body: [String: Any] = [
            "model": model,
            "messages": [
                ["role": "system", "content": summarySystemPrompt],
                ["role": "user", "content": truncated],
            ],
            "enable_thinking": false,
            "max_tokens": 100,
            "temperature": 0.3,
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 10

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let choices = json["choices"] as? [[String: Any]],
               let message = choices.first?["message"] as? [String: Any],
               let content = message["content"] as? String {
                return cleanLLMOutput(content)
            }
        } catch { /* MLX not available */ }
        return nil
    }

    // MARK: - Ollama

    private static func queryOllama(_ text: String) async -> String? {
        let url = URL(string: "http://127.0.0.1:\(ollamaPort)/api/generate")!
        let truncated = String(text.prefix(2000))
        let body: [String: Any] = [
            "model": "qwen2.5:7b",
            "prompt": "\(summarySystemPrompt)\n\n\(truncated)",
            "stream": false,
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 15

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let response = json["response"] as? String {
                return cleanLLMOutput(response)
            }
        } catch { /* Ollama not available */ }
        return nil
    }

    // MARK: - Heuristic

    static func extractTopicHint(_ text: String) -> String? {
        let lines = text.components(separatedBy: .newlines)
        var inCodeBlock = false

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") { inCodeBlock.toggle(); continue }
            if inCodeBlock { continue }
            if trimmed.isEmpty || trimmed.hasPrefix("#") || trimmed.hasPrefix("---") { continue }
            if trimmed.count < 5 { continue }

            // Strip markdown
            var clean = trimmed
                .replacingOccurrences(of: "**", with: "")
                .replacingOccurrences(of: "*", with: "")
                .replacingOccurrences(of: "`", with: "")
            // Strip Korean politeness prefixes
            let prefixes = ["네, ", "네,", "알겠습니다. ", "완료했습니다. ", "좋습니다. "]
            for prefix in prefixes {
                if clean.hasPrefix(prefix) { clean = String(clean.dropFirst(prefix.count)) }
            }

            if clean.count >= 5 {
                return String(clean.prefix(maxChars))
            }
        }
        return nil
    }

    static func cleanLLMOutput(_ content: String) -> String? {
        var text = content
        // Strip <think>...</think> blocks
        while let range = text.range(of: "<think>") {
            if let end = text.range(of: "</think>") {
                text.removeSubrange(range.lowerBound..<end.upperBound)
            } else {
                break
            }
        }

        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Strip quotes
        if (text.hasPrefix("\"") && text.hasSuffix("\"")) ||
           (text.hasPrefix("'") && text.hasSuffix("'")) {
            text = String(text.dropFirst().dropLast())
        }
        // Strip list markers
        if text.hasPrefix("- ") || text.hasPrefix("• ") {
            text = String(text.dropFirst(2))
        }

        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 3 else { return nil }
        return String(text.prefix(maxChars))
    }

    // MARK: - Prompt

    private static let summarySystemPrompt = """
    당신은 AI 코딩 에이전트의 작업 결과를 한 줄로 요약하는 역할입니다.
    규칙:
    - 최대 80자 이내
    - 결과 중심 (과정 아님)
    - 한국어로 작성
    - 인사말, 설명 없이 요약만
    """
}
#endif
