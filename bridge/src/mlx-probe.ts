import { pickMlxModel } from '@agentdeck/shared';

let preferredMlxModelsUrl: string | null = null;

/**
 * Probe the MLX server's model catalog and pick the best single model id.
 * Returns `[model]` on success, `null` when the server is unreachable.
 *
 * `null` vs `[]` matters downstream: null means "MLX not detected, render
 * the empty-state in the dashboard and skip summarize calls entirely",
 * while the old `[]` return was ambiguous with "server up but no models".
 *
 * `nanollava` variants are filtered out — they load for vision tasks but
 * are poor judges/summarizers. Model pick priority is delegated to
 * `pickMlxModel` (pin → fallback in catalog → first entry).
 */
export async function fetchMlxModels(pin?: string | null): Promise<string[] | null> {
  const candidates = preferredMlxModelsUrl
    ? [preferredMlxModelsUrl, 'http://127.0.0.1:8800/v1/models', 'http://127.0.0.1:8800/models']
    : ['http://127.0.0.1:8800/v1/models', 'http://127.0.0.1:8800/models'];

  for (const url of Array.from(new Set(candidates))) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) continue;
      const json = await resp.json() as { data?: Array<{ id?: string; name?: string }> };
      const models = (json.data ?? [])
        .map((m) => (typeof m.id === 'string' && m.id.trim().length > 0 ? m.id.trim()
          : typeof m.name === 'string' && m.name.trim().length > 0 ? m.name.trim()
          : null))
        .filter((m): m is string => m != null)
        .filter((m) => !m.toLowerCase().includes('nanollava'));
      preferredMlxModelsUrl = url;
      const deduped = Array.from(new Set(models));
      const picked = pickMlxModel(deduped, pin);
      return picked ? [picked] : [];
    } catch {
      // try next endpoint
    }
  }
  return null;
}
