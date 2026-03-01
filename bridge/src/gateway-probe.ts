import net from 'net';
import { debug } from './logger.js';

const GATEWAY_PORT = 18789;
const PROBE_TIMEOUT = 2000;

export interface GatewayStatus {
  available: boolean;
}

export async function probeGateway(): Promise<GatewayStatus> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port: GATEWAY_PORT, host: '127.0.0.1' });
    socket.setTimeout(PROBE_TIMEOUT);
    socket.on('connect', () => { socket.destroy(); resolve({ available: true }); });
    socket.on('error', () => { socket.destroy(); resolve({ available: false }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ available: false }); });
  });
}
