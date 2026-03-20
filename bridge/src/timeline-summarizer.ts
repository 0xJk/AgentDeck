/**
 * Timeline summarizer — uses local LLM to create concise 1-line summaries
 * of OpenClaw chat responses for timeline display.
 *
 * Tries: local mlx-serve qwen (port 8800) → Ollama → heuristic fallback.
 * Non-blocking — caller should fire-and-forget, update entry when ready.
 */

import { debug } from './logger.js';
import { cleanRawText } from '@agentdeck/shared';

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
let mlxFailedAt = 0;
let ollamaFailedAt = 0;
const RETRY_INTERVAL_MS = 60_000; // retry failed providers after 60s

/**
 * Summarize a chat response into a concise 1-line Korean summary.
 * Returns null if summarization fails (caller should use fallback).
 */
export async function summarizeResponse(text: string): Promise<string | null> {
  if (!text || text.length < 20) return null;

  const input = text.length > MAX_INPUT_CHARS
    ? text.slice(0, MAX_INPUT_CHARS) + '...'
    : text;

  // Try MLX qwen first (retry after RETRY_INTERVAL_MS)
  if (mlxAvailable !== false || (Date.now() - mlxFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callMLX(input);
      if (result) {
        mlxAvailable = true;
        return result;
      }
    } catch {
      mlxAvailable = false;
      mlxFailedAt = Date.now();
      debug('summarizer', 'MLX not available, trying Ollama');
    }
  }

  // Try Ollama (retry after RETRY_INTERVAL_MS)
  if (ollamaAvailable !== false || (Date.now() - ollamaFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callOllama(input);
      if (result) {
        ollamaAvailable = true;
        return result;
      }
    } catch {
      ollamaAvailable = false;
      ollamaFailedAt = Date.now();
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

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Find first non-markdown, non-code-fence, non-empty line
  let candidate: string | null = null;
  let inCodeFence = false;
  for (const line of lines) {
    // Track code fence boundaries
    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    // Skip headings-only
    if (/^#{1,6}\s*$/.test(line)) continue;

    // Strip markdown decorators for evaluation
    const stripped = cleanRawText(line)
      .replace(/^[-*]\s+/, '')
      .replace(/^>\s+/, '')
      .trim();

    if (stripped.length >= 3) {
      candidate = stripped;
      break;
    }
  }

  if (!candidate) return null;

  const snippet = candidate.length > 80 ? candidate.slice(0, 77) + '...' : candidate;

  // Remove common Korean prefixes (chained — "네, 확인했습니다." → "")
  let cleaned = snippet;
  // Strip leading "네," / "네." first, then polite phrases
  cleaned = cleaned.replace(/^네[,.]?\s*/i, '');
  cleaned = cleaned.replace(/^(완료했습니다\.\s*|알겠습니다\.\s*|확인했습니다\.\s*)/i, '');
  cleaned = cleaned.trim();

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
        enable_thinking: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        max_tokens: 100,
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

const SESSION_CONTEXT_PROMPT = `You are a session context summarizer. Given a list of recent tool calls from an AI coding agent, produce a single-line Korean summary (max 40 characters) of what this session is currently working on. Focus on the goal, not individual steps. No quotes, no markdown, no punctuation at the end. Output ONLY the summary line, nothing else. Examples:
- 터미널 포스트잇 기능 구현 중
- API 인증 버그 수정 중
- 테스트 코드 리팩터링
- README 문서 업데이트`;

/**
 * Summarize recent session tool calls into a concise 1-line Korean context description.
 * Returns null if summarization fails (caller should use heuristic fallback).
 */
export async function summarizeSessionContext(
  toolCalls: Array<{ tool: string; input: string | null }>,
  projectName: string,
): Promise<string | null> {
  if (toolCalls.length === 0) return null;

  const callList = toolCalls
    .map(tc => {
      const target = tc.input ? ` ${tc.input}` : '';
      return `- ${tc.tool}${target}`;
    })
    .join('\n');

  const userMsg = `Project "${projectName}" session:\nRecent tool calls:\n${callList}\nSummarize what this session is working on in 1 Korean sentence, max 40 chars.`;

  // Try MLX first
  if (mlxAvailable !== false || (Date.now() - mlxFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callLLM('mlx', SESSION_CONTEXT_PROMPT, userMsg);
      if (result) {
        mlxAvailable = true;
        return result;
      }
    } catch {
      mlxAvailable = false;
      mlxFailedAt = Date.now();
    }
  }

  // Try Ollama
  if (ollamaAvailable !== false || (Date.now() - ollamaFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callLLM('ollama', SESSION_CONTEXT_PROMPT, userMsg);
      if (result) {
        ollamaAvailable = true;
        return result;
      }
    } catch {
      ollamaAvailable = false;
      ollamaFailedAt = Date.now();
    }
  }

  return null;
}

/** Unified LLM call for both MLX and Ollama */
async function callLLM(
  provider: 'mlx' | 'ollama',
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    if (provider === 'mlx') {
      const resp = await fetch(MLX_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mlx-community/Qwen3.5-35B-A3B-4bit',
          enable_thinking: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 100,
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
      return cleanLLMOutput(content);
    } else {
      const resp = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5:7b',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
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
      return cleanLLMOutput(content);
    }
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
