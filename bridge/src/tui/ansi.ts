/**
 * ANSI escape code helpers for TUI dashboard rendering.
 * Raw terminal control — no external dependencies.
 */

// ===== Cursor & Screen Control =====

export const ESC = '\x1b';
export const CSI = `${ESC}[`;

export const cursor = {
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  moveTo: (row: number, col: number) => `${CSI}${row};${col}H`,
  moveToCol: (col: number) => `${CSI}${col}G`,
  up: (n = 1) => `${CSI}${n}A`,
  down: (n = 1) => `${CSI}${n}B`,
  save: `${ESC}7`,
  restore: `${ESC}8`,
};

export const screen = {
  altEnter: `${CSI}?1049h`,
  altExit: `${CSI}?1049l`,
  clear: `${CSI}2J`,
  clearLine: `${CSI}2K`,
};

export const RESET = `${CSI}0m`;
export const BOLD = `${CSI}1m`;
export const DIM = `${CSI}2m`;

// ===== Color Helpers =====

/** 24-bit truecolor foreground */
export function fg(r: number, g: number, b: number): string {
  return `${CSI}38;2;${r};${g};${b}m`;
}

/** 24-bit truecolor background */
export function bg(r: number, g: number, b: number): string {
  return `${CSI}48;2;${r};${g};${b}m`;
}

/** Standard 16-color foreground */
export function sgr(code: number): string {
  return `${CSI}${code}m`;
}

// ===== Named Colors =====

export const colors = {
  // State colors
  idle: sgr(32),        // green
  processing: sgr(33),  // yellow
  awaiting: sgr(35),    // magenta
  disconnected: sgr(31),// red
  error: sgr(31),       // red

  // UI colors
  header: `${BOLD}${sgr(36)}`,   // bold cyan
  dim: sgr(90),                   // dim gray
  dimCyan: `${DIM}${sgr(36)}`,   // dim cyan (keybindings)
  border: sgr(90),                // dim white
  white: sgr(37),
  bold: BOLD,

  // Timeline type colors
  chat: sgr(32),        // green
  tool: sgr(36),        // cyan
  end: sgr(34),         // blue
  errorTl: sgr(31),     // red

  // Terrarium truecolors
  octopus: fg(192, 112, 88),     // #C07058
  crayfish: fg(255, 77, 77),     // #FF4D4D
  tetraNeon: fg(0, 191, 255),    // #00BFFF
  tetraStripe: fg(255, 99, 71),  // #FF6347
  water: fg(30, 58, 95),         // #1e3a5f
  waterDark: fg(10, 22, 40),     // #0a1628
  sand: fg(194, 168, 120),       // #c2a878
  seaweed: fg(34, 139, 34),      // forestgreen
  bubble: fg(135, 206, 250),     // lightskyblue
  crayfishGlow: fg(255, 107, 107), // #FF6B6B - signal wave color
};

// ===== State to color mapping =====

export function stateColor(state: string): string {
  switch (state) {
    case 'idle': return colors.idle;
    case 'processing': return colors.processing;
    case 'awaiting_permission':
    case 'awaiting_option':
    case 'awaiting_diff': return colors.awaiting;
    case 'disconnected': return colors.disconnected;
    default: return colors.white;
  }
}

export function stateIcon(state: string): string {
  switch (state) {
    case 'idle': return '\u25CB'; // ○
    case 'processing': return '\u25CF'; // ●
    case 'awaiting_permission':
    case 'awaiting_option':
    case 'awaiting_diff': return '\u25C6'; // ◆
    case 'disconnected': return '\u2717'; // ✗
    default: return '\u25CB';
  }
}

// ===== Box Drawing =====

export const box = {
  tl: '\u250C', tr: '\u2510', bl: '\u2514', br: '\u2518',
  h: '\u2500', v: '\u2502',
  tee: '\u252C', bTee: '\u2534',
  lTee: '\u251C', rTee: '\u2524',
  cross: '\u253C',
};

export function hLine(width: number, char = box.h): string {
  return char.repeat(width);
}

// ===== Text Utilities =====

/** Strip ANSI escape sequences for length calculation */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visual length of a string (stripping ANSI) */
export function visLen(str: string): number {
  return stripAnsi(str).length;
}

/** Truncate text to fit width, preserving ANSI codes at boundaries */
export function truncText(text: string, maxWidth: number, ellipsis = '\u2026'): string {
  const plain = stripAnsi(text);
  if (plain.length <= maxWidth) return text;
  // Simple approach: strip ANSI, truncate, lose color (safe for most uses)
  return plain.slice(0, maxWidth - 1) + ellipsis;
}

/** Pad string to width (visual) with spaces */
export function padRight(text: string, width: number): string {
  const len = visLen(text);
  if (len >= width) return text;
  return text + ' '.repeat(width - len);
}

/** Center text in width */
export function centerText(text: string, width: number): string {
  const len = visLen(text);
  if (len >= width) return text;
  const left = Math.floor((width - len) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - len - left);
}
