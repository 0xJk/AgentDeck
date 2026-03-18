import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State, PermissionMode } from '@agentdeck/shared';
import type { AgentType } from '@agentdeck/shared';
import { ConnectionManager } from '../connection-manager.js';
import { renderButton, svgToDataUrl } from '../renderers/button-renderer.js';
import { agentLogoWatermark, CLAUDE_LOGO_PATH } from '../renderers/agent-logos.js';
import { ButtonConfig } from '../layout-manager.js';
import { handleExpandedAction } from '../expanded-actions.js';
import { setCcNoSessionMode } from './response-button.js';
import { setUsageCapabilities } from './usage-button.js';
import { updateOptionDialState } from './option-dial.js';
import { updateItermDialState, suppressAutoSwitch } from './iterm-dial.js';
import { dlog } from '../log.js';
import { readFileSync, watchFile, unwatchFile } from 'fs';
import { execSync, execFile } from 'child_process';
import { homedir } from 'os';

const SIZE = 144;
const LONG_PRESS_MS = 500;
const SESSIONS_FILE = `${homedir()}/.agentdeck/sessions.json`;
const MAX_CHARS_PER_LINE = 10;

interface SessionEntry {
  id: string;
  port: number;
  pid: number;
  projectName: string;
  tmuxSession?: string;
  tty?: string;
  startedAt: string;
}

let bridge: ConnectionManager;
let onSessionSwitched: (() => void) | null = null;
let currentState = State.DISCONNECTED;
let currentMode = PermissionMode.DEFAULT;
let currentProjectName: string | undefined;
let currentTool: string | undefined;
let currentModel: string | undefined;
let currentAgentType: AgentType | null = null;
let currentEffortLevel: string | undefined;
let currentSessionIndex = 0;
let sessions: SessionEntry[] = [];
let keyDownTime = 0;
let animTimer: ReturnType<typeof setInterval> | null = null;
let animFrame = 0;
let fileWatchActive = false;
let showingCcNoSession = false;
let currentVoiceAssistantState: string | undefined;

/** Bridge can proxy OpenClaw (daemon) so agentType may be 'openclaw' while active link remains bridge. */
function isProxiedOpenClaw(): boolean {
  return currentAgentType === 'openclaw' && bridge.getActiveAgentType() !== 'openclaw';
}

/** Enter or exit NO SESSION mode, propagating to all affected components. */
function setNoSessionMode(active: boolean): void {
  showingCcNoSession = active;
  setCcNoSessionMode(active);
  if (active) {
    // Clear capabilities so usage/dials revert to CC-disconnected behavior
    setUsageCapabilities(null);
    updateOptionDialState(currentState, [], undefined, undefined, undefined, undefined, undefined, undefined, null, null, null);
    updateItermDialState(currentState, null, null, null);
  } else {
    // Restore gateway capabilities
    const caps = bridge.getCapabilities();
    const agentType = bridge.getActiveAgentType();
    setUsageCapabilities(caps);
    updateOptionDialState(currentState, [], undefined, undefined, undefined, undefined, undefined, undefined, agentType, null, caps);
    updateItermDialState(currentState, agentType, null, caps);
  }
}

const ANIM_INTERVAL_MS = 150; // ~6.7 FPS
const ANIM_TOTAL_FRAMES = 24; // full rotation = 24 frames × 150ms = 3.6s

let setupRequired = false;
let overrideConfig: ButtonConfig | null = null;

const actionIds: string[] = [];

export function setSessionSetupRequired(value: boolean): void {
  setupRequired = value;
  refreshAll();
}

export function initSessionButton(b: ConnectionManager, sessionSwitchedCb?: () => void): void {
  bridge = b;
  onSessionSwitched = sessionSwitchedCb ?? null;
  startFileWatch();
}

