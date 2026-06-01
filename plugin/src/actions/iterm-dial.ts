/**
 * Usage Dial (E3) — dedicated rate limit / token gauge display.
 * UUID kept as iterm-dial for backward profile compatibility.
 *
 * Pages: overview (5h+7d) → 5h detail → 7d detail → session → extra
 * Rotate: cycle pages. Push: refresh usage. Touch: cycle pages.
 * OC fallback: shows timeline when in OpenClaw session detail view.
 */
import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  DialUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
  TouchTapEvent,
} from '@elgato/streamdeck';
import { State } from '@agentdeck/shared';
import type { AgentType, AgentCapabilities, OcSessionStatus } from '@agentdeck/shared';
import { isEncoderTakeoverActive } from '../encoder-takeover.js';
import { handleTakeoverPush, handleTakeoverRotate, requestTakeoverRefresh } from './option-dial.js';
import { isPickerActive, scrollPicker, selectProject } from '../project-picker.js';
import { encoderRegistry, isVoiceTextTakeoverActive, handleVtRotate, handleVtDown, handleVtUp, setTakeoverExitCallback, setUpdateUsageDialStateCallback } from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderUsageOverview, renderUsageDetail, renderUsageSession, renderUsageExtra, renderUsageDisconnected, USAGE_PAGES, type UsagePage } from '../renderers/usage-dial-renderer.js';
import { type UsageModeData, updateUsageModeData, getUsageModeData, fireUsageRefresh } from '../utility-modes/usage.js';
import { isInDetailView, getFocusedSession } from './session-slot-button.js';
import { timelineStore } from '../timeline-store.js';
import { renderTimeline } from '../renderers/timeline-renderer.js';
import type { ConnectionManager } from '../connection-manager.js';
import { dlog, dinfo } from '../log.js';

// Register cross-module callbacks (breaks circular deps via encoder-registry)
setTakeoverExitCallback(() => resetUsageLayout());
setUpdateUsageDialStateCallback((state, agentType, sessionStatus, caps) => updateUsageDialState(state, agentType, sessionStatus, caps));

const PIXMAP_LAYOUT = 'layouts/voice-layout.json';

function isOcDetailView(): boolean {
  if (!isInDetailView()) return false;
  const session = getFocusedSession();
  return session?.agentType === 'openclaw';
}

let currentState = State.DISCONNECTED;
let currentLayout = PIXMAP_LAYOUT;
let bridgeRef: ConnectionManager | null = null;
let currentAgentType: AgentType | null = null;
let currentCapabilities: AgentCapabilities | null = null;
let currentSessionStatus: OcSessionStatus | null = null;
let pageIdx = 0;
let hasReceivedData = false;

export function initUsageDial(bridge: ConnectionManager): void {
  bridgeRef = bridge;
  dinfo('UsageDial', 'initUsageDial called');
  // Timeline store change → re-render when in OC detail view
  timelineStore.onChange(() => {
    if (isOcDetailView() && !isEncoderTakeoverActive() && !isVoiceTextTakeoverActive()) {
      renderTimelineRightPanel();
    }
  });
}

/** Called from plugin.ts when usage_update arrives */
export function updateUsageDialData(data: UsageModeData): void {
  updateUsageModeData(data);
  hasReceivedData = true;
  refreshUsageDials();
}

export function updateUsageDialState(state: State, agentType?: AgentType | null, sessionStatus?: OcSessionStatus | null, capabilities?: AgentCapabilities | null): void {
  currentState = state;
  // Drop cached usage on daemon disconnect so the dial stops showing stale numbers.
  if (state === State.DISCONNECTED) hasReceivedData = false;
  if (agentType !== undefined) currentAgentType = agentType;
  if (capabilities !== undefined) currentCapabilities = capabilities ?? null;
  if (sessionStatus !== undefined) currentSessionStatus = sessionStatus ?? null;

  if (isOcDetailView()) {
    renderTimelineRightPanel();
    return;
  }
  refreshUsageDials();
}

export function resetUsageLayout(): void {
  currentLayout = '';
}

function ensurePixmapLayout(): void {
  if (currentLayout === PIXMAP_LAYOUT) return;
  currentLayout = PIXMAP_LAYOUT;
  for (const id of encoderRegistry.usageIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {});
  }
}

