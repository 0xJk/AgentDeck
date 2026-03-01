import express from 'express';
import { createServer, type Server, type ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { debug } from './logger.js';
import { isLocalConnection, validateToken } from './auth.js';
import type { BridgeEvent } from './types.js';
import type { VoiceManager } from './voice.js';

/** Minimal SSE client handle */
interface SseClient {
  res: ServerResponse;
  id: number;
}

export class HookServer extends EventEmitter {
  private app: express.Application;
  private server: Server;
  private diagHandler: ((tail?: number) => unknown) | null = null;
  private voiceManager: VoiceManager | null = null;

  // SSE
  private sseClients: SseClient[] = [];
  private sseIdCounter = 0;
  private lastStateEvent: BridgeEvent | null = null;
  private lastUsageEvent: BridgeEvent | null = null;

  // Metadata for status page / health
  private meta: { agentType?: string; projectName?: string; clientCount?: number; state?: string } = {};

  constructor() {
    super();
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
    this.server = createServer(this.app);
  }

  /** Register a callback that provides diagnostic dump data */
  onDiag(handler: (tail?: number) => unknown): void {
    this.diagHandler = handler;
  }

  /** Update metadata shown on /health and /status */
  setMeta(meta: { agentType?: string; projectName?: string; clientCount?: number; state?: string }): void {
    Object.assign(this.meta, meta);
  }

  /** Set voice manager for /voice/transcribe endpoint */
  setVoiceManager(vm: VoiceManager): void {
    this.voiceManager = vm;
  }

  /** Broadcast a BridgeEvent to all SSE clients */
  broadcastSse(event: BridgeEvent): void {
    // Cache latest events for new SSE connections
    if (event.type === 'state_update') this.lastStateEvent = event;
    if (event.type === 'usage_update') this.lastUsageEvent = event;

    const data = JSON.stringify(event);
    const msg = `event: ${event.type}\ndata: ${data}\n\n`;
    const dead: number[] = [];

    for (const client of this.sseClients) {
      try {
        client.res.write(msg);
      } catch {
        dead.push(client.id);
      }
    }

    if (dead.length > 0) {
      this.sseClients = this.sseClients.filter((c) => !dead.includes(c.id));
      debug('SSE', `Removed ${dead.length} dead clients, ${this.sseClients.length} remaining`);
    }
  }

  /** Check token auth for a request. Returns true if authorized. */
  private checkAuth(req: express.Request, res: express.Response): boolean {
    const ip = req.ip || req.socket.remoteAddress || '';
    if (isLocalConnection(ip)) return true;
    const token = req.query.token as string | undefined;
    if (token && validateToken(token)) return true;
    res.status(401).json({ error: 'Unauthorized — token required' });
    return false;
  }

  private setupRoutes(): void {
    // Health check (no auth — minimal info)
    this.app.get('/health', (_req, res) => {
      debug('Hook', 'GET /health');
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        agentType: this.meta.agentType,
        projectName: this.meta.projectName,
        state: this.meta.state,
        wsClients: this.meta.clientCount ?? 0,
        sseClients: this.sseClients.length,
      });
    });

    // SSE endpoint
    this.app.get('/sse', (req, res) => {
      if (!this.checkAuth(req, res)) return;

      debug('SSE', 'New SSE client connected');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const id = ++this.sseIdCounter;
      this.sseClients.push({ res, id });

      // Send current state snapshot
      if (this.lastStateEvent) {
        const data = JSON.stringify(this.lastStateEvent);
        res.write(`event: ${this.lastStateEvent.type}\ndata: ${data}\n\n`);
      }
      if (this.lastUsageEvent) {
        const data = JSON.stringify(this.lastUsageEvent);
        res.write(`event: ${this.lastUsageEvent.type}\ndata: ${data}\n\n`);
      }

      // Keep-alive heartbeat
      const heartbeat = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch { /* client gone */ }
      }, 30_000);

      req.on('close', () => {
        clearInterval(heartbeat);
        this.sseClients = this.sseClients.filter((c) => c.id !== id);
        debug('SSE', `Client disconnected, ${this.sseClients.length} remaining`);
      });
    });

    // Status page — inline HTML
    this.app.get('/status', (req, res) => {
      if (!this.checkAuth(req, res)) return;

      const token = req.query.token as string || '';
      const sseUrl = token ? `/sse?token=${token}` : '/sse';

      debug('Hook', 'GET /status');
      res.type('html').send(statusPageHtml(sseUrl, this.meta));
    });

    // Diagnostic endpoint
    this.app.get('/diag', (req, res) => {
      debug('Hook', 'GET /diag');
      if (!this.diagHandler) {
        res.status(503).json({ error: 'Diagnostic system not initialized' });
        return;
      }
      const tail = req.query.tail ? parseInt(req.query.tail as string, 10) : undefined;
      try {
        const dump = this.diagHandler(tail);
        res.json(dump);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // Hook endpoint - receives JSON POST from Claude Code hooks
    // The hook script pipes stdin JSON to curl POST body
    this.app.post('/hooks/:eventName', (req, res) => {
      const eventName = req.params.eventName;
      const data = req.body || {};

      debug('Hook', `POST /hooks/${eventName} (${JSON.stringify(data).slice(0, 120)})`);

      this.emit('hook', { event: eventName, data });

      // Respond quickly so the hook doesn't block Claude
      res.json({ received: true });
    });

    // Voice transcription endpoint (accepts raw WAV body)
    this.app.post('/voice/transcribe',
      express.raw({ type: 'application/octet-stream', limit: '10mb' }),
      async (req, res) => {
        if (!this.checkAuth(req, res)) return;

        if (!this.voiceManager) {
          res.status(503).json({ error: 'Voice manager not available' });
          return;
        }

        const body = req.body as Buffer;
        if (!body || body.length < 100) {
          res.status(400).json({ error: 'Empty or too short audio data' });
          return;
        }

        debug('Hook', `POST /voice/transcribe (${body.length} bytes)`);

        // Save to temp file
        const tempFile = join(tmpdir(), `sdc-voice-remote-${Date.now()}.wav`);
        try {
          writeFileSync(tempFile, body);
          const text = await this.voiceManager.transcribeFile(tempFile);
          res.json({ text });
        } catch (err) {
          debug('Hook', `Transcription error: ${err}`);
          res.status(500).json({ error: String(err) });
        } finally {
          try { unlinkSync(tempFile); } catch { /* ignore */ }
        }
      },
    );

    // Catch-all for unknown routes
    this.app.use((req, res) => {
      debug('Hook', `404: ${req.method} ${req.url}`);
      res.status(404).json({ error: 'Not found' });
    });
  }

  async listen(port: number, host: string = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use. Is another bridge instance running?`));
        } else {
          reject(err);
        }
      });

      this.server.listen(port, host, () => {
        debug('Hook', `listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  getServer(): Server {
    return this.server;
  }

  async close(): Promise<void> {
    // Close all SSE connections
    for (const client of this.sseClients) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.sseClients = [];

    return new Promise((resolve) => {
      debug('Hook', 'closing server');
      this.server.close(() => {
        resolve();
      });
    });
  }
}

// ─── Inline Status Page HTML ──────────────────────────────────────────────────

function statusPageHtml(
  sseUrl: string,
  meta: { agentType?: string; projectName?: string },
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentDeck — ${meta.projectName || 'Bridge'}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;color:#f8fafc;font-family:system-ui,-apple-system,sans-serif;padding:24px}
h1{font-size:20px;color:#94a3b8;margin-bottom:16px}
.card{background:#1e293b;border-radius:12px;padding:16px;margin-bottom:12px}
.label{color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.5px}
.value{font-size:24px;font-weight:600;margin-top:4px}
.row{display:flex;gap:12px;flex-wrap:wrap}
.row .card{flex:1;min-width:140px}
.state-IDLE{color:#22c55e}
.state-PROCESSING{color:#3b82f6}
.state-AWAITING_PERMISSION,.state-AWAITING_OPTION,.state-AWAITING_DIFF{color:#f59e0b}
.state-DISCONNECTED{color:#ef4444}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle}
.banner{text-align:center;color:#64748b;font-size:12px;margin-top:24px}
.banner a{color:#3b82f6;text-decoration:none}
</style>
</head>
<body>
<h1>AgentDeck${meta.projectName ? ' — ' + esc(meta.projectName) : ''}</h1>
<div class="row">
  <div class="card"><div class="label">State</div><div class="value" id="state">—</div></div>
  <div class="card"><div class="label">Agent</div><div class="value" id="agent">${esc(meta.agentType || '—')}</div></div>
</div>
<div class="row">
  <div class="card"><div class="label">Model</div><div class="value" id="model">—</div></div>
  <div class="card"><div class="label">Tool</div><div class="value" id="tool">—</div></div>
</div>
<div class="row">
  <div class="card"><div class="label">Session</div><div class="value" id="session">0:00</div></div>
  <div class="card"><div class="label">Tokens</div><div class="value" id="tokens">—</div></div>
  <div class="card"><div class="label">Cost</div><div class="value" id="cost">—</div></div>
</div>
<div class="banner">AgentDeck Bridge &middot; <a href="https://github.com/agentdeck">GitHub</a></div>

<script>
const es=new EventSource("${sseUrl}");
const $=id=>document.getElementById(id);
const colors={IDLE:'#22c55e',PROCESSING:'#3b82f6',AWAITING_PERMISSION:'#f59e0b',AWAITING_OPTION:'#f59e0b',AWAITING_DIFF:'#f59e0b',DISCONNECTED:'#ef4444'};
es.addEventListener('state_update',e=>{
  const d=JSON.parse(e.data);
  const s=d.state||'DISCONNECTED';
  $('state').innerHTML='<span class="dot" style="background:'+( colors[s]||'#64748b')+'"></span>'+s;
  if(d.modelName)$('model').textContent=d.modelName;
  $('tool').textContent=d.currentTool||'—';
});
es.addEventListener('usage_update',e=>{
  const d=JSON.parse(e.data);
  const m=Math.floor(d.sessionDurationSec/60),s=d.sessionDurationSec%60;
  $('session').textContent=m+':'+(s<10?'0':'')+s;
  const t=(d.inputTokens||0)+(d.outputTokens||0);
  $('tokens').textContent=t>1000?(t/1000).toFixed(1)+'k':t;
  $('cost').textContent=d.estimatedCostUsd?'$'+d.estimatedCostUsd.toFixed(2):'—';
});
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}
