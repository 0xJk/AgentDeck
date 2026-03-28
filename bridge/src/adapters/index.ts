import type { AgentType, AgentAdapter } from '../types.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexCliAdapter } from './codex-cli.js';
import { OpenClawAdapter } from './openclaw.js';
import { OpenCodeAdapter } from './opencode-adapter.js';
import { MonitorAdapter } from './monitor.js';

export { ClaudeCodeAdapter } from './claude-code.js';
export { CodexCliAdapter } from './codex-cli.js';
export { OpenClawAdapter } from './openclaw.js';
export { OpenCodeAdapter } from './opencode-adapter.js';
export { MonitorAdapter } from './monitor.js';
export { PtyAdapter } from './pty-adapter.js';

/**
 * Factory: create an adapter for the given agent type.
 */
export function createAdapter(type: AgentType, gatewayUrl?: string): AgentAdapter {
  switch (type) {
    case 'claude-code':
      return new ClaudeCodeAdapter();
    case 'codex-cli':
      return new CodexCliAdapter();
    case 'openclaw':
      return new OpenClawAdapter(gatewayUrl);
    case 'opencode':
      return new OpenCodeAdapter();
    case 'monitor':
      return new MonitorAdapter();
    default:
      throw new Error(`Unknown agent type: ${type}`);
  }
}
