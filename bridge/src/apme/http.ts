/**
 * APME HTTP routes — mounted by the daemon's raw createServer handler.
 *
 * Routes:
 *   GET  /apme/runs?limit=&agent=&model=   — recent runs with their evals
 *   GET  /apme/run/:id                     — single run detail (steps + evals)
 *   GET  /apme/scorecard                   — model scorecard (v_model_scorecard)
 *   POST /apme/vibe                        — { runId, verdict, note? }
 *   GET  /apme/rubric/current              — current rubric row
 *   POST /apme/recommend                   — { taskKind?, budgetUsd?, ... }
 *
 * Returns `true` if the request matched an APME route and was handled;
 * `false` otherwise so the caller can continue its fallback routing.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { ApmeModule } from './index.js';
import { loadApmeConfig } from './settings.js';
import { apmeDashboardHtml } from './dashboard-html.js';
import { EVAL_SCHEMA_VERSION } from '@agentdeck/shared';

export async function handleApmeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apme: ApmeModule | null,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/apme')) return false;

  if (!apme) {
    sendJson(res, 503, { error: 'APME not initialized (better-sqlite3 missing)' });
    return true;
  }

  const method = req.method ?? 'GET';
  const path = url.pathname;

  try {
    // ── Dashboard HTML ─────────────────────────────────────────────────────
    if (method === 'GET' && (path === '/apme' || path === '/apme/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(apmeDashboardHtml());
      return true;
    }

    // ── Runs ────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/apme/runs') {
      const limit = clampInt(url.searchParams.get('limit'), 1, 500, 50);
      const agentType = url.searchParams.get('agent') ?? undefined;
      const modelId = url.searchParams.get('model') ?? undefined;
      const runs = apme.store.listRuns({ limit, agentType, modelId });
      const withEvals = runs.map((r) => {
        const evals = apme.store.listEvalsForRun(r.id);
        const vibe = apme.store.latestVibeForRun(r.id);
        return {
          ...r,
          evals: evals.map((e) => ({
            layer: e.layer,
            metric: e.metric,
            score: e.score,
            rubricVer: e.rubricVer ?? null,
            judgeModel: e.judgeModel ?? null,
            createdAt: e.createdAt,
          })),
          overallScore: aggregateOverall(evals),
          vibe: vibe ? { verdict: vibe.verdict } : null,
        };
      });
      sendJson(res, 200, { schema: EVAL_SCHEMA_VERSION, runs: withEvals });
      return true;
    }

    if (method === 'GET' && path.startsWith('/apme/run/')) {
      const id = path.slice('/apme/run/'.length);
      const run = apme.store.getRun(id);
      if (!run) {
        sendJson(res, 404, { error: 'run not found' });
        return true;
      }
      const evals = apme.store.listEvalsForRun(id);
      const steps = apme.store.listSteps(id);
      const rawTurns = apme.store.listTurns(id);
      const vibe = apme.store.latestVibeForRun(id);
      // Include per-turn evals for mid-session scoring
      const turns = rawTurns.map(t => ({
        ...t,
        turnEvals: apme.store.listEvalsForTurn(t.id as string),
      }));
      // Include per-task rollup evals — task-unit granularity is the canonical
      // evaluation surface for "how well did this agent do this task".
      const rawTasks = apme.store.listTasksForRun(id);
      const tasks = rawTasks.map((t) => ({
        ...t,
        evals: apme.store.listEvalsForTask(t.id),
      }));
      sendJson(res, 200, {
        schema: EVAL_SCHEMA_VERSION,
        run,
        evals,
        steps,
        turns,
        tasks,
        vibe,
        overallScore: aggregateOverall(evals),
      });
      return true;
    }

    if (method === 'GET' && path.startsWith('/apme/tasks/')) {
      const taskId = path.slice('/apme/tasks/'.length);
      const task = apme.store.getTask(taskId);
      if (!task) {
        sendJson(res, 404, { error: 'task not found' });
        return true;
      }
      const taskEvals = apme.store.listEvalsForTask(taskId);
      const turns = apme.store.listTurnsForTask(taskId);
      sendJson(res, 200, {
        schema: EVAL_SCHEMA_VERSION,
        task,
        evals: taskEvals,
        turns,
        overallScore: aggregateOverall(taskEvals),
      });
      return true;
    }

    // ── Scorecard ───────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/apme/scorecard') {
      sendJson(res, 200, { schema: EVAL_SCHEMA_VERSION, scorecards: apme.store.scorecard() });
      return true;
    }

    if (method === 'GET' && path === '/apme/categories') {
      sendJson(res, 200, { schema: EVAL_SCHEMA_VERSION, categories: apme.store.categoryScorecard() });
      return true;
    }

    // ── Rubric ──────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/apme/rubric/current') {
      const rubric = apme.store.getCurrentRubric('general');
      if (!rubric) {
        sendJson(res, 404, { error: 'no rubric seeded' });
        return true;
      }
      sendJson(res, 200, { schema: EVAL_SCHEMA_VERSION, rubric });
      return true;
    }

    // ── Vibe feedback ───────────────────────────────────────────────────────
    if (method === 'POST' && path === '/apme/vibe') {
      const body = await readJsonBody(req);
      if (!body || typeof body.runId !== 'string' || typeof body.verdict !== 'string') {
        sendJson(res, 400, { error: 'expected { runId, verdict, note? }' });
        return true;
      }
      if (!['approve', 'reject', 'neutral'].includes(body.verdict)) {
        sendJson(res, 400, { error: 'verdict must be approve|reject|neutral' });
        return true;
      }
      const run = apme.store.getRun(body.runId);
      if (!run) {
        sendJson(res, 404, { error: 'run not found' });
        return true;
      }
      apme.store.insertVibe({
        runId: body.runId,
        verdict: body.verdict as 'approve' | 'reject' | 'neutral',
        note: typeof body.note === 'string' ? body.note : null,
        ts: Date.now(),
      });
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ── Recommendation ──────────────────────────────────────────────────────
    if (method === 'POST' && path === '/apme/recommend') {
      const body = await readJsonBody(req);
      const input = body && typeof body === 'object' ? body : {};
      const cfg = loadApmeConfig();
      const candidates = apme.recommender.recommend({
        taskKind: typeof input.taskKind === 'string' ? input.taskKind : undefined,
        budgetUsd: typeof input.budgetUsd === 'number' ? input.budgetUsd : undefined,
        latencyBudgetMs: typeof input.latencyBudgetMs === 'number' ? input.latencyBudgetMs : undefined,
        preferLocal: typeof input.preferLocal === 'boolean' ? input.preferLocal : undefined,
        availableModels: cfg.availableModels.length > 0 ? cfg.availableModels : undefined,
      });
      sendJson(res, 200, { candidates });
      return true;
    }

    // ── Rubric tune trigger (manual) ────────────────────────────────────────
    if (method === 'POST' && path === '/apme/tune') {
      const outcome = await apme.tuner.tune();
      sendJson(res, 200, outcome);
      return true;
    }

    // Unknown /apme/* path
    sendJson(res, 404, { error: 'unknown apme endpoint' });
    return true;
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
    return true;
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      total += c.length;
      if (total > 1_000_000) req.destroy(); // 1 MB cap
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function clampInt(s: string | null, min: number, max: number, dflt: number): number {
  if (!s) return dflt;
  const n = parseInt(s, 10);
  if (!isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

export function aggregateOverall(evals: ReturnType<ApmeModule['store']['listEvalsForRun']>): number | null {
  const overall = evals.find((e) => e.layer === 'llm_judge' && e.metric === 'overall');
  if (overall) return overall.score;
  const det = evals.filter((e) => e.layer === 'deterministic');
  if (det.length === 0) return null;
  return det.reduce((sum, e) => sum + e.score, 0) / det.length;
}
