import { McpUpstreamError, ToolExecutionError } from '@nest-mcp/common';
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedRequest } from '../interfaces/openapi-mcp-options.interface';
import { execute } from './execute';

function mockResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    headers: new Headers({ 'content-type': contentType }),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

const sampleReq: NormalizedRequest = {
  method: 'GET',
  url: 'https://api.example.com/x',
  headers: {},
};

describe('execute', () => {
  it('returns the parsed JSON body on 200', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(200, { ok: true }));
    const result = await execute(sampleReq, 'tool', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
  });

  it('parses text response when content-type is not JSON', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(200, 'plain', 'text/plain'));
    const result = await execute(sampleReq, 'tool', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.body).toBe('plain');
  });

  it('throws McpUpstreamError on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(404, { error: 'not found' }));
    await expect(
      execute(sampleReq, 'tool', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(McpUpstreamError);
  });

  it('throws ToolExecutionError on AbortError', async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    await expect(
      execute(sampleReq, 'tool', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it('does not send a body for GET requests', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBeUndefined();
      return mockResponse(200, {});
    });
    await execute(sampleReq, 'tool', { fetchImpl: fetchImpl as unknown as typeof fetch });
  });

  it('serializes JSON body for POST', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBe('{"name":"rex"}');
      return mockResponse(200, {});
    });
    await execute({ ...sampleReq, method: 'POST', body: { name: 'rex' } }, 'tool', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  });
});
