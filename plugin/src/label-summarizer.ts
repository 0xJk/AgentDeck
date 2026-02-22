/**
 * Async label summarizer using Claude Haiku via `claude -p` CLI.
 * Used as a fallback when local heuristic abbreviation still overflows button space.
 *
 * Flow: caller checks cache (sync) → miss → fires async `claude -p` → callback on ready.
 * First render uses ellipsis; Haiku result replaces on next render cycle.
 */
import { execFile } from 'node:child_process';
import { dlog, dwarn } from './log.js';

const TAG = 'LabelSum';
const MAX_CACHE = 200;
const TIMEOUT_MS = 10_000;

/** label → abbreviated string */
const cache = new Map<string, string>();
/** label → in-flight promise (dedup) */
const pending = new Map<string, Promise<string | null>>();

/** Sync cache lookup. Returns abbreviated label or null if not cached. */
export function getCachedLabel(label: string): string | null {
  return cache.get(label) ?? null;
}

/**
 * Request Haiku abbreviation for a label.
 * Returns a promise that resolves to the abbreviated string, or null on failure.
 * Results are cached. Duplicate requests are deduped.
 */
export async function requestAbbreviation(
  label: string,
  maxChars: number,
): Promise<string | null> {
  if (cache.has(label)) return cache.get(label)!;
  if (pending.has(label)) return pending.get(label)!;

  const promise = summarizeViaHaiku(label, maxChars);
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

function summarizeViaHaiku(label: string, maxChars: number): Promise<string | null> {
  const prompt = `Shorten this UI button label to at most ${maxChars} characters. Keep the core meaning. Return ONLY the shortened text, nothing else.\n\nLabel: "${label}"`;

  return new Promise((resolve) => {
    execFile('claude', ['-p', '--model', 'haiku', prompt], {
      timeout: TIMEOUT_MS,
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1', CLAUDECODE: '' },
    }, (err, stdout) => {
      if (err) {
        dwarn(TAG, `claude -p error: ${err.message}`);
        resolve(null);
        return;
      }
      const text = stdout.trim();
      if (!text || text.length > maxChars * 2) {
        dwarn(TAG, `bad result: "${text}"`);
        resolve(null);
        return;
      }
      dlog(TAG, `"${label}" → "${text}"`);
      resolve(text);
    });
  });
}

/** Clear cache (e.g. on session change) */
export function clearLabelCache(): void {
  cache.clear();
  pending.clear();
}
