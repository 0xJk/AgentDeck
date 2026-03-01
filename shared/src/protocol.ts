import { State, PermissionMode, PromptOption } from './states.js';
import type { AgentType, AgentCapabilities } from './adapter.js';

// ===== Billing Type =====

export type BillingType = 'subscription' | 'api' | 'unknown';

// ===== Model Catalog (OpenClaw) =====

export interface ModelCatalogEntry {
  name: string;
  role: 'default' | `fallback-${number}` | 'configured';
  available: boolean;
}

// ===== OpenClaw Session Status =====

export interface OcSessionStatus {
  model?: string;
  contextTokens?: number;
  messageCount?: number;
  uptime?: string;
  sessionId?: string;
  [key: string]: unknown;
}

// ===== Encoder LCD State (Bridge → Plugin/Android) =====

export interface EncoderSlotState {
  slot: number; // 0-3 (E1~E4)
  encoderType: 'utility' | 'action' | 'terminal' | 'voice';
  header: string;         // "VOLUME", "PROMPT", "SESSION", "VOICE"
  value?: string;         // "65%", "go on", session name, "Ready"
  icon?: string;          // emoji
  accentColor: string;    // hex — bottom indicator bar color
  progress?: number;      // 0-1, indicator bar fill
  counter?: string;       // "1/4" format
  detail?: string;        // additional text (option description, error msg, etc.)
  // Voice specific
  voiceState?: 'idle' | 'recording' | 'transcribing' | 'error' | 'review';
  recordingMs?: number;
  transcription?: string;
}

export interface EncoderStateEvent {
  type: 'encoder_state';
  encoders: EncoderSlotState[];
  takeoverActive: boolean; // AWAITING states: all encoders show options
}

// ===== Deck Slot Map (Plugin → Bridge → Android) =====

export interface DeckSlotConfig {
  slot: number;
  actionType: string; // 'mode-button' | 'session-button' | 'usage-button' | 'response-button' | 'stop-button' | 'utility-dial' | 'option-dial' | 'iterm-dial' | 'voice-dial'
  settings?: Record<string, unknown>;
}

export interface DeckSlotMapEvent {
  type: 'deck_slot_map';
  buttons: DeckSlotConfig[];
  encoders: DeckSlotConfig[];
}

// ===== Ollama Status =====

export interface OllamaModel {
  name: string;
  size: number;
  sizeVram: number;
}

export interface OllamaStatus {
  available: boolean;
  models: OllamaModel[];
}

// ===== Bridge → Plugin (State Updates) =====

export interface StateUpdateEvent {
  type: 'state_update';
  state: State;
  permissionMode: PermissionMode;
  agentType?: AgentType;
  agentCapabilities?: AgentCapabilities;
  currentTool?: string;
  toolInput?: string;
  toolProgress?: string;
  projectName?: string;
  modelName?: string;
  billingType?: BillingType;
  options?: PromptOption[];
  promptType?: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review';
  question?: string;
  navigable?: boolean;
  cursorIndex?: number;
  suggestedPrompt?: string;
  modelCatalog?: ModelCatalogEntry[];
  sessionStatus?: OcSessionStatus;
  remoteUrl?: string;
  /** Authenticated WS URL for remote pairing (ws://ip:port?token=hex) */
  pairingUrl?: string;
  /** Number of OpenClaw backend worker sessions (multi-agent) */
  workerSessionCount?: number;
  /** Ollama process status + running models */
  ollamaStatus?: OllamaStatus;
  /** OpenClaw Gateway reachability (port 18789) */
  gatewayAvailable?: boolean;
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
  // OAuth connection status
  oauthConnected?: boolean;
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

export interface DisplayStateEvent {
  type: 'display_state';
  displayOn: boolean;
}

// ===== Multi-session Discovery =====

export interface SessionInfo {
  id: string;
  port: number;
  projectName: string;
  agentType?: AgentType;
  alive: boolean;
  state?: string;  // sibling's current state from /health query
}

export interface SessionsListEvent {
  type: 'sessions_list';
  sessions: SessionInfo[];
}

export type BridgeEvent =
  | StateUpdateEvent
  | PromptOptionsEvent
  | UsageEvent
  | ConnectionEvent
  | UserPromptEvent
  | VoiceStateEvent
  | DisplayStateEvent
  | SessionsListEvent
  | EncoderStateEvent
  | DeckSlotMapEvent;

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

export interface DiagCommand {
  type: 'diag';
  action: 'dump' | 'analyze';
}

export interface UtilityCommand {
  type: 'utility';
  action: 'adjust_volume' | 'toggle_mute' | 'adjust_brightness'
        | 'media_play_pause' | 'media_next' | 'media_prev';
  value?: number; // delta ticks (for adjust commands)
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
  | QueryUsageCommand
  | DiagCommand
  | UtilityCommand;

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
