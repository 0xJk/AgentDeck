/**
 * Timeline summarizer — uses local LLM to create concise 1-line summaries
 * of OpenClaw chat responses for timeline display.
 *
 * Tries: local mlx-serve qwen (port 8800) → Ollama → heuristic fallback.
 * Non-blocking — caller should fire-and-forget, update entry when ready.
 */

import { debug } from './logger.js';
import { SUMMARY_SYSTEM_PROMPT, cleanLLMOutput, mlxChatUrl, resolveMlxModel } from '@agentdeck/shared';
import { fetchMlxModels } from './mlx-probe.js';
export { extractTopicHint } from '@agentdeck/shared';

const MLX_URL = mlxChatUrl();

// In-memory cache of the probe's first result, so summarizers don't hit
// /v1/models on every call. Refreshed lazily when the model call fails.
let probedFirstModel: string | null = null;
let probedAt = 0;
const PROBE_CACHE_TTL_MS = 60_000;

async function resolveModelForCall(): Promise<string> {
  const now = Date.now();
  if (!probedFirstModel || now - probedAt > PROBE_CACHE_TTL_MS) {
    try {
      const models = await fetchMlxModels();
      probedFirstModel = models && models.length > 0 ? models[0] : null;
      probedAt = now;
    } catch {
      probedFirstModel = null;
    }
  }
  return resolveMlxModel(probedFirstModel);
}
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
  const model = await resolveModelForCall();

  try {
    const resp = await fetch(MLX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
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

const SESSION_CONTEXT_PROMPT = `You are a session context summarizer. Given a list of recent tool calls from an AI coding agent, produce a single-line English summary (max 40 characters) describing what this session is working on. Focus on the goal, not steps. No quotes, no markdown, no punctuation at the end. Infer the purpose from file paths and tool patterns. Output ONLY the summary line, nothing else. Examples:
- Fix Pixoo device hang on reconnect
- Improve terminal badge overlay
- Unify logging infrastructure
- Add ESP32 WiFi auto-provisioning
- Refactor adapter for OpenClaw support`;

/**
 * Summarize recent session tool calls into a 3-line Korean context description.
 * Used by terminal badge. Returns multi-line string (lines joined with \n).
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

  const userMsg = `Project "${projectName}" session:\nRecent tool calls:\n${callList}\nSummarize what this session is doing in 1 English line, max 40 chars.`;

  return callLLMWithFallback(SESSION_CONTEXT_PROMPT, userMsg);
}

const ROUND_SUMMARY_PROMPT = `You are a work log summarizer. Given a list of tool calls from one work round of an AI coding agent, produce a single-line English summary (max 35 characters) describing what was accomplished in this round. Focus on the outcome, not the tools used. No quotes, no markdown, no file extensions. Output ONLY the summary line. Examples:
- Updated badge layout to 8 lines
- Fixed mDNS error logging
- Added dark mode detection
- Refactored logging to use logger`;

/**
 * Summarize a single processing round's tool calls into a 1-line milestone.
 * Used by terminal badge to show meaningful work history.
 */
export async function summarizeRound(
  toolCalls: Array<{ tool: string; input: string | null }>,
): Promise<string | null> {
  if (toolCalls.length === 0) return null;

  const callList = toolCalls
    .map(tc => {
      const target = tc.input ? ` ${tc.input}` : '';
      return `- ${tc.tool}${target}`;
    })
    .join('\n');

  const userMsg = `This round's tool calls:\n${callList}\nSummarize what was done in 1 English line, max 35 chars.`;

  return callLLMWithFallback(ROUND_SUMMARY_PROMPT, userMsg);
}

/** LLM call that preserves multi-line output (for session context badge) */
async function callLLMMultiLine(
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  // Try MLX first
  if (mlxAvailable !== false || (Date.now() - mlxFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callLLMRaw('mlx', systemPrompt, userMessage);
      if (result) { mlxAvailable = true; return result; }
    } catch {
      mlxAvailable = false;
      mlxFailedAt = Date.now();
    }
  }
  // Try Ollama
  if (ollamaAvailable !== false || (Date.now() - ollamaFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callLLMRaw('ollama', systemPrompt, userMessage);
      if (result) { ollamaAvailable = true; return result; }
    } catch {
      ollamaAvailable = false;
      ollamaFailedAt = Date.now();
    }
  }
  return null;
}

/** Raw LLM call with multi-line cleaning (strips think blocks, keeps lines) */
async function callLLMRaw(
  provider: 'mlx' | 'ollama',
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = provider === 'mlx' ? MLX_URL : OLLAMA_URL;
    const mlxModel = provider === 'mlx' ? await resolveModelForCall() : '';
    const body = provider === 'mlx'
      ? {
        model: mlxModel,
        enable_thinking: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 150,
        temperature: 0.3,
      }
      : {
        model: 'qwen2.5:7b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        stream: false,
      };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`${provider} ${resp.status}`);

    const data = await resp.json() as Record<string, unknown>;
    let content: string | undefined;
    if (provider === 'mlx') {
      const choices = (data as { choices?: Array<{ message?: { content?: string } }> }).choices;
      content = choices?.[0]?.message?.content?.trim();
    } else {
      content = ((data as { message?: { content?: string } }).message?.content)?.trim();
    }
    if (!content) return null;

    // Strip think blocks but preserve multi-line output
    const cleaned = content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/g, '')
      .trim();

    // Take up to 3 non-empty lines, strip markdown artifacts
    const lines = cleaned.split('\n')
      .map(l => l.trim().replace(/^[-*]\s*/, '').replace(/^["'`]+|["'`]+$/g, ''))
      .filter(l => l.length > 0)
      .slice(0, 3);

    return lines.length > 0 ? lines.join('\n') : null;
  } catch (err) { clearTimeout(timer); throw err; }
}

/** Try MLX → Ollama with shared availability tracking */
async function callLLMWithFallback(
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  // Try MLX first
  if (mlxAvailable !== false || (Date.now() - mlxFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callMLXGeneric(systemPrompt, userMessage);
      if (result) { mlxAvailable = true; return result; }
    } catch {
      mlxAvailable = false;
      mlxFailedAt = Date.now();
    }
  }
  // Try Ollama
  if (ollamaAvailable !== false || (Date.now() - ollamaFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callOllamaGeneric(systemPrompt, userMessage);
      if (result) { ollamaAvailable = true; return result; }
    } catch {
      ollamaAvailable = false;
      ollamaFailedAt = Date.now();
    }
  }
  return null;
}

async function callMLXGeneric(systemPrompt: string, userMessage: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const model = await resolveModelForCall();
  try {
    const resp = await fetch(MLX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
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
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    return content ? cleanLLMOutput(content) : null;
  } catch (err) { clearTimeout(timer); throw err; }
}

async function callOllamaGeneric(systemPrompt: string, userMessage: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
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
    const data = await resp.json() as { message?: { content?: string } };
    const content = data.message?.content?.trim();
    return content ? cleanLLMOutput(content) : null;
  } catch (err) { clearTimeout(timer); throw err; }
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
