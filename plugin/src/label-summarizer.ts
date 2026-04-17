/**
 * Async label summarizer using local MLX Qwen via HTTP.
 * Used as a fallback when local heuristic abbreviation still overflows button space.
 *
 * Flow: caller checks cache (sync) → miss → fires async MLX request → callback on ready.
 * First render uses ellipsis; result replaces on next render cycle.
 */
import { dlog, dwarn } from './log.js';
import { mlxChatUrl, resolveMlxModel } from '@agentdeck/shared';

const TAG = 'LabelSum';
const MAX_CACHE = 200;
const MLX_URL = mlxChatUrl();
const TIMEOUT_MS = 10_000;
const RETRY_INTERVAL_MS = 60_000;

/** label → abbreviated string */
const cache = new Map<string, string>();
/** label → in-flight promise (dedup) */
const pending = new Map<string, Promise<string | null>>();

let mlxAvailable: boolean | null = null;
let mlxFailedAt = 0;

/** Sync cache lookup. Returns abbreviated label or null if not cached. */
export function getCachedLabel(label: string): string | null {
  return cache.get(label) ?? null;
}

/**
 * Request abbreviation for a label via local MLX.
 * Returns a promise that resolves to the abbreviated string, or null on failure.
 * Results are cached. Duplicate requests are deduped.
 */
export async function requestAbbreviation(
  label: string,
  maxChars: number,
): Promise<string | null> {
  if (cache.has(label)) return cache.get(label)!;
  if (pending.has(label)) return pending.get(label)!;

  const promise = summarizeViaMlx(label, maxChars);
  pending.set(label, promise);

  try {
    const result = await promise;
    if (result) {
      // Evict oldest if cache full
      if (cache.size >= MAX_CACHE) {
        const oldest = cache.keys().next().value;
        if (oldest != null) cache.delete(oldest);
      }
      cache.set(label, result);
    }
    return result;
  } finally {
    pending.delete(label);
  }
}

async function summarizeViaMlx(label: string, maxChars: number): Promise<string | null> {
  if (mlxAvailable === false && Date.now() - mlxFailedAt < RETRY_INTERVAL_MS) return null;

  const prompt = `Shorten this UI button label to at most ${maxChars} characters. Keep the core meaning. Return ONLY the shortened text, nothing else.\n\nLabel: "${label}"`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const resp = await fetch(MLX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: resolveMlxModel(),
        enable_thinking: false,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 60,
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`MLX ${resp.status}`);

    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    let text = data.choices?.[0]?.message?.content?.trim() ?? '';

    // Strip thinking tokens
    text = text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/g, '')
      .trim();

    // Take last non-empty line (thinking may precede answer)
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) text = lines[lines.length - 1];

    // Strip quotes/markdown
    text = text.replace(/^["'`"""]+|["'`"""]+$/g, '').trim();

    if (!text || text.length > maxChars * 2) {
      dwarn(TAG, `bad result: "${text}"`);
      return null;
    }

    mlxAvailable = true;
    dlog(TAG, `"${label}" → "${text}"`);
    return text;
  } catch (err: unknown) {
    mlxAvailable = false;
    mlxFailedAt = Date.now();
    dwarn(TAG, `MLX error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Clear cache (e.g. on session change) */
export function clearLabelCache(): void {
  cache.clear();
  pending.clear();
}
