let preferredMlxModelsUrl: string | null = null;

export async function fetchMlxModels(): Promise<string[] | null> {
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
      return Array.from(new Set(models));
    } catch {
      // try next endpoint
    }
  }
  return [];
}