function startFileWatch(): void {
  if (fileWatchActive) return;
  fileWatchActive = true;
  watchFile(SESSIONS_FILE, { interval: 1000 }, () => {
    const prevCount = sessions.length;
    const prevPort = bridge.getBridgePort();
    sessions = loadSessions();

    if (sessions.length > prevCount) {
      // New session added — auto-switch if disconnected or showing NO SESSION
      if (currentState === State.DISCONNECTED || showingCcNoSession) {
        if (showingCcNoSession) {
          setNoSessionMode(false);
          bridge.resetToAuto();
        }
        const sorted = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        const newest = sorted[0];
        if (newest && newest.port !== prevPort) {
          currentSessionIndex = sessions.indexOf(newest);
          currentProjectName = newest.projectName;
          dlog('SesBut', `New session detected (disconnected) — auto-switching to ${getDisplayName(newest, sessions)}:${newest.port}`);
          bridge.reconnectBridgeTo(newest.port);
        }
      } else {
        dlog('SesBut', `New session detected — staying on current (state=${currentState}), count ${prevCount}→${sessions.length}`);
        // Update currentSessionIndex to keep pointing at the same port
        const idx = sessions.findIndex((s) => s.port === prevPort);
        if (idx !== -1) currentSessionIndex = idx;
      }
    } else {
      // Sessions changed — keep pointing at same port if still alive
      const idx = sessions.findIndex((s) => s.port === prevPort);
      if (idx !== -1) {
        currentSessionIndex = idx;
      } else {
        // Port gone — clamp index to valid range
        currentSessionIndex = Math.max(0, sessions.length - 1);
      }
    }
    refreshAll();
  });
}

function stopFileWatch(): void {
  if (!fileWatchActive) return;
  fileWatchActive = false;
  unwatchFile(SESSIONS_FILE);
}

export function overrideSessionButton(config: ButtonConfig | null): void {
  overrideConfig = config;
  refreshAll();
}

export function updateSessionButton(
  state: State,
  mode: PermissionMode,
  project?: string,
  tool?: string,
  model?: string,
  agentType?: AgentType | null,
  effortLevel?: string,
  voiceAssistantState?: string,
): void {
  const wasConnected = currentState !== State.DISCONNECTED;
  const wasIdle = currentState === State.IDLE;
  currentState = state;
  currentMode = mode;
  if (project) currentProjectName = project;
  // For AWAITING_ states, preserve currentTool from PROCESSING
  if (state !== State.AWAITING_PERMISSION && state !== State.AWAITING_OPTION && state !== State.AWAITING_DIFF) {
    currentTool = tool;
  }
  if (model) currentModel = model;
  if (agentType !== undefined) currentAgentType = agentType;
  if (effortLevel !== undefined) currentEffortLevel = effortLevel;
  if (voiceAssistantState !== undefined) currentVoiceAssistantState = voiceAssistantState;

  // CC connected — clear NO SESSION mode
  if (showingCcNoSession && agentType === 'claude-code') {
    setNoSessionMode(false);
  }

  // Reload session list only on transition to IDLE (not on every render)
  if (state === State.IDLE && !wasIdle) {
    sessions = loadSessions();
  }

  // Auto-reconnect: if we just disconnected, try switching to another active session
  if (state === State.DISCONNECTED && wasConnected) {
    dlog('SesBut', 'disconnected — attempting auto-reconnect');
    autoReconnect();
  }

  // Start/stop spinner animation for PROCESSING / AWAITING states
  const needsAnim =
    state === State.PROCESSING ||
    state === State.AWAITING_PERMISSION ||
    state === State.AWAITING_OPTION ||
    state === State.AWAITING_DIFF;

  if (needsAnim && !animTimer) {
    animFrame = 0;
    animTimer = setInterval(() => {
      animFrame = (animFrame + 1) % ANIM_TOTAL_FRAMES;
      refreshAll();
    }, ANIM_INTERVAL_MS);
  } else if (!needsAnim && animTimer) {
    clearInterval(animTimer);
    animTimer = null;
    animFrame = 0;
  }

  refreshAll();
}

function autoReconnect(): void {
  sessions = loadSessions();
  if (sessions.length === 0) return;

  const currentPort = bridge.getBridgePort();
  const other = sessions.find((s) => s.port !== currentPort);
  if (other) {
    currentSessionIndex = sessions.indexOf(other);
    currentProjectName = other.projectName;
    bridge.reconnectBridgeTo(other.port);
  }
}

