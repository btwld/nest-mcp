import { describe, expect, it, vi } from 'vitest';
import { ExpressAdapter } from './express.adapter';

describe('ExpressAdapter', () => {
  const adapter = new ExpressAdapter();

  describe('getRequestMethod', () => {
    it('returns the request method', () => {
      expect(adapter.getRequestMethod({ method: 'POST' })).toBe('POST');
    });
  });

  describe('getRequestUrl', () => {
    it('returns the request url', () => {
      expect(adapter.getRequestUrl({ url: '/mcp' })).toBe('/mcp');
    });
  });

  describe('getRequestHeaders', () => {
    it('returns the request headers', () => {
      const headers = { 'content-type': 'application/json', 'x-multi': ['a', 'b'] };
      expect(adapter.getRequestHeaders({ headers })).toBe(headers);
    });
  });

  describe('getRequestBody', () => {
    it('returns the request body', () => {
      const body = { foo: 'bar' };
      expect(adapter.getRequestBody({ body })).toBe(body);
    });
  });

  describe('getRequestQuery', () => {
    it('returns the query params', () => {
      const query = { cursor: 'abc' };
      expect(adapter.getRequestQuery({ query })).toBe(query);
    });
  });

  describe('setResponseHeader', () => {
    it('calls res.setHeader with name and value', () => {
      const setHeader = vi.fn();
      adapter.setResponseHeader({ setHeader }, 'Content-Type', 'text/plain');
      expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain');
    });
  });

  describe('sendResponse', () => {
    it('calls res.status().json() when body is provided', () => {
      const json = vi.fn();
      const status = vi.fn().mockReturnValue({ json });
      adapter.sendResponse({ status }, 200, { ok: true });
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ ok: true });
    });

    it('calls res.status().end() when body is undefined', () => {
      const end = vi.fn();
      const status = vi.fn().mockReturnValue({ end });
      adapter.sendResponse({ status }, 204);
      expect(status).toHaveBeenCalledWith(204);
      expect(end).toHaveBeenCalled();
    });
  });

  describe('sendSseEvent', () => {
    it('writes event and data chunks', () => {
      const write = vi.fn();
      adapter.sendSseEvent({ write }, 'message', 'hello');
      expect(write).toHaveBeenCalledWith('event: message\n');
      expect(write).toHaveBeenCalledWith('data: hello\n\n');
    });

    it('writes id chunk when provided', () => {
      const write = vi.fn();
      adapter.sendSseEvent({ write }, 'ping', 'data', '42');
      expect(write).toHaveBeenCalledWith('id: 42\n');
      expect(write).toHaveBeenCalledWith('event: ping\n');
      expect(write).toHaveBeenCalledWith('data: data\n\n');
    });

    it('calls flush when available', () => {
      const write = vi.fn();
      const flush = vi.fn();
      adapter.sendSseEvent({ write, flush }, 'msg', 'body');
      expect(flush).toHaveBeenCalled();
    });

    it('does not fail when flush is absent', () => {
      const write = vi.fn();
      expect(() => adapter.sendSseEvent({ write }, 'msg', 'body')).not.toThrow();
    });
  });

  describe('setupSse', () => {
    it('calls writeHead with SSE headers', () => {
      const writeHead = vi.fn();
      adapter.setupSse({ writeHead });
      expect(writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
    });
  });

  describe('closeSse', () => {
    it('calls res.end()', () => {
      const end = vi.fn();
      adapter.closeSse({ end });
      expect(end).toHaveBeenCalled();
    });
  });

  describe('onClose', () => {
    it('registers a listener for the close event', () => {
      const on = vi.fn();
      const cb = vi.fn();
      adapter.onClose({ on }, cb);
      expect(on).toHaveBeenCalledWith('close', cb);
    });
  });
});
