/**
 * Project Picker — DISCONNECTED state project selector.
 * Takes over encoder LCDs to show project list, buttons show current page items.
 */
import streamDeck from '@elgato/streamdeck';
import { scanProjects, ProjectEntry } from './project-scanner.js';
import { osascript } from './utility-modes/macos.js';
import { encoderRegistry, encoderLayout } from './encoder-registry.js';
import { svgToDataUrl } from './renderers/button-renderer.js';
import { ButtonConfig } from './layout-manager.js';
import { dlog } from './log.js';

const PIXMAP_LAYOUT = 'layouts/option-pixmap-layout.json';

let active = false;
let projects: ProjectEntry[] = [];
let cursor = 0;
let baseDir = '~/Documents';
let refreshButtonsCb: ((configs: ButtonConfig[] | null) => void) | null = null;

/** Register callback to update response buttons (avoids circular dep) */
export function setPickerButtonCallback(cb: (configs: ButtonConfig[] | null) => void): void {
  refreshButtonsCb = cb;
}

export function isPickerActive(): boolean {
  return active;
}

export function setPickerBaseDir(dir: string): void {
  baseDir = dir;
}

export async function openPicker(): Promise<void> {
  projects = scanProjects(baseDir);
  if (projects.length === 0) {
    dlog('Picker', `no projects found in ${baseDir}`);
    // Fallback: just launch agentdeck in baseDir
    await launchAgentdeck(baseDir);
    return;
  }
  cursor = 0;
  active = true;
  dlog('Picker', `opened: ${projects.length} projects`);

  // Take over encoder LCDs
  const allIds = getAllEncoderIds();
  const promises: Promise<void>[] = [];
  for (const id of allIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) promises.push(dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {}));
  }
  await Promise.all(promises);

  refreshPicker();
  refreshPickerButtons();
}

export function closePicker(): void {
  if (!active) return;
  active = false;
  dlog('Picker', 'closed');

  // Restore encoder layouts
  const defaultLayout = 'layouts/voice-layout.json';
  for (const id of getAllEncoderIds()) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(defaultLayout).catch(() => {});
  }

  // Restore button state
  refreshButtonsCb?.(null);
}

export function scrollPicker(ticks: number): void {
  if (!active || projects.length === 0) return;
  if (ticks > 0) {
    cursor = Math.min(cursor + 1, projects.length - 1);
  } else {
    cursor = Math.max(cursor - 1, 0);
  }
  refreshPicker();
  refreshPickerButtons();
}

export async function selectProject(index?: number): Promise<void> {
  if (!active || projects.length === 0) return;
  const idx = index ?? cursor;
  if (idx < 0 || idx >= projects.length) return;
  const project = projects[idx];
  dlog('Picker', `selected: ${project.name} (${project.path})`);
  active = false;
  await launchAgentdeck(project.path);

  // Restore encoder layouts
  const defaultLayout = 'layouts/voice-layout.json';
  for (const id of getAllEncoderIds()) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(defaultLayout).catch(() => {});
  }
  refreshButtonsCb?.(null);
}

/** Select by button slot index (0-3 mapped to visible page items) */
export function selectByButtonSlot(slot: number): void {
  if (!active) return;
  // Button slots map to items around cursor: page of 4 centered on cursor
  const pageStart = Math.max(0, Math.min(cursor - 1, projects.length - 4));
  const idx = pageStart + slot;
  if (idx >= 0 && idx < projects.length) {
    void selectProject(idx);
  }
}

// ---- Internal ----

function getAllEncoderIds(): string[] {
  return [
    ...encoderRegistry.utilityIds,
    ...encoderRegistry.optionIds,
    ...encoderRegistry.itermIds,
    ...encoderRegistry.voiceIds,
  ];
}

