/**
 * OpenCode HTTP API client + SSE event subscriber.
 *
 * Connects to an OpenCode server (`opencode serve`) for structured
 * session management, messaging, and real-time event streaming.
 */

import { EventEmitter } from 'events';
import { debug } from './logger.js';

const log = (...args: unknown[]) => debug('opencode:client', ...args);

// ===== API Types =====

export interface OpenCodeHealthResponse {
  healthy: boolean;
  version: string;
}

export interface OpenCodeSessionInfo {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  summary?: { additions: number; deletions: number; files: number };
  time: { created: number; updated: number };
}

export interface OpenCodeSessionStatus {
  type: 'idle' | 'busy';
}

export interface OpenCodeTokens {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: { created: number; completed?: number };
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: OpenCodeTokens;
  finish?: string;
  agent?: string;
  variant?: string;
}

export interface OpenCodeMessagePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'step-start' | 'step-finish' | 'text' | 'reasoning' | 'tool';
  // step-start
  snapshot?: string;
  // step-finish
  reason?: string;
  cost?: number;
  tokens?: OpenCodeTokens;
  // text / reasoning
  text?: string;
  // tool
  tool?: string;
  callID?: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
  };
  time?: { start?: number; end?: number };
  metadata?: Record<string, unknown>;
}

// ===== SSE Event Types =====

export interface OpenCodeSSEEvent {
  directory?: string;
  payload: {
    type: string;
    properties: Record<string, unknown>;
  };
}

// ===== Client =====

export class OpenCodeClient extends EventEmitter {
  private serverUrl: string;
  private directory: string;
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private shutdownRequested = false;

  private static readonly MAX_RECONNECT_DELAY = 30_000;

  constructor(serverUrl: string, directory: string) {
    super();
    // Normalize URL (remove trailing slash)
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.directory = directory;
  }

  // ===== HTTP Helpers =====

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-opencode-directory': this.directory,
    };
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.serverUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    url.searchParams.set('directory', this.directory);
    const resp = await fetch(url.toString(), { headers: this.headers() });
    if (!resp.ok) throw new Error(`GET ${path} failed: ${resp.status} ${resp.statusText}`);
    return resp.json() as Promise<T>;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.serverUrl);
    url.searchParams.set('directory', this.directory);
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) throw new Error(`POST ${path} failed: ${resp.status} ${resp.statusText}`);
    const text = await resp.text();
    return text ? JSON.parse(text) as T : undefined as T;
  }

  // ===== API Methods =====

  async health(): Promise<OpenCodeHealthResponse> {
    return this.get('/global/health');
  }

  async listSessions(limit = 20): Promise<OpenCodeSessionInfo[]> {
    return this.get('/session', { limit: String(limit) });
  }

  async createSession(title?: string): Promise<OpenCodeSessionInfo> {
    return this.post('/session', title ? { title } : {});
  }

  async getSession(sessionID: string): Promise<OpenCodeSessionInfo> {
    return this.get(`/session/${sessionID}`);
  }

  async getSessionStatus(): Promise<Record<string, OpenCodeSessionStatus>> {
    return this.get('/session/status');
  }

  async sendMessage(
    sessionID: string,
    text: string,
    options?: { model?: string; agent?: string },
  ): Promise<{ info: OpenCodeMessageInfo; parts: OpenCodeMessagePart[] }> {
    return this.post(`/session/${sessionID}/message`, {
      parts: [{ type: 'text', text }],
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.agent ? { agent: options.agent } : {}),
    });
  }

  async abortSession(sessionID: string): Promise<void> {
    await this.post(`/session/${sessionID}/abort`);
  }

  async respondPermission(
    sessionID: string,
    permissionID: string,
    response: boolean,
  ): Promise<void> {
    await this.post(`/session/${sessionID}/permissions/${permissionID}`, {
      response: response ? 'allow' : 'deny',
    });
  }

  async replyQuestion(requestID: string, answers: Record<string, string>): Promise<void> {
    await this.post(`/question/${requestID}/reply`, { answers });
  }

  async rejectQuestion(requestID: string): Promise<void> {
    await this.post(`/question/${requestID}/reject`);
  }

  // ===== SSE Event Stream =====

  /**
   * Subscribe to the SSE event stream.
   * Emits 'sse' events with OpenCodeSSEEvent payloads.
   * Auto-reconnects on disconnect.
   */
  async subscribe(): Promise<void> {
    if (this.shutdownRequested) return;

    this.abortController?.abort();
    this.abortController = new AbortController();

    const url = new URL('/global/event', this.serverUrl);
    url.searchParams.set('directory', this.directory);

    try {
      const resp = await fetch(url.toString(), {
        headers: { Accept: 'text/event-stream' },
        signal: this.abortController.signal,
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`SSE connect failed: ${resp.status}`);
      }

      // Reset reconnect delay on successful connection
      this.reconnectDelay = 1000;
      log('SSE connected to', this.serverUrl);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!this.shutdownRequested) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr) as OpenCodeSSEEvent;
            this.emit('sse', event);
          } catch (e) {
            log('SSE parse error:', e);
          }
        }
      }
    } catch (err: unknown) {
      if (this.shutdownRequested) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      log('SSE error:', err);
    }

    // Schedule reconnect
    if (!this.shutdownRequested) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    log(`SSE reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.subscribe().catch((err) => log('SSE reconnect failed:', err));
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      OpenCodeClient.MAX_RECONNECT_DELAY,
    );
  }

  // ===== Lifecycle =====

  disconnect(): void {
    this.shutdownRequested = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
  }

  get url(): string {
    return this.serverUrl;
  }
}
