/**
 * SessionSlotButton — v4 dynamic session-per-button action.
 *
 * Single action UUID, 8 instances (SupportedInMultiActions).
 * Each instance auto-detects its physical slot from willAppear coordinates.
 * Central SessionSlotManager drives all rendering and press handling.
 */
import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State } from '@agentdeck/shared';
import type { SessionInfo, PromptOption, AgentType } from '@agentdeck/shared';
import { SessionSlotManager, type SessionSlotConfig } from '../session-slot-manager.js';
import {
  renderSessionSlot,
  renderEmptySlot,
  renderNoDaemonSlot,
  renderBackButton,
  renderNextPageButton,
  renderEscButton,
  renderStopButton,
  renderDetailInfo,
  renderOptionButton,
  renderInfoSlot,
  renderPresetButton,
} from '../renderers/session-slot-renderer.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { dlog } from '../log.js';
import { openAgentDeckAppOrGitHub } from '../utility-modes/macos.js';

// ---- Module state ----

const manager = new SessionSlotManager();

/** Action instance ID → physical slot index (0-7) */
const slotMap = new Map<string, number>();

/** All registered action instance IDs */
const actionIds: string[] = [];

/** Animation frame counter (for AWAITING pulse) */
let animFrame = 0;
let animTimer: ReturnType<typeof setInterval> | null = null;
const ANIM_INTERVAL_MS = 150;

/** Callback for press actions that need bridge interaction */
let onSlotAction: ((action: ReturnType<typeof manager.handleSlotPress>) => void) | null = null;

/** Whether daemon connection is alive */
let daemonConnected = false;

// ---- Public API ----

export function initSessionSlots(
  callback: (action: ReturnType<typeof manager.handleSlotPress>) => void,
): void {
  onSlotAction = callback;
}

export function updateSessionSlotSessions(sessions: SessionInfo[], gatewayAvailable: boolean): void {
  manager.updateSessions(sessions, gatewayAvailable);
  refreshAll();
}

export function setActiveSession(sessionId: string | null, port: number | null): void {
  manager.setActiveSession(sessionId, port);
  if (manager.view === 'list') refreshAll();
}

export function updateDetailViewState(
  state: State,
  options: PromptOption[],
  tool?: string,
  toolInput?: string,
  question?: string,
  modelName?: string,
  mode?: string,
): void {
  manager.updateDetailState(state, options, tool, toolInput, question, modelName, mode);
  if (manager.view === 'detail') refreshAll();
}

export function exitDetailView(): void {
  manager.exitDetailView();
  stopAnimation();
  refreshAll();
}

export function getSessionSlotManager(): SessionSlotManager {
  return manager;
}

export function isInDetailView(): boolean {
  return manager.view === 'detail';
}

export function getFocusedSession(): SessionInfo | undefined {
  return manager.getFocusedSession();
}

export function setDaemonConnected(connected: boolean): void {
  daemonConnected = connected;
  if (!connected) {
    // Clear sessions on daemon disconnect
    manager.updateSessions([], false);
    if (manager.view === 'detail') {
      manager.exitDetailView();
    }
  }
  refreshAll();
}

// ---- Animation ----

function startAnimation(): void {
  if (animTimer) return;
  animFrame = 0;
  animTimer = setInterval(() => {
    animFrame++;
    refreshAll();
  }, ANIM_INTERVAL_MS);
}

function stopAnimation(): void {
  if (animTimer) {
    clearInterval(animTimer);
    animTimer = null;
  }
}

/** Check if any visible session needs animation (AWAITING pulse or PROCESSING flowing border) */
function needsAnimation(): boolean {
  if (manager.view === 'detail') return false; // Detail view doesn't animate session buttons
  for (const session of manager.sessions) {
    if (session.state?.startsWith('awaiting')) return true;
    if (session.state === 'processing') return true;
  }
  return false;
}

// ---- Rendering ----

