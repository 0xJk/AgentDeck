import { describe, it, expect } from 'vitest';
import type { SessionInfo } from '@agentdeck/shared';
import { buildHudEntries, formatTaskEvalSuffix } from '../tui/renderer.js';
import type { DashboardState } from '../tui/dashboard.js';

function baseState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    state: 'idle',
    connectionStatus: 'connected',
    isStale: false,
    projectName: 'AgentDeck',
    modelName: null,
    currentTool: null,
    sessions: [],
    usage: null,
    modelCatalog: [],
    timeline: [],
    helpVisible: false,
    currentPort: 9121,
    agentType: 'claude-code',
    gatewayAvailable: false,
    crayfishRouting: false,
    gatewayHasError: false,
    voiceAssistantState: 'disabled',
    voiceAssistantText: null,
    voiceAssistantResponseText: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sid',
    projectName: 'AgentDeck',
    agentType: 'claude-code',
    state: 'idle',
    port: undefined,
    startedAt: '2026-05-11T10:00:00Z',
    modelName: undefined,
    ...overrides,
  } as SessionInfo;
}

describe('buildHudEntries — primary anchoring', () => {
  it('promotes the matching-port sibling to primary instead of appending a duplicate', () => {
    const state = baseState({
      currentPort: 9121,
      sessions: [
        makeSession({ id: 'a', port: 9121, projectName: 'AgentDeck', startedAt: '2026-05-11T10:00:00Z' }),
        makeSession({ id: 'b', port: 9122, projectName: 'AgentDeck', startedAt: '2026-05-11T11:00:00Z' }),
      ],
    });
    const entries = buildHudEntries(state);
    expect(entries.length).toBe(2);
    expect(entries.find(e => e.id === 'a')!.isPrimary).toBe(true);
    expect(entries.find(e => e.id === 'b')!.isPrimary).toBe(false);
  });

  it("patches the anchored sibling with the primary's live fields (matches macOS / Android)", () => {
    // The sibling snapshot may lag the primary state_update — daemon-relayed
    // sessions_list often arrives stale. macOS / Android render the row from
    // the live primary state and only borrow the sibling's startedAt for
    // sort positioning; TUI must do the same or the dashboard shows stale
    // model/state/currentTask for the connected session.
    const state = baseState({
      currentPort: 9121,
      agentType: 'claude-code',
      state: 'processing',
      projectName: 'AgentDeck',
      modelName: 'sonnet-4-7-live',
      currentTool: 'Edit',
      sessions: [
        makeSession({
          id: 'a',
          port: 9121,
          projectName: 'StaleProject',
          agentType: 'claude-code',
          state: 'idle',
          modelName: 'sonnet-4-6-stale',
          startedAt: '2026-05-11T10:00:00Z',
        }),
      ],
    });
    const entries = buildHudEntries(state);
    const promoted = entries.find(e => e.id === 'a')!;
    expect(promoted.isPrimary).toBe(true);
    // Live primary fields win over the sibling snapshot
    expect(promoted.projectName).toBe('AgentDeck');
    expect(promoted.modelName).toBe('sonnet-4-7-live');
    expect(promoted.state).toBe('processing');
    expect(promoted.currentTask).toBe('Edit');
    // Anchor fields stay with the sibling (sort + hotkey identity)
    expect(promoted.startedAt).toBe('2026-05-11T10:00:00Z');
    expect(promoted.port).toBe(9121);
  });

  it("uses the primary's projectName for the #N suffix grouping after anchoring", () => {
    // If the anchor sibling carries a stale projectName ("StaleProject") but
    // the live primary is "AgentDeck", #N counting must use the live name —
    // otherwise duplicate detection misses and the suffix order desyncs from
    // macOS / Android. Two AgentDeck sessions: one is the connected primary
    // (anchored on a sibling whose snapshot still says "StaleProject"), the
    // other is a real AgentDeck sibling. Both should land in the same #N
    // group.
    const state = baseState({
      currentPort: 9121,
      agentType: 'claude-code',
      state: 'processing',
      projectName: 'AgentDeck',
      sessions: [
        makeSession({ id: 'a', port: 9121, projectName: 'StaleProject', startedAt: '2026-05-11T10:00:00Z' }),
        makeSession({ id: 'b', port: 9122, projectName: 'AgentDeck', startedAt: '2026-05-11T11:00:00Z' }),
      ],
    });
    const entries = buildHudEntries(state);
    const a = entries.find(e => e.id === 'a')!;
    const b = entries.find(e => e.id === 'b')!;
    expect(a.projectName).toBe('AgentDeck');
    expect(b.projectName).toBe('AgentDeck');
    expect(a.displayName).toBe('AgentDeck #1');
    expect(b.displayName).toBe('AgentDeck #2');
  });

  it('preserves the deterministic #N order when primary anchors a sibling slot', () => {
    // Same scenario as the iOS Tablet reproduction: two AgentDeck claude-code
    // sessions where one is the connected primary. The primary must keep
    // the sibling's startedAt so its position inside the (project, agentType)
    // group does not flip on event arrival order.
    const state = baseState({
      currentPort: 9121,
      sessions: [
        makeSession({ id: 'newer', port: 9122, startedAt: '2026-05-11T11:00:00Z' }),
        makeSession({ id: 'older', port: 9121, startedAt: '2026-05-11T10:00:00Z' }),
      ],
    });
    const entries = buildHudEntries(state);
    const order = entries.map(e => `${e.id}=${e.displayName}`);
    expect(order).toEqual(['older=AgentDeck #1', 'newer=AgentDeck #2']);
  });

  it('appends a synthetic primary when no sibling shares its agentType', () => {
    const state = baseState({
      currentPort: 9121,
      agentType: 'claude-code',
      sessions: [
        makeSession({ id: 'codex-1', agentType: 'codex-cli', port: 9122 }),
      ],
    });
    const entries = buildHudEntries(state);
    expect(entries.find(e => e.id === '__self__')?.isPrimary).toBe(true);
    expect(entries.length).toBe(2);
  });

  it('skips the synthetic primary when a sibling shares agentType but no port match (duplicate guard)', () => {
    const state = baseState({
      currentPort: 9121,
      agentType: 'claude-code',
      sessions: [
        // Sibling has same agentType but a different port → no anchor → duplicate guard skips primary.
        makeSession({ id: 'sib', port: 9999, projectName: 'OtherProject' }),
      ],
    });
    const entries = buildHudEntries(state);
    expect(entries.find(e => e.id === '__self__')).toBeUndefined();
    expect(entries.find(e => e.isPrimary)).toBeUndefined();
  });

  it('never appends primary when agentType is daemon or openclaw', () => {
    for (const agentType of ['daemon', 'openclaw']) {
      const state = baseState({
        agentType,
        sessions: [makeSession({ id: 'sib', agentType: 'claude-code', port: 9122 })],
      });
      const entries = buildHudEntries(state);
      expect(entries.find(e => e.isPrimary)).toBeUndefined();
    }
  });
});

