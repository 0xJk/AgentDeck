/**
 * APME Evaluation Runner — two-layer pipeline executed after a run closes.
 *
 * Layer 1 (deterministic): detect project language from the run's projectPath,
 * run lint/build/test in-place with a hard timeout, normalize each outcome to
 * 0/1 in `evals` (metrics: lint_clean, build_ok, tests_pass).
 *
 * Layer 2 (llm_judge): G-Eval style rubric against the latest `rubrics` row.
 * Backend is pluggable — default is local MLX (cost-free), API/OpenClaw are
 * opt-in via `~/.agentdeck/settings.json`. Gated by `shouldJudge()` so the
 * common "clear pass" case skips layer 2 entirely.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { debug } from '../logger.js';
import type { ApmeStore } from './store.js';
import type { ApmeConfig, ApmeJudgeConfig } from './settings.js';
import { loadApmeConfig, shouldJudge } from './settings.js';
import { loadMlxSettings, mlxChatUrl } from '@agentdeck/shared';
import type { ApmeRunRow } from './types.js';
import { execSync } from 'child_process';

export interface EvalJob {
  runId: string;
  /** Optional project path override; falls back to the run row. */
  projectPath?: string;
}

export interface EvalJobResult {
  runId: string;
  turnId?: string;   // set for turn-level evals
  taskId?: string;   // set for task-level evals
  layer1Ran: boolean;
  layer2Ran: boolean;
  overall?: number;
}

type Lang = 'typescript' | 'swift' | 'kotlin';

interface DetStepResult {
  metric: 'lint_clean' | 'build_ok' | 'tests_pass';
  score: 0 | 1;
  exitCode: number;
  durationMs: number;
  outputTail: string;
  command: string;
}

const DEFAULT_COMMANDS: Record<Lang, { lint?: string; build?: string; test?: string | ((cwd: string) => string | null) }> = {
  typescript: {
    lint: 'pnpm -w lint',
    build: 'pnpm -r build',
    test: 'pnpm -w test',
  },
  swift: {
    test: (cwd: string) => {
      // Auto-detect scheme from the project — don't hardcode "AgentDeck".
      const scheme = detectSwiftScheme(cwd);
      return scheme ? `xcodebuild test -scheme ${scheme} -quiet` : null;
    },
  },
  kotlin: {
    test: './gradlew testDebugUnitTest',
  },
};

// ─── Runner ────────────────────────────────────────────────────────────────────

export class ApmeRunner {
  private queue: EvalJob[] = [];
  private drainPromise: Promise<void> | null = null;
  private readonly listeners = new Set<(r: EvalJobResult) => void>();
  private configOverride: ApmeConfig | null = null;
  private judgeOverride: ((prompt: string, judgeCfg: ApmeJudgeConfig) => Promise<string>) | null = null;
  private detOverride: ((runRow: ApmeRunRow, cfg: ApmeConfig) => Promise<DetStepResult[]>) | null = null;

  constructor(private readonly store: ApmeStore) {}

  _setConfig(cfg: ApmeConfig): void { this.configOverride = cfg; }
  _setJudgeFn(fn: ((prompt: string, judgeCfg: ApmeJudgeConfig) => Promise<string>) | null): void {
    this.judgeOverride = fn;
  }
  _setDeterministicFn(fn: ((runRow: ApmeRunRow, cfg: ApmeConfig) => Promise<DetStepResult[]>) | null): void {
    this.detOverride = fn;
  }

