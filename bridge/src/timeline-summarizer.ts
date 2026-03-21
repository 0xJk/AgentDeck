/**
 * Timeline summarizer — uses local LLM to create concise 1-line summaries
 * of OpenClaw chat responses for timeline display.
 *
 * Tries: local mlx-serve qwen (port 8800) → Ollama → heuristic fallback.
 * Non-blocking — caller should fire-and-forget, update entry when ready.
 */

import { debug } from './logger.js';
import { SUMMARY_SYSTEM_PROMPT, cleanLLMOutput } from '@agentdeck/shared';
export { extractTopicHint } from '@agentdeck/shared';

const MLX_URL = 'http://127.0.0.1:8800/chat/completions';
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const TIMEOUT_MS = 30_000; // 30s — first inference needs model load time
const MAX_INPUT_CHARS = 2000;

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

// extractTopicHint and cleanLLMOutput moved to @agentdeck/shared/timeline-summarizer

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
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
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
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
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
