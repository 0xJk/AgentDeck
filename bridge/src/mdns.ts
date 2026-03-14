import { Bonjour } from 'bonjour-service';
import { networkInterfaces } from 'os';
import type { AgentType } from './types.js';
import { debug } from './logger.js';

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

/**
 * Advertise this bridge session via mDNS/Bonjour so Android/LAN clients
 * can discover it automatically.
 *
 * @returns cleanup function to call on shutdown
 */
export function advertiseBridge(
  port: number,
  projectName: string,
  agentType: AgentType,
  token?: string,
): () => void {
  try {
    instance = new Bonjour();

    const lanIp = getLanIp();
    const txt: Record<string, string> = {
      project: projectName,
      agent: agentType,
      v: '1',
      port: String(port),
    };
    if (token) {
      txt.token = token;
    }
    if (lanIp) {
      txt.ip = lanIp;
    }

    const service = instance.publish({
      name: `AgentDeck-${projectName}-${port}`,
      type: 'agentdeck',
      port,
      txt,
    });

    // Catch async publish errors (e.g. "Service name already in use") — mDNS is non-critical
    service.on?.('error', (err: Error) => {
      debug('mDNS', `Service error (ignored): ${err.message}`);
    });

    debug('mDNS', `Published _agentdeck._tcp on port ${port} (project: ${projectName})`);

    return () => {
      try {
        service.stop?.();
        instance?.unpublishAll();
        instance?.destroy();
        instance = null;
        debug('mDNS', 'Service unpublished and destroyed');
      } catch (err) {
        debug('mDNS', `Cleanup error: ${err}`);
      }
    };
  } catch (err) {
    debug('mDNS', `Failed to advertise: ${err}`);
    // Return no-op cleanup if mDNS fails (non-critical)
    return () => {};
  }
}