  onResult(fn: (r: EvalJobResult) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  enqueue(job: EvalJob): void {
    if (!this.store.enabled) return;
    this.queue.push(job);
    debug('APME', `enqueue eval runId=${job.runId} (queue=${this.queue.length})`);
    void this.drain();
  }

  /** Immediately judge a single completed turn (mid-session eval).
   *  Used for non-code categories where turn prompt+response is the eval unit.
   *  Fires-and-forgets; result is stored and notified via onResult listeners. */
  enqueueTurn(job: { runId: string; turnId: string; category?: string }): void {
    if (!this.store.enabled) return;
    void this.runTurnEval(job);
  }

  /** Judge a closed task (group of turns between boundary signals —
   *  TodoWrite all-completed, /clear, session_end). Fires-and-forgets;
   *  task-level summary and axis scores are persisted in tasks + evals. */
  enqueueTask(job: { runId: string; taskId: string; category?: string; boundarySignal?: string }): void {
    if (!this.store.enabled) return;
    void this.runTaskEval(job);
  }

  private async runTaskEval({ runId, taskId, category, boundarySignal }: { runId: string; taskId: string; category?: string; boundarySignal?: string }): Promise<void> {
    const cfg = this.configOverride ?? loadApmeConfig();
    if (!cfg.enabled) return;

    const task = this.store.getTask(taskId);
    if (!task) return;
    const turns = this.store.listTurnsForTask(taskId);
    if (turns.length === 0) return;

    // Skip tasks whose turns carry no meaningful text — all tool_only/empty.
    const anyText = turns.some((t) => {
      const kind = readResponseKind(t);
      if (kind === 'text') return true;
      const prompt = typeof t.prompt === 'string' ? t.prompt.trim() : '';
      return prompt.length > 0;
    });
    if (!anyText) {
      debug('APME', `runTaskEval skip task=${taskId.slice(0, 8)} — no text`);
      return;
    }

    // Select rubric: task_rollup preferred, fall back to category, then general.
    const rubric = this.store.getCurrentRubric('task_rollup')
      ?? (category ? this.store.getCurrentRubric(category) : null)
      ?? this.store.getCurrentRubric('general');
    if (!rubric) return;

    const TURN_CAP = 10;
    const clipped = turns.slice(0, TURN_CAP);
    const lines: string[] = [];
    for (const t of clipped) {
      const idx = t.turn_index as number;
      const prompt = ((t.prompt as string | null) ?? '').slice(0, 1500);
      const response = ((t.response as string | null) ?? '').slice(0, 2500);
      lines.push(`[Turn ${idx}] User: ${prompt || '(empty)'}`);
      if (response) lines.push(`Agent: ${response}`);
    }
    if (turns.length > TURN_CAP) {
      lines.push(`… (${turns.length - TURN_CAP} more turns omitted)`);
    }

    const judgePrompt = [
      rubric.prompt,
      '',
      '--- TASK CONTEXT ---',
      `task_category: ${category ?? task.taskCategory ?? 'unknown'}`,
      `turn_count: ${turns.length}`,
      `boundary_signal: ${boundarySignal ?? task.boundarySignal}`,
      '',
      '--- TURNS ---',
      ...lines,
      '',
      'Respond with strict JSON only.',
    ].join('\n');

    try {
      const judgeText = this.judgeOverride
        ? await this.judgeOverride(judgePrompt, cfg.judge)
        : await callJudge(judgePrompt, cfg.judge);
      const parsed = parseJudgeJson(judgeText);
      if (!parsed) {
        debug('APME', `runTaskEval parse failed task=${taskId.slice(0, 8)}`);
        return;
      }

      const now = Date.now();
      const judgeModel = effectiveJudgeModelTag(cfg.judge);
      for (const [axis, score] of Object.entries(parsed.scores)) {
        this.store.insertEvalForTask({
          id: 0,
          runId, taskId,
          layer: 'task_judge',
          metric: axis,
          score,
          raw: axis === 'overall'
            ? JSON.stringify({
                summary: parsed.summary,
                reasoning: parsed.reasoning,
                done: parsed.done,
                missed: parsed.missed,
              })
            : null,
          rubricVer: rubric.version,
          judgeModel,
          createdAt: now,
        });
      }

      this.store.updateTask(taskId, {
        summary: parsed.summary ?? null,
        compositeScore: parsed.scores.overall ?? null,
        notesJson: JSON.stringify({
          reasoning: parsed.reasoning,
          done: parsed.done,
          missed: parsed.missed,
        }),
      });

      debug('APME', `task eval ${taskId.slice(0, 8)}: overall=${parsed.scores.overall} summary=${parsed.summary?.slice(0, 40) ?? '-'}`);
      for (const fn of this.listeners) {
        try { fn({ runId, taskId, layer1Ran: false, layer2Ran: true, overall: parsed.scores.overall }); }
        catch { /* ignore */ }
      }
    } catch (err) {
      debug('APME', `task eval error taskId=${taskId.slice(0, 8)}: ${String(err)}`);
    }
  }

  private async runTurnEval({ runId, turnId, category }: { runId: string; turnId: string; category?: string }): Promise<void> {
    const cfg = this.configOverride ?? loadApmeConfig();
    if (!cfg.enabled) return;

    const turn = this.store.getTurn(turnId);
    if (!turn) return;
    const prompt = (turn.prompt as string | null) ?? '';
    const response = (turn.response as string | null) ?? '';
    if (!prompt && !response) return; // nothing to judge
    // Skip turns the agent answered with tool calls only (or not at all) —
    // the rubric prompt can't score "silence" meaningfully and doing so
    // generates noise scores. `tool_only` / `empty` tags are set by the
    // collector in turns.efficiency_json.
    const kind = readResponseKind(turn);
    if (kind === 'tool_only' || kind === 'empty') {
      debug('APME', `runTurnEval skip turn=${turnId.slice(0,8)} kind=${kind}`);
      return;
    }

    // Select rubric by category (conversation/planning/research/review)
    const rubric = (category ? this.store.getCurrentRubric(category) : null)
      ?? this.store.getCurrentRubric('conversation'); // sensible fallback
    if (!rubric) return;

    const judgePrompt = [
      rubric.prompt,
      '',
      '--- TURN CONTEXT ---',
      `task_category: ${category ?? 'conversation'}`,
      '',
      '--- USER PROMPT ---',
      prompt.slice(0, 2000) || '(not captured)',
      '',
      '--- AGENT RESPONSE ---',
      response.slice(0, 4000) || '(not captured)',
      '',
      'Respond with strict JSON only.',
    ].join('\n');

    try {
      const judgeText = this.judgeOverride
        ? await this.judgeOverride(judgePrompt, cfg.judge)
        : await callJudge(judgePrompt, cfg.judge);
      const parsed = parseJudgeJson(judgeText);
      if (!parsed) return;

      const now = Date.now();
      const judgeModel = effectiveJudgeModelTag(cfg.judge);
      for (const [axis, score] of Object.entries(parsed.scores)) {
        this.store.insertEvalForTurn({
          runId, turnId,
          id: 0, // autoincrement
          layer: 'turn_judge',
          metric: axis,
          score,
          raw: axis === 'overall'
            ? JSON.stringify({ reasoning: parsed.reasoning, done: parsed.done, missed: parsed.missed })
            : null,
          rubricVer: rubric.version,
          judgeModel,
          createdAt: now,
        });
      }
      debug('APME', `turn eval ${turnId.slice(0, 8)}: overall=${parsed.scores.overall}`);
      // Notify listeners with turnId so daemon can broadcast turn eval
      for (const fn of this.listeners) {
        fn({ runId, turnId, layer1Ran: false, layer2Ran: true, overall: parsed.scores.overall });
      }
    } catch (err) {
      debug('APME', `turn eval error turnId=${turnId.slice(0, 8)}: ${String(err)}`);
    }
  }

  /** Runs the queue until empty. Awaitable — callers can join the current drain. */
  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.doDrain();
    try { await this.drainPromise; }
    finally { this.drainPromise = null; }
  }

