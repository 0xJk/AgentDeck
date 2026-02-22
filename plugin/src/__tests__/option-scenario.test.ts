import { describe, it, expect } from 'vitest';
import { State, PermissionMode, type PromptOption } from '@agentdeck/shared';
import { LayoutManager } from '../layout-manager.js';
import {
  renderFocusPanel,
  renderListPanel,
  renderDetailPanel,
} from '../renderers/option-renderer.js';

function makeOptions(count: number): PromptOption[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    label: `Option ${i + 1} with a longer description text here`,
    shortcut: i === 0 ? 'y' : '',
    recommended: i === 0,
    selected: false,
  }));
}

describe('6-option SELECT scenario', () => {
  const lm = new LayoutManager();
  const opts = makeOptions(6);

  it('Quick Action slots: 2 options + MORE (not on STOP slot)', () => {
    const buttons = lm.getButtonLayout(State.AWAITING_OPTION, PermissionMode.DEFAULT, opts);
    expect(buttons).toHaveLength(3);
    expect(buttons[0].action).toBe('select_option:0');
    expect(buttons[1].action).toBe('select_option:1');
    expect(buttons[2].title).toBe('MORE ▼');
    expect(buttons[2].action).toBe('expand_options');
  });

  it('STOP slot is always preserved (getStopSlotOverride returns null)', () => {
    expect(lm.getStopSlotOverride(State.AWAITING_OPTION, opts)).toBeNull();
  });

  it('3 options: all shown in Quick Action slots, no MORE', () => {
    const opts3 = makeOptions(3);
    const buttons = lm.getButtonLayout(State.AWAITING_OPTION, PermissionMode.DEFAULT, opts3);
    expect(buttons[0].action).toBe('select_option:0');
    expect(buttons[1].action).toBe('select_option:1');
    expect(buttons[2].action).toBe('select_option:2');
  });

  it('4 options: 2 options + MORE', () => {
    const opts4 = makeOptions(4);
    const buttons = lm.getButtonLayout(State.AWAITING_OPTION, PermissionMode.DEFAULT, opts4);
    expect(buttons[2].title).toBe('MORE ▼');
  });

  it('E2 Focus panel renders with adaptive font', () => {
    const svg = renderFocusPanel({
      opt: opts[0],
      selectedIndex: 0,
      total: 6,
      isPermOrDiff: false,
      state: State.AWAITING_OPTION,
      fourEnc: true,
    });
    expect(svg).toContain('font-size=');
    expect(svg).toContain('<svg');
  });

  it('E3 List panel renders 4 visible rows with 14px font', () => {
    const svg = renderListPanel({
      options: opts,
      selectedIndex: 2,
      isPermOrDiff: false,
      state: State.AWAITING_OPTION,
    });
    expect(svg).toContain('font-size="14"');
    // Should have scroll indicator for 6 > 4 rows
    expect(svg).toContain('fill="#475569"'); // thumb bar
  });

  it('E4 Detail panel shows word-wrapped label (12px, left-aligned)', () => {
    const svg = renderDetailPanel({
      opt: opts[0],
      isPermOrDiff: false,
      state: State.AWAITING_OPTION,
      selectedIndex: 0,
      total: 6,
    });
    expect(svg).toContain('font-size="12"');
    expect(svg).toContain('x="10"'); // left-aligned
  });

  it('PERMISSION without shortcut: diffButtons uses label first char', () => {
    const permOpts: PromptOption[] = [
      { index: 0, label: 'Yes', shortcut: 'y', recommended: false, selected: false },
      { index: 1, label: 'No', shortcut: '', recommended: false, selected: false },
      { index: 2, label: 'Always', shortcut: '', recommended: false, selected: false },
    ];
    const buttons = lm.getButtonLayout(State.AWAITING_PERMISSION, PermissionMode.DEFAULT, permOpts);
    // permissionButtons: shortcut || label first char fallback
    expect(buttons[0].action).toBe('respond:y');
    // Empty shortcut falls back to label first char ('n' for 'No')
    expect(buttons[1].action).toBe('respond:n');
  });
});