/** Switch bridge to a specific port (used by iTerm auto-switch). */
export function switchToPort(port: number): void {
  sessions = loadSessions();
  const idx = sessions.findIndex((s) => s.port === port);
  if (idx === -1) return;
  if (bridge.getBridgePort() === port) return;
  currentSessionIndex = idx;
  currentProjectName = sessions[idx].projectName;
  // Reset stale state for instant visual feedback
  currentState = State.IDLE;
  currentTool = undefined;
  currentModel = undefined;
  currentEffortLevel = undefined;
  dlog('SesBut', `switchToPort: → ${getDisplayName(sessions[idx], sessions)}:${port}`);
  bridge.reconnectBridgeTo(port);
  refreshAll();
  onSessionSwitched?.();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadSessions(): SessionEntry[] {
  try {
    const data = readFileSync(SESSIONS_FILE, 'utf-8');
    const parsed = JSON.parse(data) as SessionEntry[];
    // session cycling 목록에서 daemon 제외 (인프라스트럭처, 에이전트 아님)
    return parsed.filter((s) => isProcessAlive(s.pid) && (s as any).agentType !== 'daemon');
  } catch {
    return [];
  }
}

/** Get display name with #N suffix when multiple sessions share the same projectName */
function getDisplayName(session: SessionEntry, allSessions: SessionEntry[]): string {
  const same = allSessions
    .filter((s) => s.projectName === session.projectName)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (same.length <= 1) return session.projectName;
  const idx = same.findIndex((s) => s.id === session.id);
  return `${session.projectName} #${idx + 1}`;
}

/** Safe accessor — returns undefined if index is out of bounds */
function getCurrentSession(): SessionEntry | undefined {
  if (currentSessionIndex >= 0 && currentSessionIndex < sessions.length) {
    return sessions[currentSessionIndex];
  }
  return undefined;
}

function refreshAll(): void {
  const dataUrl = overrideConfig
    ? svgToDataUrl(renderButton(overrideConfig))
    : svgToDataUrl(renderSessionSvg());
  for (const id of actionIds) {
    const act = streamDeck.actions.getActionById(id);
    if (act) {
      void act.setImage(dataUrl).catch(() => {});
    }
  }
}

/** Find best split point near target position in a string */
function findSplitPoint(name: string, target: number, maxChars: number): number {
  let bestSplit = -1;

  // Look for split points near target: camelCase, kebab-case, spaces
  for (let i = Math.max(1, target - 4); i <= Math.min(name.length - 1, target + 4); i++) {
    if (/[a-z]/.test(name[i - 1]) && /[A-Z]/.test(name[i])) {
      bestSplit = i;
      break;
    }
    if (name[i] === '-' || name[i] === '_' || name[i] === ' ') {
      bestSplit = i + 1;
      break;
    }
  }

  // Widen search if no split found near target
  if (bestSplit === -1) {
    for (let i = 1; i < name.length; i++) {
      if (/[a-z]/.test(name[i - 1]) && /[A-Z]/.test(name[i])) {
        bestSplit = i;
        break;
      }
      if (name[i] === '-' || name[i] === '_' || name[i] === ' ') {
        bestSplit = i + 1;
        break;
      }
    }
  }

  // Hard split if no natural boundary
  if (bestSplit === -1 || bestSplit < 1 || bestSplit >= name.length) {
    bestSplit = maxChars;
  }

  return bestSplit;
}

/** Split a project name into 1–3 lines at natural boundaries */
function splitProjectName(name: string, maxChars: number): string[] {
  if (name.length <= maxChars) return [name];

  const mid = Math.floor(name.length / 2);
  const bestSplit = findSplitPoint(name, mid, maxChars);

  const line1 = name.slice(0, bestSplit).replace(/[-_ ]$/, '');
  const line2Raw = name.slice(bestSplit).replace(/^[-_ ]/, '');

  // If both lines fit, return 2 lines
  if (line1.length <= maxChars && line2Raw.length <= maxChars) {
    return [truncate(line1, maxChars), truncate(line2Raw, maxChars)];
  }

  // Try splitting the longer line to make 3 lines
  if (line1.length > maxChars) {
    const split2 = findSplitPoint(line1, Math.floor(line1.length / 2), maxChars);
    const l1 = line1.slice(0, split2).replace(/[-_ ]$/, '');
    const l2 = line1.slice(split2).replace(/^[-_ ]/, '');
    return [truncate(l1, maxChars), truncate(l2, maxChars), truncate(line2Raw, maxChars)];
  }

  // line2Raw is too long — split it
  const split2 = findSplitPoint(line2Raw, Math.floor(line2Raw.length / 2), maxChars);
  const l2 = line2Raw.slice(0, split2).replace(/[-_ ]$/, '');
  const l3 = line2Raw.slice(split2).replace(/^[-_ ]/, '');
  return [truncate(line1, maxChars), truncate(l2, maxChars), truncate(l3, maxChars)];
}

function getStatusInfo(): { label: string; detail: string; color: string; bg: string } {
  switch (currentState) {
    case State.PROCESSING:
      return {
        label: 'RUNNING',
        detail: currentTool || 'Thinking...',
        color: '#fbbf24',
        bg: '#2a1f00',
      };
    case State.AWAITING_PERMISSION:
      return {
        label: 'PERMIT?',
        detail: currentTool || 'Allow?',
        color: '#f87171',
        bg: '#2a0f0f',
      };
    case State.AWAITING_OPTION:
      return {
        label: 'SELECT',
        detail: currentTool || 'Choose...',
        color: '#60a5fa',
        bg: '#0f1a2a',
      };
    case State.AWAITING_DIFF:
      return {
        label: 'DIFF',
        detail: currentTool || 'Review...',
        color: '#a78bfa',
        bg: '#1a0f2a',
      };
    default:
      return { label: 'RUNNING', detail: 'Thinking...', color: '#fbbf24', bg: '#2a1f00' };
  }
}

function setupRequiredSvg(): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#1a1a2e"/>`,
    `<text x="72" y="46" text-anchor="middle" font-family="Arial,sans-serif" font-size="36">\u2699\uFE0F</text>`,
    `<text x="72" y="86" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="bold" fill="#818cf8">SETUP</text>`,
    `<text x="72" y="110" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#64748b">AgentDeck</text>`,
    `</svg>`,
  ].join('');
}

