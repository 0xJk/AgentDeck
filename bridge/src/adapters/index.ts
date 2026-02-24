import type { AgentType, AgentAdapter } from '../types.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { OpenClawAdapter } from './openclaw.js';

export { ClaudeCodeAdapter } from './claude-code.js';
export { OpenClawAdapter } from './openclaw.js';

/**
 * Factory: create an adapter for the given agent type.
 */
export function createAdapter(type: AgentType, gatewayUrl?: string): AgentAdapter {
  switch (type) {
    case 'claude-code':
      return new ClaudeCodeAdapter();
    case 'openclaw':
      return new OpenClawAdapter(gatewayUrl);
    default:
      throw new Error(`Unknown agent type: ${type}`);
  }
}