function refreshAll(): void {
  // Daemon not connected → show "No Daemon" on all slots
  if (!daemonConnected) {
    for (const id of actionIds) {
      const slot = slotMap.get(id);
      if (slot == null) continue;
      const act = streamDeck.actions.getActionById(id);
      if (!act) continue;
      void act.setImage(svgToDataUrl(renderNoDaemonSlot(slot))).catch(() => {});
    }
    stopAnimation();
    return;
  }

  // Start/stop animation based on whether any session is AWAITING
  if (needsAnimation() && !animTimer) {
    startAnimation();
  } else if (!needsAnimation() && animTimer) {
    stopAnimation();
  }

  for (const id of actionIds) {
    const slot = slotMap.get(id);
    if (slot == null) continue;
    const act = streamDeck.actions.getActionById(id);
    if (!act) continue;

    const config = manager.getSlotConfig(slot);
    const svg = renderSlotSvg(config, slot);
    void act.setImage(svgToDataUrl(svg)).catch(() => {});
  }
}

function renderSlotSvg(config: SessionSlotConfig, _slot: number): string {
  switch (config.type) {
    case 'session':
      return renderSessionSlot(config.session!, config.isActive ?? false, animFrame);

    case 'back':
      return renderBackButton();

    case 'info':
      if (config.session) {
        return renderDetailInfo(
          config.session,
          manager.detailState,
          undefined, // tool shown separately
          manager.detailModelName ?? config.session.modelName,
          undefined,
        );
      }
      return renderInfoSlot(config.label ?? '---');

    case 'option':
      return renderOptionButton(config.option!, config.optionIndex ?? 0);

    case 'preset':
      if (config.preset) {
        return renderPresetButton(config.preset.label, config.preset.iconSvg, config.preset.color, config.preset.textColor, config.preset.subtitle, config.preset.loading);
      }
      return renderEmptySlot();

    case 'esc':
      return renderEscButton(config.label === 'active');

    case 'stop':
      return renderStopButton(config.label === 'active');

    case 'next-page':
      return renderNextPageButton(config.label ?? '');

    case 'empty':
    default:
      return renderEmptySlot();
  }
}

// ---- Action class ----

@action({ UUID: 'bound.serendipity.agentdeck.session-slot' })
export class SessionSlotButtonAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const id = ev.action.id;
    if (!actionIds.includes(id)) {
      actionIds.push(id);
    }

    // Auto-detect physical slot from coordinates
    const col = (ev.payload as any)?.coordinates?.column ?? 0;
    const row = (ev.payload as any)?.coordinates?.row ?? 0;
    const slot = row * 4 + col; // SD+ 2×4 grid: row 0 = slots 0-3, row 1 = slots 4-7
    slotMap.set(id, slot);

    dlog('SesSlot', `willAppear: id=${id.slice(-6)} slot=${slot} (row=${row} col=${col}) daemon=${daemonConnected}`);

    // Render appropriate state
    if (!daemonConnected) {
      await ev.action.setImage(svgToDataUrl(renderNoDaemonSlot(slot)));
    } else {
      const config = manager.getSlotConfig(slot);
      await ev.action.setImage(svgToDataUrl(renderSlotSvg(config, slot)));
    }
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const slot = slotMap.get(ev.action.id);
    if (slot == null) return;

    // No daemon — slot 0 = START (launch macOS app)
    if (!daemonConnected && slot === 0) {
      dlog('SesSlot', 'keyDown: launching AgentDeck app or GitHub');
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }

    const result = manager.handleSlotPress(slot);
    dlog('SesSlot', `keyDown: slot=${slot} action=${result.action}`);

    if (result.action === 'next-page') {
      manager.nextPage();
      refreshAll();
      return;
    }

    if (result.action === 'exit-detail') {
      manager.exitDetailView();
      refreshAll();
    }

    // Delegate to bridge callback
    if (onSlotAction) {
      onSlotAction(result);
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = actionIds.indexOf(ev.action.id);
    if (idx !== -1) actionIds.splice(idx, 1);
    slotMap.delete(ev.action.id);
  }
}
