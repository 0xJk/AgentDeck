import { describe, expect, it } from 'vitest';
import { State, type SessionInfo } from '@agentdeck/shared';
import { SessionSlotManager, type DeckLayout } from '../session-slot-manager.js';

const SD_PLUS_LAYOUT: DeckLayout = {
  columns: 4,
  rows: 2,
  keyCount: 8,
  family: 'streamdeckplus',
};

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'session-1',
    port: 9121,
    projectName: 'AgentDeck',
    agentType: 'claude-code',
    alive: true,
    state: State.IDLE,
    modelName: 'opus-4',
    effortLevel: 'high',
    ...overrides,
  };
}

describe('SessionSlotManager detail layout', () => {
  it('re-points detail focus onto the codex fold representative when the focused thread is absorbed', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([
      makeSession({ id: 'codex:old', agentType: 'codex-cli', state: State.IDLE, startedAt: '2026-04-11T10:00:00Z' }),
    ], false);
    manager.enterDetailView('codex:old');
    expect(manager.focusedSessionId).toBe('codex:old');

    manager.updateSessions([
      makeSession({ id: 'codex:old', agentType: 'codex-cli', state: State.IDLE, startedAt: '2026-04-11T10:00:00Z' }),
      makeSession({ id: 'codex:new', agentType: 'codex-cli', state: State.PROCESSING, startedAt: '2026-04-11T10:02:00Z' }),
    ], false);

    expect(manager.view).toBe('detail');
    expect(manager.focusedSessionId).toBe('codex:new');
    expect(manager.getFocusedSession()?.foldedSessionIds).toContain('codex:old');
  });

  it('exits detail view when the focused session is gone with no fold successor', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([
      makeSession({ id: 'claude:1', agentType: 'claude-code', state: State.IDLE }),
    ], false);
    manager.enterDetailView('claude:1');

    manager.updateSessions([], false);

    expect(manager.view).toBe('list');
    expect(manager.focusedSessionId).toBeNull();
  });

  it('folds codex companion threads by project before slot assignment', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([
      makeSession({
        id: 'codex:old',
        agentType: 'codex-cli',
        state: State.IDLE,
        startedAt: '2026-04-11T10:00:00Z',
      }),
      makeSession({
        id: 'codex:new',
        agentType: 'codex-cli',
        state: State.PROCESSING,
        currentTool: 'exec',
        startedAt: '2026-04-11T10:02:00Z',
      }),
      makeSession({
        id: 'claude:1',
        agentType: 'claude-code',
        state: State.IDLE,
        startedAt: '2026-04-11T10:01:00Z',
      }),
    ], false);

    expect(manager.sessions.map(s => s.id)).toEqual(['claude:1', 'codex:new']);
    expect(manager.sessions[1]).toMatchObject({
      groupSize: 2,
      foldedSessionIds: ['codex:old', 'codex:new'],
      currentTool: 'exec',
      state: State.PROCESSING,
    });
  });

  it('renders connected no-session list as status cards instead of text-only empty buttons', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([], false);

    expect(manager.getSlotConfig(0, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'status',
      label: 'HUB READY',
      subtitle: 'CONNECTED',
      icon: 'hub',
    });
    expect(manager.getSlotConfig(1, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'status',
      label: 'NO SESSION',
      subtitle: 'WAITING',
      icon: 'no-session',
    });
    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'status',
      label: 'AgentDeck',
      subtitle: 'IDLE',
      icon: 'agentdeck',
    });
  });

  it('puts processing tool info before OpenClaw presets', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([
      makeSession({
        id: 'openclaw',
        agentType: 'openclaw',
        state: State.PROCESSING,
        modelName: 'gpt-5',
      }),
    ], true);
    manager.enterDetailView('openclaw');
    manager.updateDetailState(State.PROCESSING, [], 'logs.tail', 'tail latest logs', undefined, 'gpt-5');

    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'status',
      label: 'logs.tail',
      subtitle: 'tail latest logs',
      icon: 'tool',
    });
    expect(manager.getSlotConfig(3, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'preset',
      preset: { label: 'STATUS' },
    });
    expect(manager.getSlotConfig(4, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'preset',
      preset: { label: 'MODEL' },
    });
    expect(manager.getSlotConfig(5, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'preset',
      preset: { label: 'GATEWAY' },
    });
  });

  it('keeps a processing status tile even before tool metadata arrives', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([
      makeSession({
        id: 'openclaw',
        agentType: 'openclaw',
        state: State.PROCESSING,
      }),
    ], true);
    manager.enterDetailView('openclaw');
    manager.updateDetailState(State.PROCESSING, []);

    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'status',
      label: 'ROUTING',
      subtitle: 'running',
      icon: 'tool',
    });
    expect(manager.getSlotConfig(3, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'preset',
      preset: { label: 'STATUS' },
    });
  });

  it('uses actual parser options and reserves MORE only when awaiting overflow exists', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({ state: State.AWAITING_OPTION })], false);
    manager.enterDetailView('session-1');
    manager.updateDetailState(State.AWAITING_OPTION, [
      { index: 0, label: 'Yes' },
      { index: 1, label: 'No' },
      { index: 2, label: 'Always allow' },
      { index: 3, label: 'Deny' },
      { index: 4, label: 'Explain' },
    ]);

    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({ type: 'option', optionIndex: 0 });
    expect(manager.getSlotConfig(5, SD_PLUS_LAYOUT)).toMatchObject({ type: 'option', optionIndex: 3 });
    expect(manager.getSlotConfig(6, SD_PLUS_LAYOUT)).toMatchObject({ type: 'next-page', label: '1/2' });
    expect(manager.getSlotConfig(7, SD_PLUS_LAYOUT)).toMatchObject({ type: 'esc', label: 'active' });
  });
});
