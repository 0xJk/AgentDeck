/**
 * Timeline summarizer — uses local LLM to create concise 1-line summaries
 * of OpenClaw chat responses for timeline display.
 *
 * Tries: local mlx-serve qwen (port 8800) → Ollama → heuristic fallback.
 * Non-blocking — caller should fire-and-forget, update entry when ready.
 */

import { debug } from './logger.js';

const MLX_URL = 'http://127.0.0.1:8800/chat/completions';
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const TIMEOUT_MS = 30_000; // 30s — first inference needs model load time
const MAX_INPUT_CHARS = 2000;

const SYSTEM_PROMPT = `You are a timeline summarizer. Given an AI assistant's response text, produce a single-line Korean summary (max 80 characters) of what was accomplished. Focus on the result, not the process. No quotes, no markdown, no punctuation at the end. Output ONLY the summary line, nothing else. Examples:
- 봇마당 인박스에 AI 에이전트 운영 팁 3건 수집
- 주간 모델 사용량 리포트: glm-5 28회 최다
- GitHub 이슈 #10428 검토 완료, PR #16831 대기 중
- HBF 뉴스 9월~2월분 한글 정리 완료`;

let mlxAvailable: boolean | null = null;
let ollamaAvailable: boolean | null = null;

/**
 * Summarize a chat response into a concise 1-line Korean summary.
 * Returns null if summarization fails (caller should use fallback).
 */
export async function summarizeResponse(text: string): Promise<string | null> {
  if (!text || text.length < 20) return null;

  const input = text.length > MAX_INPUT_CHARS
    ? text.slice(0, MAX_INPUT_CHARS) + '...'
    : text;

  // Try MLX qwen first
  if (mlxAvailable !== false) {
    try {
      const result = await callMLX(input);
      if (result) {
        mlxAvailable = true;
        return result;
      }
    } catch {
      mlxAvailable = false;
      debug('summarizer', 'MLX not available, trying Ollama');
    }
  }

  // Try Ollama
  if (ollamaAvailable !== false) {
    try {
      const result = await callOllama(input);
      if (result) {
        ollamaAvailable = true;
        return result;
      }
    } catch {
      ollamaAvailable = false;
      debug('summarizer', 'Ollama not available, using heuristic');
    }
  }

  return null;
}

/**
 * Extract a topic hint from the first few tokens of a response.
 * Used for immediate chat_start enrichment before LLM summarization.
 */
export function extractTopicHint(text: string): string | null {
  if (!text || text.length < 5) return null;

  // Take first line or first 80 chars
  const firstLine = text.split('\n')[0].trim();
  const snippet = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;

  // Remove common prefixes
  const cleaned = snippet
    .replace(/^(완료했습니다\.\s*|네,?\s*|알겠습니다\.\s*|확인했습니다\.\s*)/i, '')
    .replace(/^(\*\*|#{1,3}\s*)/g, '')
    .trim();

  return cleaned || null;
}

/** Clean LLM output — strip thinking, quotes, markdown artifacts */
function cleanLLMOutput(content: string): string | null {
  let cleaned = content
    // Strip <think>...</think> blocks (Qwen thinking mode)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    // Strip unclosed <think> at end (truncated output)
    .replace(/<think>[\s\S]*$/g, '')
    .trim();

  // If output has multiple lines, take the last non-empty line
  // (thinking text tends to come first, summary last)
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    // Find the last line that looks like Korean summary (contains Korean chars)
    const koreanLine = lines.reverse().find(l => /[\uAC00-\uD7AF]/.test(l));
    cleaned = koreanLine || lines[lines.length - 1];
  }

  // Strip surrounding quotes, markdown list markers
  cleaned = cleaned
    .replace(/^[-*]\s*/, '')
    .replace(/^["'`"""]+|["'`"""]+$/g, '')
    .replace(/[.。]$/, '') // remove trailing period
    .trim();

  if (!cleaned || cleaned.length < 3) return null;
  // Truncate to 80 chars if needed
  if (cleaned.length > 80) cleaned = cleaned.slice(0, 77) + '...';
  return cleaned;
}

async function callMLX(input: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(MLX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mlx-community/Qwen3.5-35B-A3B-4bit',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          // /no_think suffix disables Qwen3 extended thinking
          { role: 'user', content: input + '\n\n/no_think' },
        ],
        max_tokens: 200,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`MLX ${resp.status}`);

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const result = cleanLLMOutput(content);
    if (result) debug('summarizer', `MLX summary: ${result}`);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function callOllama(input: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:7b',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`Ollama ${resp.status}`);

    const data = await resp.json() as {
      message?: { content?: string };
    };
    const content = data.message?.content?.trim();
    if (!content) return null;

    const result = cleanLLMOutput(content);
    if (result) debug('summarizer', `Ollama summary: ${result}`);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