function renderVoiceAssistantOverlaySvg(): string | null {
  if (!currentVoiceAssistantState || currentVoiceAssistantState === 'idle' || currentVoiceAssistantState === 'disabled') {
    return null;
  }
  switch (currentVoiceAssistantState) {
    case 'listening':
      return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#0a2a2e"/>`,
        `<text x="72" y="48" text-anchor="middle" font-family="Arial,sans-serif" font-size="36">🎤</text>`,
        `<text x="72" y="82" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#22d3ee">LISTENING</text>`,
        `<text x="72" y="106" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#67e8f9" opacity="0.6">Voice Assistant</text>`,
        `</svg>`,
      ].join('');
    case 'processing':
      return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#1a1a0a"/>`,
        `<text x="72" y="42" text-anchor="middle" font-family="Arial,sans-serif" font-size="36">🎤</text>`,
        `<text x="72" y="76" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#fbbf24">PROCESSING</text>`,
        `<text x="72" y="106" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#fbbf24" opacity="0.6">Voice Assistant</text>`,
        `</svg>`,
      ].join('');
    case 'speaking':
      return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#0a2e14"/>`,
        `<text x="72" y="48" text-anchor="middle" font-family="Arial,sans-serif" font-size="36">🔊</text>`,
        `<text x="72" y="82" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#4ade80">SPEAKING</text>`,
        `<text x="72" y="106" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#4ade80" opacity="0.6">Voice Assistant</text>`,
        `</svg>`,
      ].join('');
    default:
      return null;
  }
}