  private async doDrain(): Promise<void> {
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        const result = await this.runOne(job);
        for (const fn of this.listeners) {
          try { fn(result); } catch { /* ignore */ }
        }
      } catch (err) {
        debug('APME', `runner error runId=${job.runId}: ${String(err)}`);
      }
    }
  }

  private async runOne(job: EvalJob): Promise<EvalJobResult> {
    const cfg = this.configOverride ?? loadApmeConfig();
    const run = this.store.getRun(job.runId);
    if (!run) {
      debug('APME', `runOne: run ${job.runId} not found`);
      return { runId: job.runId, layer1Ran: false, layer2Ran: false };
    }

    // ── Layer 1 — deterministic ───────────────────────────────────────────────
    let layer1Ran = false;
    let layer1Passed: boolean | null = null;
    if (cfg.deterministic.enabled) {
      try {
        const results = this.detOverride
          ? await this.detOverride(run, cfg)
          : await runDeterministic(run, cfg);
        for (const r of results) {
          this.store.insertEval({
            runId: run.id,
            layer: 'deterministic',
            metric: r.metric,
            score: r.score,
            raw: JSON.stringify({
              command: r.command,
              exitCode: r.exitCode,
              durationMs: r.durationMs,
              outputTail: r.outputTail,
            }),
            createdAt: Date.now(),
          });
        }
        if (results.length > 0) {
          layer1Ran = true;
          // Aggregate: pass only if every step passed.
          layer1Passed = results.every((r) => r.score === 1);
        }
        debug('APME', `runOne layer1 runId=${run.id} results=${results.length} passed=${layer1Passed}`);
      } catch (err) {
        debug('APME', `layer1 error runId=${run.id}: ${String(err)}`);
      }
    }

    // ── Layer 2 — llm_judge (gated) ───────────────────────────────────────────
    let layer2Ran = false;
    let overall: number | undefined;
    if (cfg.enabled && shouldJudge(cfg.judge, layer1Passed)) {
      // Select category-specific rubric, fall back to 'general'
      const rubric = (run.taskCategory ? this.store.getCurrentRubric(run.taskCategory) : null)
        ?? this.store.getCurrentRubric('general');
      if (rubric) {
        try {
          const prompt = buildJudgePrompt(run, rubric.prompt, layer1Passed, this.store);
          const judgeText = this.judgeOverride
            ? await this.judgeOverride(prompt, cfg.judge)
            : await callJudge(prompt, cfg.judge);
          const parsed = parseJudgeJson(judgeText);
          if (parsed) {
            const now = Date.now();
            const judgeModel = effectiveJudgeModelTag(cfg.judge);
            for (const [axis, score] of Object.entries(parsed.scores)) {
              this.store.insertEval({
                runId: run.id,
                layer: 'llm_judge',
                metric: axis,
                score,
                raw: axis === 'overall' ? JSON.stringify({ reasoning: parsed.reasoning, done: parsed.done, missed: parsed.missed }) : null,
                rubricVer: rubric.version,
                judgeModel,
                createdAt: now,
              });
            }
            overall = parsed.scores.overall;
            layer2Ran = true;
            // Re-compute composite score with judge contribution
            try {
              const { recomputeComposite } = await import('./outcome.js');
              recomputeComposite(this.store, run.id);
            } catch { /* ignore — outcome may not have run yet */ }
          } else {
            debug('APME', `judge response unparseable runId=${run.id}`);
          }
        } catch (err) {
          // Per cost-sensitive-defaults memory: never silently fall back from MLX to API.
          debug('APME', `layer2 error runId=${run.id} (skipping, no fallback): ${String(err)}`);
        }
      }
    }

    return { runId: job.runId, layer1Ran, layer2Ran, overall };
  }
}

