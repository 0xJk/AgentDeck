/**
 * APME module — public surface for the bridge/daemon.
 *
 * Usage:
 *   const apme = await initApme();  // may return null if disabled
 *   apme?.collector.openRun({...});
 *   apme?.collector.ingestHook(sessionId, 'PreToolUse', data);
 *   apme?.collector.closeRun(sessionId, exitCode);
 *
 * The module is intentionally boot-safe: if better-sqlite3 can't load, all
 * methods still exist but are no-ops, and `initApme()` returns null.
 */

import { debug } from '../logger.js';
import { ApmeStore } from './store.js';
import { ApmeCollector } from './collector.js';
import { ApmeRunner } from './runner.js';
import { ApmeTuner } from './tuner.js';
import { ApmeHwSampler } from './hw-sampler.js';
import { ApmeRecommender } from './recommend.js';

export interface ApmeModule {
  store: ApmeStore;
  collector: ApmeCollector;
  runner: ApmeRunner;
  tuner: ApmeTuner;
  hwSampler: ApmeHwSampler;
  recommender: ApmeRecommender;
}

let singleton: ApmeModule | null = null;

/** Initialize the APME subsystem. Returns null if the SQLite store can't open. */
export async function initApme(dbPath?: string): Promise<ApmeModule | null> {
  if (singleton) return singleton;
  const store = new ApmeStore(dbPath);
  const ok = await store.init();
  if (!ok) {
    debug('APME', 'initApme skipped (store disabled)');
    return null;
  }
  const hwSampler = new ApmeHwSampler();
  const collector = new ApmeCollector(store, hwSampler);
  const runner = new ApmeRunner(store);
  const tuner = new ApmeTuner(store);
  const recommender = new ApmeRecommender(store);
  singleton = { store, collector, runner, tuner, hwSampler, recommender };

  // Auto-enqueue eval on run close: collectors call `closeRun()` and we
  // forward the returned runId here when wired into the bridge.

  return singleton;
}

export function getApme(): ApmeModule | null {
  return singleton;
}

export { loadApmeConfig, shouldJudge, DEFAULT_APME_CONFIG } from './settings.js';
export type { ApmeConfig, ApmeJudgeConfig, ApmeJudgeBackend } from './settings.js';
export { ApmeStore } from './store.js';
export { ApmeCollector } from './collector.js';
export { ApmeRunner } from './runner.js';
export { ApmeTuner } from './tuner.js';
export { ApmeHwSampler } from './hw-sampler.js';
export { ApmeRecommender } from './recommend.js';
export { classifyRun, classify, computeSignals, TASK_CATEGORIES } from './classifier.js';
export type { TaskSignals, TaskCategory } from './classifier.js';
export type * from './types.js';
