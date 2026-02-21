// Re-export all shared types
export {
  State,
  PermissionMode,
  type TransitionSource,
  type StateTransition,
  transitions,
  type PromptOption,
  type StateSnapshot,
  type BillingType,
} from '@agentdeck/shared';

export {
  type StateUpdateEvent,
  type PromptOptionsEvent,
  type UsageEvent,
  type ConnectionEvent,
  type UserPromptEvent,
  type VoiceStateEvent,
  type BridgeEvent,
  type ResponseCommand,
  type SelectOptionCommand,
  type NavigateOptionCommand,
  type SendPromptCommand,
  type SwitchModeCommand,
  type InterruptCommand,
  type VoiceCommand,
  type QueryUsageCommand,
  type PluginCommand,
  type HookEvent,
  BRIDGE_WS_PORT,
  BRIDGE_HTTP_PORT,
  RECONNECT_INTERVAL_MS,
  STUCK_TIMEOUT_MS,
} from '@agentdeck/shared';

// ===== Bridge-specific types =====

export interface VoiceState {
  recording: boolean;
  transcribing: boolean;
  lastTranscription: string | null;
  error: string | null;
}

export interface SessionInfo {
  sessionId: string;
  startedAt: number;
  pid: number | null;
  port: number;
  workingDirectory: string;
}

export interface UsageSnapshot {
  sessionDurationSec: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  estimatedCostUsd: number | null;
  sessionPercent: number | null;
  costSpent: number | null;
  costLimit: number | null;
  resetTime: string | null;
  resetDate: string | null;
}
