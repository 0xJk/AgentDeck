/**
 * APME Collector — the ingestion boundary.
 *
 * Responsibilities:
 *   - openRun(session): create a `runs` row when a bridge session starts
 *   - ingestHook(evt): write a `steps` row for every hook POST
 *   - updateUsage(snapshot): keep token/cost columns in sync
 *   - closeRun(session, exitCode): finalize the row, capture git SHA, enqueue eval
 *
 * The collector is lazy — it's created once at daemon/bridge startup and gated on
 * `store.enabled`. All methods are no-ops if the store failed to initialize
 * (e.g. better-sqlite3 missing), so the rest of the bridge never needs to care.
 */

import { randomUUID, createHash } from 'crypto';
import { execSync } from 'child_process';
import { basename, join } from 'path';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { debug } from '../logger.js';
import type { UsageSnapshot } from '../types.js';
import type { SessionEntry } from '../session-registry.js';
import type { ApmeStore } from './store.js';
import type { ApmeRunRow } from './types.js';
import type { AgentType } from '@agentdeck/shared';
import type { ApmeHwSampler } from './hw-sampler.js';

export interface OpenRunInput {
  sessionId: string;
  agentType: AgentType;
  modelId?: string;
  projectName?: string;
  projectPath?: string;
  taskPrompt?: string;
}

export class ApmeCollector {
  private readonly sessionToRun = new Map<string, string>(); // sessionId → runId

  constructor(
    private readonly store: ApmeStore,
    private readonly hwSampler?: ApmeHwSampler,
  ) {}

  /** Start a new run and return its id. Safe to call if store disabled (returns ''). */
  openRun(input: OpenRunInput): string {
    if (!this.store.enabled) return '';
    const runId = randomUUID();
    const gitBefore = readGitHead(input.projectPath);
    const row: ApmeRunRow = {
      id: runId,
      sessionId: input.sessionId,
      agentType: input.agentType,
      modelId: input.modelId ?? null,
      projectName: input.projectName ?? (input.projectPath ? basename(input.projectPath) : null),
      projectPath: input.projectPath ?? null,
      taskPrompt: input.taskPrompt ?? null,
      startedAt: Date.now(),
      gitBefore,
    };
    try {
      this.store.insertRun(row);
      this.sessionToRun.set(input.sessionId, runId);
      debug('APME', `openRun ${runId} session=${input.sessionId} agent=${input.agentType} model=${input.modelId ?? '-'}`);
    } catch (err) {
      debug('APME', `openRun failed: ${String(err)}`);
    }
    return runId;
  }

  /** Record a hook event as a step. */
  ingestHook(sessionId: string, event: string, data: Record<string, unknown>): void {
    if (!this.store.enabled) return;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    const toolName = typeof data.tool_name === 'string' ? data.tool_name : null;
    // Capture task_prompt lazily — first UserPromptSubmit wins.
    if (event === 'UserPromptSubmit' && typeof data.prompt === 'string') {
      try {
        const run = this.store.getRun(runId);
        if (run && !run.taskPrompt) {
          this.store.updateRun(runId, { taskPrompt: (data.prompt as string).slice(0, 8_000) });
        }
      } catch { /* ignore */ }
    }
    try {
      this.store.insertStep({
        runId,
        ts: Date.now(),
        kind: event,
        toolName,
        payload: safeStringify(data),
      });
    } catch (err) {
      debug('APME', `ingestHook failed: ${String(err)}`);
    }
  }

  /** Ingest a generic timeline-style event (non-hook). */
  ingestStep(sessionId: string, kind: string, payload: Record<string, unknown>, toolName?: string): void {
    if (!this.store.enabled) return;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    try {
      this.store.insertStep({
        runId, ts: Date.now(), kind,
        toolName: toolName ?? null,
        payload: safeStringify(payload),
      });
    } catch { /* ignore */ }
  }

  /** Update token / cost columns from the bridge's UsageTracker snapshot. */
  updateUsage(sessionId: string, snapshot: UsageSnapshot): void {
    if (!this.store.enabled) return;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    try {
      this.store.updateRun(runId, {
        inputTokens: snapshot.inputTokens,
        outputTokens: snapshot.outputTokens,
        costUsd: snapshot.estimatedCostUsd ?? snapshot.costSpent ?? null,
      });
    } catch { /* ignore */ }
  }

  /** Update model id when the bridge resolves which model is in use. */
  updateModel(sessionId: string, modelId: string | undefined | null): void {
    if (!this.store.enabled || !modelId) return;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    try { this.store.updateRun(runId, { modelId }); } catch { /* ignore */ }
  }

  /** Finalize a run. Returns the runId so callers can enqueue evaluation. */
  closeRun(sessionId: string, exitCode?: number, projectPath?: string): string | null {
    if (!this.store.enabled) return null;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return null;
    this.sessionToRun.delete(sessionId);
    const gitAfter = readGitHead(projectPath);
    try {
      this.store.updateRun(runId, {
        endedAt: Date.now(),
        exitCode: exitCode ?? null,
        gitAfter,
      });
      debug('APME', `closeRun ${runId} exit=${exitCode ?? '-'} gitAfter=${gitAfter ?? '-'}`);
    } catch (err) {
      debug('APME', `closeRun failed: ${String(err)}`);
    }
    // Capture hardware profile asynchronously — don't block shutdown.
    if (this.hwSampler) {
      this.hwSampler.snapshot().then((snap) => {
        try { this.store.updateRun(runId, { hwProfile: JSON.stringify(snap) }); }
        catch { /* ignore */ }
      }).catch(() => { /* ignore */ });
    }
    // Save git diff as artifact (best-effort, capped at 1MB).
    this.saveDiffArtifact(runId, projectPath);
    return runId;
  }

  /** Save the git diff produced by this run as an artifact file. */
  private saveDiffArtifact(runId: string, projectPath?: string): void {
    if (!projectPath) return;
    try {
      const run = this.store.getRun(runId);
      if (!run) return;
      const args = run.gitBefore && run.gitAfter && run.gitBefore !== run.gitAfter
        ? `diff ${run.gitBefore}..${run.gitAfter}`
        : 'diff HEAD';
      const diff = execSync(`git ${args}`, {
        cwd: projectPath, encoding: 'utf-8', timeout: 5000,
        maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!diff || diff.length < 10) return;
      const hash = createHash('sha256').update(diff).digest('hex').slice(0, 16);
      const artifactDir = getArtifactDir(runId);
      mkdirSync(artifactDir, { recursive: true });
      const filePath = join(artifactDir, `${hash}.diff`);
      writeFileSync(filePath, diff, 'utf-8');
      this.store.insertArtifact({
        runId, kind: 'diff', path: filePath,
        sha256: createHash('sha256').update(diff).digest('hex'),
        bytes: Buffer.byteLength(diff, 'utf-8'),
      });
    } catch { /* ignore — artifact storage is best-effort */ }
  }

  /** Translate a `SessionEntry` + optional extras into an OpenRunInput. */
  static fromSessionEntry(entry: SessionEntry, extras: { modelId?: string; projectPath?: string } = {}): OpenRunInput {
    return {
      sessionId: entry.id,
      agentType: (entry.agentType ?? 'claude-code') as AgentType,
      modelId: extras.modelId,
      projectName: entry.projectName,
      projectPath: extras.projectPath,
    };
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function readGitHead(cwd?: string): string | null {
  if (!cwd) return null;
  try {
    return execSync('git rev-parse HEAD', {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function getArtifactDir(runId: string): string {
  const dataDir = process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
  return join(dataDir, 'apme', 'artifacts', runId);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '"<unserializable>"';
  }
}
