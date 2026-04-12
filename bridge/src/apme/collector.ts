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
import { classifyRunSmart } from './classifier.js';

export interface OpenRunInput {
  sessionId: string;
  agentType: AgentType;
  modelId?: string;
  projectName?: string;
  projectPath?: string;
  taskPrompt?: string;
}

interface ActiveTurn {
  id: string;
  runId: string;
  index: number;
  startedAt: number;
  toolCalls: number;
  filesModified: number;
  filesCreated: number;
  gitBefore: string | null;
}

export class ApmeCollector {
  private readonly sessionToRun = new Map<string, string>(); // sessionId → runId
  private readonly sessionToTurn = new Map<string, ActiveTurn>(); // sessionId → current turn

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

  /** Record a hook event as a step + manage turn lifecycle. */
  ingestHook(sessionId: string, event: string, data: Record<string, unknown>): void {
    if (!this.store.enabled) return;
    const runId = this.sessionToRun.get(sessionId);
    if (!runId) return;
    const toolName = typeof data.tool_name === 'string' ? data.tool_name : null;

    // ── Turn management ──
    if (event === 'UserPromptSubmit') {
      // Claude Code sends { message: { content: "..." } }, legacy sends { prompt: "..." }
      const rawPrompt = typeof data.prompt === 'string' ? data.prompt
        : (typeof (data as Record<string, unknown>).message === 'object'
          ? ((data as Record<string, unknown>).message as Record<string, unknown>)?.content as string | undefined
          : undefined);
      const prompt = typeof rawPrompt === 'string' ? rawPrompt.slice(0, 8_000) : null;
      // Close previous turn if open
      this.closeTurn(sessionId);
      // Open new turn
      const prevTurn = this.sessionToTurn.get(sessionId);
      const turnIndex = prevTurn ? prevTurn.index + 1 : 0;
      const run = this.store.getRun(runId);
      const projectPath = run?.projectPath ?? undefined;
      const turnId = randomUUID();
      const turn: ActiveTurn = {
        id: turnId, runId, index: turnIndex,
        startedAt: Date.now(), toolCalls: 0,
        filesModified: 0, filesCreated: 0,
        gitBefore: readGitHead(projectPath),
      };
      this.sessionToTurn.set(sessionId, turn);
      try {
        this.store.insertTurn({
          id: turnId, runId, turnIndex, prompt: prompt ?? undefined,
          startedAt: turn.startedAt, gitBefore: turn.gitBefore ?? undefined,
        });
      } catch (err) { debug('APME', `insertTurn failed: ${String(err)}`); }
      // Also set run's task_prompt from first prompt
      try {
        if (run && !run.taskPrompt && prompt) {
          this.store.updateRun(runId, { taskPrompt: prompt });
        }
      } catch { /* ignore */ }
    }

    // Track tool calls on the active turn
    const activeTurn = this.sessionToTurn.get(sessionId);
    if (activeTurn && (event === 'PreToolUse' || event === 'tool_start')) {
      activeTurn.toolCalls++;
      if (toolName === 'Edit') activeTurn.filesModified++;
      if (toolName === 'Write') activeTurn.filesCreated++;
    }

    // Record step
    try {
      this.store.insertStep({
        runId, ts: Date.now(), kind: event,
        toolName, payload: safeStringify(data),
      });
    } catch (err) {
      debug('APME', `ingestHook failed: ${String(err)}`);
    }
  }

  /** Close the current turn for a session (called on new prompt or session end). */
  private closeTurn(sessionId: string): void {
    const turn = this.sessionToTurn.get(sessionId);
    if (!turn) return;
    this.sessionToTurn.delete(sessionId);
    const run = this.store.getRun(turn.runId);
    const projectPath = run?.projectPath ?? undefined;
    const gitAfter = readGitHead(projectPath);
    try {
      this.store.updateTurn(turn.id, {
        endedAt: Date.now(),
        toolCalls: turn.toolCalls,
        filesModified: turn.filesModified,
        filesCreated: turn.filesCreated,
        gitAfter,
      });
      debug('APME', `closeTurn ${turn.id.slice(0, 8)} index=${turn.index} tools=${turn.toolCalls}`);
    } catch (err) {
      debug('APME', `closeTurn failed: ${String(err)}`);
    }
  }

  /** Get the current active turn ID for a session (if any). */
  getActiveTurnId(sessionId: string): string | null {
    return this.sessionToTurn.get(sessionId)?.id ?? null;
  }

  /** Store Claude's response text on the current turn. */
  setTurnResponse(sessionId: string, response: string): void {
    if (!this.store.enabled) return;
    const turn = this.sessionToTurn.get(sessionId);
    if (!turn) return;
    try {
      this.store.updateTurn(turn.id, { response: response.slice(0, 10_000) });
    } catch { /* ignore */ }
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
    // Close the last open turn before finalizing the run.
    this.closeTurn(sessionId);
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
    // Classify the run — rule-based first, LLM fallback if unknown.
    // Fire-and-forget since classifyRunSmart is async (LLM call).
    void classifyRunSmart(this.store, runId).then(({ signals, category, source }) => {
      this.store.updateRun(runId, {
        taskSignals: JSON.stringify(signals),
        taskCategory: category,
        taskCategorySource: source,
      });
      debug('APME', `classified ${runId} as ${category} (${source})`);
    }).catch((err) => {
      debug('APME', `classify failed: ${String(err)}`);
    });
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
