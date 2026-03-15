/**
 * TUI Dashboard renderer — layout calculation + panel rendering.
 *
 * Width invariant: every output line is exactly `cols` characters wide (visually).
 * Box structure:
 *   Wide:     ┌─leftW─┬─rightW─┐  where leftW + rightW + 3 = cols
 *   Std/Nar:  ┌──w────┐         where w + 2 = cols
 *   Split:    │ lh │ rh │       where lh + rh + 3 = cols
 */

import {
  cursor, screen as screenCodes, RESET, BOLD, DIM,
  colors, box, hLine, sgr, stateColor, stateIcon,
  truncText, padRight, visLen,
} from './ansi.js';
import { blockGauge, resetTimeStr, formatUptime, formatTokens } from './gauge.js';
import type { DashboardState, LayoutMode } from './dashboard.js';
import type { TimelineEntry, TimelineEntryType } from '@agentdeck/shared';

// ===== Layout Breakpoints =====

export function getLayout(cols: number, rows: number): LayoutMode {
  if (cols >= 120) return 'wide';
  if (cols >= 80) return 'standard';
  return 'narrow';
}

export function shouldShowTerrarium(cols: number, rows: number): boolean {
  if (cols < 60) return false;
  if (rows < 16) return false;
  return true;
}

// ===== Border Line Builder =====

function borderFill(prefix: string, suffix: string, targetWidth: number): string {
  const fillLen = Math.max(0, targetWidth - visLen(prefix) - visLen(suffix));
  return prefix + `${colors.border}${hLine(fillLen)}${RESET}` + suffix;
}

// ===== Pixel Font (4 wide × 6 tall → 4×3 half-block) =====

