import { EventEmitter } from 'events';
import {
  State,
  PermissionMode,
  STUCK_TIMEOUT_MS,
  type StateSnapshot,
  type PromptOption,
  type StateTransition,
  transitions,
} from './types.js';
import type { BillingType } from '@agentdeck/shared';
import { UsageTracker } from './usage-tracker.js';
import { debug } from './logger.js';

export class StateMachine extends EventEmitter {
  private state: State = State.DISCONNECTED;
  private permissionMode: PermissionMode = PermissionMode.DEFAULT;
  private currentTool: string | null = null;
  private toolProgress: string | null = null;
  private options: PromptOption[] = [];
  private question: string | null = null;
  private projectName: string | null = null;
  private modelName: string | null = null;
  private billingType: BillingType = 'unknown';
  private usageTracker: UsageTracker;
  private stuckTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(usageTracker: UsageTracker) {
    super();
    this.usageTracker = usageTracker;
  }

  handleHookEvent(eventName: string, data: Record<string, unknown>): void {
    debug('SM', `hookEvent: ${eventName} (current: ${this.state})`);
    switch (eventName) {
      case 'SessionStart':
        this.usageTracker.start();
        this.transition(State.IDLE, 'session_start', 'hook');
        break;

      case 'UserPromptSubmit':
        this.transition(State.PROCESSING, 'user_prompt_submit', 'hook');
        break;

      case 'PreToolUse': {
        const toolName = (data.tool_name as string) || null;
        this.currentTool = toolName;
        this.toolProgress = `Using ${toolName}`;
        this.emitSnapshot();
        break;
      }

      case 'PostToolUse': {
        this.usageTracker.addToolCall(data);
        this.currentTool = null;
        this.toolProgress = null;
        this.emitSnapshot();
        break;
      }

      case 'Stop':
        this.currentTool = null;
        this.toolProgress = null;
        this.options = [];
        this.question = null;
        this.transition(State.IDLE, 'stop', 'hook');
        break;

      case 'SessionEnd':
        this.transition(State.DISCONNECTED, 'session_end', 'hook');
        break;

      case 'Notification': {
        if (typeof data.input_tokens === 'number' && typeof data.output_tokens === 'number') {
          this.usageTracker.addTokens(
            data.input_tokens as number,
            data.output_tokens as number,
          );
        }
        break;
      }

      default:
        break;
    }
  }

  handleParserEvent(eventName: string, data?: Record<string, unknown>): void {
    debug('SM', `parserEvent: ${eventName} (current: ${this.state})`);
    switch (eventName) {
      case 'permission_prompt': {
        this.options = (data?.options as PromptOption[]) || [];
        this.question = (data?.question as string) || null;
        this.transition(State.AWAITING_PERMISSION, 'permission_prompt', 'pty');
        break;
      }

      case 'option_prompt': {
        this.options = (data?.options as PromptOption[]) || [];
        this.transition(State.AWAITING_OPTION, 'option_ui_detected', 'pty');
        break;
      }

      case 'diff_prompt': {
        this.options = (data?.options as PromptOption[]) || [];
        this.transition(State.AWAITING_DIFF, 'diff_ui_detected', 'pty');
        break;
      }

      case 'spinner_start':
        if (this.state !== State.PROCESSING) {
          this.transition(State.PROCESSING, 'spinner_start', 'pty');
        }
        break;

      case 'spinner_stop':
        // Spinner stopped — if we're in an active state, go to IDLE
        if (
          this.state === State.PROCESSING ||
          this.state === State.AWAITING_PERMISSION ||
          this.state === State.AWAITING_OPTION ||
          this.state === State.AWAITING_DIFF
        ) {
          this.currentTool = null;
          this.toolProgress = null;
          this.options = [];
          this.question = null;
          this.transition(State.IDLE, 'idle_detected', 'pty');
        }
        break;

      case 'idle':
        if (
          this.state === State.PROCESSING ||
          this.state === State.AWAITING_PERMISSION ||
          this.state === State.AWAITING_OPTION ||
          this.state === State.AWAITING_DIFF
        ) {
          this.currentTool = null;
          this.toolProgress = null;
          this.options = [];
          this.question = null;
          this.transition(State.IDLE, 'idle_detected', 'pty');
        }
        break;

      case 'mode_change': {
        const mode = data?.mode as string | undefined;
        if (mode === 'plan') {
          this.setPermissionMode(PermissionMode.PLAN);
        } else if (mode === 'acceptEdits') {
          this.setPermissionMode(PermissionMode.ACCEPT_EDITS);
        } else {
          this.setPermissionMode(PermissionMode.DEFAULT);
        }
        break;
      }

      // --- Metadata events (don't change state, update display data) ---
      case 'status_line': {
        // Token/duration from PTY status line: "1m 0s · ↓ 1.9k tokens"
        const durationSec = data?.durationSec as number | undefined;
        const tokens = data?.tokens as number | undefined;
        if (durationSec != null) {
          this.usageTracker.setDuration(durationSec);
        }
        if (tokens != null) {
          this.usageTracker.setOutputTokens(tokens);
        }
        this.emitSnapshot();
        break;
      }

      case 'tool_action': {
        const toolName = data?.toolName as string | undefined;
        if (toolName) {
          this.currentTool = toolName;
          this.toolProgress = `Using ${toolName}`;
          this.usageTracker.incrementToolCalls();
          this.emitSnapshot();
        }
        break;
      }

      case 'project_name': {
        const name = data?.name as string | undefined;
        if (name) {
          this.projectName = name;
          debug('SM', `project: ${name}`);
          this.emitSnapshot();
        }
        break;
      }

      case 'model_info': {
        const model = data?.model as string | undefined;
        const plan = data?.plan as string | undefined;
        if (model) {
          this.modelName = model;
          debug('SM', `model: ${model}`);
        }
        if (plan) {
          if (/max/i.test(plan)) {
            this.billingType = 'subscription';
          } else if (/api/i.test(plan)) {
            this.billingType = 'api';
          }
          debug('SM', `billingType: ${this.billingType} (plan="${plan}")`);
        }
        if (model || plan) {
          this.emitSnapshot();
        }
        break;
      }

      default:
        break;
    }
  }

