import { describe, expect, it, vi } from 'vitest';
import { FastifyAdapter } from './fastify.adapter';

describe('FastifyAdapter', () => {
  const adapter = new FastifyAdapter();

  describe('getRequestMethod', () => {
    it('returns the request method', () => {
      expect(adapter.getRequestMethod({ method: 'GET' })).toBe('GET');
    });
  });

  describe('getRequestUrl', () => {
    it('returns the request url', () => {
      expect(adapter.getRequestUrl({ url: '/mcp' })).toBe('/mcp');
    });
  });

  describe('getRequestHeaders', () => {
    it('returns the request headers', () => {
      const headers = { authorization: 'Bearer token', 'x-multi': ['a', 'b'] };
      expect(adapter.getRequestHeaders({ headers })).toBe(headers);
    });
  });

  describe('getRequestBody', () => {
    it('returns the request body', () => {
      const body = { jsonrpc: '2.0' };
      expect(adapter.getRequestBody({ body })).toBe(body);
    });
  });

  describe('getRequestQuery', () => {
    it('returns the query params', () => {
      const query = { sessionId: 'abc' };
      expect(adapter.getRequestQuery({ query })).toBe(query);
    });
  });

  describe('setResponseHeader', () => {
    it('calls res.header() with name and value', () => {
      const header = vi.fn();
      adapter.setResponseHeader({ header }, 'Content-Type', 'application/json');
      expect(header).toHaveBeenCalledWith('Content-Type', 'application/json');
    });
  });

  describe('sendResponse', () => {
    it('calls res.code().send(body) when body is provided', () => {
      const send = vi.fn();
      const code = vi.fn().mockReturnValue({ send });
      adapter.sendResponse({ code }, 200, { result: 'ok' });
      expect(code).toHaveBeenCalledWith(200);
      expect(send).toHaveBeenCalledWith({ result: 'ok' });
    });

    it('calls res.code().send() with no args when body is undefined', () => {
      const send = vi.fn();
      const code = vi.fn().mockReturnValue({ send });
      adapter.sendResponse({ code }, 204);
      expect(code).toHaveBeenCalledWith(204);
      expect(send).toHaveBeenCalledWith();
    });
  });

  describe('sendSseEvent', () => {
    it('writes event and data through raw', () => {
      const write = vi.fn();
      adapter.sendSseEvent({ raw: { write } }, 'message', 'hello');
      expect(write).toHaveBeenCalledWith('event: message\n');
      expect(write).toHaveBeenCalledWith('data: hello\n\n');
    });

    it('writes id chunk when provided', () => {
      const write = vi.fn();
      adapter.sendSseEvent({ raw: { write } }, 'ping', 'data', '7');
      expect(write).toHaveBeenCalledWith('id: 7\n');
      expect(write).toHaveBeenCalledWith('event: ping\n');
      expect(write).toHaveBeenCalledWith('data: data\n\n');
    });
  });

  describe('setupSse', () => {
    it('calls raw.writeHead with SSE headers', () => {
      const writeHead = vi.fn();
      adapter.setupSse({ raw: { writeHead } });
      expect(writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
    });
  });

  describe('closeSse', () => {
    it('calls raw.end()', () => {
      const end = vi.fn();
      adapter.closeSse({ raw: { end } });
      expect(end).toHaveBeenCalled();
    });
  });

  describe('onClose', () => {
    it('registers listener on raw close event', () => {
      const on = vi.fn();
      const cb = vi.fn();
      adapter.onClose({ raw: { on } }, cb);
      expect(on).toHaveBeenCalledWith('close', cb);
    });
  });
});