function renderSessionSvg(): string {
  // Voice assistant active — override session button with VA indicator
  const vaOverlay = renderVoiceAssistantOverlaySvg();
  if (vaOverlay) return vaOverlay;

  // CC No Session virtual state
  if (showingCcNoSession) {
    return simpleSvg('NO', 'SESSION', '#666666', '#1a1a1a');
  }

  // OpenClaw active — show whenever agentType reports openclaw (daemon-proxied or direct gateway)
  if (currentAgentType === 'openclaw') {
    return renderOpenClawSvg();
  }

  const isActive =
    currentState === State.PROCESSING ||
    currentState === State.AWAITING_PERMISSION ||
    currentState === State.AWAITING_OPTION ||
    currentState === State.AWAITING_DIFF;

  switch (isActive ? 'active' : currentState) {
    case State.DISCONNECTED:
      if (setupRequired) return setupRequiredSvg();
      return simpleSvg('NO', 'SESSION', '#666666', '#1a1a1a');

    case State.IDLE: {
      const currentSession = getCurrentSession();
      const name = currentSession
        ? getDisplayName(currentSession, sessions)
        : (currentProjectName || 'Session');
      // Adaptive maxChars: determine line count first, then use font-appropriate limit
      // 26px → ~10 chars, 20px → ~12 chars, 16px → ~14 chars (144px button)
      let nameLines = splitProjectName(name, MAX_CHARS_PER_LINE);
      let nameFs: number;
      if (nameLines.length === 1) {
        nameFs = 26;
      } else if (nameLines.length === 2) {
        nameFs = 20;
        nameLines = splitProjectName(name, 12); // re-split with wider limit
      } else {
        nameFs = 16;
        nameLines = splitProjectName(name, 14); // re-split with wider limit
      }
      const total = sessions.length;
      const modelLine = currentModel
        ? truncate(currentEffortLevel && currentEffortLevel !== 'medium' ? `${currentModel} · ${currentEffortLevel}` : currentModel, 14)
        : '';
      const modelFs = 20;

      // Build text elements for auto-centering
      const els: Array<{ text: string; fs: number; bold: boolean; opacity: number }> = [];
      const gaps: number[] = []; // gap between el[i] and el[i+1]

      for (const nl of nameLines) {
        els.push({ text: nl, fs: nameFs, bold: true, opacity: 1 });
      }
      if (modelLine) {
        els.push({ text: modelLine, fs: modelFs, bold: false, opacity: 0.65 });
      }
      for (let i = 0; i < els.length - 1; i++) {
        gaps.push(i < nameLines.length - 1 ? 4 : 12);
      }

      // Auto-center: place visual centers around button center (72)
      // Same approach as mode-button.ts which uses plain baseline y values
      const BUTTON_CENTER = 72;
      let span = 0;
      for (let i = 0; i < gaps.length; i++) {
        span += els[i].fs / 2 + gaps[i] + els[i + 1].fs / 2;
      }
      let cy = BUTTON_CENTER - span / 2;

      const lines: string[] = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#0a2e14"/>`,
        agentLogoWatermark('claude-code', '#4ade80', 0.08),
        `<circle cx="18" cy="18" r="5" fill="#4ade80"/>`,
      ];

      if (total > 1) {
        lines.push(
          `<rect x="102" y="6" width="36" height="20" rx="10" fill="#4ade80" opacity="0.25"/>`,
          `<text x="120" y="20" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="#4ade80">${currentSessionIndex + 1}/${total}</text>`,
        );
      }

      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const baseline = Math.round(cy + el.fs * 0.35);
        lines.push(
          `<text x="72" y="${baseline}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${el.fs}"${el.bold ? ' font-weight="bold"' : ''} fill="#4ade80"${el.opacity < 1 ? ` opacity="${el.opacity}"` : ''}>${escXml(el.text)}</text>`,
        );
        if (i < els.length - 1) {
          cy += els[i].fs / 2 + gaps[i] + els[i + 1].fs / 2;
        }
      }

      lines.push(`</svg>`);
      return lines.join('');
    }

    case 'active': {
      // Frame-based star spinner animation with state-specific colors
      const info = getStatusInfo();
      const detail = truncate(info.detail, 14);

      // Project name (up to 3 lines, 13px) — centered together with star+label+detail
      const currentSession = getCurrentSession();
      const projName = currentSession
        ? getDisplayName(currentSession, sessions)
        : (currentProjectName || '');
      const projLines = projName ? splitProjectName(projName, 12) : [];
      const projFs = 13;
      const projLineH = 11; // line spacing for project name lines

      // Build unified vertical stack: [projLines...] gap [star] gap [label] gap [detail]
      const starH = 20;
      const labelFs = 24;
      const detailFs = 16;
      const gapProj = 4;  // proj ↔ star
      const gap1 = 4;     // star ↔ label
      const gap2 = 6;     // label ↔ detail

      // Total span calculation
      const projSpan = projLines.length > 0 ? (projLines.length - 1) * projLineH + projFs : 0;
      const projGap = projLines.length > 0 ? gapProj : 0;
      const totalSpan = projSpan + projGap + starH + gap1 + labelFs + gap2 + detailFs;

      const BUTTON_CENTER = 72;
      let cy = BUTTON_CENTER - totalSpan / 2;

      // Rotation: 360° over ANIM_TOTAL_FRAMES
      const angle = Math.round((animFrame / ANIM_TOTAL_FRAMES) * 360);
      // Breathing opacity: sinusoidal 0.5–1.0
      const opacity = (0.75 + 0.25 * Math.sin((animFrame / ANIM_TOTAL_FRAMES) * Math.PI * 2)).toFixed(2);

      const lines: string[] = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="${info.bg}"/>`,
        agentLogoWatermark(currentAgentType || 'claude-code', info.color, 0.15),
      ];

      // Render project name lines
      for (let i = 0; i < projLines.length; i++) {
        const baseline = Math.round(cy + projFs * 0.35);
        lines.push(
          `<text x="72" y="${baseline}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${projFs}" fill="${info.color}" opacity="0.6">${escXml(truncate(projLines[i], 14))}</text>`,
        );
        cy += i < projLines.length - 1 ? projLineH : projFs / 2;
      }
      if (projLines.length > 0) cy += projGap + starH / 2;
      else cy += starH / 2;

      const starY = Math.round(cy);
      cy += starH / 2 + gap1 + labelFs / 2;
      const labelBaseline = Math.round(cy + labelFs * 0.35);
      cy += labelFs / 2 + gap2 + detailFs / 2;
      const detailBaseline = Math.round(cy + detailFs * 0.35);

      // Claude sparkle: 16x16 path centered at (-8,-8), scaled to ~24px
      const sparkleScale = 1.5;
      lines.push(
        `<g transform="translate(72, ${starY}) rotate(${angle}) scale(${sparkleScale}) translate(-8,-8)">`,
        `<path d="${CLAUDE_LOGO_PATH}" fill="${info.color}" opacity="${opacity}"/>`,
        `</g>`,
        `<text x="72" y="${labelBaseline}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="${info.color}">${info.label}</text>`,
        `<text x="72" y="${detailBaseline}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="${info.color}" opacity="0.7">${escXml(detail)}</text>`,
        `</svg>`,
      );
      return lines.join('');
    }

    default:
      return simpleSvg('???', '', '#666666', '#1a1a1a');
  }
}

