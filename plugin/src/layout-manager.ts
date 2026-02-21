import { State, PermissionMode, PromptOption } from '@agentdeck/shared';

export interface ButtonConfig {
  title: string;
  subtitle?: string;
  badge?: string;
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

interface ProcessedLabel {
  main: string;
  sub?: string;
}

function processLabel(raw: string): ProcessedLabel {
  // " · " separator from parseOptions normalization
  const parts = raw.split(' · ');
  if (parts.length >= 2) {
    return { main: parts[0].trim(), sub: parts.slice(1).join(' · ').trim() };
  }
  // Long labels: split at first space
  if (raw.length > 12) {
    const firstSpace = raw.indexOf(' ');
    if (firstSpace > 0 && firstSpace < 15) {
      return { main: raw.slice(0, firstSpace), sub: raw.slice(firstSpace + 1) };
    }
  }
  return { main: raw };
}

/** Shorten permission/diff option label for button display (max ~9 chars) */
function truncateLabel(label: string): string {
  const lower = label.toLowerCase();
  if (/^yes\b/.test(lower)) return 'YES';
  if (/^no\b/.test(lower) || /^deny\b/.test(lower)) return 'DENY';
  if (/^always\b/.test(lower)) return 'ALWAYS';
  if (/^allow\b/.test(lower)) return 'ALLOW';
  if (/^view\b/.test(lower)) return 'VIEW';
  if (/^apply\b/.test(lower)) return 'APPLY';
  // Unknown: first word, uppercase, max 9 chars
  const first = label.split(/[\s,]+/)[0] || label;
  return first.toUpperCase().slice(0, 9);
}

/** Determine button colors based on shortcut or label semantics */
function colorForOption(opt: PromptOption): { color: string; textColor: string } {
  const s = opt.shortcut?.toLowerCase() ?? '';
  const lower = opt.label.toLowerCase();

  // Blue: always (check before shortcut — "always" has shortcut 'a' but should be blue)
  if (/^always\b/.test(lower)) {
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
   * Returns 3 ButtonConfigs for dynamic response slots 3-5
   * (Slot 0 = MODE, Slot 1 = SESSION & STATUS, Slot 2 = USAGE, Slot 6 = STOP — handled separately)
   */
  getButtonLayout(
    state: State,
    mode: PermissionMode,
    options: PromptOption[],
  ): ButtonConfig[] {
    switch (state) {
      case State.DISCONNECTED:
        return this.disconnectedButtons();
      case State.IDLE:
        // IDLE rendering handled by response-button.ts per-instance PI settings
        return [DIM, DIM, DIM];
      case State.PROCESSING:
        return this.processingButtons();
      case State.AWAITING_PERMISSION:
        return this.permissionButtons(options);
      case State.AWAITING_OPTION:
        return this.optionButtons(options);
      case State.AWAITING_DIFF:
        return this.diffButtons(options);
      default:
        return this.disconnectedButtons();
    }
  }

  /**
   * Returns a ButtonConfig for the stop slot (slot 6) when it should show
   * a 4th option or a MORE button instead of ESC/STOP.
   */
  getStopSlotOverride(state: State, options: PromptOption[]): ButtonConfig | null {
    if (!isInteractive(state)) return null;

    // Permission/diff prompts always use ≤3 options — no override needed
    if (state === State.AWAITING_PERMISSION || state === State.AWAITING_DIFF) return null;

    if (options.length === 4) {
      return this.optionToConfig(options[3], state);
    }
    if (options.length >= 5) {
      return {
        title: 'MORE \u25BC',
        color: '#334155',
        textColor: '#94a3b8',
        enabled: true,
        action: 'expand_options',
      };
    }
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

    return {
      title: label.main,
      subtitle: label.sub,
      badge,
      ...colors,
      enabled: true,
      action: `select_option:${opt.index}`,
    };
  }

  private disconnectedButtons(): ButtonConfig[] {
    return [DIM, DIM, DIM];
  }

  private processingButtons(): ButtonConfig[] {
    return [DIM, DIM, DIM];
  }

  private permissionButtons(options: PromptOption[]): ButtonConfig[] {
    if (options.length === 0) {
      // Fallback: hardcoded YES/NO/ALWAYS
      return [
        { title: 'YES', color: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:y' },
        { title: 'NO', color: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:n' },
        { title: 'ALWAYS', color: '#1e40af', textColor: '#ffffff', enabled: true, action: 'respond:a' },
      ];
    }
    return options.slice(0, 3).map(opt => ({
      title: truncateLabel(opt.label),
      ...colorForOption(opt),
      enabled: true,
      action: `respond:${opt.shortcut || 'y'}`,
    }));
  }

  private optionButtons(options: PromptOption[]): ButtonConfig[] {
    // Show first 3 options in slots 3-5 using optionToConfig for rich display
    const buttons: ButtonConfig[] = [];
    for (let i = 0; i < 3; i++) {
      if (i < options.length) {
        buttons.push(this.optionToConfig(options[i], State.AWAITING_OPTION));
      } else {
        buttons.push(DIM);
      }
    }
    return buttons;
  }

  private diffButtons(options: PromptOption[]): ButtonConfig[] {
    if (options.length === 0) {
      // Fallback: hardcoded APPLY/DENY/VIEW
      return [
        { title: 'APPLY', color: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:a' },
        { title: 'DENY', color: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:d' },
        { title: 'VIEW', color: '#1e3a5f', textColor: '#93c5fd', enabled: true, action: 'respond:v' },
      ];
    }
    return options.slice(0, 3).map(opt => ({
      title: truncateLabel(opt.label),
      ...colorForOption(opt),
      enabled: true,
      action: `respond:${opt.shortcut || opt.label.charAt(0).toLowerCase()}`,
    }));
  }
}
