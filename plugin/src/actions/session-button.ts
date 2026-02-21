import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State, PermissionMode } from '@agentdeck/shared';
import { BridgeClient } from '../bridge-client.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { dlog } from '../log.js';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
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
  startedAt: string;
}

let bridge: BridgeClient;
let currentState = State.DISCONNECTED;
let currentMode = PermissionMode.DEFAULT;
let currentProjectName: string | undefined;
let currentTool: string | undefined;
let currentModel: string | undefined;
let currentSessionIndex = 0;
let sessions: SessionEntry[] = [];
let keyDownTime = 0;
let animTimer: ReturnType<typeof setInterval> | null = null;
let animFrame = 0;

const ANIM_INTERVAL_MS = 150; // ~6.7 FPS
const ANIM_TOTAL_FRAMES = 24; // full rotation = 24 frames × 150ms = 3.6s

const actionIds: string[] = [];

export function initSessionButton(b: BridgeClient): void {
  bridge = b;
}

export function updateSessionButton(
  state: State,
  mode: PermissionMode,
  project?: string,
  tool?: string,
  model?: string,
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
  const activeSessions = loadSessions();
  if (activeSessions.length === 0) return;

  const currentPort = bridge.getPort();
  const other = activeSessions.find((s) => s.port !== currentPort);
  if (other) {
    currentSessionIndex = activeSessions.indexOf(other);
    currentProjectName = other.projectName;
    bridge.reconnectTo(other.port);
  }
}

function loadSessions(): SessionEntry[] {
  try {
    const data = readFileSync(SESSIONS_FILE, 'utf-8');
    const parsed = JSON.parse(data) as SessionEntry[];
    return parsed;
  } catch {
    return [];
  }
}

function refreshAll(): void {
  const svg = renderSessionSvg();
  const dataUrl = svgToDataUrl(svg);
  for (const id of actionIds) {
    const act = streamDeck.actions.getActionById(id);
    if (act) {
      void act.setImage(dataUrl).catch(() => {});
    }
  }
}

/** Split a project name into 1 or 2 lines at natural boundaries */
function splitProjectName(name: string, maxChars: number): string[] {
  if (name.length <= maxChars) return [name];

  // Try splitting at camelCase boundary near midpoint
  const mid = Math.floor(name.length / 2);
  let bestSplit = -1;

  // Look for split points: camelCase, kebab-case, spaces
  for (let i = Math.max(1, mid - 4); i <= Math.min(name.length - 1, mid + 4); i++) {
    // camelCase boundary: lowercase followed by uppercase
    if (/[a-z]/.test(name[i - 1]) && /[A-Z]/.test(name[i])) {
      bestSplit = i;
      break;
    }
    // kebab-case or space
    if (name[i] === '-' || name[i] === '_' || name[i] === ' ') {
      bestSplit = i + 1;
      break;
    }
  }

  // Widen search if no split found near midpoint
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

  const line1 = name.slice(0, bestSplit).replace(/[-_ ]$/, '');
  const line2 = name.slice(bestSplit).replace(/^[-_ ]/, '');

  // Truncate each line if still too long
  return [
    truncate(line1, maxChars),
    truncate(line2, maxChars),
  ];
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

function renderSessionSvg(): string {
  const isActive =
    currentState === State.PROCESSING ||
    currentState === State.AWAITING_PERMISSION ||
    currentState === State.AWAITING_OPTION ||
    currentState === State.AWAITING_DIFF;

  switch (isActive ? 'active' : currentState) {
    case State.DISCONNECTED:
      return simpleSvg('NO', 'SESSION', '#666666', '#1a1a1a');

    case State.IDLE: {
      const name = currentProjectName || 'Session';
      const nameLines = splitProjectName(name, MAX_CHARS_PER_LINE);
      const isTwoLine = nameLines.length > 1;
      const total = sessions.length;
      const modelLine = currentModel ? truncate(currentModel, 12) : '';
      const nameFs = isTwoLine ? 20 : 26;
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
      const BUTTON_CENTER = 72;
      const starH = 20;
      const labelFs = 24;
      const detailFs = 16;
      const gap1 = 6;   // star ↔ label
      const gap2 = 8;   // label ↔ detail
      const span = starH / 2 + gap1 + labelFs / 2 + labelFs / 2 + gap2 + detailFs / 2;
      let cy = BUTTON_CENTER - span / 2;
      const starY = Math.round(cy);
      cy += starH / 2 + gap1 + labelFs / 2;
      const labelBaseline = Math.round(cy + labelFs * 0.35);
      cy += labelFs / 2 + gap2 + detailFs / 2;
      const detailBaseline = Math.round(cy + detailFs * 0.35);

      // Rotation: 360° over ANIM_TOTAL_FRAMES
      const angle = Math.round((animFrame / ANIM_TOTAL_FRAMES) * 360);
      // Breathing opacity: sinusoidal 0.5–1.0
      const opacity = (0.75 + 0.25 * Math.sin((animFrame / ANIM_TOTAL_FRAMES) * Math.PI * 2)).toFixed(2);

      return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="${info.bg}"/>`,
        `<g transform="translate(72, ${starY}) rotate(${angle})">`,
        `<path d="M0,-10 L2,-3 L10,0 L2,3 L0,10 L-2,3 L-10,0 L-2,-3Z" fill="${info.color}" opacity="${opacity}"/>`,
        `</g>`,
        `<text x="72" y="${labelBaseline}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="${info.color}">${info.label}</text>`,
        `<text x="72" y="${detailBaseline}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="${info.color}" opacity="0.7">${escXml(detail)}</text>`,
        `</svg>`,
      ].join('');
    }

    default:
      return simpleSvg('???', '', '#666666', '#1a1a1a');
  }
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
    keyDownTime = Date.now();
  }

  override async onKeyUp(_ev: KeyUpEvent): Promise<void> {
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

function cycleSession(): void {
  sessions = loadSessions();
  if (sessions.length <= 1) return;

  currentSessionIndex = (currentSessionIndex + 1) % sessions.length;
  const next = sessions[currentSessionIndex];
  if (next) {
    dlog('SesBut', `cycle: ${currentSessionIndex + 1}/${sessions.length} → ${next.projectName}:${next.port}`);
    currentProjectName = next.projectName;
    bridge.reconnectTo(next.port);
    refreshAll();
  }
}

function focusTerminal(): void {
  try {
    const session = sessions[currentSessionIndex];
    execSync(
      `osascript -e 'tell application "iTerm2" to activate' 2>/dev/null || osascript -e 'tell application "Terminal" to activate'`,
      { timeout: 3000 },
    );
    if (session?.tmuxSession) {
      execSync(`tmux select-window -t ${session.tmuxSession}`, {
        timeout: 2000,
      });
    }
  } catch {
    // Best effort
  }
}
