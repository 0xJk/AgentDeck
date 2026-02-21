import { State, PermissionMode, PromptOption } from './states.js';

// ===== Billing Type =====

export type BillingType = 'subscription' | 'api' | 'unknown';

// ===== Bridge → Plugin (State Updates) =====

export interface StateUpdateEvent {
  type: 'state_update';
  state: State;
  permissionMode: PermissionMode;
  currentTool?: string;
  toolProgress?: string;
  projectName?: string;
  modelName?: string;
  billingType?: BillingType;
  options?: PromptOption[];
  promptType?: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review';
  question?: string;
  navigable?: boolean;
  cursorIndex?: number;
}

export interface PromptOptionsEvent {
  type: 'prompt_options';
  promptType: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review';
  question?: string;
  options: PromptOption[];
}

export interface UsageEvent {
  type: 'usage_update';
  sessionDurationSec: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  estimatedCostUsd?: number;
  // Legacy PTY-parsed fields (kept for backward compat)
  sessionPercent?: number;
  costSpent?: number;
  costLimit?: number;
  resetTime?: string;
  resetDate?: string;
  // API-sourced global usage
  fiveHourPercent?: number;
  fiveHourResetsAt?: string;
  sevenDayPercent?: number;
  sevenDayResetsAt?: string;
  // Extra usage (pay-per-use beyond plan limits)
  extraUsageEnabled?: boolean;
  extraUsageMonthlyLimit?: number;
  extraUsageUsedCredits?: number;
  extraUsageUtilization?: number;
}

export interface ConnectionEvent {
  type: 'connection';
  status: 'connected' | 'reconnecting' | 'disconnected';
  sessionId?: string;
}

export interface UserPromptEvent {
  type: 'user_prompt';
  text: string;
}

export interface VoiceStateEvent {
  type: 'voice_state';
  state: 'idle' | 'recording' | 'transcribing' | 'error';
  text?: string;
  error?: string;
}

export type BridgeEvent =
  | StateUpdateEvent
  | PromptOptionsEvent
  | UsageEvent
  | ConnectionEvent
  | UserPromptEvent
  | VoiceStateEvent;

// ===== Plugin → Bridge (Commands) =====

export interface ResponseCommand {
  type: 'respond';
  value: string; // 'y' | 'n' | 'a' or option text
}

export interface SelectOptionCommand {
  type: 'select_option';
  index: number; // 0-based option index
}

export interface NavigateOptionCommand {
  type: 'navigate_option';
  direction: 'up' | 'down';
}

export interface SendPromptCommand {
  type: 'send_prompt';
  text: string;
}

export interface SwitchModeCommand {
  type: 'switch_mode';
  mode?: 'plan' | 'acceptEdits' | 'default';
}

export interface InterruptCommand {
  type: 'interrupt'; // Ctrl+C
}

export interface EscapeCommand {
  type: 'escape'; // Esc key — cancel prompt/selection
}

export interface VoiceCommand {
  type: 'voice';
  action: 'start' | 'stop' | 'cancel';
}

export interface QueryUsageCommand {
  type: 'query_usage';
}

export type PluginCommand =
  | ResponseCommand
  | SelectOptionCommand
  | NavigateOptionCommand
  | SendPromptCommand
  | SwitchModeCommand
  | InterruptCommand
  | EscapeCommand
  | VoiceCommand
  | QueryUsageCommand;

// ===== Hook Event Types =====

export interface HookEvent {
  event: string;
  data: Record<string, unknown>;
}

// ===== Constants =====

export const BRIDGE_WS_PORT = 9120;
export const BRIDGE_HTTP_PORT = 9120; // Same port, different path
export const RECONNECT_INTERVAL_MS = 3000;
export const STUCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