async function launchAgentdeck(projectPath: string): Promise<void> {
  const resolved = projectPath.startsWith('~/') ? projectPath.replace('~', process.env.HOME || '~') : projectPath;
  const cmd = `cd ${JSON.stringify(resolved)} && agentdeck claude`;
  // Fast path: use running iTerm2. Slow path: launch iTerm2 and wait. Fallback: Terminal.app (iTerm2 not installed).
  const script = [
    `set cmd to ${JSON.stringify(cmd)}`,
    'set launched to false',
    '',
    'if application "iTerm2" is running then',
    '  tell application "iTerm2"',
    '    set newWin to (create window with default profile)',
    '    tell current session of current tab of newWin to write text cmd',
    '    activate',
    '  end tell',
    '  set launched to true',
    'end if',
    '',
    'if not launched then',
    '  try',
    '    do shell script "open -a iTerm"',
    '    repeat 50 times',
    '      delay 0.1',
    '      try',
    '        tell application "iTerm2" to count windows',
    '        exit repeat',
    '      end try',
    '    end repeat',
    '    tell application "iTerm2"',
    '      set newWin to (create window with default profile)',
    '      tell current session of current tab of newWin to write text cmd',
    '      activate',
    '    end tell',
    '    set launched to true',
    '  end try',
    'end if',
    '',
    'if not launched then',
    '  tell application "Terminal"',
    '    do script cmd',
    '    activate',
    '  end tell',
    'end if',
  ].join('\n');
  try {
    await osascript(script);
    dlog('Picker', `launched agentdeck in ${projectPath}`);
  } catch (e) {
    dlog('Picker', `launch failed: ${e}`);
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function refreshPicker(): void {
  const groups = getActiveGroups();
  if (groups.length === 0) return;

  // Render project list across all encoder panels
  if (groups.length === 1) {
    setGroupFeedback(groups[0], renderFocusPanel());
  } else if (groups.length === 2) {
    setGroupFeedback(groups[0], renderFocusPanel());
    setGroupFeedback(groups[1], renderListPanel());
  } else if (groups.length === 3) {
    setGroupFeedback(groups[0], renderHeaderPanel());
    setGroupFeedback(groups[1], renderFocusPanel());
    setGroupFeedback(groups[2], renderListPanel());
  } else {
    setGroupFeedback(groups[0], renderHeaderPanel());
    setGroupFeedback(groups[1], renderFocusPanel());
    setGroupFeedback(groups[2], renderListPanel());
    for (let i = 3; i < groups.length; i++) {
      setGroupFeedback(groups[i], renderListPanel(i - 2));
    }
  }
}

function getActiveGroups(): string[][] {
  const groups: string[][] = [];
  if (encoderRegistry.utilityIds.length > 0) groups.push(encoderRegistry.utilityIds);
  if (encoderRegistry.optionIds.length > 0) groups.push(encoderRegistry.optionIds);
  if (encoderRegistry.itermIds.length > 0) groups.push(encoderRegistry.itermIds);
  if (encoderRegistry.voiceIds.length > 0) groups.push(encoderRegistry.voiceIds);
  return groups;
}

function setGroupFeedback(ids: string[], svg: string): void {
  const feedback = { canvas: svgToDataUrl(svg) };
  for (const id of ids) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

const W = 200;
const H = 100;

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
}

function renderHeaderPanel(): string {
  const counter = `${cursor + 1}/${projects.length}`;
  const barW = Math.round((180 * (cursor + 1)) / projects.length);
  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">PROJECT</text>
    <text x="190" y="18" text-anchor="end" font-family="Arial,sans-serif" font-size="11" fill="#475569">${counter}</text>
    <text x="100" y="55" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" fill="#60a5fa" opacity="0.8">📂</text>
    <text x="100" y="78" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#60a5fa" opacity="0.6">Select &amp; Launch</text>
    <rect x="10" y="90" width="180" height="2" rx="1" fill="#1e293b"/>
    <rect x="10" y="90" width="${Math.max(2, barW)}" height="2" rx="1" fill="#60a5fa" opacity="0.3"/>
  `);
}

function renderFocusPanel(): string {
  const project = projects[cursor];
  if (!project) return svgWrap(`<rect width="${W}" height="${H}" fill="#0f172a"/>`);

  const name = escapeXml(project.name.length > 18 ? project.name.slice(0, 17) + '\u2026' : project.name);
  const counter = `${cursor + 1}/${projects.length}`;
  const accent = '#60a5fa';

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">PROJECT</text>
    <text x="190" y="18" text-anchor="end" font-family="Arial,sans-serif" font-size="11" fill="#475569">${counter}</text>
    <text x="100" y="52" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="bold" fill="${accent}">${name}</text>
    <text x="100" y="72" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#475569">push to launch</text>
    <rect x="10" y="90" width="180" height="2" rx="1" fill="#1e293b"/>
    <rect x="10" y="90" width="${Math.round((180 * (cursor + 1)) / projects.length)}" height="2" rx="1" fill="${accent}" opacity="0.5"/>
  `);
}

function renderListPanel(page = 0): string {
  // Show items around cursor, 4 visible per panel
  const visibleCount = 4;
  const startOffset = page * visibleCount;
  const startIdx = Math.max(0, cursor - 1 + startOffset);

  const items: string[] = [];
  items.push(`<rect width="${W}" height="${H}" fill="#0f172a"/>`);
  items.push(`<text x="100" y="14" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="bold" fill="#64748b">LIST</text>`);

  for (let i = 0; i < visibleCount; i++) {
    const idx = startIdx + i;
    if (idx >= projects.length) break;
    const y = 28 + i * 18;
    const isCurrent = idx === cursor;
    const color = isCurrent ? '#60a5fa' : '#64748b';
    const weight = isCurrent ? 'bold' : 'normal';
    const prefix = isCurrent ? '\u25B6 ' : '  ';
    const name = escapeXml(projects[idx].name.length > 20 ? projects[idx].name.slice(0, 19) + '\u2026' : projects[idx].name);
    items.push(`<text x="10" y="${y}" font-family="Arial,sans-serif" font-size="13" font-weight="${weight}" fill="${color}">${prefix}${name}</text>`);
  }

  return svgWrap(items.join(''));
}

/** Update response buttons to show current page project names */
function refreshPickerButtons(): void {
  const pageStart = Math.max(0, Math.min(cursor - 1, projects.length - 4));
  const configs: ButtonConfig[] = [];

  for (let i = 0; i < 4; i++) {
    const idx = pageStart + i;
    if (idx < projects.length) {
      const isCurrent = idx === cursor;
      configs.push({
        title: projects[idx].name,
        color: isCurrent ? '#1e3a5f' : '#1e293b',
        textColor: isCurrent ? '#60a5fa' : '#94a3b8',
        enabled: true,
        action: `picker:${idx}`,
      });
    } else {
      configs.push({
        title: '',
        color: '#1a1a1a',
        textColor: '#444444',
        enabled: false,
      });
    }
  }

  refreshButtonsCb?.(configs);
}
