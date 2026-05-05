/**
 * APME settings loader.
 *
 * Reads `~/.agentdeck/settings.json` and returns a fully resolved APME config
 * merged with cost-sensitive defaults. The contract is intentionally strict:
 *
 *   - Default judge backend = local MLX (zero marginal cost).
 *   - `backend: "api"` is **NOT supported on the Node bridge** — `callApi()`
 *     in runner.ts is a stub that always throws. The Swift daemon
 *     (App Store macOS) does implement an Anthropic API adapter; users on
 *     macOS can set "api" through the Apple Settings picker because that
 *     value rides in a different Group Container settings.json. On the Node
 *     bridge, "api" is silently downgraded to "mlx" with a warning so a
 *     misconfigured value never produces silent zero-eval sessions.
 *   - `sampleRate` + `onlyWhenDisagreement` gate how often layer 2 runs at all.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { debug } from '../logger.js';

export type ApmeJudgeBackend = 'mlx' | 'api' | 'openclaw' | 'foundationModels';

export interface ApmeJudgeConfig {
  backend: ApmeJudgeBackend;
  /** Model id at the chosen backend (e.g. "qwen3-30b", "claude-opus-4-6").
   *  Unused for `foundationModels` — Apple picks the on-device model. */
  model: string;
  /** Fraction of closed runs that trigger a layer-2 judge call (0..1). */
  sampleRate: number;
  /** Only judge runs where layer-1 signal is ambiguous (tests flaky / mixed). */
  onlyWhenDisagreement: boolean;
  /** Optional custom endpoint (MLX server URL, OpenClaw gateway, etc).
   *  For `foundationModels` this is the Swift daemon's `/apme/judge/foundation-models`
   *  endpoint — defaults to the daemon on the standard discovery path. */
  endpoint?: string;
  /** Opt-in: when `foundationModels` is unavailable, retry via MLX instead of
   *  skipping the eval. Default `false` to honour cost-sensitive-defaults and
   *  the App Store invariant that evals must never silently route to network
   *  backends. */
  fallbackToMlx?: boolean;
}

export interface ApmeDeterministicConfig {
  enabled: boolean;
  /** Hard ceiling per command step (seconds). */
  timeoutSec: number;
  /** Language-specific command overrides. Unset keys fall back to defaults. */
  commands: Partial<Record<'typescript' | 'swift' | 'kotlin', {
    lint?: string;
    build?: string;
    test?: string;
  }>>;
}

export interface ApmeConfig {
  enabled: boolean;
  /** Auto-tune the judge rubric based on disagreement + vibe feedback. */
  autoTune: boolean;
  deterministic: ApmeDeterministicConfig;
  judge: ApmeJudgeConfig;
  /** Models the user actually has access to — fed into the recommender. */
  availableModels: string[];
}

/** Cost-sensitive defaults: local MLX, sparse sampling, no API calls. */
export const DEFAULT_APME_CONFIG: ApmeConfig = {
  enabled: true,
  autoTune: true,
  deterministic: {
    enabled: true,
    timeoutSec: 180,
    commands: {},
  },
  judge: {
    backend: 'mlx',
    model: 'qwen3-30b',
    sampleRate: 1.0,
    onlyWhenDisagreement: false,
  },
  availableModels: [],
};

function getSettingsPath(): string {
  const dir = process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
  return join(dir, 'settings.json');
}

/**
 * Load APME config from `~/.agentdeck/settings.json`, merging any `apme` block
 * on top of the cost-sensitive defaults. Missing or malformed settings fall
 * back silently — the bridge must keep booting.
 */
export function loadApmeConfig(): ApmeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(getSettingsPath(), 'utf-8'));
  } catch {
    return { ...DEFAULT_APME_CONFIG };
  }
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_APME_CONFIG };
  const apme = (raw as { apme?: unknown }).apme;
  if (!apme || typeof apme !== 'object') return { ...DEFAULT_APME_CONFIG };

  const a = apme as Partial<ApmeConfig> & { judge?: Partial<ApmeJudgeConfig> };
  const judge: ApmeJudgeConfig = {
    ...DEFAULT_APME_CONFIG.judge,
    ...(a.judge ?? {}),
  };
  // Clamp pathological values.
  judge.sampleRate = Math.max(0, Math.min(1, Number(judge.sampleRate) || 0));

  // Any forced backend change MUST also wipe backend-specific endpoint/model
  // so we don't end up calling, e.g., callMlx() against an Anthropic URL or
  // a model id that only exists on the original backend. resetBackendCoupledFields
  // restores the backend's own defaults; the user can re-state per-backend
  // overrides cleanly in settings.json.
  const resetBackendCoupledFields = (reason: string): void => {
    debug('APME', `${reason} — also resetting judge.endpoint and judge.model to mlx defaults to avoid cross-backend leakage.`);
    judge.endpoint = undefined;
    judge.model = DEFAULT_APME_CONFIG.judge.model;
  };

  if (!['mlx', 'api', 'openclaw', 'foundationModels'].includes(judge.backend)) {
    resetBackendCoupledFields(`unknown judge.backend=${judge.backend}, falling back to mlx`);
    judge.backend = 'mlx';
  }
  // The 'api' backend is currently a stub on the Node bridge (callApi() always
  // throws). Downgrade silently to MLX with a one-shot diagnostic so a stale
  // settings.json doesn't leave APME wedged. Swift daemon has its own loader
  // that does NOT degrade — see apple/AgentDeck/Daemon/Apme/ApmeSettings.swift.
  if (judge.backend === 'api') {
    resetBackendCoupledFields('judge.backend="api" is not implemented on the Node bridge — downgrading to "mlx". Use the macOS app for Anthropic API judging, or pick "openclaw" / "foundationModels" / "mlx"');
    judge.backend = 'mlx';
  }
  judge.fallbackToMlx = Boolean(judge.fallbackToMlx);

  const det: ApmeDeterministicConfig = {
    ...DEFAULT_APME_CONFIG.deterministic,
    ...((a as { deterministic?: Partial<ApmeDeterministicConfig> }).deterministic ?? {}),
  };
  det.timeoutSec = Math.max(5, Math.min(1800, Number(det.timeoutSec) || DEFAULT_APME_CONFIG.deterministic.timeoutSec));
  det.commands = det.commands ?? {};

  const merged: ApmeConfig = {
    enabled: a.enabled ?? DEFAULT_APME_CONFIG.enabled,
    autoTune: a.autoTune ?? DEFAULT_APME_CONFIG.autoTune,
    deterministic: det,
    judge,
    availableModels: Array.isArray(a.availableModels) ? a.availableModels : [],
  };
  return merged;
}

/**
 * Decide whether layer-2 (LLM judge) should run for this run, based on the
 * sampleRate + disagreement gates. `deterministicPassed` reflects layer-1 outcome.
 */
export function shouldJudge(cfg: ApmeJudgeConfig, deterministicPassed: boolean | null): boolean {
  if (cfg.sampleRate <= 0) return false;
  if (cfg.onlyWhenDisagreement) {
    // Judge when layer-1 signal is missing or already flagged as failure.
    // Clear passes are skipped — they're the least informative samples.
    if (deterministicPassed === true) return false;
  }
  return Math.random() < cfg.sampleRate;
}
