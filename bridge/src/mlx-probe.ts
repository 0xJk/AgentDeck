let preferredMlxModelsUrl: string | null = null;

/**
 * Probe the MLX server's model catalog. When `pin` matches one of the
 * advertised ids, return `[pin]` so downstream consumers (dashboard,
 * summarizers, judge) all see a single authoritative model. Otherwise
 * return the full filtered list.
 *
 * `nanollava` variants are always filtered out — some users keep them
 * loaded for vision tasks but they are not good judges/summarizers.
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
      if (pin && deduped.includes(pin)) {
        return [pin];
      }
      // Auto-pick the first model when the catalog advertises multiple and
      // no explicit pin is set. mlx_vlm.server enumerates every downloaded
      // model regardless of what's actually loaded, so exposing all of them
      // in the dashboard creates ambiguity. Matches the APME judge's existing
      // "first non-nanollava" auto-detection.
      if (deduped.length > 1) return [deduped[0]];
      return deduped;
    } catch {
      // try next endpoint
    }
  }
  return [];
}
