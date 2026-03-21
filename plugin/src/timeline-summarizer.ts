/**
 * Lightweight timeline summarizer for plugin (no bridge).
 * Tries MLX qwen → heuristic fallback. Ollama skipped to keep plugin lean.
 */

import { SUMMARY_SYSTEM_PROMPT, cleanLLMOutput } from '@agentdeck/shared';
export { extractTopicHint } from '@agentdeck/shared';

const MLX_URL = 'http://127.0.0.1:8800/chat/completions';
const TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 2000;
const RETRY_INTERVAL_MS = 60_000;

let mlxAvailable: boolean | null = null;
let mlxFailedAt = 0;

export async function summarizeResponse(text: string): Promise<string | null> {
  if (!text || text.length < 20) return null;
  if (mlxAvailable === false && Date.now() - mlxFailedAt < RETRY_INTERVAL_MS) return null;

  const input = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) + '...' : text;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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

    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const cleaned = cleanLLMOutput(content);
    if (cleaned) mlxAvailable = true;
    return cleaned;
  } catch {
    mlxAvailable = false;
    mlxFailedAt = Date.now();
    return null;
  }
}

// cleanLLMOutput and extractTopicHint moved to @agentdeck/shared/timeline-summarizer