// ─── Language detection ───────────────────────────────────────────────────────

/** Auto-detect the first testable Xcode scheme from a project directory. */
function detectSwiftScheme(cwd: string): string | null {
  try {
    const out = execSync('xcodebuild -list -json', {
      cwd, encoding: 'utf-8', timeout: 10_000,
      maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const json = JSON.parse(out) as { project?: { schemes?: string[] } };
    const schemes = json.project?.schemes;
    if (!schemes || schemes.length === 0) return null;
    // Prefer schemes with "Test" or matching directory name.
    const dirName = cwd.split('/').pop() ?? '';
    const testScheme = schemes.find((s) => s.toLowerCase().includes('test'));
    const matchScheme = schemes.find((s) => dirName.toLowerCase().includes(s.toLowerCase().replace(/_/g, '')));
    return matchScheme ?? testScheme ?? schemes[0];
  } catch {
    return null;
  }
}

export function detectLanguage(projectPath: string | null | undefined): Lang | null {
  if (!projectPath || !existsSync(projectPath)) return null;
  try {
    const entries = readdirSync(projectPath);
    if (entries.includes('package.json') || entries.some((e) => e.endsWith('.ts') || e.endsWith('.tsx'))) {
      return 'typescript';
    }
    if (entries.some((e) => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'))) {
      return 'swift';
    }
    if (entries.includes('build.gradle') || entries.includes('build.gradle.kts') || entries.includes('settings.gradle.kts')) {
      return 'kotlin';
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Layer 1 execution ────────────────────────────────────────────────────────

export async function runDeterministic(run: ApmeRunRow, cfg: ApmeConfig): Promise<DetStepResult[]> {
  const cwd = run.projectPath;
  if (!cwd) return [];
  const lang = detectLanguage(cwd);
  if (!lang) return [];

  // Only run deterministic checks when there are actual changes from this run.
  // If gitBefore == gitAfter and no uncommitted diff, the agent didn't produce
  // code — running tests gives stale baseline data, so skip.
  if (!hasChanges(run)) {
    debug('APME', `runDeterministic skipped runId=${run.id} — no git diff`);
    return [];
  }

  const override = cfg.deterministic.commands[lang] ?? {};
  const defaults = DEFAULT_COMMANDS[lang];
  const rawSteps: Array<{ metric: DetStepResult['metric']; cmd: string | ((cwd: string) => string | null) | undefined }> = [
    { metric: 'lint_clean', cmd: override.lint ?? defaults.lint },
    { metric: 'build_ok',   cmd: override.build ?? defaults.build },
    { metric: 'tests_pass', cmd: override.test  ?? defaults.test },
  ];

  const results: DetStepResult[] = [];
  for (const s of rawSteps) {
    // Resolve command: may be a string or a function(cwd) → string|null.
    const command = typeof s.cmd === 'function' ? s.cmd(cwd) : s.cmd;
    if (!command) continue;
    const r = await runCommand(command, cwd, cfg.deterministic.timeoutSec * 1000);
    results.push({
      metric: s.metric,
      command,
      score: r.exitCode === 0 ? 1 : 0,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      outputTail: r.outputTail,
    });
  }
  return results;
}

function hasChanges(run: ApmeRunRow): boolean {
  if (!run.projectPath) return false;
  if (run.gitBefore && run.gitAfter && run.gitBefore !== run.gitAfter) return true;
  // Check uncommitted diff (dirty worktree).
  try {
    const status = execSync('git status --porcelain', {
      cwd: run.projectPath, encoding: 'utf-8', timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return status.trim().length > 0;
  } catch {
    // Not a git repo — assume changes exist so we don't silently skip everything.
    return true;
  }
}

interface CmdResult { exitCode: number; durationMs: number; outputTail: string }

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: { ...process.env, CI: '1', APME_EVAL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let done = false;
    const cap = 32 * 1024; // keep last 32KB
    const onData = (buf: Buffer) => {
      chunks.push(buf);
      let total = chunks.reduce((n, b) => n + b.length, 0);
      while (total > cap * 2 && chunks.length > 1) {
        const head = chunks.shift()!;
        total -= head.length;
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const combined = Buffer.concat(chunks).toString('utf-8');
      const tail = combined.length > cap ? combined.slice(combined.length - cap) : combined;
      resolve({
        exitCode: typeof code === 'number' ? code : (signal ? 137 : 1),
        durationMs: Date.now() - start,
        outputTail: tail,
      });
    });
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: 127, durationMs: Date.now() - start, outputTail: `spawn failed: ${command}` });
    });
  });
}

// ─── Layer 2 execution ────────────────────────────────────────────────────────

interface ParsedJudge {
  scores: Record<string, number>;
  reasoning: string;
  done?: string[];    // items the agent completed
  missed?: string[];  // items the agent missed
  summary?: string;   // task-level one-line summary (task_rollup rubric)
}

const NON_CODE_CATEGORIES = new Set(['conversation', 'planning', 'research', 'review']);

export function buildJudgePrompt(
  run: ApmeRunRow, rubricPrompt: string, layer1Passed: boolean | null,
  store?: import('./store.js').ApmeStore,
): string {
  const task = (run.taskPrompt ?? '').slice(0, 4_000);
  const det = layer1Passed === null ? 'unknown' : layer1Passed ? 'passed' : 'failed';
  const isNonCode = run.taskCategory && NON_CODE_CATEGORIES.has(run.taskCategory);

  const sections: string[] = [
    rubricPrompt,
    '',
    '--- RUN CONTEXT ---',
    `agent_type: ${run.agentType}`,
    `model: ${run.modelId ?? 'unknown'}`,
    `project: ${run.projectName ?? 'unknown'}`,
    `task_category: ${run.taskCategory ?? 'unknown'}`,
    `deterministic_checks: ${det}`,
    '',
    '--- TASK PROMPT ---',
    task || '(not captured)',
  ];

  if (isNonCode && store) {
    // Non-code categories: include turns (prompt + response) instead of diff
    const turns = store.listTurns(run.id);
    sections.push('', '--- CONVERSATION ---');
    for (const t of turns.slice(0, 10)) {
      const prompt = ((t.prompt as string) ?? '').slice(0, 2000);
      const response = ((t.response as string) ?? '').slice(0, 3000);
      sections.push(`[Turn ${t.turn_index}] User: ${prompt}`);
      if (response) sections.push(`Agent: ${response}`);
    }
  } else {
    // Code categories: include git diff
    const diff = collectDiff(run);
    sections.push('', '--- DIFF (truncated) ---', diff || '(no diff captured)');
  }

  sections.push('', 'Respond with strict JSON only.');
  return sections.join('\n');
}

/** Response classification stored by ApmeCollector under turns.efficiency_json.response_kind.
 *  Drives which turns make it to the LLM judge — `tool_only` / `empty` are silence
 *  to the judge and produce noise scores. Fallback is 'text' when the tag is missing
 *  (older rows) but response content is non-trivial. */
export type ResponseKind = 'text' | 'tool_only' | 'empty';

export function readResponseKind(turn: Record<string, unknown>): ResponseKind {
  const raw = turn.efficiency_json;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as { response_kind?: unknown };
      const k = parsed.response_kind;
      if (k === 'text' || k === 'tool_only' || k === 'empty') return k;
    } catch { /* fall through */ }
  }
  const response = typeof turn.response === 'string' ? turn.response.trim() : '';
  const toolCalls = typeof turn.tool_calls === 'number' ? turn.tool_calls : 0;
  if (response.length >= 1) return 'text';
  return toolCalls > 0 ? 'tool_only' : 'empty';
}