function renderTimelineRightPanel(): void {
  if (encoderRegistry.usageIds.length === 0) return;
  ensurePixmapLayout();
  const { panels } = renderTimeline(
    timelineStore.getGroupedDisplay(),
    timelineStore.getScrollIndex(),
    timelineStore.isDetailMode(),
    currentSessionStatus,
  );
  const feedback = { canvas: svgToDataUrl(panels[1]) };
  for (const id of encoderRegistry.usageIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

function refreshUsageDials(): void {
  if (isEncoderTakeoverActive()) return;
  if (isVoiceTextTakeoverActive()) return;
  if (encoderRegistry.usageIds.length === 0) return;
  // OC detail view: redirect to timeline rendering
  if (isOcDetailView()) {
    renderTimelineRightPanel();
    return;
  }

  ensurePixmapLayout();

  const data = getUsageModeData();
  let svg: string;

  // Collapse the dial to the disconnected placeholder when upstream has no
  // live usage to show. Three distinct reasons, rendered with distinct labels
  // so "Waiting..." is reserved for the genuine first-payload-not-yet case —
  // stale / missing-subscription is honestly labeled "No usage data".
  const connected = currentState !== State.DISCONNECTED;
  const usageUnavailable = data.usageStale === true || data.fiveHourPercent == null;
  if (!connected) {
    svg = renderUsageDisconnected(false, 'offline');
  } else if (!hasReceivedData) {
    svg = renderUsageDisconnected(true, 'waiting');
  } else if (usageUnavailable) {
    svg = renderUsageDisconnected(true, 'unavailable');
  } else {
    const page = USAGE_PAGES[pageIdx];
    switch (page) {
      case 'overview': svg = renderUsageOverview(data); break;
      case '5h': svg = renderUsageDetail(data, '5h'); break;
      case '7d': svg = renderUsageDetail(data, '7d'); break;
      case 'session': svg = renderUsageSession(data); break;
      case 'extra': svg = renderUsageExtra(data); break;
      default: svg = renderUsageOverview(data);
    }
  }

  const feedback = { canvas: svgToDataUrl(svg) };
  for (const id of encoderRegistry.usageIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

@action({ UUID: 'bound.serendipity.agentdeck.iterm-dial' })
export class UsageDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.usageIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    dinfo('UsageDial', `onWillAppear: id=${ev.action.id}`);
    if (!encoderRegistry.usageIds.includes(ev.action.id)) {
      encoderRegistry.usageIds.push(ev.action.id);
    }
    if (isEncoderTakeoverActive()) {
      requestTakeoverRefresh();
      return;
    }
    if (isOcDetailView()) {
      renderTimelineRightPanel();
      return;
    }
    // Request fresh usage data on appear
    fireUsageRefresh();
    refreshUsageDials();
  }

  override async onTouchTap(_ev: TouchTapEvent): Promise<void> {
    if (isEncoderTakeoverActive()) { handleTakeoverPush(); return; }
    if (isVoiceTextTakeoverActive()) return;
    if (isOcDetailView()) {
      timelineStore.toggleDetail();
      return;
    }
    // Touch: cycle pages
    pageIdx = (pageIdx + 1) % USAGE_PAGES.length;
    refreshUsageDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (isPickerActive()) { scrollPicker(ev.payload.ticks); return; }
    if (isEncoderTakeoverActive()) { handleTakeoverRotate(ev.payload.ticks); return; }
    if (isVoiceTextTakeoverActive()) { handleVtRotate(ev.payload.ticks); return; }
    if (isOcDetailView()) {
      timelineStore.scroll(ev.payload.ticks);
      return;
    }
    // Rotate: cycle pages
    pageIdx = (pageIdx + ev.payload.ticks + USAGE_PAGES.length) % USAGE_PAGES.length;
    refreshUsageDials();
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (isPickerActive()) { void selectProject(); return; }
    if (isEncoderTakeoverActive()) { handleTakeoverPush(); return; }
    if (isVoiceTextTakeoverActive()) { handleVtDown(); return; }
    if (isOcDetailView()) {
      timelineStore.toggleDetail();
      return;
    }
    // Push: refresh usage data
    fireUsageRefresh();
    dlog('UsageDial', 'push: requesting usage refresh');
  }

  override async onDialUp(_ev: DialUpEvent): Promise<void> {
    if (isEncoderTakeoverActive()) return;
    if (isVoiceTextTakeoverActive()) { handleVtUp(); return; }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    dinfo('UsageDial', `onWillDisappear: id=${ev.action.id}`);
    const idx = encoderRegistry.usageIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.usageIds.splice(idx, 1);
    }
  }
}
