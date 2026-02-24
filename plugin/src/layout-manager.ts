import { State, PermissionMode, PromptOption } from '@agentdeck/shared';

export interface ButtonConfig {
  title: string;
  subtitle?: string;
  badge?: string;
  slotNumber?: number;
  color: string;
  textColor: string;
  enabled: boolean;
  action?: string;
}

export interface EncoderConfig {
  title: string;
  value: string;
  indicator: { value: number; bar_fill_c?: string };
  enabled: boolean;
}

const DIM: ButtonConfig = {
  title: '',
  color: '#1a1a1a',
  textColor: '#444444',
  enabled: false,
};

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

/** Capitalize short permission/diff labels (e.g. "Yes" → "YES", "No, deny" → "NO, DENY") */
function uppercaseShort(label: string): string {
  // Short labels (≤12 chars) look better in uppercase for permission/diff buttons
  return label.length <= 12 ? label.toUpperCase() : label;
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

function isInteractive(state: State): boolean {
  return (
    state === State.AWAITING_PERMISSION ||
    state === State.AWAITING_OPTION ||
    state === State.AWAITING_DIFF
  );
}

export class LayoutManager {
  /**
   * Returns 4 ButtonConfigs for dynamic response slots 3-6
   * (Slot 0 = MODE, Slot 1 = SESSION & STATUS, Slot 2 = USAGE — handled separately)
   * When fewer than 4 configs are needed, remaining slots are DIM.
   */
  getButtonLayout(
    state: State,
    mode: PermissionMode,
    options: PromptOption[],
    navigable?: boolean,
  ): ButtonConfig[] {
    switch (state) {
      case State.DISCONNECTED:
        return this.disconnectedButtons();
      case State.IDLE:
        // IDLE rendering handled by response-button.ts per-instance PI settings
        return [DIM, DIM, DIM, DIM];
      case State.PROCESSING:
        return this.processingButtons();
      case State.AWAITING_PERMISSION:
        return this.permissionButtons(options, navigable);
      case State.AWAITING_OPTION:
        return this.optionButtons(options);
      case State.AWAITING_DIFF:
        return this.diffButtons(options, navigable);
      default:
        return this.disconnectedButtons();
    }
  }

  /**
   * Returns a ButtonConfig for the stop slot (slot 6) when it should show
   * a 4th option or a MORE button instead of ESC/STOP.
   */
  getStopSlotOverride(_state: State, _options: PromptOption[]): ButtonConfig | null {
    // STOP/ESC always preserved — MORE moved to 3rd Quick Action slot
    return null;
  }

  /**
   * Expanded layout: returns 7 ButtonConfigs for slots 0-6.
   * Shows up to 7 options across the entire keypad.
   */
  getExpandedLayout(state: State, options: PromptOption[]): ButtonConfig[] {
    const capped = options.slice(0, 7);
    const configs: ButtonConfig[] = [];
    for (let i = 0; i < 7; i++) {
      if (i < capped.length) {
        configs.push(this.optionToConfig(capped[i], state));
      } else {
        configs.push(DIM);
      }
    }
    return configs;
  }

  private optionToConfig(opt: PromptOption, state: State): ButtonConfig {
    const label = processLabel(opt.label);
    const badge = opt.recommended ? '\u2605' : opt.selected ? '\u2713' : undefined;

    // Permission/diff states use semantic colors; option state uses themed colors
    const colors = (state === State.AWAITING_PERMISSION || state === State.AWAITING_DIFF)
      ? colorForOption(opt)
      : opt.recommended
        ? { color: '#1e4d2b', textColor: '#86efac' }
        : { color: '#1e3a5f', textColor: '#93c5fd' };

    // For long labels, use full text as title (button-renderer handles word wrap + adaptive font)
    const fullLabel = label.sub ? `${label.main} ${label.sub}` : label.main;

    return {
      title: fullLabel,
      badge,
      ...colors,
      enabled: true,
      action: `select_option:${opt.index}`,
    };
  }

  private disconnectedButtons(): ButtonConfig[] {
    return [DIM, DIM, DIM, DIM];
  }

  private processingButtons(): ButtonConfig[] {
    return [DIM, DIM, DIM, DIM];
  }

  private permissionButtons(options: PromptOption[], navigable?: boolean): ButtonConfig[] {
    if (options.length === 0) {
      // Fallback: hardcoded YES/NO/ALWAYS + DIM (no index available)
      return [
        { title: 'YES', color: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:y' },
        { title: 'NO', color: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:n' },
        { title: 'ALWAYS', color: '#1e40af', textColor: '#ffffff', enabled: true, action: 'respond:a' },
        DIM,
      ];
    }
    const buttons: ButtonConfig[] = options.slice(0, 4).map(opt => ({
      title: uppercaseShort(opt.label),
      ...colorForOption(opt),
      enabled: true,
      action: navigable
        ? `select_option:${opt.index}`
        : `respond:${opt.shortcut || opt.label.charAt(0).toLowerCase()}`,
    }));
    while (buttons.length < 4) buttons.push(DIM);
    return buttons;
  }

  private optionButtons(options: PromptOption[]): ButtonConfig[] {
    // ≤4 options: show all (pad with DIM)
    if (options.length <= 4) {
      const buttons: ButtonConfig[] = [];
      for (let i = 0; i < 4; i++) {
        if (i < options.length) {
          buttons.push(this.optionToConfig(options[i], State.AWAITING_OPTION));
        } else {
          buttons.push(DIM);
        }
      }
      return buttons;
    }
    // 5+ options: first 3 options + MORE in 4th slot
    return [
      this.optionToConfig(options[0], State.AWAITING_OPTION),
      this.optionToConfig(options[1], State.AWAITING_OPTION),
      this.optionToConfig(options[2], State.AWAITING_OPTION),
      {
        title: 'MORE \u25BC',
        color: '#334155',
        textColor: '#94a3b8',
        enabled: true,
        action: 'expand_options',
      },
    ];
  }

  private diffButtons(options: PromptOption[], navigable?: boolean): ButtonConfig[] {
    if (options.length === 0) {
      // Fallback: hardcoded APPLY/DENY/VIEW + DIM (no index available)
      return [
        { title: 'APPLY', color: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:a' },
        { title: 'DENY', color: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:d' },
        { title: 'VIEW', color: '#1e3a5f', textColor: '#93c5fd', enabled: true, action: 'respond:v' },
        DIM,
      ];
    }
    const buttons: ButtonConfig[] = options.slice(0, 4).map(opt => ({
      title: uppercaseShort(opt.label),
      ...colorForOption(opt),
      enabled: true,
      action: navigable
        ? `select_option:${opt.index}`
        : `respond:${opt.shortcut || opt.label.charAt(0).toLowerCase()}`,
    }));
    while (buttons.length < 4) buttons.push(DIM);
    return buttons;
  }
}
