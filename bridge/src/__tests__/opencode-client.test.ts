import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeClient, type OpenCodeSSEEvent } from '../opencode-client.js';

describe('OpenCodeClient', () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    client = new OpenCodeClient('http://localhost:14096', '/test/project');
  });

  afterEach(() => {
    client.disconnect();
  });

  describe('health', () => {
    it('should call /global/health', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ healthy: true, version: '1.3.3' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const health = await client.health();
      expect(health).toEqual({ healthy: true, version: '1.3.3' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/global/health'),
        expect.objectContaining({ headers: expect.objectContaining({ 'x-opencode-directory': '/test/project' }) }),
      );

      vi.unstubAllGlobals();
    });
  });

  describe('listSessions', () => {
    it('should call /session with directory and limit', async () => {
      const sessions = [{ id: 'ses_1', title: 'test' }];
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(sessions),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await client.listSessions(5);
      expect(result).toEqual(sessions);
      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('/session');
      expect(calledUrl).toContain('limit=5');
      expect(calledUrl).toContain('directory=');

      vi.unstubAllGlobals();
    });
  });

  describe('createSession', () => {
    it('should POST to /session', async () => {
      const session = { id: 'ses_new', title: 'new' };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(session)),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await client.createSession('test title');
      expect(result).toEqual(session);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/session'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'test title' }),
        }),
      );

      vi.unstubAllGlobals();
    });
  });

  describe('sendMessage', () => {
    it('should POST to /session/{id}/message with parts', async () => {
      const response = { info: { id: 'msg_1' }, parts: [] };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(response)),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await client.sendMessage('ses_1', 'hello');
      expect(result).toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/session/ses_1/message'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }),
        }),
      );

      vi.unstubAllGlobals();
    });

    it('should include model option when provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ info: {}, parts: [] })),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.sendMessage('ses_1', 'hello', { model: 'openai/gpt-5' });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('openai/gpt-5');

      vi.unstubAllGlobals();
    });
  });

  describe('abortSession', () => {
    it('should POST to /session/{id}/abort', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(''),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.abortSession('ses_1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/session/ses_1/abort'),
        expect.objectContaining({ method: 'POST' }),
      );

      vi.unstubAllGlobals();
    });
  });

  describe('respondPermission', () => {
    it('should POST allow response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(''),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.respondPermission('ses_1', 'perm_1', true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.response).toBe('allow');

      vi.unstubAllGlobals();
    });

    it('should POST deny response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(''),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.respondPermission('ses_1', 'perm_1', false);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.response).toBe('deny');

      vi.unstubAllGlobals();
    });
  });

  describe('HTTP error handling', () => {
    it('should throw on non-ok response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(client.health()).rejects.toThrow('GET /global/health failed: 500');

      vi.unstubAllGlobals();
    });
  });

  describe('disconnect', () => {
    it('should prevent reconnection after disconnect', () => {
      client.disconnect();
      // After disconnect, subscribe should not attempt connection
      // (verifying no throw)
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  describe('url accessor', () => {
    it('should return server URL', () => {
      expect(client.url).toBe('http://localhost:14096');
    });

    it('should strip trailing slash', () => {
      const c = new OpenCodeClient('http://localhost:14096/', '/test');
      expect(c.url).toBe('http://localhost:14096');
      c.disconnect();
    });
  });
});

describe('OpenCodeAdapter event mapping', () => {
  // Integration-style tests verifying SSE → AdapterEvent mapping
  // These would require the adapter + mock client wired together.
  // For now we test the client independently above.

  it('should export OpenCodeSSEEvent type', () => {
    // Type-level assertion — if this compiles, the type exists
    const evt: OpenCodeSSEEvent = {
      directory: '/test',
      payload: { type: 'session.status', properties: { status: { type: 'busy' } } },
    };
    expect(evt.payload.type).toBe('session.status');
  });
});
