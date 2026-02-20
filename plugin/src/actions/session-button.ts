import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State, PermissionMode } from '@streamdeck-claude/shared';
import { BridgeClient } from '../bridge-client.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { dlog } from '../log.js';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';

const SIZE = 144;
const LONG_PRESS_MS = 500;
const SESSIONS_FILE = `${homedir()}/.streamdeck-claude/sessions.json`;

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
  currentTool = tool;
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

function renderSessionSvg(): string {
  switch (currentState) {
    case State.DISCONNECTED:
      return simpleSvg('NO', 'SESSION', '#666666', '#1a1a1a');

    case State.IDLE: {
      const name = truncate(currentProjectName || 'Session', 12);
      const modeLabel =
        currentMode === PermissionMode.PLAN ? 'Plan Mode'
        : currentMode === PermissionMode.ACCEPT_EDITS ? 'Accept Edits'
        : 'Default';
      const total = sessions.length;
      const indicator = total > 1 ? ` [${currentSessionIndex + 1}/${total}]` : '';
      const modelLine = currentModel ? truncate(currentModel, 20) : '';

      const lines: string[] = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#0a2e14"/>`,
        // Green dot = connected
        `<circle cx="18" cy="18" r="5" fill="#4ade80"/>`,
        // Project name (large)
        `<text x="72" y="48" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="bold" fill="#4ade80">${escXml(name)}</text>`,
        // Mode label
        `<text x="72" y="72" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#4ade80" opacity="0.7">${escXml(modeLabel)}${escXml(indicator)}</text>`,
      ];

      if (modelLine) {
        lines.push(
          `<text x="72" y="96" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#4ade80" opacity="0.4">${escXml(modelLine)}</text>`,
        );
      }

      lines.push(`</svg>`);
      return lines.join('');
    }

    case State.PROCESSING: {
      const tool = truncate(currentTool || 'Thinking...', 14);
      return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#2a1f00"/>`,
        `<circle cx="72" cy="28" r="8" fill="#fbbf24"><animate attributeName="opacity" values="1;0.3;1" dur="1.2s" repeatCount="indefinite"/></circle>`,
        `<text x="72" y="68" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="#fbbf24">RUNNING</text>`,
        `<text x="72" y="96" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#fbbf24" opacity="0.7">${escXml(tool)}</text>`,
        `</svg>`,
      ].join('');
    }

    case State.AWAITING_PERMISSION:
      return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#2a0a0a"/>`,
        `<text x="72" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="bold" fill="#f87171">PERMISSION</text>`,
        `<text x="72" y="88" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#f87171" opacity="0.7">Yes / No / Always</text>`,
        `</svg>`,
      ].join('');

    case State.AWAITING_OPTION:
      return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#0a1a2e"/>`,
        `<text x="72" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="bold" fill="#60a5fa">SELECT</text>`,
        `<text x="72" y="88" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#60a5fa" opacity="0.7">Choose option</text>`,
        `</svg>`,
      ].join('');

    case State.AWAITING_DIFF:
      return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
        `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#1a0a2e"/>`,
        `<text x="72" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="bold" fill="#c084fc">DIFF</text>`,
        `<text x="72" y="88" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#c084fc" opacity="0.7">Apply / Deny / View</text>`,
        `</svg>`,
      ].join('');

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