function collectDiff(run: ApmeRunRow): string {
  if (!run.projectPath) return '';
  try {
    const args = run.gitBefore && run.gitAfter && run.gitBefore !== run.gitAfter
      ? ['diff', '--unified=2', `${run.gitBefore}..${run.gitAfter}`]
      : ['diff', '--unified=2', 'HEAD'];
    const out = execSync(`git ${args.join(' ')}`, {
      cwd: run.projectPath, encoding: 'utf-8', timeout: 4000,
      maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.length > 12_000 ? out.slice(0, 12_000) + '\n...[truncated]' : out;
  } catch {
    return '';
  }
}

/**
 * Build the `judgeModel` DB tag. For MLX backend the effective model is the
 * llm.mlx pin when set — otherwise cfg.judge.model (may still be the legacy
 * "qwen3-30b" placeholder). Non-MLX backends use cfg.judge.model verbatim.
 */
export function effectiveJudgeModelTag(cfg: ApmeJudgeConfig): string {
  if (cfg.backend === 'mlx') {
    const pinned = loadMlxSettings().model;
    return `mlx:${pinned ?? cfg.model}`;
  }
  // Must stay byte-identical with Swift's `ApmeJudgeFoundationModels.judgeModelLabel`
  // so analytics queries aggregate FM evals across the Node and Swift stacks.
  if (cfg.backend === 'foundationModels') return 'foundationModels:apple-intelligence';
  return `${cfg.backend}:${cfg.model}`;
}

export async function callJudge(prompt: string, judgeCfg: ApmeJudgeConfig): Promise<string> {
  if (judgeCfg.backend === 'mlx') return callMlx(prompt, judgeCfg);
  if (judgeCfg.backend === 'openclaw') return callOpenClaw(prompt, judgeCfg);
  if (judgeCfg.backend === 'api') return callApi(prompt, judgeCfg);
  if (judgeCfg.backend === 'foundationModels') {
    try {
      return await callFoundationModels(prompt, judgeCfg);
    } catch (err) {
      // Cost-sensitive default: do not silently route to a network backend.
      // Only retry via MLX when the user explicitly opts in — otherwise
      // propagate the error so the runner's try/catch skips this eval.
      if (judgeCfg.fallbackToMlx) {
        debug('APME', `foundationModels unavailable, fallback to MLX: ${String(err)}`);
        return callMlx(prompt, judgeCfg);
      }
      throw err;
    }
  }
  throw new Error(`unknown judge backend: ${String(judgeCfg.backend)}`);
}

async function callMlx(prompt: string, cfg: ApmeJudgeConfig): Promise<string> {
  // MLX server speaks OpenAI chat-completions. The llm.mlx pin (shared with
  // timeline/label summarizers) is the source of truth; cfg.endpoint/model
  // override only when the user explicitly set apme.judge.* in settings.json.
  const mlx = loadMlxSettings();
  const url = cfg.endpoint ?? mlxChatUrl();
  // Pin > cfg.model > probe auto-detect > cfg.model (final fallback).
  let model = mlx.model ?? cfg.model;
  if (!model || model === 'qwen3-30b') {
    try {
      const base = (cfg.endpoint ?? mlx.endpoint).replace(/\/chat\/completions$/, '').replace(/\/v1\/chat\/completions$/, '');
      for (const path of ['/v1/models', '/models']) {
        const mResp = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (mResp?.ok) {
          const mJson = await mResp.json() as { data?: Array<{ id?: string }> };
          const first = mJson.data?.find(m => m.id && !m.id.toLowerCase().includes('nanollava'))?.id;
          if (first) { model = first; break; }
        }
      }
    } catch { /* use configured model */ }
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are an exacting code evaluator. Reply with strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.0,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`MLX judge HTTP ${resp.status}`);
  const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('MLX judge returned empty content');
  }
  return text;
}

async function callOpenClaw(prompt: string, cfg: ApmeJudgeConfig): Promise<string> {
  // OpenClaw Gateway exposes the user's configured models. Route through it
  // when the user wants to reuse their existing subscription models for judge.
  const url = cfg.endpoint ?? 'http://127.0.0.1:18789/chat';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, prompt, temperature: 0, max_tokens: 800 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`OpenClaw judge HTTP ${resp.status}`);
  const json = await resp.json() as { text?: string };
  if (typeof json.text !== 'string') throw new Error('OpenClaw judge missing text');
  return json.text;
}

