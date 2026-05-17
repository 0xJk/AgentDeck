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

import { writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { debug, logError } from '../logger.js';
import { ApmeStore } from './store.js';
import { apmeDashboardHtml } from './dashboard-html.js';
import { ApmeCollector } from './collector.js';
import { ApmeRunner } from './runner.js';
import { ApmeTuner } from './tuner.js';
import { ApmeHwSampler } from './hw-sampler.js';
import { ApmeRecommender } from './recommend.js';
import type { TimelineEntry } from '@agentdeck/shared';

export interface ApmeModule {
  store: ApmeStore;
  collector: ApmeCollector;
  runner: ApmeRunner;
  tuner: ApmeTuner;
  hwSampler: ApmeHwSampler;
  recommender: ApmeRecommender;
}

export interface InitApmeOptions {
  /** Where to forward task hierarchy entries so they show up in the dashboard
   *  timeline. Optional — when absent, task tracking still works for eval but
   *  the dashboard sees only turn-level rows. */
  emitTimeline?: (entry: TimelineEntry) => void;
}

let singleton: ApmeModule | null = null;

/** Initialize the APME subsystem. Returns null if the SQLite store can't open.
 *  When null, the failure reason is logged at ERROR level — silent disable was
 *  the dominant cause of multi-day data outages observed in user telemetry. */
export async function initApme(
  dbPath?: string,
  opts: InitApmeOptions = {},
): Promise<ApmeModule | null> {
  if (singleton) return singleton;
  const store = new ApmeStore(dbPath);
  const ok = await store.init();
  if (!ok) {
    logError(`APME disabled — ${store.lastInitError ?? 'unknown init failure'}. Agent runs will not be measured.`);
    return null;
  }
  const hwSampler = new ApmeHwSampler();
  const collector = new ApmeCollector(store, hwSampler);
  const runner = new ApmeRunner(store);
  const tuner = new ApmeTuner(store);
  const recommender = new ApmeRecommender(store);
  singleton = { store, collector, runner, tuner, hwSampler, recommender };

  const emitTimeline = opts.emitTimeline;

  // Wire task-level judge: whenever the collector closes a task (TodoWrite
  // all-completed / /clear / session_end), enqueue a task_rollup judge call.
  // Kept here — not in the collector constructor — so the collector has no
  // hard dependency on the runner.
  collector.onTaskClosed = ({
    taskId, runId, sessionId, agentType, projectName,
    startedAt, endedAt, boundarySignal, taskCategory,
  }) => {
    runner.enqueueTask({
      runId,
      taskId,
      category: taskCategory ?? undefined,
      boundarySignal,
    });

    if (emitTimeline) {
      const durationSec = Math.max(0, Math.round((endedAt - startedAt) / 1000));
      const signalLabel = boundarySignal === 'todo_complete' ? 'TODO done'
        : boundarySignal === 'clear' ? '/clear'
        : boundarySignal === 'session_end' ? 'Session end'
        : 'Task end';
      emitTimeline({
        ts: endedAt,
        type: 'task_end',
        raw: `${signalLabel} · ${durationSec}s`,
        agentType: agentType ?? undefined,
        projectName: projectName ?? undefined,
        sessionId,
        runId,
        taskId,
        boundarySignal,
        startedAt,
        endedAt,
      });
    }
  };

  // Wire task-start emission. The runner has no opinion on opens — only the
  // dashboard does — so we keep this strictly local to the timeline path.
  if (emitTimeline) {
    collector.onTaskOpened = ({
      taskId, runId, sessionId, agentType, projectName, taskIndex, startedAt,
    }) => {
      emitTimeline({
        ts: startedAt,
        type: 'task_start',
        raw: `Task ${taskIndex + 1}`,
        agentType: agentType ?? undefined,
        projectName: projectName ?? undefined,
        sessionId,
        runId,
        taskId,
        startedAt,
      });
    };
  }

  // Wire task-eval completion → re-emit `task_end` with score + outcome.
  // The original `task_end` (above) fires synchronously on closeTask so the
  // boundary is visible immediately; the judge runs async and may take
  // 5-30 s. When it resolves, this listener emits a second `task_end` with
  // the same `taskId`. Timeline stores upsert by (type='task_end', taskId)
  // and merge the new score fields onto the existing row, so dashboard task
  // headers get the score badge as soon as the judge returns.
  if (emitTimeline) {
    runner.onTaskEvaluated((e) => {
      const durationSec = Math.max(0, Math.round((e.endedAt - e.startedAt) / 1000));
      const signalLabel = e.boundarySignal === 'todo_complete' ? 'TODO done'
        : e.boundarySignal === 'clear' ? '/clear'
        : e.boundarySignal === 'session_end' ? 'Session end'
        : e.boundarySignal === 'manual' ? 'Manual'
        : e.boundarySignal === 'idle_gap' ? 'Idle gap'
        : 'Task end';
      emitTimeline({
        ts: e.endedAt,
        type: 'task_end',
        raw: `${signalLabel} · ${durationSec}s`,
        agentType: e.agentType,
        projectName: e.projectName,
        sessionId: e.sessionId,
        runId: e.runId,
        taskId: e.taskId,
        boundarySignal: e.boundarySignal,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        taskScore: e.compositeScore ?? undefined,
        taskOutcome: e.outcome,
        taskCategory: e.taskCategory,
        taskSummary: e.summary,
      });
    });
  }

  // Write dashboard HTML for Swift daemon to pick up.
  try {
    const dataDir = process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
    writeFileSync(join(dataDir, 'apme-dashboard.html'), apmeDashboardHtml(), 'utf-8');
  } catch { /* best-effort */ }

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
export { classifyRun, classifyRunSmart, classifyWithLlm, classify, computeSignals, TASK_CATEGORIES } from './classifier.js';
export { evaluateOutcome, detectOutcome, computeEfficiency, computeComposite } from './outcome.js';
export type { Outcome, OutcomeResult, EfficiencyMetrics, CompositeBreakdown } from './outcome.js';
export type { TaskSignals, TaskCategory } from './classifier.js';
export type * from './types.js';
