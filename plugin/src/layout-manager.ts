import { PromptOption } from '@agentdeck/shared';

export interface ButtonConfig {
  title: string;
  subtitle?: string;
  badge?: string;
  slotNumber?: number;
  color: string;
  textColor: string;
  enabled: boolean;
  action?: string;
  iconSvg?: string;
  loading?: boolean;
}

export interface ProcessedLabel {
  main: string;
  sub?: string;
}

export function processLabel(raw: string): ProcessedLabel {
  // Split on multi-space boundaries (TUI columns separated by 2+ spaces)
  const segments = raw.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  if (segments.length >= 2) {
    return { main: segments[0], sub: segments.slice(1).join(' \u00B7 ') };
  }
  // Long single-segment labels: split at first space
  if (raw.length > 12) {
    const firstSpace = raw.indexOf(' ');
    if (firstSpace > 0 && firstSpace < 15) {
      return { main: raw.slice(0, firstSpace), sub: raw.slice(firstSpace + 1) };
    }
  }
  return { main: raw };
}

/** Determine button colors based on shortcut or label semantics */
export function colorForOption(opt: PromptOption): { color: string; textColor: string } {
  const s = opt.shortcut?.toLowerCase() ?? '';
  const lower = opt.label.toLowerCase();

  // Blue: always / "don't ask again" / "allow all sessions"
  if (/^always\b/.test(lower)) {
    return { color: '#1e40af', textColor: '#ffffff' };
  }
  if (/don['\u2019]t\s+ask\s+again/.test(lower)) {
    return { color: '#1e40af', textColor: '#ffffff' };
  }
  if (/allow\s+all\s+sessions/.test(lower)) {
    return { color: '#1e40af', textColor: '#ffffff' };
  }
  // Red: no, deny
  if (s === 'n' || s === 'd' || /^(no|deny)\b/.test(lower)) {
    return { color: '#991b1b', textColor: '#ffffff' };
  }
  // Green: yes, apply, allow (shortcuts y/a)
  if (s === 'y' || s === 'a') {
    return { color: '#166534', textColor: '#ffffff' };
  }
  // Teal default
  return { color: '#1e3a5f', textColor: '#93c5fd' };
}