function renderOpenClawSvg(): string {
  const isActive =
    currentState === State.PROCESSING ||
    currentState === State.AWAITING_PERMISSION ||
    currentState === State.AWAITING_OPTION;

  if (isActive) {
    // OC active states use the same spinner as CC but with OC colors
    const info = getStatusInfo();
    const detail = truncate(info.detail, 14);
    const angle = Math.round((animFrame / ANIM_TOTAL_FRAMES) * 360);
    const opacity = (0.75 + 0.25 * Math.sin((animFrame / ANIM_TOTAL_FRAMES) * Math.PI * 2)).toFixed(2);
    const projName = 'OpenClaw';
    const projLines = projName ? splitProjectName(projName, 12) : [];
    const projFs = 13;
    const projLineH = 11;
    const starH = 20;
    const labelFs = 24;
    const detailFs = 16;
    const gapProj = 4;
    const gap1 = 4;
    const gap2 = 6;
    const projSpan = projLines.length > 0 ? (projLines.length - 1) * projLineH + projFs : 0;
    const projGap = projLines.length > 0 ? gapProj : 0;
    const totalSpan = projSpan + projGap + starH + gap1 + labelFs + gap2 + detailFs;
    const BUTTON_CENTER = 72;
    let cy = BUTTON_CENTER - totalSpan / 2;

    // Use OC purple tint for background
    const bg = info.bg === '#2a1f00' ? '#1a0f2e' : info.bg === '#2a0f0f' ? '#2a0f1a' : '#0f1a2e';
    const lines: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
      `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="${bg}"/>`,
      agentLogoWatermark('openclaw', info.color, 0.20),
    ];

    for (let i = 0; i < projLines.length; i++) {
      const baseline = Math.round(cy + projFs * 0.35);
      lines.push(
        `<text x="72" y="${baseline}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${projFs}" fill="${info.color}" opacity="0.6">${escXml(truncate(projLines[i], 14))}</text>`,
      );
      cy += i < projLines.length - 1 ? projLineH : projFs / 2;
    }
    if (projLines.length > 0) cy += gapProj + starH / 2;
    else cy += starH / 2;

    const starY = Math.round(cy);
    cy += starH / 2 + gap1 + labelFs / 2;
    const labelBaseline = Math.round(cy + labelFs * 0.35);
    cy += labelFs / 2 + gap2 + detailFs / 2;
    const detailBaseline = Math.round(cy + detailFs * 0.35);

    lines.push(
      `<g transform="translate(72, ${starY}) rotate(${angle})">`,
      `<path d="M0,-10 L2,-3 L10,0 L2,3 L0,10 L-2,3 L-10,0 L-2,-3Z" fill="${info.color}" opacity="${opacity}"/>`,
      `</g>`,
      `<text x="72" y="${labelBaseline}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="${info.color}">${info.label}</text>`,
      `<text x="72" y="${detailBaseline}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="${info.color}" opacity="0.7">${escXml(detail)}</text>`,
      `</svg>`,
    );
    return lines.join('');
  }

  // OC IDLE — lobster watermark + project name, no [OC] badge
  const name = 'OpenClaw';
  const color = '#c084fc'; // purple for OC
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#1a0a2e"/>`,
    agentLogoWatermark('openclaw', color, 0.30),
    `<circle cx="18" cy="18" r="5" fill="#4ade80"/>`,
    `<text x="72" y="80" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="${color}">${escXml(name)}</text>`,
    `</svg>`,
  ];
  return lines.join('');
}