/**
 * Route a judge call to the Swift daemon's Foundation Models adapter.
 *
 * The actual on-device LLMSession lives in
 * `apple/AgentDeck/Daemon/Apme/ApmeJudgeFoundationModels.swift`; this TS path
 * just forwards the prompt. Available only when a Swift in-process daemon is
 * running on the same machine (App Store macOS build). Node-only setups don't
 * ship Foundation Models — callers should either opt into `fallbackToMlx` or
 * accept the resulting eval skip.
 *
 * Shape contract:
 *   Request  : POST /apme/judge/foundation-models { prompt: string }
 *   Response : { text: string } | { error: "unavailable", reason: string }
 */
async function callFoundationModels(prompt: string, cfg: ApmeJudgeConfig): Promise<string> {
  const url = cfg.endpoint ?? await resolveFoundationModelsUrl();
  if (!url) throw new Error('foundationModels: no Swift daemon found — FM is only available in App Store macOS builds');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`foundationModels HTTP ${resp.status}`);
  const json = await resp.json() as { text?: string; error?: string; reason?: string };
  if (json.error) {
    throw new Error(`foundationModels ${json.error}: ${json.reason ?? 'no reason'}`);
  }
  if (typeof json.text !== 'string' || json.text.length === 0) {
    throw new Error('foundationModels returned empty text');
  }
  return json.text;
}

