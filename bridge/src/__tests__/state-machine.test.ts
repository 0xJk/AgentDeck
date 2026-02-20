import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateMachine } from '../state-machine.js';
import { UsageTracker } from '../usage-tracker.js';
import { State, PermissionMode } from '../types.js';

function createSM() {
  const tracker = new UsageTracker();
  const sm = new StateMachine(tracker);
  return sm;
}

/** Boot state machine to IDLE (simulating session start) */
function bootToIdle() {
  const sm = createSM();
  sm.handleHookEvent('SessionStart', {});
  expect(sm.getState()).toBe(State.IDLE);
  return sm;
}

describe('StateMachine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // === Basic Transitions ===

  describe('basic transitions', () => {
    it('starts in DISCONNECTED', () => {
      const sm = createSM();
      expect(sm.getState()).toBe(State.DISCONNECTED);
    });

    it('SessionStart → IDLE', () => {
      const sm = createSM();
      sm.handleHookEvent('SessionStart', {});
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('UserPromptSubmit → PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      expect(sm.getState()).toBe(State.PROCESSING);
    });

    it('Stop → IDLE from PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleHookEvent('Stop', {});
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('SessionEnd → DISCONNECTED from any state', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleHookEvent('SessionEnd', {});
      expect(sm.getState()).toBe(State.DISCONNECTED);
    });
  });

  // === Permission Flow ===

  describe('permission flow', () => {
    it('permission_prompt → AWAITING_PERMISSION', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }],
        question: 'Allow?',
      });
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);
    });

    it('user respond → PROCESSING from AWAITING_PERMISSION', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      sm.handleUserAction('respond');
      expect(sm.getState()).toBe(State.PROCESSING);
    });
  });

  // === Option Flow ===

  describe('option flow', () => {
    it('option_prompt → AWAITING_OPTION', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_OPTION);
    });

    it('select_option → PROCESSING from AWAITING_OPTION', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }],
      });
      sm.handleUserAction('select_option');
      expect(sm.getState()).toBe(State.PROCESSING);
    });
  });

  // === Diff Flow ===

  describe('diff flow', () => {
    it('diff_prompt → AWAITING_DIFF', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('diff_prompt', {
        options: [{ index: 0, label: 'Accept' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_DIFF);
    });

    it('respond → PROCESSING from AWAITING_DIFF', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('diff_prompt', {
        options: [{ index: 0, label: 'Accept' }],
      });
      sm.handleUserAction('respond');
      expect(sm.getState()).toBe(State.PROCESSING);
    });
  });

  // === Interrupt ===

  describe('interrupt', () => {
    it('interrupt → IDLE from PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleUserAction('interrupt');
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('interrupt → IDLE from AWAITING_PERMISSION', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      sm.handleUserAction('interrupt');
      expect(sm.getState()).toBe(State.IDLE);
    });
  });

  // === Strict Transition Validation ===

  describe('strict transitions', () => {
    it('blocks invalid transition: IDLE → AWAITING_PERMISSION', () => {
      const sm = bootToIdle();
      // permission_prompt while IDLE (not PROCESSING) — should be blocked
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('blocks invalid transition: DISCONNECTED → PROCESSING', () => {
      const sm = createSM();
      sm.handleHookEvent('UserPromptSubmit', {});
      expect(sm.getState()).toBe(State.DISCONNECTED);
    });

    it('allows wildcard session_end from any state', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);
      sm.handleHookEvent('SessionEnd', {});
      expect(sm.getState()).toBe(State.DISCONNECTED);
    });
  });

  // === Stuck Timeout ===

  describe('stuck timeout', () => {
    it('PROCESSING for >5min → auto-recovery to IDLE', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      expect(sm.getState()).toBe(State.PROCESSING);

      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('AWAITING_PERMISSION for >5min → auto-recovery to IDLE', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('permission_prompt', {
        options: [{ index: 0, label: 'Yes' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_PERMISSION);

      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('AWAITING_OPTION for >5min → auto-recovery to IDLE', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('option_prompt', {
        options: [{ index: 0, label: 'A' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_OPTION);

      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('AWAITING_DIFF for >5min → auto-recovery to IDLE', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('diff_prompt', {
        options: [{ index: 0, label: 'Accept' }],
      });
      expect(sm.getState()).toBe(State.AWAITING_DIFF);

      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('timer resets on state change before timeout', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      expect(sm.getState()).toBe(State.PROCESSING);

      // Advance 4 min, then trigger Stop → IDLE → no timeout
      vi.advanceTimersByTime(4 * 60 * 1000);
      sm.handleHookEvent('Stop', {});
      expect(sm.getState()).toBe(State.IDLE);

      // Advance past the original 5 min mark — should still be IDLE
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('no timeout in IDLE state', () => {
      const sm = bootToIdle();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(sm.getState()).toBe(State.IDLE);
    });
  });

  // === Parser Events ===

  describe('parser events', () => {
    it('spinner_start → PROCESSING from IDLE', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('spinner_start');
      expect(sm.getState()).toBe(State.PROCESSING);
    });

    it('spinner_stop → IDLE from PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('spinner_start');
      sm.handleParserEvent('spinner_stop');
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('idle → IDLE from PROCESSING', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleParserEvent('idle');
      expect(sm.getState()).toBe(State.IDLE);
    });

    it('mode_change updates permission mode', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('mode_change', { mode: 'plan' });
      expect(sm.getSnapshot().permissionMode).toBe(PermissionMode.PLAN);

      sm.handleParserEvent('mode_change', { mode: 'acceptEdits' });
      expect(sm.getSnapshot().permissionMode).toBe(PermissionMode.ACCEPT_EDITS);

      sm.handleParserEvent('mode_change', { mode: 'default' });
      expect(sm.getSnapshot().permissionMode).toBe(PermissionMode.DEFAULT);
    });
  });

  // === Snapshot ===

  describe('snapshot', () => {
    it('emits state_changed on transitions', () => {
      const sm = createSM();
      const snapshots: any[] = [];
      sm.on('state_changed', (s: any) => snapshots.push(s));

      sm.handleHookEvent('SessionStart', {});
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[snapshots.length - 1].state).toBe(State.IDLE);
    });

    it('includes tool info in snapshot', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleHookEvent('PreToolUse', { tool_name: 'Read' });

      const snap = sm.getSnapshot();
      expect(snap.currentTool).toBe('Read');
      expect(snap.toolProgress).toBe('Using Read');
    });

    it('clears tool info on PostToolUse', () => {
      const sm = bootToIdle();
      sm.handleHookEvent('UserPromptSubmit', {});
      sm.handleHookEvent('PreToolUse', { tool_name: 'Read' });
      sm.handleHookEvent('PostToolUse', {});

      const snap = sm.getSnapshot();
      expect(snap.currentTool).toBeNull();
      expect(snap.toolProgress).toBeNull();
    });

    it('includes project name and model', () => {
      const sm = bootToIdle();
      sm.handleParserEvent('project_name', { name: 'AgentDeck' });
      sm.handleParserEvent('model_info', { model: 'claude-opus-4' });

      const snap = sm.getSnapshot();
      expect(snap.projectName).toBe('AgentDeck');
      expect(snap.modelName).toBe('claude-opus-4');
    });
  });
});
