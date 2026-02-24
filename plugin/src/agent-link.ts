import type { EventEmitter } from 'events';
import type { PluginCommand, AgentCapabilities } from '@agentdeck/shared';

/**
 * Common interface for BridgeClient and GatewayClient.
 *
 * Actions only need send() and isConnected() — they never interact
 * with connection lifecycle or protocol-specific details.
 *
 * Extends EventEmitter so callers can listen for BridgeEvent types
 * (state_update, prompt_options, etc.) and connection events
 * (connected, disconnected).
 */
export interface AgentLink extends EventEmitter {
  send(command: PluginCommand): void;
  isConnected(): boolean;
  getCapabilities(): AgentCapabilities | null;
  disconnect(): void;
}