const FONT: Record<string, string[]> = {
  A: ['.##.', '#..#', '####', '#..#', '#..#', '....'],
  G: ['.###', '#...', '#.##', '#..#', '.##.', '....'],
  E: ['####', '#...', '###.', '#...', '####', '....'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#', '....'],
  T: ['####', '.##.', '.##.', '.##.', '.##.', '....'],
  D: ['###.', '#..#', '#..#', '#..#', '###.', '....'],
  C: ['.###', '#...', '#...', '#...', '.###', '....'],
  K: ['#..#', '#.#.', '##..', '#.#.', '#..#', '....'],
};

/** Render a word in half-block pixel font. Returns 3 terminal lines. */
function renderPixelFont(word: string): string[] {
  const result = ['', '', ''];
  for (let li = 0; li < word.length; li++) {
    if (li > 0) { result[0] += ' '; result[1] += ' '; result[2] += ' '; }
    const pixels = FONT[word[li]];
    if (!pixels) continue;
    for (let hr = 0; hr < 3; hr++) {
      const topRow = pixels[hr * 2];
      const botRow = pixels[hr * 2 + 1];
      for (let col = 0; col < 4; col++) {
        const top = topRow[col] === '#';
        const bot = botRow[col] === '#';
        if (top && bot) result[hr] += '\u2588';      // █
        else if (top) result[hr] += '\u2580';          // ▀
        else if (bot) result[hr] += '\u2584';          // ▄
        else result[hr] += ' ';
      }
    }
  }
  return result;
}

// Pre-render logo lines
const LOGO_AGENT = renderPixelFont('AGENT'); // 3 lines, 24 chars each (5*4 + 4 spaces)
const LOGO_DECK = renderPixelFont('DECK');   // 3 lines, 19 chars each (4*4 + 3 spaces)

// ===== Timeline Icons =====

function typeIcon(type: TimelineEntryType): string {
  switch (type) {
    case 'chat_start': case 'user_action': return '\u25B6';
    case 'chat_end': return '\u25A0';
    case 'chat_response': return '\u25A1';
    case 'tool_request': case 'tool_exec': return '\u25C6';
    case 'tool_resolved': return '\u2713';
    case 'error': return '\u2717';
    case 'model_call': case 'model_response': return '\u25C8';
    case 'memory_recall': return '\u25CC';
    case 'scheduled': return '\u25D1';
    default: return '\u25C6';
  }
}

function typeColor(type: TimelineEntryType): string {
  switch (type) {
    case 'chat_start': case 'user_action': return colors.chat;
    case 'chat_end': case 'chat_response': return colors.end;
    case 'tool_request': case 'tool_exec': case 'tool_resolved': return colors.tool;
    case 'error': return colors.errorTl;
    case 'model_call': case 'model_response': return sgr(35);
    case 'memory_recall': return sgr(33);
    default: return colors.dim;
  }
}

const SPINNER_FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

export function spinner(frame: number): string {
  return SPINNER_FRAMES[Math.floor(frame / 2) % SPINNER_FRAMES.length];
}

// ===== Creature Emoji Helper =====

function creatureEmoji(agentType?: string): string {
  if ((agentType as string) === 'daemon') return '\u2699\uFE0F';
  if ((agentType as string) === 'openclaw') return '\uD83E\uDD9E';
  return '\uD83D\uDC19';
}

// ===== Panel Renderers =====

function renderAgentLines(state: DashboardState, maxWidth: number, useLogo: boolean): string[] {
  const lines: string[] = [];

  // Big pixel-font logo (3 rows AGENT + 3 rows DECK) when wide enough
  if (useLogo && maxWidth >= 24) {
    for (const l of LOGO_AGENT) lines.push(`${colors.header}${l}${RESET}`);
    lines.push('');
    for (const l of LOGO_DECK) lines.push(`${colors.header} ${l}${RESET}`); // indent DECK
  } else if (useLogo && maxWidth >= 10) {
    lines.push(`${colors.header} AgentDeck${RESET}`);
  }
  lines.push('');

  // Session list
  const renderSession = (
    proj: string, model: string | undefined, sessState: string, agentType?: string,
  ) => {
    const icon = stateIcon(sessState);
    const col = stateColor(sessState);
    const name = truncText(proj, maxWidth - 12);
    const emoji = creatureEmoji(agentType);
    lines.push(` ${emoji} ${col}${name}${RESET}`);
    if (model) lines.push(`${colors.dim}    ${model}${RESET}`);
    lines.push(`    ${col}${icon} ${sessState.toUpperCase().replace(/_/g, ' ')}${RESET}`);
  };

  // When connected to daemon: sessions list has all real sessions
  // When connected to session bridge: sessions has siblings only — add self first
  if (state.agentType === 'daemon') {
    for (const sess of state.sessions) {
      renderSession(sess.projectName || 'unknown', undefined,
        sess.state || 'idle', sess.agentType as string | undefined);
    }
  } else if (state.state) {
    // Self (primary session)
    renderSession(state.projectName || 'unknown', state.modelName ?? undefined,
      state.state, state.agentType ?? undefined);
    // Siblings (other sessions)
    for (const sess of state.sessions) {
      renderSession(sess.projectName || 'unknown', undefined,
        sess.state || 'idle', sess.agentType as string | undefined);
    }
  }

  // Virtual OpenClaw entry when gateway detected but not in sessions list
  const hasOcSession = state.sessions.some(s =>
    s.agentType === 'openclaw' || (s.agentType as string) === 'gateway'
  );
  if (state.gatewayAvailable && !hasOcSession) {
    renderSession('OpenClaw', undefined, state.crayfishRouting ? 'processing' : 'idle', 'openclaw');
  }

  lines.push('');

  if (state.usage) {
    const u = state.usage;
    if (u.inputTokens || u.outputTokens) {
      lines.push(`${colors.dim} Tokens: ${formatTokens(u.inputTokens)}/${formatTokens(u.outputTokens)}${RESET}`);
    }
    if (u.estimatedCostUsd) {
      lines.push(`${colors.dim} Cost: $${u.estimatedCostUsd.toFixed(2)}${RESET}`);
    }
    if (u.sessionDurationSec) {
      lines.push(`${colors.dim} Up: ${formatUptime(u.sessionDurationSec)}${RESET}`);
    }
  }

  return lines;
}

// ===== Status Panel: LIMITS | MODELS =====

function renderStatusLimitsLines(state: DashboardState, width: number): string[] {
  const lines: string[] = [];
  const u = state.usage;
  if (!u) return lines;
  const gaugeW = Math.min(10, Math.floor(width * 0.3));
  if (u.fiveHourPercent !== undefined) {
    const pct = Math.round(u.fiveHourPercent);
    lines.push(` 5h [${blockGauge(pct, gaugeW)}] ${pct}%`);
    const reset = resetTimeStr(u.fiveHourResetsAt);
    if (reset) lines.push(`${colors.dim}    ${reset}${RESET}`);
  }
  if (u.sevenDayPercent !== undefined) {
    const pct = Math.round(u.sevenDayPercent);
    lines.push(` 7d [${blockGauge(pct, gaugeW)}] ${pct}%`);
    const reset = resetTimeStr(u.sevenDayResetsAt);
    if (reset) lines.push(`${colors.dim}    ${reset}${RESET}`);
  }
  if (state.currentTool) {
    lines.push(` ${colors.tool}${truncText(state.currentTool, width - 2)}${RESET}`);
  }
  return lines;
}

function renderStatusModelsLines(state: DashboardState, width: number): string[] {
  const lines: string[] = [];
  const u = state.usage;
  if (state.modelName) {
    const dot = u?.oauthConnected ? `${colors.idle}\u25CF${RESET}` : `${colors.dim}\u25CB${RESET}`;
    lines.push(` ${dot} ${state.modelName}`);
  }
  if (u?.ollamaStatus?.available && u.ollamaStatus.models.length > 0) {
    lines.push(`${colors.dim} Ollama:${RESET}`);
    for (const m of u.ollamaStatus.models.slice(0, 3)) {
      const size = m.size > 0 ? ` ${(m.size / 1e9).toFixed(1)}G` : '';
      lines.push(`${colors.dim}  ${truncText(m.name, width - 8)}${size}${RESET}`);
    }
  } else if (u?.ollamaStatus) {
    lines.push(`${colors.dim} Ollama: stopped${RESET}`);
  }
  return lines;
}

function renderStatusLines(state: DashboardState, width: number): string[] {
  const lines: string[] = [];
  const u = state.usage;
  if (u) {
    const gaugeW = Math.min(12, Math.floor(width * 0.15));
    if (u.fiveHourPercent !== undefined) {
      const pct = Math.round(u.fiveHourPercent);
      lines.push(` 5h [${blockGauge(pct, gaugeW)}] ${pct}% ${colors.dim}${resetTimeStr(u.fiveHourResetsAt)}${RESET}`);
    }
    if (u.sevenDayPercent !== undefined) {
      const pct = Math.round(u.sevenDayPercent);
      lines.push(` 7d [${blockGauge(pct, gaugeW)}] ${pct}% ${colors.dim}${resetTimeStr(u.sevenDayResetsAt)}${RESET}`);
    }
  }
  if (state.currentTool) lines.push(` ${colors.tool}Tool: ${truncText(state.currentTool, width - 8)}${RESET}`);
  if (state.modelName) lines.push(`${colors.dim} Model: ${state.modelName}${RESET}`);
  return lines;
}

function renderTimelineLines(
  state: DashboardState, width: number, maxLines: number, scrollOffset: number,
): string[] {
  const lines: string[] = [];
  const entries = state.timeline;
  if (entries.length === 0) {
    lines.push(`${colors.dim} No events yet${RESET}`);
    return lines;
  }
  const start = Math.max(0, entries.length - maxLines - scrollOffset);
  const end = Math.min(entries.length, start + maxLines);
  for (let i = start; i < end; i++) {
    const e = entries[i];
    const time = new Date(e.ts);
    const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    const raw = truncText(e.raw, width - 10);
    const pending = e.status === 'pending' ? `${colors.dim} [PENDING]${RESET}` : '';
    lines.push(` ${colors.dim}${timeStr}${RESET} ${typeColor(e.type)}${typeIcon(e.type)}${RESET} ${raw}${pending}`);
  }
  return lines;
}

// ===== Output Helper =====

/** Write buf lines to screen. Last row reserved for q quit hint. */
function flushBuf(buf: string[], cols: number, rows: number): string {
  const maxBoxRows = rows - 1;
  let output = cursor.moveTo(1, 1);
  const limit = Math.min(buf.length, maxBoxRows);
  for (let i = 0; i < limit; i++) {
    output += cursor.moveTo(i + 1, 1) + screenCodes.clearLine + buf[i];
  }
  for (let i = limit; i < maxBoxRows; i++) {
    output += cursor.moveTo(i + 1, 1) + screenCodes.clearLine;
  }
  // q quit on last row
  output += cursor.moveTo(rows, 1) + screenCodes.clearLine +
    ` ${colors.dimCyan}q quit${RESET}`;
  return output;
}

// ===== Main Render =====

export function renderDashboard(
  state: DashboardState, cols: number, rows: number,
  terrariumLines: string[], frame: number, scrollOffset: number,
): string {
  const layout = getLayout(cols, rows);
  if (cols < 40 || rows < 10) {
    return cursor.moveTo(1, 1) + screenCodes.clear +
      `Resize terminal to at least 60\u00D716 (current: ${cols}\u00D7${rows})`;
  }
  const connIcon = state.connectionStatus === 'connected' ? `${colors.idle}\u25CF` :
    state.connectionStatus === 'reconnecting' ? `${colors.processing}\u25D4` :
    `${colors.disconnected}\u25CB`;
  const staleTag = state.isStale ? ` ${colors.error}[STALE]${RESET}` : '';
  const spinnerStr = state.state === 'processing'
    ? ` ${colors.processing}${spinner(frame)}${RESET}` : '';

  if (layout === 'wide') return renderWideLayout(state, cols, rows, terrariumLines, frame, scrollOffset, connIcon, staleTag, spinnerStr);
  if (layout === 'standard') return renderStandardLayout(state, cols, rows, terrariumLines, frame, scrollOffset, connIcon, staleTag, spinnerStr);
  return renderNarrowLayout(state, cols, rows, frame, scrollOffset, connIcon, staleTag, spinnerStr);
}

// ===== Wide Layout =====

function renderWideLayout(
  state: DashboardState, cols: number, rows: number,
  terrariumLines: string[], frame: number, scrollOffset: number,
  connIcon: string, staleTag: string, spinnerStr: string,
): string {
  const leftW = Math.max(20, Math.floor(cols * 0.22));
  const rightW = cols - leftW - 3;
  const buf: string[] = [];

  // Top border
  const topLeft = `${colors.border}${box.tl}${box.h} AGENTS ${RESET}`;
  const topMid = `${colors.border}${box.tee}${box.h} TERRARIUM ${RESET}${connIcon}${RESET}${spinnerStr}${staleTag} `;
  const topRight = `${colors.border}${box.tr}${RESET}`;
  const leftFillLen = Math.max(0, leftW + 1 - visLen(topLeft));
  const rightFillLen = Math.max(0, rightW + 2 - visLen(topMid) - visLen(topRight));
  buf.push(topLeft + `${colors.border}${hLine(leftFillLen)}${RESET}` + topMid + `${colors.border}${hLine(rightFillLen)}${RESET}` + topRight);

  const agentLines = renderAgentLines(state, leftW - 2, true);

  // Status: LIMITS | MODELS
  const tH = terrariumLines.length;
  const statusLimitW = Math.floor(rightW * 0.4);
  const statusModelW = rightW - statusLimitW - 1;
  const limitsLines = renderStatusLimitsLines(state, statusLimitW);
  const modelsLines = renderStatusModelsLines(state, statusModelW);
  const statusH = Math.max(3, Math.max(limitsLines.length, modelsLines.length) + 1);

  const boxContentRows = rows - 3; // top border + bottom border + q quit row
  const timelineH = Math.max(3, boxContentRows - tH - statusH - 2);
  const tlLines = renderTimelineLines(state, rightW - 2, timelineH - 1, scrollOffset);

  for (let r = 0; r < boxContentRows; r++) {
    const leftContent = padRight(r < agentLines.length ? agentLines[r] : '', leftW);

    let rightContent = '';
    if (r < tH) {
      rightContent = terrariumLines[r] || '';
    } else if (r === tH) {
      rightContent = `${colors.border}${hLine(statusLimitW)}${RESET}` +
        `${colors.border}\u252C${RESET}` +
        `${colors.border}${hLine(statusModelW)}${RESET}`;
    } else if (r < tH + 1 + statusH) {
      const si = r - tH - 1;
      if (si === 0) {
        rightContent = padRight(`${colors.header} LIMITS${RESET}`, statusLimitW) +
          `${colors.border}${box.v}${RESET}` +
          padRight(`${colors.header} MODELS${RESET}`, statusModelW);
      } else {
        const li = si - 1;
        rightContent = padRight(li < limitsLines.length ? limitsLines[li] : '', statusLimitW) +
          `${colors.border}${box.v}${RESET}` +
          padRight(li < modelsLines.length ? modelsLines[li] : '', statusModelW);
      }
    } else if (r === tH + 1 + statusH) {
      rightContent = `${colors.border}${hLine(rightW)}${RESET}`;
    } else {
      const ti = r - tH - statusH - 2;
      if (ti === 0) rightContent = `${colors.header} TIMELINE${RESET}`;
      else rightContent = ti - 1 < tlLines.length ? tlLines[ti - 1] : '';
    }

    buf.push(
      `${colors.border}${box.v}${RESET}${padRight(leftContent, leftW)}` +
      `${colors.border}${box.v}${RESET}${padRight(rightContent, rightW)}` +
      `${colors.border}${box.v}${RESET}`
    );
  }

  buf.push(`${colors.border}${box.bl}${hLine(leftW)}${box.bTee}${hLine(rightW)}${box.br}${RESET}`);
  return flushBuf(buf, cols, rows);
}

// ===== Standard Layout =====

function renderStandardLayout(
  state: DashboardState, cols: number, rows: number,
  terrariumLines: string[], frame: number, scrollOffset: number,
  connIcon: string, staleTag: string, spinnerStr: string,
): string {
  const w = cols - 2;
  const buf: string[] = [];

  buf.push(borderFill(
    `${colors.border}${box.tl}${box.h} TERRARIUM ${RESET}${connIcon}${RESET}${spinnerStr}${staleTag} `,
    `${colors.border}${box.tr}${RESET}`, cols));

  for (const tl of terrariumLines) {
    buf.push(`${colors.border}${box.v}${RESET}${padRight(tl, w)}${colors.border}${box.v}${RESET}`);
  }

  const leftHalf = Math.floor(w / 2);
  const rightHalf = w - leftHalf - 1;

  const splitPrefix = `${colors.border}${box.lTee}${box.h} STATUS ${RESET}`;
  const splitMid = `${colors.border}${box.tee}${box.h} AGENTS ${RESET}`;
  const splitSuffix = `${colors.border}${box.rTee}${RESET}`;
  buf.push(
    splitPrefix + `${colors.border}${hLine(Math.max(0, leftHalf + 1 - visLen(splitPrefix)))}${RESET}` +
    splitMid + `${colors.border}${hLine(Math.max(0, rightHalf + 2 - visLen(splitMid) - visLen(splitSuffix)))}${RESET}` + splitSuffix
  );

  const statusLines = renderStatusLines(state, leftHalf - 1);
  const agentCompact = renderAgentCompactLines(state, rightHalf - 1);
  const pairRows = Math.max(statusLines.length, agentCompact.length, 3);

  for (let r = 0; r < pairRows; r++) {
    buf.push(
      `${colors.border}${box.v}${RESET}${padRight(r < statusLines.length ? statusLines[r] : '', leftHalf)}` +
      `${colors.border}${box.v}${RESET}${padRight(r < agentCompact.length ? agentCompact[r] : '', rightHalf)}` +
      `${colors.border}${box.v}${RESET}`
    );
  }

  buf.push(`${colors.border}${box.lTee}${hLine(leftHalf)}${box.bTee}${hLine(rightHalf)}${box.rTee}${RESET}`);
  buf.push(
    `${colors.border}${box.v}${RESET}${colors.header} TIMELINE${RESET}` +
    `${' '.repeat(Math.max(0, w - 9))}${colors.border}${box.v}${RESET}`
  );

  const tlAvailable = Math.max(2, rows - buf.length - 1);
  const tlLines = renderTimelineLines(state, w - 1, tlAvailable, scrollOffset);
  for (const tl of tlLines) {
    buf.push(`${colors.border}${box.v}${RESET}${padRight(tl, w)}${colors.border}${box.v}${RESET}`);
  }

  buf.push(`${colors.border}${box.bl}${hLine(w)}${box.br}${RESET}`);
  return flushBuf(buf, cols, rows);
}

function renderAgentCompactLines(state: DashboardState, width: number): string[] {
  const lines: string[] = [];
  if (state.agentType === 'daemon') {
    for (const s of state.sessions) {
      const st = s.state || 'idle';
      const col = stateColor(st);
      const emoji = creatureEmoji(s.agentType as string | undefined);
      lines.push(` ${emoji} ${truncText(s.projectName || '?', width - 18)} ${col}${stateIcon(st)}${st.toUpperCase().replace(/_/g, ' ').slice(0, 8)}${RESET}`);
    }
  } else if (state.state) {
    // Self first
    const col = stateColor(state.state);
    const proj = truncText(state.projectName || '?', width - 20);
    const model = state.modelName ? ` \u00B7 ${state.modelName}` : '';
    const emoji = creatureEmoji(state.agentType ?? undefined);
    lines.push(` ${emoji} ${proj}${colors.dim}${model}${RESET} ${col}${stateIcon(state.state)}${state.state.toUpperCase().replace(/_/g, ' ')}${RESET}`);
    // Siblings
    for (const s of state.sessions) {
      const st = s.state || 'idle';
      const sCol = stateColor(st);
      const sEmoji = creatureEmoji(s.agentType as string | undefined);
      lines.push(` ${sEmoji} ${truncText(s.projectName || '?', width - 18)} ${sCol}${stateIcon(st)}${st.toUpperCase().replace(/_/g, ' ').slice(0, 8)}${RESET}`);
    }
  }
  // Virtual OpenClaw entry
  const hasOcCompact = state.sessions.some(s =>
    s.agentType === 'openclaw' || (s.agentType as string) === 'gateway'
  );
  if (state.gatewayAvailable && !hasOcCompact) {
    const ocState = state.crayfishRouting ? 'processing' : 'idle';
    const ocCol = stateColor(ocState);
    const ocEmoji = creatureEmoji('openclaw');
    lines.push(` ${ocEmoji} OpenClaw ${ocCol}${stateIcon(ocState)}${ocState.toUpperCase()}${RESET}`);
  }
  if (state.usage) {
    const u = state.usage;
    const parts: string[] = [];
    if (u.inputTokens || u.outputTokens) parts.push(`${formatTokens(u.inputTokens)}/${formatTokens(u.outputTokens)}`);
    if (u.estimatedCostUsd) parts.push(`$${u.estimatedCostUsd.toFixed(2)}`);
    if (u.sessionDurationSec) parts.push(formatUptime(u.sessionDurationSec));
    if (parts.length > 0) lines.push(`${colors.dim} ${parts.join('  ')}${RESET}`);
  }
  return lines;
}

// ===== Narrow Layout =====

function renderNarrowLayout(
  state: DashboardState, cols: number, rows: number,
  frame: number, scrollOffset: number,
  connIcon: string, staleTag: string, spinnerStr: string,
): string {
  const w = cols - 2;
  const buf: string[] = [];

  buf.push(borderFill(
    `${colors.border}${box.tl}${box.h} AgentDeck ${RESET}${connIcon}${RESET}${spinnerStr}${staleTag} `,
    `${colors.border}${box.tr}${RESET}`, cols));

  for (const al of renderAgentCompactLines(state, w - 1)) {
    buf.push(`${colors.border}${box.v}${RESET}${padRight(al, w)}${colors.border}${box.v}${RESET}`);
  }

  buf.push(`${colors.border}${box.lTee}${hLine(w)}${box.rTee}${RESET}`);

  for (const sl of renderStatusLines(state, w - 1)) {
    buf.push(`${colors.border}${box.v}${RESET}${padRight(sl, w)}${colors.border}${box.v}${RESET}`);
  }

  buf.push(`${colors.border}${box.lTee}${hLine(w)}${box.rTee}${RESET}`);

  const tlAvailable = Math.max(2, rows - buf.length - 1);
  const tlLines = renderTimelineLines(state, w - 1, tlAvailable, scrollOffset);
  for (const tl of tlLines) {
    buf.push(`${colors.border}${box.v}${RESET}${padRight(tl, w)}${colors.border}${box.v}${RESET}`);
  }

  buf.push(`${colors.border}${box.bl}${hLine(w)}${box.br}${RESET}`);
  return flushBuf(buf, cols, rows);
}
