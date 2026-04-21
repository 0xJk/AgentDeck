/**
 * Session slot button SVG renderer for v4 dynamic layout.
 *
 * Renders: session list buttons, detail view info/options/nav buttons.
 * 144x144 canvas matching SD+ button spec.
 *
 * Agent identification: creature icon (agentLogoIcon) at top of button.
 * State colors: unified palette from shared/state-colors (no agent overrides).
 */
import type { AgentType } from '../adapter.js';
import type { SessionInfo } from '../protocol.js';
import type { PromptOption } from '../states.js';
import { State } from '../states.js';
import { stateColor } from '../state-colors.js';
import { agentLogoIcon } from './agent-logos.js';
import { wrapTextByWidth, measureTextWidth } from './text-utils.js';

const SIZE = 144;
const MAX_TEXT_PX = 124; // 144 - 10px padding each side

function stateLabel(state?: string, agentType?: AgentType): string {
  if (!state) return 'OFFLINE';
  // OpenClaw-specific labels
  if (agentType === 'openclaw') {
    if (state === 'idle') return 'STANDBY';
    if (state === 'processing') return 'ROUTING';
  }
  switch (state) {
    case 'idle': return 'IDLE';
    case 'processing': return 'WORKING';
    case 'awaiting_option':
    case 'awaiting_permission':
    case 'awaiting_diff':
      return 'AWAITING';
    default: return state.toUpperCase();
  }
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}

/**
 * Format "Model · effort" suffix for session tile / detail view.
 * Skips neutral efforts ("medium" legacy, "default" is Claude Code 2.1+
 * per-model default) so they don't clutter the tile. Truncates the model
 * name preferentially so the effort label survives in tight pixel budgets.
 */
export function formatModelEffort(modelName?: string, effortLevel?: string, maxLen = 14): string {
  if (!modelName) return '';
  const showEffort = effortLevel && effortLevel !== 'medium' && effortLevel !== 'default';
  if (!showEffort) return truncate(modelName, maxLen);
  const combined = `${modelName} · ${effortLevel}`;
  if (combined.length <= maxLen) return combined;
  const effortSuffix = ` · ${effortLevel}`;
  const modelBudget = Math.max(4, maxLen - effortSuffix.length);
  return truncate(modelName, modelBudget) + effortSuffix;
}

// ---- Session List Button ----

