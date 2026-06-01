/**
 * macOS LaunchAgent plist generation for the AgentDeck daemon auto-start.
 *
 * Extracted from cli.ts so it can be unit-tested without triggering the CLI's
 * top-level program.parse(). See plan 002 #3 — the daemon failed to bind on
 * boot because the plist redirects stdout/stderr into ~/.agentdeck but the
 * install step never created that dir (launchd then can't open the redirect
 * target and the job fails to spawn). The plist also pins a WorkingDirectory.
 */
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

export const PLIST_LABEL = 'dev.agentdeck.daemon';
export const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

/** Directory the plist redirects daemon stdout/stderr into — must exist before load. */
export const LAUNCH_AGENT_LOG_DIR = join(homedir(), '.agentdeck');

/** Resolve the `agentdeck` binary path for the plist's ProgramArguments. */
export function getAgentdeckBin(): string {
  try {
    return execSync('which agentdeck', { encoding: 'utf-8' }).trim();
  } catch {
    const distDir = new URL('.', import.meta.url).pathname;
    return join(distDir, 'cli.js');
  }
}

export function buildPlist(): string {
  const bin = getAgentdeckBin();
  const logDir = LAUNCH_AGENT_LOG_DIR;
  const home = homedir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>daemon</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>WorkingDirectory</key>
  <string>${home}</string>
  <key>StandardOutPath</key>
  <string>${logDir}/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/daemon-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
  </dict>
</dict>
</plist>`;
}