  handleUserAction(action: string): void {
    switch (action) {
      case 'respond':
        if (
          this.state === State.AWAITING_PERMISSION ||
          this.state === State.AWAITING_DIFF
        ) {
          this.options = [];
          this.question = null;
          this.transition(State.PROCESSING, 'user_response', 'user');
        }
        break;

      case 'select_option':
        if (this.state === State.AWAITING_OPTION) {
          this.options = [];
          this.transition(State.PROCESSING, 'user_selection', 'user');
        }
        break;

      case 'interrupt':
        this.currentTool = null;
        this.toolProgress = null;
        this.options = [];
        this.question = null;
        this.transition(State.IDLE, 'interrupt', 'user');
        break;

      default:
        break;
    }
  }

  transition(to: State, trigger: string, source: string): void {
    const valid = transitions.some(
      (t: StateTransition) =>
        (t.from === this.state || t.from === '*') &&
        t.to === to &&
        t.trigger === trigger,
    );

    if (!valid) {
      debug('SM', `Invalid transition blocked: ${this.state} -> ${to} (trigger: ${trigger}, source: ${source})`);
      return;
    }

    const prev = this.state;
    this.state = to;

    // Manage stuck-state timer for any non-terminal active state
    this.resetStuckTimer();
    if (
      to === State.PROCESSING ||
      to === State.AWAITING_PERMISSION ||
      to === State.AWAITING_OPTION ||
      to === State.AWAITING_DIFF
    ) {
      this.stuckTimer = setTimeout(() => {
        debug('SM', `Stuck timeout: ${to} for >${STUCK_TIMEOUT_MS / 1000}s, recovering to IDLE`);
        this.currentTool = null;
        this.toolProgress = null;
        this.options = [];
        this.question = null;
        this.transition(State.IDLE, 'stuck_timeout', 'internal');
      }, STUCK_TIMEOUT_MS);
    }

    if (prev !== to) {
      debug('SM', `${prev} -> ${to} (trigger: ${trigger}, source: ${source})`);
      this.emitSnapshot();
    }
  }

  private resetStuckTimer(): void {
    if (this.stuckTimer) {
      clearTimeout(this.stuckTimer);
      this.stuckTimer = null;
    }
  }

  private emitSnapshot(): void {
    this.emit('state_changed', this.getSnapshot());
  }

  getSnapshot(): StateSnapshot {
    const usage = this.usageTracker.getSnapshot();
    return {
      state: this.state,
      permissionMode: this.permissionMode,
      currentTool: this.currentTool,
      toolProgress: this.toolProgress,
      options: this.options,
      question: this.question,
      projectName: this.projectName,
      modelName: this.modelName,
      billingType: this.billingType,
      sessionDurationSec: usage.sessionDurationSec,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      toolCalls: usage.toolCalls,
      estimatedCostUsd: usage.estimatedCostUsd,
      sessionPercent: usage.sessionPercent,
      costSpent: usage.costSpent,
      costLimit: usage.costLimit,
      resetTime: usage.resetTime,
      resetDate: usage.resetDate,
    };
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.emitSnapshot();
  }

  getState(): State {
    return this.state;
  }
}