export function renderSessionSlot(
  session: SessionInfo,
  isActive: boolean,
  animFrame: number,
  displayName?: string,
  options?: { animated?: boolean },
): string {
  const isWorking = session.state === 'processing';
  const isAsking = session.state?.startsWith('awaiting') ?? false;
  const isIdle = !isWorking && !isAsking;
  // Stream Deck / SD+ run a 150ms tick — animated. D200H's TypeScript image
  // pipeline (bridge/src/d200h/image-renderer.ts) has no such loop: passing
  // animFrame=0 every time freezes dashed strokes and leaves the sin-based
  // pulse at a dim phase. Callers without a loop should pass animated:false
  // so we emit a motion-free visual (solid borders + badges) that still
  // clearly distinguishes working vs awaiting vs idle.
  const animated = options?.animated ?? true;

  const agent = (session.agentType as AgentType) || 'claude-code';
  const nameForDisplay = displayName ?? session.projectName;
  // Bottom line budget: tile width ~124px at 14px font ≈ 16 chars. Leave a
  // little headroom so "Opus 4.7 · max" fits without running into the
  // watermark on the right.
  const modelText = formatModelEffort(session.modelName, session.effortLevel, 15);

  // Custom palette mimicking the premium demo
  const p1 = agent === 'claude-code' ? '#D97757' : agent === 'codex-cli' ? '#8BA4FF' : agent === 'openclaw' ? '#FF6B6B' : '#F1ECEC';
  const p2 = agent === 'claude-code' ? '#BE6D52' : agent === 'codex-cli' ? '#5981FF' : agent === 'openclaw' ? '#CC3333' : '#AFAFAF';

  const sColor = stateColor(session.state);
  const fontFam = 'Inter, -apple-system, system-ui, Helvetica Neue, sans-serif';

  const stateLbl = isWorking ? 'RUNNING' : isAsking ? 'PERMIT?' : 'IDLE';
  const colorText = isWorking ? '#FDE68A' : isAsking ? '#FECACA' : p1;

  const gradId = `sd-bg-${agent}-${session.state || 'idle'}`;
  
  let defs = `
    <linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1C1C1E"/>
      <stop offset="100%" stop-color="#0C0C0E"/>
    </linearGradient>
  `;

  let glowBorder = '';
  let askDot = '';
  let runBadge = '';
  const filterId = `pg-${animFrame}`;
  const blurDef = `
      <filter id="${filterId}" x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="2.4"/>
      </filter>
    `;
  if (isAsking) {
    // Animated callers pulse the opacity (0.55…1.0 over a sin wave). Static
    // callers (D200H) pin to a near-peak value so the frozen snapshot reads
    // as bright and attention-grabbing instead of dim.
    const pulseOpacity = animated
      ? 0.55 + 0.45 * Math.abs(Math.sin(animFrame * 0.15))
      : 0.95;
    defs += blurDef;
    // Thick outer glow + crisp inner ring — distinct "breathing" solid border.
    glowBorder =
      `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${sColor}" stroke-width="4.5" opacity="${pulseOpacity.toFixed(2)}" filter="url(#${filterId})"/>` +
      `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${sColor}" stroke-width="1.5" opacity="${(pulseOpacity * 0.9).toFixed(2)}"/>`;
    askDot = `
      <circle cx="114" cy="24" r="5" fill="#F5B942" filter="url(#${filterId})"/>
      <circle cx="114" cy="24" r="3" fill="#ffffff" />
    `;
  } else if (isWorking) {
    if (animated) {
      // Flowing-light dashed border — SD/SD+ 150ms tick advances animFrame
      // → dashoffset drifts → chasing light.
      const perimeter = 128 * 4;
      const dashOffset = ((animFrame * 4) % perimeter).toFixed(0);
      defs += blurDef;
      glowBorder =
        `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${sColor}" stroke-width="4.5" stroke-dasharray="22 14" stroke-dashoffset="-${dashOffset}" opacity="0.85" filter="url(#${filterId})"/>` +
        `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${sColor}" stroke-width="1.5" stroke-dasharray="22 14" stroke-dashoffset="-${dashOffset}" opacity="0.95"/>`;
    } else {
      // Non-animated callers (D200H still-image pipeline): render a solid
      // glowing border + a play-chevron badge so WORKING is obvious without
      // motion. The amber border is still the primary signal; the ▶ badge
      // distinguishes this from the red awaiting state at a glance.
      defs += blurDef;
      glowBorder =
        `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${sColor}" stroke-width="4.5" opacity="0.9" filter="url(#${filterId})"/>` +
        `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${sColor}" stroke-width="1.5" opacity="0.95"/>`;
      runBadge = `
        <rect x="100" y="14" width="28" height="16" rx="8" fill="${sColor}" opacity="0.9" />
        <text x="114" y="26" font-size="11" font-weight="800" text-anchor="middle" fill="#0C0C0E" font-family="${fontFam}">▶ RUN</text>
      `;
    }
  }

  // Simplified Agent watermark at bottom-right
  // agentLogoIcon renders at x,y with given width/height
  const watermark = `<g transform="translate(90, 86)" opacity="${isIdle ? '0.46' : '0.34'}">
    ${agentLogoIcon(agent, 40, 1, 0, 0)}
  </g>`;
  
  // Left Edge Color Strip
  const leftStrip = `<rect x="8" y="8" width="4" height="128" rx="2" fill="${isWorking ? '#F5B942' : isAsking ? '#F87171' : p1}"/>`;

  // Border is now the primary working/awaiting signal — no tiny spinner glyph.
  const spinner = '';

  // ACT badge only on IDLE — WORKING has the flowing border, AWAITING has the pulse.
  const badgeObj = isIdle ? `
    <rect x="100" y="14" width="28" height="16" rx="8" fill="#ffffff" opacity="0.1" />
    <text x="114" y="25" font-size="10" font-weight="700" text-anchor="middle" fill="#A1A1AA" font-family="${fontFam}">ACT</text>
  ` : '';

  const toolStr = isWorking ? 'Running task' : modelText;

  const elements = [
    `<defs>${defs}</defs>`,
    `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="url(#${gradId})"/>`,
    `<rect x="8" y="8" width="128" height="128" rx="12" fill="#2C2C2E" opacity="0.8"/>`,
    glowBorder,
    leftStrip,
    watermark,
    spinner,
    askDot,
    runBadge,
    badgeObj,
    `<text x="20" y="32" font-size="17" font-weight="800" text-anchor="start" fill="${colorText}" font-family="${fontFam}">${escXml(stateLbl)}</text>`,
    `<text x="20" y="52" font-size="13" font-weight="600" text-anchor="start" fill="#E2E8F0" font-family="${fontFam}">${escXml(truncate(nameForDisplay, 13))}</text>`,
    `<text x="20" y="120" font-size="${isWorking ? '13' : '14'}" font-weight="500" text-anchor="start" fill="${colorText}" opacity="0.8" font-family="${fontFam}">${escXml(toolStr)}</text>`
  ].join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${elements}</svg>`;
}

// ---- Empty Slot ----

export function renderEmptySlot(): string {
  const label = `<text x="72" y="76" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#333333">Empty</text>`;
  return svgFrame('#111111', label);
}

