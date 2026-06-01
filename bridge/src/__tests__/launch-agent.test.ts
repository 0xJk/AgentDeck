/**
 * LaunchAgent plist generation (plan 002 #3).
 *
 * The daemon LaunchAgent failed to bind on boot. Root cause: the plist's
 * StandardOutPath/StandardErrorPath live under ~/.agentdeck, but `daemon install`
 * never created that directory — launchd cannot open the redirect target, so the
 * job fails to spawn. The plist must also pin a WorkingDirectory so the daemon's
 * relative-path assumptions don't depend on launchd's default cwd (/).
 */
import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import { buildPlist, LAUNCH_AGENT_LOG_DIR, PLIST_PATH } from '../launch-agent.js';

describe('buildPlist', () => {
  const plist = buildPlist();

  it('runs the daemon in the foreground at load', () => {
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toMatch(/<string>daemon<\/string>\s*<string>start<\/string>\s*<string>--foreground<\/string>/);
  });

  it('redirects stdout/stderr into the agentdeck data dir', () => {
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LOG_DIR}/daemon-stdout.log</string>`);
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LOG_DIR}/daemon-stderr.log</string>`);
  });

  it('pins a WorkingDirectory so launchd does not default to /', () => {
    expect(plist).toContain('<key>WorkingDirectory</key>');
    expect(plist).toContain(`<string>${homedir()}</string>`);
  });

  it('exposes a PATH so the node shebang resolves under launchd', () => {
    expect(plist).toContain('<key>PATH</key>');
  });

  it('puts the LaunchAgent plist under ~/Library/LaunchAgents', () => {
    expect(PLIST_PATH).toContain('/Library/LaunchAgents/dev.agentdeck.daemon.plist');
  });
});
