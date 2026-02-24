import 'reflect-metadata';
import { McpTransportType } from '@btwld/mcp-common';
import { McpContextFactory } from './context.factory';

describe('McpContextFactory', () => {
  let factory: McpContextFactory;

  beforeEach(() => {
    factory = new McpContextFactory();
  });

  it('creates context with sessionId, transport, metadata, and logger', () => {
    const ctx = factory.createContext({
      sessionId: 'sess-12345678-abcd',
      transport: McpTransportType.SSE,
    });

    expect(ctx.sessionId).toBe('sess-12345678-abcd');
    expect(ctx.transport).toBe(McpTransportType.SSE);
    expect(ctx.metadata).toEqual({});
    expect(ctx.log).toBeDefined();
    expect(typeof ctx.log.debug).toBe('function');
    expect(typeof ctx.log.info).toBe('function');
    expect(typeof ctx.log.warn).toBe('function');
    expect(typeof ctx.log.error).toBe('function');
  });

  it('includes user when provided', () => {
    const user = { id: 'user-1', roles: ['admin'] };
    const ctx = factory.createContext({
      sessionId: 'sess-1',
      transport: McpTransportType.STDIO,
      user,
    });

    expect(ctx.user).toBe(user);
  });

  it('includes request when provided', () => {
    const request = { headers: { authorization: 'Bearer token' } };
    const ctx = factory.createContext({
      sessionId: 'sess-1',
      transport: McpTransportType.STDIO,
      request,
    });

    expect(ctx.request).toBe(request);
  });

  it('includes signal when provided', () => {
    const controller = new AbortController();
    const ctx = factory.createContext({
      sessionId: 'sess-1',
      transport: McpTransportType.STDIO,
      signal: controller.signal,
    });

    expect(ctx.signal).toBe(controller.signal);
  });

  it('uses noop reportProgress when no callback is provided', async () => {
    const ctx = factory.createContext({
      sessionId: 'sess-1',
      transport: McpTransportType.STDIO,
    });

    await expect(ctx.reportProgress({ progress: 50, total: 100 })).resolves.toBeUndefined();
  });

  it('uses the provided progressCallback for reportProgress', async () => {
    const progressCallback = vi.fn().mockResolvedValue(undefined);
    const ctx = factory.createContext({
      sessionId: 'sess-1',
      transport: McpTransportType.STDIO,
      progressCallback,
    });

    await ctx.reportProgress({ progress: 50, total: 100 });
    expect(progressCallback).toHaveBeenCalledWith({ progress: 50, total: 100 });
  });

  it('leaves user and request undefined when not provided', () => {
    const ctx = factory.createContext({
      sessionId: 'sess-1',
      transport: McpTransportType.STREAMABLE_HTTP,
    });

    expect(ctx.user).toBeUndefined();
    expect(ctx.request).toBeUndefined();
    expect(ctx.signal).toBeUndefined();
  });
});
