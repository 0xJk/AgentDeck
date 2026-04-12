import { describe, it, expect } from 'vitest';
import {
  HOOK_EVENTS,
  buildHookEntry,
  applyHooks,
  removeHooks,
  migrateHooks,
} from '../install.js';

describe('Hook Installer', () => {
  describe('buildHookEntry', () => {
    it('creates matcher-group format with AGENTDECK_PORT env var', () => {
      const entry = buildHookEntry('SessionStart');
      expect(entry.matcher).toBe('');
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0].type).toBe('command');
      expect(entry.hooks[0].command).toContain('AGENTDECK_PORT');
      expect(entry.hooks[0].command).toContain('/hooks/SessionStart');
    });

    it('includes fallback port 9120 in command', () => {
      const entry = buildHookEntry('Stop');
      expect(entry.hooks[0].command).toContain('${AGENTDECK_PORT:-9120}');
    });
  });

  describe('applyHooks', () => {
    it('installs hooks to empty settings in matcher-group format', () => {
      const result = applyHooks({});
      expect(result.hooks).toBeDefined();
      expect(Object.keys(result.hooks)).toHaveLength(HOOK_EVENTS.length);

      for (const event of HOOK_EVENTS) {
        expect(result.hooks[event]).toHaveLength(1);
        const group = result.hooks[event][0];
        const expectStar = ['PreToolUse', 'PostToolUse'].includes(event);
        expect(group.matcher).toBe(expectStar ? '*' : '');
        expect(group.hooks).toHaveLength(1);
        expect(group.hooks[0].command).toContain('AGENTDECK_PORT');
        expect(group.hooks[0].command).toContain(event);
      }
    });

    it('preserves non-AgentDeck hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            { matcher: 'custom', hooks: [{ type: 'command', command: 'echo "custom hook"' }] },
          ],
        },
      };
      const result = applyHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(2);
      expect(result.hooks.SessionStart[0].hooks[0].command).toBe('echo "custom hook"');
    });

    it('replaces old flat-format hooks', () => {
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
      const result = applyHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('replaces old matcher-format hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'curl -sf http://localhost:9120/hooks/SessionStart' }],
            },
          ],
        },
      };
      const result = applyHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('is idempotent — running twice produces same result', () => {
      const first = applyHooks({});
      const second = applyHooks(JSON.parse(JSON.stringify(first)));

      for (const event of HOOK_EVENTS) {
        expect(second.hooks[event]).toHaveLength(1);
      }
    });

    it('preserves existing non-hook settings', () => {
      const settings = { permissions: { allow: true }, other: 'value' };
      const result = applyHooks(settings);
      expect(result.permissions).toEqual({ allow: true });
      expect(result.other).toBe('value');
    });
  });

  describe('removeHooks', () => {
    it('removes all AgentDeck hooks (new format)', () => {
      const installed = applyHooks({});
      const result = removeHooks(installed);
      expect(result.hooks).toBeUndefined();
    });

    it('removes old flat-format AgentDeck hooks', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            { type: 'command', command: 'curl -sf http://localhost:9120/hooks/PreToolUse ...' },
          ],
        },
      };
      const result = removeHooks(settings);
      expect(result.hooks).toBeUndefined();
    });

    it('preserves non-AgentDeck hooks', () => {
      const settings = applyHooks({});
      settings.hooks.SessionStart.unshift({
        matcher: 'custom',
        hooks: [{ type: 'command', command: 'echo "keep me"' }],
      });
      const result = removeHooks(settings);
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].hooks[0].command).toBe('echo "keep me"');
    });

    it('handles empty settings gracefully', () => {
      const result = removeHooks({});
      expect(result.hooks).toBeUndefined();
    });
  });

  describe('migrateHooks', () => {
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
      const { settings: migrated, migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      // Should be migrated to matcher-group format
      expect(migrated.hooks.SessionStart[0].hooks).toBeDefined();
      expect(migrated.hooks.SessionStart[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('migrates flat format to matcher-group format', () => {
      const settings = {
        hooks: {
          PreToolUse: [
            {
              type: 'command',
              command: "curl -sf -X POST http://localhost:${AGENTDECK_PORT:-9120}/hooks/PreToolUse ...",
            },
          ],
        },
      };
      const { settings: migrated, migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      expect(migrated.hooks.PreToolUse[0].matcher).toBe('');
      expect(migrated.hooks.PreToolUse[0].hooks[0].command).toContain('AGENTDECK_PORT');
    });

    it('skips already-migrated hooks (new format)', () => {
      const settings = applyHooks({});
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(false);
    });

    it('skips non-AgentDeck hooks', () => {
      const settings = {
        hooks: {
          SessionStart: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo "unrelated"' }] },
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
        expect(settings.hooks[event][0].hooks).toBeDefined();
        expect(settings.hooks[event][0].hooks[0].command).toContain('AGENTDECK_PORT');
      }
    });

    it('migrates hardcoded port inside matcher-group', () => {
      const settings = {
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [{
                type: 'command',
                command: "curl -sf http://localhost:9120/hooks/Stop ...",
              }],
            },
          ],
        },
      };
      const { migrated: didMigrate } = migrateHooks(settings);
      expect(didMigrate).toBe(true);
      expect(settings.hooks.Stop[0].hooks[0].command).toContain('AGENTDECK_PORT');
      expect(settings.hooks.Stop[0].hooks[0].command).not.toContain('localhost:9120');
    });
  });
});
