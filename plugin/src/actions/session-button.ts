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
const MAX_CHARS_PER_LINE = 11;

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

function renderSessionSvg(): string {
  // Change 6: AWAITING_ states render same as PROCESSING
  const effectiveState =
    currentState === State.AWAITING_PERMISSION ||
    currentState === State.AWAITING_OPTION ||
    currentState === State.AWAITING_DIFF
      ? State.PROCESSING
      : currentState;

  switch (effectiveState) {
    case State.DISCONNECTED:
      return simpleSvg('NO', 'SESSION', '#666666', '#1a1a1a');

    case State.IDLE: {
      const name = currentProjectName || 'Session';
      const nameLines = splitProjectName(name, MAX_CHARS_PER_LINE);
      const isTwoLine = nameLines.length > 1;
      const total = sessions.length;
      const modelLine = currentModel ? truncate(currentModel, 16) : '';

      const lines: string[] = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#0a2e14"/>`,
        // Green dot = connected
        `<circle cx="18" cy="18" r="5" fill="#4ade80"/>`,
      ];

      // Change 3: Session count badge (top-right, only when >1 session)
      if (total > 1) {
        lines.push(
          `<rect x="102" y="6" width="36" height="20" rx="10" fill="#4ade80" opacity="0.25"/>`,
          `<text x="120" y="20" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="#4ade80">${currentSessionIndex + 1}/${total}</text>`,
        );
      }

      // Change 1: Project name — 1 or 2 lines
      if (isTwoLine) {
        lines.push(
          `<text x="72" y="44" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#4ade80">${escXml(nameLines[0])}</text>`,
          `<text x="72" y="62" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#4ade80">${escXml(nameLines[1])}</text>`,
        );
      } else {
        lines.push(
          `<text x="72" y="52" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="bold" fill="#4ade80">${escXml(nameLines[0])}</text>`,
        );
      }

      // Change 2: Mode label removed (shown on Mode Toggle button instead)

      // Change 4: Model name — larger
      if (modelLine) {
        const modelY = isTwoLine ? 90 : 82;
        lines.push(
          `<text x="72" y="${modelY}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#4ade80" opacity="0.65">${escXml(modelLine)}</text>`,
        );
      }

      lines.push(`</svg>`);
      return lines.join('');
    }

    case State.PROCESSING: {
      // Change 5: Star spinner animation
      const tool = truncate(currentTool || 'Thinking...', 14);
      return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#2a1f00"/>`,
        // 4-point star with rotation + breathing opacity
        `<g transform="translate(72, 28)">`,
        `<path d="M0,-10 L2,-3 L10,0 L2,3 L0,10 L-2,3 L-10,0 L-2,-3Z" fill="#fbbf24">`,
        `<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s" repeatCount="indefinite"/>`,
        `<animate attributeName="opacity" values="0.9;0.5;0.9" dur="1.2s" repeatCount="indefinite"/>`,
        `</path>`,
        `</g>`,
        `<text x="72" y="68" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="#fbbf24">RUNNING</text>`,
        `<text x="72" y="96" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#fbbf24" opacity="0.7">${escXml(tool)}</text>`,
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
