import { Bonjour } from 'bonjour-service';
import { networkInterfaces } from 'os';
import type { AgentType } from './types.js';
import { debug, log } from './logger.js';

let instance: Bonjour | null = null;

/** Find the first routable (non-link-local, non-loopback) IPv4 address. */
function getLanIp(): string | undefined {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        return a.address;
      }
    }
  }
  return undefined;
}

const MDNS_RECOVERY_INTERVAL = 30_000; // 30s

/**
 * Called from uncaughtException handler when mDNS socket fails.
 * Nulls the instance so the recovery timer knows to re-publish.
 */
export function invalidateMdnsInstance(): void {
  if (instance) {
    try {
      instance.destroy();
    } catch { /* ignore */ }
    instance = null;
    debug('mDNS', 'Instance invalidated — recovery timer will re-publish');
  }
}

/**
 * Advertise this bridge session via mDNS/Bonjour so Android/LAN clients
 * can discover it automatically.
 *
 * Includes automatic recovery: if the underlying mDNS socket fails (e.g. after
 * sleep/wake or WiFi reconnect), a periodic check detects the broken state and
 * re-publishes the service.
 *
 * @returns cleanup function to call on shutdown
 */
export function advertiseBridge(
  port: number,
  projectName: string,
  agentType: AgentType,
  token?: string,
): () => void {
  let stopped = false;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  let currentCleanup: (() => void) | null = null;

  function publish(): boolean {
    try {
      // Tear down previous instance if any
      if (instance) {
        try {
          instance.unpublishAll();
          instance.destroy();
        } catch { /* ignore cleanup errors */ }
        instance = null;
      }

      instance = new Bonjour();

      const lanIp = getLanIp();
      const txt: Record<string, string> = {
        project: projectName,
        agent: agentType,
        v: '1',
        port: String(port),
      };
      if (token) txt.token = token;
      if (lanIp) txt.ip = lanIp;

      const service = instance.publish({
        name: `${projectName}-${port}`,
        type: 'agentdeck',
        port,
        txt,
      });

      // Catch async publish errors — mDNS is non-critical
      service.on?.('error', (err: Error) => {
        debug('mDNS', `Service error (ignored): ${err.message}`);
      });

      debug('mDNS', `Published _agentdeck._tcp on port ${port} (project: ${projectName})`);

      currentCleanup = () => {
        try {
          service.stop?.();
          instance?.unpublishAll();
          instance?.destroy();
          instance = null;
        } catch (err) {
          debug('mDNS', `Cleanup error: ${err}`);
        }
      };

      return true;
    } catch (err) {
      debug('mDNS', `Failed to advertise: ${err}`);
      instance = null;
      currentCleanup = null;
      return false;
    }
  }

  // Initial publish
  publish();

  // Periodic recovery: if network came back, re-publish
  recoveryTimer = setInterval(() => {
    if (stopped) return;
    const lanIp = getLanIp();
    if (!lanIp) {
      // No network — nothing to recover yet
      debug('mDNS', 'Recovery check: no LAN IP available');
      return;
    }
    // Test if current mDNS socket is alive by checking the instance
    // bonjour-service doesn't expose socket state, so we re-publish
    // only if the instance was lost (set to null after error)
    if (!instance) {
      log('[mDNS] Network recovered — re-publishing service');
      publish();
    }
  }, MDNS_RECOVERY_INTERVAL);

  return () => {
    stopped = true;
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      recoveryTimer = null;
    }
    currentCleanup?.();
    currentCleanup = null;
  };
}
