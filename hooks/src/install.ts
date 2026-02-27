import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'UserPromptSubmit',
] as const;

// Build hook config for each event — uses $AGENTDECK_PORT env var so each
// bridge session's Claude process POSTs to the correct port.
// Claude Code v2.1+ requires 3-level nesting: event → matcher group → hook handler.
function buildHookEntry(eventName: string) {
  const handler: any = {
    type: 'command',
    command: `curl -sf -X POST http://localhost:\${AGENTDECK_PORT:-9120}/hooks/${eventName} -H 'Content-Type: application/json' -d @- 2>/dev/null || true`,
  };
  return {
    matcher: '',
    hooks: [handler],
  };
}

export function installHooks(): void {
  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');

  // Ensure .claude directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Read existing settings or start fresh
  let settings: any = {};
  if (existsSync(settingsPath)) {
    const content = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(content);
  }

  // Ensure hooks object exists
  if (!settings.hooks) {
    settings.hooks = {};
  }

  // For each event, add our hook (avoid duplicates)
  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Remove any existing AgentDeck hooks — both old flat format and new matcher format
    settings.hooks[event] = settings.hooks[event].filter((h: any) => {
      // Old flat format: { type: "command", command: "curl ... AGENTDECK_PORT ..." }
      if (h.command?.includes('AGENTDECK_PORT') || h.command?.includes('localhost:9120')) {
        return false;
      }
      // New matcher format: { matcher: ..., hooks: [{ command: "curl ..." }] }
      if (Array.isArray(h.hooks) && h.hooks.some((hh: any) =>
        hh.command?.includes('AGENTDECK_PORT') || hh.command?.includes('localhost:9120')
      )) {
        return false;
      }
      return true;
    });

    // Add our hook (new matcher-group format for Claude Code v2.1+)
    settings.hooks[event].push(buildHookEntry(event));
  }

  // Write back
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Hooks installed to ${settingsPath}`);
}

export function uninstallHooks(): void {
  const settingsPath = join(homedir(), '.claude', 'settings.local.json');
  if (!existsSync(settingsPath)) return;

  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  if (!settings.hooks) return;

  for (const event of HOOK_EVENTS) {
    if (settings.hooks[event]) {
      settings.hooks[event] = settings.hooks[event].filter((h: any) => {
        // Old flat format
        if (h.command?.includes('AGENTDECK_PORT') || h.command?.includes('localhost:9120')) {
          return false;
        }
        // New matcher format
        if (Array.isArray(h.hooks) && h.hooks.some((hh: any) =>
          hh.command?.includes('AGENTDECK_PORT') || hh.command?.includes('localhost:9120')
        )) {
          return false;
        }
        return true;
      });
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('Hooks uninstalled');
}

// CLI execution
const isMainModule = import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === new URL(process.argv[1], 'file://').href;

if (isMainModule) {
  const action = process.argv[2] || 'install';
  if (action === 'uninstall') {
    uninstallHooks();
  } else {
    installHooks();
  }
}