/** Best-effort resolver for the Swift daemon's FM endpoint. Returns null when
 *  no Swift daemon (httpPort ≠ port) is reachable. */
async function resolveFoundationModelsUrl(): Promise<string | null> {
  // Lazy-require to avoid pulling session-registry into every test bundle
  // that imports runner.ts for its pure helpers.
  const { findDaemonPortAsync } = await import('../session-registry.js');
  const info = await findDaemonPortAsync();
  if (!info) return null;
  const port = info.httpPort ?? info.port;
  return `http://127.0.0.1:${port}/apme/judge/foundation-models`;
}

async function callApi(_prompt: string, _cfg: ApmeJudgeConfig): Promise<string> {
  // Anthropic API — opt-in only. Requires ANTHROPIC_API_KEY and the @anthropic-ai/sdk
  // package, neither of which we depend on by default. Surface a clear error so
  // users understand they enabled API mode but didn't wire credentials.
  throw new Error(
    'APME judge backend "api" requires explicit setup: install @anthropic-ai/sdk and set ANTHROPIC_API_KEY. ' +
    'Phase 2 ships with MLX (local, free) by default.',
  );
}

export function parseJudgeJson(text: string): ParsedJudge | null {
  // Models often wrap JSON in prose or code fences — grab the first {...} block.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(match[0]); }
  catch { return null; }

  // Accept any numeric axis — category-specific rubrics define their own
  // (conversation: accuracy/helpfulness/conciseness; research: thoroughness/…;
  // planning: completeness/feasibility/clarity; etc.) A hardcoded whitelist
  // silently drops those, leaving only `overall` on turn_judge rows.
  const scores: Record<string, number> = {};
  const RESERVED = new Set(['reasoning', 'done', 'missed', 'notes', 'summary']);
  for (const [axis, v] of Object.entries(obj)) {
    if (RESERVED.has(axis)) continue;
    if (typeof v === 'number' && isFinite(v)) {
      scores[axis] = clamp01(v);
    }
  }
  // Must at least have overall to be useful.
  if (scores.overall === undefined) return null;
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
  const done = Array.isArray(obj.done) ? (obj.done as unknown[]).filter((s): s is string => typeof s === 'string') : undefined;
  const missed = Array.isArray(obj.missed) ? (obj.missed as unknown[]).filter((s): s is string => typeof s === 'string') : undefined;
  // `summary` is produced by the task_rollup rubric; one-line past-tense sentence.
  // Clip defensively so a runaway model can't blow up the tasks.summary column.
  const summary = typeof obj.summary === 'string' && obj.summary.trim().length > 0
    ? obj.summary.trim().slice(0, 280)
    : undefined;
  return { scores, reasoning, done, missed, summary };
}

function clamp01(n: number): number {
  if (n > 1 && n <= 10) n = n / 10; // accept 0-10 scale and rescale
  if (n > 1) n = 1;
  if (n < 0) n = 0;
  return n;
}
