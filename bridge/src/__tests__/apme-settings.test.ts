import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadApmeConfig, DEFAULT_APME_CONFIG } from '../apme/settings.js';

// Regression guard for cost-sensitive defaults: when a user has no
// ~/.agentdeck/settings.json (or has one without an `apme` section),
// APME must self-activate with the local MLX judge — that's how the
// "11-day data stall" diagnostic case (sqlite mtime 2026-04-19) would
// silently happen if defaults regress to disabled. See plans/…-graham.md
// stage 0.3.

const ORIGINAL_DATA_DIR = process.env.AGENTDECK_DATA_DIR;

function withTempDataDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'apme-settings-'));
  process.env.AGENTDECK_DATA_DIR = dir;
  try { fn(dir); }
  finally {
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGENTDECK_DATA_DIR;
    else process.env.AGENTDECK_DATA_DIR = ORIGINAL_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadApmeConfig — defaults + merge behaviour', () => {
  it('returns full defaults when settings.json does not exist', () => {
    withTempDataDir(() => {
      const cfg = loadApmeConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.autoTune).toBe(true);
      expect(cfg.deterministic.enabled).toBe(true);
      expect(cfg.deterministic.timeoutSec).toBe(DEFAULT_APME_CONFIG.deterministic.timeoutSec);
      expect(cfg.judge.backend).toBe('mlx');
      expect(cfg.judge.model).toBe('qwen3-30b');
      expect(cfg.judge.sampleRate).toBe(1.0);
      expect(cfg.judge.onlyWhenDisagreement).toBe(false);
      expect(cfg.availableModels).toEqual([]);
    });
  });

  it('returns full defaults when settings.json has no apme section', () => {
    withTempDataDir((dir) => {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ pixooDevices: [{ ip: '192.0.2.1', name: 'demo' }], wakeWord: false }),
        'utf-8',
      );
      const cfg = loadApmeConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.judge.backend).toBe('mlx');
    });
  });

  it('returns defaults on malformed JSON (must not throw)', () => {
    withTempDataDir((dir) => {
      writeFileSync(join(dir, 'settings.json'), '{not valid json', 'utf-8');
      const cfg = loadApmeConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.judge.backend).toBe('mlx');
    });
  });

  it('merges user-set fields on top of defaults', () => {
    withTempDataDir((dir) => {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          apme: {
            judge: { backend: 'openclaw', model: 'gpt-4', sampleRate: 0.5 },
            availableModels: ['claude-opus', 'gpt-4'],
          },
        }),
        'utf-8',
      );
      const cfg = loadApmeConfig();
      expect(cfg.enabled).toBe(true); // unchanged default
      expect(cfg.autoTune).toBe(true); // unchanged default
      expect(cfg.judge.backend).toBe('openclaw');
      expect(cfg.judge.model).toBe('gpt-4');
      expect(cfg.judge.sampleRate).toBe(0.5);
      expect(cfg.judge.onlyWhenDisagreement).toBe(false); // unchanged default
      expect(cfg.availableModels).toEqual(['claude-opus', 'gpt-4']);
    });
  });

  it('clamps sampleRate to [0, 1]', () => {
    withTempDataDir((dir) => {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ apme: { judge: { sampleRate: 5 } } }),
        'utf-8',
      );
      expect(loadApmeConfig().judge.sampleRate).toBe(1);

      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ apme: { judge: { sampleRate: -0.3 } } }),
        'utf-8',
      );
      expect(loadApmeConfig().judge.sampleRate).toBe(0);
    });
  });

  it('falls back to mlx when judge.backend is unknown string', () => {
    withTempDataDir((dir) => {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ apme: { judge: { backend: 'totally-made-up' } } }),
        'utf-8',
      );
      expect(loadApmeConfig().judge.backend).toBe('mlx');
    });
  });

  it('downgrades judge.backend="api" to "mlx" on the Node bridge (callApi is a stub)', () => {
    // Regression guard for "API backend diagnostics still contradict the new
    // probe" — probe reports unavailable for 'api' AND settings loader must
    // strip 'api' before it reaches the dispatcher, so a stale settings.json
    // entry doesn't park the bridge in a never-fires state.
    withTempDataDir((dir) => {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ apme: { judge: { backend: 'api' } } }),
        'utf-8',
      );
      expect(loadApmeConfig().judge.backend).toBe('mlx');
    });
  });

  it('also wipes endpoint/model when downgrading backend="api" → "mlx"', () => {
    // Regression guard for "API→MLX downgrade keeps stale API model/endpoint":
    // if the user wrote `{backend:"api", endpoint:"https://api.anthropic.com/...",
    // model:"claude-opus-4-7"}`, the downgrade must reset endpoint/model too,
    // otherwise callMlx() ends up POSTing to api.anthropic.com with a model
    // that the MLX server doesn't know — silent failure on every eval.
    withTempDataDir((dir) => {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          apme: {
            judge: {
              backend: 'api',
              endpoint: 'https://api.anthropic.com/v1/messages',
              model: 'claude-opus-4-7',
            },
          },
        }),
        'utf-8',
      );
      const cfg = loadApmeConfig();
      expect(cfg.judge.backend).toBe('mlx');
      expect(cfg.judge.endpoint).toBeUndefined();
      expect(cfg.judge.model).toBe(DEFAULT_APME_CONFIG.judge.model);
    });
  });

  it('also wipes endpoint/model when falling back from unknown backend → "mlx"', () => {
    withTempDataDir((dir) => {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          apme: {
            judge: {
              backend: 'gemini-pro',
              endpoint: 'https://generativelanguage.googleapis.com/v1/...',
              model: 'gemini-2.5-pro',
            },
          },
        }),
        'utf-8',
      );
      const cfg = loadApmeConfig();
      expect(cfg.judge.backend).toBe('mlx');
      expect(cfg.judge.endpoint).toBeUndefined();
      expect(cfg.judge.model).toBe(DEFAULT_APME_CONFIG.judge.model);
    });
  });

  it('preserves user-set endpoint/model when keeping their chosen backend', () => {
    // Negative case: when the backend is valid + supported, the loader must
    // NOT touch endpoint/model. Reset is only triggered by a forced fallback.
    withTempDataDir((dir) => {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          apme: {
            judge: {
              backend: 'mlx',
              endpoint: 'http://192.0.2.1:9999/v1/chat/completions',
              model: 'qwen3-72b-custom',
            },
          },
        }),
        'utf-8',
      );
      const cfg = loadApmeConfig();
      expect(cfg.judge.backend).toBe('mlx');
      expect(cfg.judge.endpoint).toBe('http://192.0.2.1:9999/v1/chat/completions');
      expect(cfg.judge.model).toBe('qwen3-72b-custom');
    });
  });

  it('respects explicit enabled=false (opt-out)', () => {
    withTempDataDir((dir) => {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ apme: { enabled: false } }),
        'utf-8',
      );
      expect(loadApmeConfig().enabled).toBe(false);
    });
  });

  it('clamps deterministic.timeoutSec to [5, 1800]', () => {
    withTempDataDir((dir) => {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ apme: { deterministic: { timeoutSec: 99999 } } }),
        'utf-8',
      );
      expect(loadApmeConfig().deterministic.timeoutSec).toBe(1800);

      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ apme: { deterministic: { timeoutSec: 1 } } }),
        'utf-8',
      );
      expect(loadApmeConfig().deterministic.timeoutSec).toBe(5);
    });
  });
});

describe('loadApmeConfig — DEFAULT_APME_CONFIG sanity', () => {
  it('default backend is local MLX (cost-sensitive policy)', () => {
    expect(DEFAULT_APME_CONFIG.judge.backend).toBe('mlx');
  });
  it('default sampleRate is 1.0 (judge every closed run; cost is local)', () => {
    expect(DEFAULT_APME_CONFIG.judge.sampleRate).toBe(1.0);
  });
  it('default enabled is true (zero-config activation)', () => {
    expect(DEFAULT_APME_CONFIG.enabled).toBe(true);
  });
  it('default autoTune is true (rubric self-improves over time)', () => {
    expect(DEFAULT_APME_CONFIG.autoTune).toBe(true);
  });
});
