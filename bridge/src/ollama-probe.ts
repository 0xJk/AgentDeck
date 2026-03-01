import { debug } from './logger.js';

export interface OllamaModel {
  name: string;
  size: number;
  sizeVram: number;
}

export interface OllamaStatus {
  available: boolean;
  models: OllamaModel[];
}

const OLLAMA_BASE = 'http://127.0.0.1:11434';

export class OllamaProbe {
  async getStatus(): Promise<OllamaStatus> {
    try {
      // Health check via /api/tags (lightweight)
      const tagsRes = await fetch(`${OLLAMA_BASE}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!tagsRes.ok) {
        return { available: false, models: [] };
      }

      // Running models via /api/ps
      const psRes = await fetch(`${OLLAMA_BASE}/api/ps`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!psRes.ok) {
        return { available: true, models: [] };
      }

      const data = (await psRes.json()) as { models?: Array<{
        name?: string;
        size?: number;
        size_vram?: number;
      }> };

      const models: OllamaModel[] = (data.models ?? []).map((m) => ({
        name: m.name ?? 'unknown',
        size: m.size ?? 0,
        sizeVram: m.size_vram ?? 0,
      }));

      debug('OllamaProbe', `available, ${models.length} running model(s)`);
      return { available: true, models };
    } catch {
      return { available: false, models: [] };
    }
  }
}
