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
      // Installed models via /api/tags — always consistent (no flicker)
      const tagsRes = await fetch(`${OLLAMA_BASE}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!tagsRes.ok) {
        return { available: false, models: [] };
      }

      const tagsData = (await tagsRes.json()) as { models?: Array<{
        name?: string;
        size?: number;
      }> };

      const installed = tagsData.models ?? [];
      if (installed.length === 0) {
        return { available: true, models: [] };
      }

      // Running models via /api/ps — enrich with VRAM info for loaded models
      let vramMap: Map<string, number> = new Map();
      try {
        const psRes = await fetch(`${OLLAMA_BASE}/api/ps`, {
          signal: AbortSignal.timeout(3000),
        });
        if (psRes.ok) {
          const psData = (await psRes.json()) as { models?: Array<{
            name?: string;
            size_vram?: number;
          }> };
          for (const m of psData.models ?? []) {
            if (m.name) vramMap.set(m.name, m.size_vram ?? 0);
          }
        }
      } catch { /* ps failure is non-fatal */ }

      const models: OllamaModel[] = installed.map((m) => ({
        name: m.name ?? 'unknown',
        size: m.size ?? 0,
        sizeVram: vramMap.get(m.name ?? '') ?? 0,
      }));

      debug('OllamaProbe', `available, ${models.length} installed model(s), ${vramMap.size} loaded`);
      return { available: true, models };
    } catch {
      return { available: false, models: [] };
    }
  }
}
