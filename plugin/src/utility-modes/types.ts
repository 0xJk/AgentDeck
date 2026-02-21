/**
 * Interface for utility dial modes.
 * Each mode implements a different macOS utility (volume, brightness, etc.).
 */
export interface UtilityMode {
  id: string;
  label: string;
  /** Custom layout file for this mode's LCD. If omitted, uses utility-layout.json. */
  layout?: string;
  onRotate(ticks: number): Promise<void>;
  onPush(): Promise<void>;
  /** Long press action (≥500ms hold). If absent, onPush is used for all presses. */
  onLongPush?(): Promise<void>;
  getFeedback(): Record<string, unknown>;
  onActivate?(): Promise<void>;
  onDeactivate?(): void;
}

/** Callback to trigger LCD refresh from within a mode (e.g. timer tick). */
export type RefreshCallback = () => void;
