import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Test hook installation logic by reimplementing the core algorithm
// (avoids side effects on real ~/.claude/settings.local.json)

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'UserPromptSubmit',
] as const;

function buildHookEntry(eventName: string) {
  const entry: any = {
    type: 'command',
    command: `curl -sf -X POST http://localhost:\${AGENTDECK_PORT:-9120}/hooks/${eventName} -H 'Content-Type: application/json' -d @- 2>/dev/null || true`,
  };
  if (eventName === 'SessionEnd') {
    entry.async = true;
  }
  return entry;
}

function installHooks(settings: any): any {
  if (!settings.hooks) {
    settings.hooks = {};
  }
  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }
    settings.hooks[event] = settings.hooks[event].filter(
      (h: any) =>
        !h.command?.includes('localhost:9120') &&
        !h.command?.includes('AGENTDECK_PORT'),
    );
    settings.hooks[event].push(buildHookEntry(event));
  }
  return settings;
}

function uninstallHooks(settings: any): any {
  if (!settings.hooks) return settings;
  for (const event of HOOK_EVENTS) {
    if (settings.hooks[event]) {
      settings.hooks[event] = settings.hooks[event].filter(
        (h: any) =>
          !h.command?.includes('localhost:9120') &&
          !h.command?.includes('AGENTDECK_PORT'),
      );
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  return settings;
}

/** Simulate the bridge's migrateHooksIfNeeded logic */
function migrateHooks(settings: any): { settings: any; migrated: boolean } {
  let migrated = false;
  if (!settings.hooks) return { settings, migrated };

  for (const event of Object.keys(settings.hooks)) {
    const hooks = settings.hooks[event];
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      if (
        hook.command?.includes('localhost:9120') &&
        !hook.command?.includes('AGENTDECK_PORT')
      ) {
        hook.command = hook.command.replace(
          /localhost:9120/g,
          'localhost:${AGENTDECK_PORT:-9120}',
        );
        migrated = true;
      }
    }
  }
  return { settings, migrated };
}

describe('Hook Installer', () => {
  describe('installHooks', () => {
    it('installs hooks to empty settings', () => {
      const result = installHooks({});
      expect(result.hooks).toBeDefined();
      expect(Object.keys(result.hooks)).toHaveLength(HOOK_EVENTS.length);

      for (const event of HOOK_EVENTS) {
        expect(result.hooks[event]).toHaveLength(1);
        expect(result.hooks[event][0].command).toContain('AGENTDECK_PORT');
        expect(result.hooks[event][0].command).toContain(event);
      }
    });

    it('SessionEnd hook has async: true', () => {
      const result = installHooks({});
      expect(result.hooks.SessionEnd[0].async).toBe(true);
    });

    it('other hooks do not have async', () => {
      const result = installHooks({});
      expect(result.hooks.SessionStart[0].async).toBeUndefined();
      expect(result.hooks.PreToolUse[0].async).toBeUndefined();
    });

    it('preserves non-AgentDeck hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            { type: 'command', command: 'echo "custom hook"' },
          ],
        },
      };
      const result = installHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(2);
      expect(result.hooks.SessionStart[0].command).toBe('echo "custom hook"');
    });

    it('replaces old hardcoded hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            {
              type: 'command',
              command: 'curl -sf -X POST http://localhost:9120/hooks/SessionStart ...',
            },
          ],
        },
      };
      const result = installHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].command).toContain('AGENTDECK_PORT');
    });

    it('is idempotent — running twice produces same result', () => {
      const first = installHooks({});
      const second = installHooks(JSON.parse(JSON.stringify(first)));

      for (const event of HOOK_EVENTS) {
        expect(second.hooks[event]).toHaveLength(1);
      }
    });

    it('preserves existing non-hook settings', () => {
      const settings = { permissions: { allow: true }, other: 'value' };
      const result = installHooks(settings);
      expect(result.permissions).toEqual({ allow: true });
      expect(result.other).toBe('value');
    });
  });

  describe('uninstallHooks', () => {
    it('removes all AgentDeck hooks', () => {
      const installed = installHooks({});
      const result = uninstallHooks(installed);
      expect(result.hooks).toBeUndefined();
    });

    it('preserves non-AgentDeck hooks', () => {
      const settings = installHooks({});
      settings.hooks.SessionStart.unshift({
        type: 'command',
        command: 'echo "keep me"',
      });
      const result = uninstallHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].command).toBe('echo "keep me"');
    });

    it('handles empty settings gracefully', () => {
      const result = uninstallHooks({});
      expect(result.hooks).toBeUndefined();
    });
  });

  describe('hook migration', () => {
    it('migrates old hardcoded port to env var', () => {
      const settings = {
        hooks: {
          SessionStart: [
            {
              type: 'command',
              command:
                "curl -sf -X POST http://localhost:9120/hooks/SessionStart -H 'Content-Type: application/json' -d @- 2>/dev/null || true",
            },
          ],
        },
      };
      const { settings: migrated, migrated: didMigrate } =
        migrateHooks(settings);
      expect(didMigrate).toBe(true);
      expect(migrated.hooks.SessionStart[0].command).toContain(
        'AGENTDECK_PORT',
      );
      expect(migrated.hooks.SessionStart[0].command).not.toMatch(
        /localhost:9120(?!})/,
      );
    });

    it('skips already-migrated hooks', () => {
      const settings = installHooks({});
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(false);
    });

    it('skips non-AgentDeck hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            { type: 'command', command: 'echo "unrelated"' },
          ],
        },
      };
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(false);
    });

    it('migrates multiple events at once', () => {
      const settings: any = { hooks: {} };
      for (const event of HOOK_EVENTS) {
        settings.hooks[event] = [
          {
            type: 'command',
            command: `curl -sf -X POST http://localhost:9120/hooks/${event} ...`,
          },
        ];
      }
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      for (const event of HOOK_EVENTS) {
        expect(settings.hooks[event][0].command).toContain('AGENTDECK_PORT');
      }
    });
  });
});