function simpleSvg(line1: string, line2: string, color: string, bg: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="${bg}"/>`,
    `<text x="72" y="64" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="${color}">${escXml(line1)}</text>`,
    `<text x="72" y="92" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="${color}">${escXml(line2)}</text>`,
    `</svg>`,
  ].join('');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@action({ UUID: 'bound.serendipity.agentdeck.session-button' })
export class SessionButtonAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!actionIds.includes(ev.action.id)) {
      actionIds.push(ev.action.id);
    }
    const svg = renderSessionSvg();
    await ev.action.setImage(svgToDataUrl(svg));
  }

  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    if (overrideConfig?.action) {
      dlog('SesBut', `keyDown: override action="${overrideConfig.action}"`);
      handleExpandedAction(overrideConfig.action, bridge);
      return;
    }
    keyDownTime = Date.now();
  }

  override async onKeyUp(_ev: KeyUpEvent): Promise<void> {
    if (overrideConfig) return; // override handled in keyDown
    const elapsed = Date.now() - keyDownTime;

    if (elapsed >= LONG_PRESS_MS) {
      focusTerminal();
    } else {
      cycleSession();
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = actionIds.indexOf(ev.action.id);
    if (idx !== -1) actionIds.splice(idx, 1);
  }
}

type CycleEntry =
  | { type: 'cc'; session: SessionEntry }
  | { type: 'oc' }
  | { type: 'cc-nosession' };

function buildCycleList(): CycleEntry[] {
  const ccEntries: CycleEntry[] = sessions.map(s => ({ type: 'cc' as const, session: s }));
  if (bridge.isGatewayAvailable()) {
    if (ccEntries.length === 0) {
      ccEntries.push({ type: 'cc-nosession' as const });
    }
    ccEntries.push({ type: 'oc' as const });
  }
  return ccEntries;
}

function cycleSession(): void {
  sessions = loadSessions();

  const cycleList = buildCycleList();

  // Nothing to cycle
  if (cycleList.length === 0) return;
  if (cycleList.length === 1 && !bridge.isGatewayAvailable()) return;

  // Find current position in cycle list
  let currentPos: number;
  if (showingCcNoSession) {
    currentPos = cycleList.findIndex(e => e.type === 'cc-nosession');
    if (currentPos === -1) currentPos = 0;
  } else if (currentAgentType === 'openclaw') {
    currentPos = cycleList.findIndex(e => e.type === 'oc');
    if (currentPos === -1) currentPos = cycleList.length - 1;
  } else if (bridge.getUserSelection() === 'gateway') {
    currentPos = cycleList.findIndex(e => e.type === 'oc');
    if (currentPos === -1) currentPos = cycleList.length - 1;
  } else {
    // Port-based lookup: find current bridge port in cycle list
    const currentPort = bridge.getBridgePort();
    const portIdx = cycleList.findIndex(e =>
      e.type === 'cc' && e.session.port === currentPort
    );
    currentPos = portIdx !== -1 ? portIdx : 0;
  }

  // If only one entry (current), nothing to cycle to
  if (cycleList.length <= 1) return;

  const nextPos = (currentPos + 1) % cycleList.length;
  const next = cycleList[nextPos];

  if (next.type === 'cc-nosession') {
    dlog('SesBut', `cycle: → NO SESSION`);
    setNoSessionMode(true);
  } else if (next.type === 'oc') {
    dlog('SesBut', `cycle: → OpenClaw`);
    const wasNoSession = showingCcNoSession;
    setNoSessionMode(false);
    if (!wasNoSession && !isProxiedOpenClaw()) {
      bridge.activateGateway();
    }
    // wasNoSession: already on gateway, just clear the virtual state
  } else {
    setNoSessionMode(false);
    const session = next.session;
    currentSessionIndex = sessions.indexOf(session);
    currentProjectName = session.projectName;
    // Reset stale state from previous session for instant visual feedback
    currentState = State.IDLE;
    currentTool = undefined;
    currentModel = undefined;
    currentEffortLevel = undefined;
    dlog('SesBut', `cycle: ${currentSessionIndex + 1}/${sessions.length} → ${getDisplayName(session, sessions)}:${session.port}`);
    suppressAutoSwitch();
    bridge.activateBridge();
    bridge.reconnectBridgeTo(session.port);
  }
  refreshAll();
  // Trigger full UI flush (encoders, response buttons, etc.) with reset state
  onSessionSwitched?.();
}

async function focusTerminal(): Promise<void> {
  try {
    const session = getCurrentSession();
    execSync(
      `osascript -e 'tell application "iTerm2" to activate' 2>/dev/null || osascript -e 'tell application "Terminal" to activate'`,
      { timeout: 3000 },
    );
    if (session?.tmuxSession) {
      try {
        execSync(`tmux select-window -t ${session.tmuxSession}`, { timeout: 2000 });
      } catch {
        // select-window failed → tmux is likely detached, attach in new iTerm tab
        const { attachTmuxInIterm } = await import('../utility-modes/macos.js');
        attachTmuxInIterm(session.tmuxSession);
      }
    }
  } catch {
    // Best effort
  }
}
