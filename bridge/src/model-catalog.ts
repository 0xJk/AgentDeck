/**
 * OpenClaw model catalog — fetches configured models via `openclaw models list --json`.
 *
 * Results are cached for 60 seconds to avoid repeated CLI invocations.
 */
import { execSync } from 'child_process';
import { debug } from './logger.js';
import type { ModelCatalogEntry } from './types.js';
import { augmentedPath } from '@agentdeck/shared';

export interface OpenClawModel {
  key: string;
  name: string;
  input?: string;
  contextWindow?: number;
  local?: boolean;
  available?: boolean;
  tags?: string[];
  missing?: boolean;
}

interface ModelListResult {
  count: number;
  models: OpenClawModel[];
}

// Cache
let cachedEntries: ModelCatalogEntry[] | null = null;
let cachedRaw: OpenClawModel[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

/**
 * Parse role from model tags.
 * - "default" → "default"
 * - "fallback#N" → "fallback-N"
 * - otherwise → "configured"
 */
function parseRole(tags: string[]): ModelCatalogEntry['role'] {
  if (tags.includes('default')) return 'default';
  for (const tag of tags) {
    const match = tag.match(/^fallback#(\d+)$/);
    if (match) return `fallback-${match[1]}` as `fallback-${number}`;
  }
  return 'configured';
}

/**
 * Convert raw CLI models to catalog entries for the plugin.
 */
function toEntries(models: OpenClawModel[]): ModelCatalogEntry[] {
  return models.map((m) => ({
    name: m.name,
    role: parseRole(m.tags ?? []),
    available: m.available !== false,
  }));
}

/**
 * Fetch the model catalog from `openclaw models list --json`.
 * Returns cached entries if within TTL.
 * Returns null if openclaw is not installed or the command fails.
 */
export function fetchModelCatalog(): { entries: ModelCatalogEntry[]; raw: OpenClawModel[] } | null {
  const now = Date.now();
  if (cachedEntries && cachedRaw && now - cacheTime < CACHE_TTL_MS) {
    return { entries: cachedEntries, raw: cachedRaw };
  }

  try {
    const output = execSync('openclaw models list --json', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: augmentedPath() },
    }).trim();

    const result = JSON.parse(output) as ModelListResult;
    if (!result.models || !Array.isArray(result.models)) {
      debug('model-catalog', 'Unexpected CLI output format');
      return null;
    }

    cachedRaw = result.models;
    cachedEntries = toEntries(result.models);
    cacheTime = now;

    debug('model-catalog', `Fetched ${cachedEntries.length} models (default: ${cachedEntries.find((e) => e.role === 'default')?.name ?? 'none'})`);
    return { entries: cachedEntries, raw: cachedRaw };
  } catch (err) {
    debug('model-catalog', `CLI call failed: ${err}`);
    return null;
  }
}

/**
 * Get the default model name from the catalog, or null.
 */
export function getDefaultModelName(): string | null {
  const catalog = fetchModelCatalog();
  if (!catalog) return null;
  const defaultEntry = catalog.entries.find((e) => e.role === 'default');
  return defaultEntry?.name ?? null;
}

/**
 * Invalidate the cache (e.g., on reconnect).
 */
export function invalidateModelCache(): void {
  cachedEntries = null;
  cachedRaw = null;
  cacheTime = 0;
}