export function renderNoDaemonSlot(slot: number): string {
  if (slot === 0) {
    // START button — launches macOS app
    const elements = [
      `<text x="72" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#94a3b8">AgentDeck</text>`,
      `<text x="72" y="96" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="#22c55e">\u25B6 START</text>`,
    ].join('');
    return svgFrame('#0f1a0f', elements);
  }
  return svgFrame('#111111', '');
}

// ---- Navigation Buttons ----

export function renderBackButton(): string {
  const arrow = `<text x="72" y="76" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" fill="#94a3b8">\u2190</text>`;
  const label = `<text x="72" y="108" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="600" fill="#94a3b8">BACK</text>`;
  return svgFrame('#1a1a1a', arrow + label);
}

export function renderNextPageButton(pageLabel: string): string {
  const arrow = `<text x="72" y="64" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" fill="#60a5fa">\u25B6</text>`;
  const label = `<text x="72" y="92" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="600" fill="#60a5fa">NEXT</text>`;
  const page = `<text x="72" y="114" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#64748b">${escXml(pageLabel)}</text>`;
  return svgFrame('#1a1a2e', arrow + label + page);
}

export function renderEscButton(active = true): string {
  const c = active ? '#f97316' : '#a0855a';
  const bg = active ? '#2d1810' : '#1a1308';
  const op = active ? '' : ' opacity="0.45"';
  const elements = [
    `<text x="72" y="62" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" fill="${c}"${op}>\u2716</text>`,
    `<text x="72" y="100" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="${c}"${op}>ESC</text>`,
  ].join('');
  return svgFrame(bg, elements);
}

export function renderStopButton(active = true): string {
  const c = active ? '#ef4444' : '#666666';
  const bg = active ? '#2d1010' : '#1a0a0a';
  const op = active ? '' : ' opacity="0.4"';
  const elements = [
    `<text x="72" y="62" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" fill="${c}"${op}>\u25A0</text>`,
    `<text x="72" y="100" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="${c}"${op}>STOP</text>`,
  ].join('');
  return svgFrame(bg, elements);
}

// ---- Detail View: Session Info ----