describe('buildHudEntries — virtual OpenClaw', () => {
  it('inserts a virtual OpenClaw row when gateway is available and sessions has none', () => {
    const state = baseState({
      gatewayAvailable: true,
      sessions: [makeSession({ id: 'sib', port: 9122 })],
    });
    const entries = buildHudEntries(state);
    const oc = entries.find(e => e.isVirtualOpenClaw);
    expect(oc).toBeDefined();
    expect(oc!.agentType).toBe('openclaw');
    // openclaw rank=0 → must land before claude-code in the sort
    expect(entries[0]!.agentType).toBe('openclaw');
  });

  it('does not insert a virtual row when sessions already contains an openclaw entry', () => {
    const state = baseState({
      gatewayAvailable: true,
      sessions: [
        makeSession({ id: 'oc', agentType: 'openclaw', port: 9122 }),
      ],
    });
    const entries = buildHudEntries(state);
    expect(entries.filter(e => e.agentType === 'openclaw').length).toBe(1);
    expect(entries[0]!.isVirtualOpenClaw).toBe(false);
  });
});

describe('buildHudEntries — hotkey eligibility (sibling-only)', () => {
  it('primary and virtual rows do not consume hotkey slots', () => {
    const state = baseState({
      currentPort: 9121,
      gatewayAvailable: true,
      sessions: [
        makeSession({ id: 'a', port: 9121 }),                                                       // becomes primary
        makeSession({ id: 'b', port: 9122, projectName: 'Beta', startedAt: '2026-05-11T11:00:00Z' }),
      ],
    });
    const entries = buildHudEntries(state);
    const focusable = entries.filter(e => !e.isPrimary && !e.isVirtualOpenClaw && e.port !== undefined);
    expect(focusable.map(e => e.id)).toEqual(['b']);
  });
});

// Task-end eval suffix rendering (Step 2 + Step 5 manual-cancel preservation)
// — must not silently fall back to '' when the user closed a task with
// `agentdeck task cancel` (outcome=abandoned). The previous regression
// rendered abandoned rows identically to pending, hiding the user's
// gesture from the TUI dashboard.
describe('formatTaskEvalSuffix — task_end badge for each outcome class', () => {
  it('renders ✓ for success', () => {
    expect(formatTaskEvalSuffix(0.92, 'success')).toBe(' · 0.92 ✓');
  });
  it('renders ✗ for fail', () => {
    expect(formatTaskEvalSuffix(0.2, 'fail')).toBe(' · 0.20 ✗');
  });
  it('renders △ for partial', () => {
    expect(formatTaskEvalSuffix(0.55, 'partial')).toBe(' · 0.55 △');
  });
  it('renders ⊘ for abandoned (manual cancel)', () => {
    expect(formatTaskEvalSuffix(0.55, 'abandoned')).toBe(' · 0.55 ⊘');
  });
  it('renders ? as score placeholder when judge has not produced a number yet', () => {
    expect(formatTaskEvalSuffix(undefined, 'abandoned')).toBe(' · ? ⊘');
  });
  it('returns empty string while the eval is still pending (outcome undefined)', () => {
    expect(formatTaskEvalSuffix(undefined, undefined)).toBe('');
    expect(formatTaskEvalSuffix(0.5, 'pending')).toBe('');
  });
});