export function renderDetailInfo(session: SessionInfo | undefined, state: State, tool?: string, modelName?: string, mode?: string, displayName?: string, effortLevel?: string): string {
  if (!session) return renderEmptySlot();

  const agent = (session.agentType as AgentType) || 'claude-code';
  const nameForDisplay = displayName ?? session.projectName;
  
  const fontFam = 'Inter, -apple-system, system-ui, Helvetica Neue, sans-serif';
  const sColor = stateColor(session.state);
  const stateLbl = stateLabel(session.state, agent);
  
  const gradId = `sd-bg-detail-${agent}`;
  const defs = `
    <linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#151720"/>
      <stop offset="100%" stop-color="#0A0B10"/>
    </linearGradient>
  `;

  const watermark = `<g transform="translate(90, 86)" opacity="0.36">
    ${agentLogoIcon(agent, 40, 1, 0, 0)}
  </g>`;

  const leftStrip = `<rect x="8" y="8" width="4" height="128" rx="2" fill="${sColor}"/>`;

  const badgeObj = `
    <rect x="100" y="14" width="28" height="16" rx="8" fill="#ffffff" opacity="0.1" />
    <text x="114" y="25" font-size="10" font-weight="700" text-anchor="middle" fill="#A1A1AA" font-family="${fontFam}">INFO</text>
  `;

  const toolDisplay = tool ? `\u25B6 ${truncate(tool, 18)}` : stateLbl;

  const elements = [
    `<defs>${defs}</defs>`,
    `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="url(#${gradId})"/>`,
    `<rect x="8" y="8" width="128" height="128" rx="12" fill="#1C1F2E" opacity="0.8"/>`,
    leftStrip,
    watermark,
    badgeObj,
    // Title
    `<text x="20" y="34" font-size="18" font-weight="800" text-anchor="start" fill="#ffffff" font-family="${fontFam}">${escXml(truncate(nameForDisplay, 10))}</text>`,
    // Model/Mode — effort renders inline with model (e.g. "Opus 4.7 · max")
    // so the permission-mode chip below keeps its y=74 slot.
    (modelName && agent !== 'openclaw') ? `<text x="20" y="56" font-size="12" font-weight="600" text-anchor="start" fill="#94a3b8" font-family="${fontFam}">${escXml(formatModelEffort(modelName, effortLevel, 17))}</text>` : '',
    (mode && mode !== 'default' && agent !== 'openclaw') ? `<text x="20" y="74" font-size="11" font-weight="700" text-anchor="start" fill="#a78bfa" font-family="${fontFam}">${escXml(mode.toUpperCase())}</text>` : '',
    // Tool/State
    `<text x="20" y="120" font-size="12" font-weight="700" text-anchor="start" fill="${tool ? '#fbbf24' : sColor}" font-family="${fontFam}">${escXml(toolDisplay)}</text>`,
  ].join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${elements}</svg>`;
}

// ---- Detail View: Option Button ----

export function renderOptionButton(option: PromptOption, index: number): string {
  const label = option.label || `Option ${index + 1}`;
  const lines = wrapTextByWidth(label, MAX_TEXT_PX, 16);
  const lineHeight = 20;
  const startY = lines.length === 1 ? 76 : 76 - ((lines.length - 1) * lineHeight) / 2;

  // Slot number (top-right)
  const slotNum = `<text x="${SIZE - 10}" y="18" text-anchor="end" font-family="Arial,sans-serif" font-size="13" fill="#ffffff" opacity="0.25">${index + 1}</text>`;

  const textEls = lines.slice(0, 3).map((line, i) =>
    `<text x="72" y="${startY + i * lineHeight}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#ffffff">${escXml(line)}</text>`
  ).join('');

  // Use different bg colors for visual distinction
  const colors = ['#1e3a5f', '#1e3a4a', '#2a1e4a', '#1e4a3a', '#3a1e2a'];
  const bgColor = colors[index % colors.length];

  return svgFrame(bgColor, slotNum + textEls);
}

// ---- Detail View: Preset Action Button ----

export function renderPresetButton(label: string, iconSvg: string, color: string, textColor: string, subtitle?: string, loading?: boolean): string {
  if (loading) {
    return svgFrame(color, iconSvg);
  }
  const labelEl = `<text x="72" y="100" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="${textColor}">${escXml(label)}</text>`;
  const subEl = subtitle
    ? `<text x="72" y="118" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="${textColor}" opacity="0.7">${escXml(truncate(subtitle, 14))}</text>`
    : '';
  return svgFrame(color, iconSvg + labelEl + subEl);
}

// ---- Detail View: Info slot (tool, model/mode) ----

export function renderInfoSlot(label: string, subtitle?: string): string {
  const mainEl = `<text x="72" y="${subtitle ? 68 : 76}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#94a3b8">${escXml(truncate(label, 18))}</text>`;
  const subEl = subtitle
    ? `<text x="72" y="92" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#64748b">${escXml(truncate(subtitle, 22))}</text>`
    : '';
  return svgFrame('#1a1a1a', mainEl + subEl);
}

// ---- SVG Frame ----

export function svgFrame(bgColor: string, innerElements: string): string {
  // Use a random ID to prevent SVG constraint clashes
  const gradId = 'frame-bg-' + Math.floor(Math.random() * 1000000);
  const defs = `
    <linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${bgColor}"/>
      <stop offset="100%" stop-color="#0A0A0E"/>
    </linearGradient>
  `;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<defs>${defs}</defs>`,
    `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="url(#${gradId})"/>`,
    `<rect x="8" y="8" width="128" height="128" rx="12" fill="#2C2C2E" opacity="0.6"/>`,
    innerElements,
    `</svg>`,
  ].join('');
}
