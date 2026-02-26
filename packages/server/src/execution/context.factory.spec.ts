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

  // --- MCP Log Bridge ---

  describe('log bridge with mcpServer', () => {
    it('calls sendLoggingMessage on debug', () => {
      const mockServer = {
        sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
      };
      const ctx = factory.createContext({
        sessionId: 'sess-abcd1234',
        transport: McpTransportType.SSE,
        mcpServer: mockServer as never,
      });

      ctx.log.debug('test message');

      expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith({
        level: 'debug',
        logger: 'MCP:sess-abc',
        data: 'test message',
      });
    });

    it('calls sendLoggingMessage on info', () => {
      const mockServer = {
        sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
      };
      const ctx = factory.createContext({
        sessionId: 'sess-abcd1234',
        transport: McpTransportType.SSE,
        mcpServer: mockServer as never,
      });

      ctx.log.info('info message');

      expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith({
        level: 'info',
        logger: 'MCP:sess-abc',
        data: 'info message',
      });
    });

    it('maps warn to MCP warning level', () => {
      const mockServer = {
        sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
      };
      const ctx = factory.createContext({
        sessionId: 'sess-abcd1234',
        transport: McpTransportType.SSE,
        mcpServer: mockServer as never,
      });

      ctx.log.warn('warn message');

      expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith({
        level: 'warning',
        logger: 'MCP:sess-abc',
        data: 'warn message',
      });
    });

    it('calls sendLoggingMessage on error', () => {
      const mockServer = {
        sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
      };
      const ctx = factory.createContext({
        sessionId: 'sess-abcd1234',
        transport: McpTransportType.SSE,
        mcpServer: mockServer as never,
      });

      ctx.log.error('error message');

      expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith({
        level: 'error',
        logger: 'MCP:sess-abc',
        data: 'error message',
      });
    });

    it('includes data in sendLoggingMessage when provided', () => {
      const mockServer = {
        sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
      };
      const ctx = factory.createContext({
        sessionId: 'sess-abcd1234',
        transport: McpTransportType.SSE,
        mcpServer: mockServer as never,
      });

      ctx.log.info('with data', { key: 'value' });

      expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith({
        level: 'info',
        logger: 'MCP:sess-abc',
        data: { message: 'with data', key: 'value' },
      });
    });

    it('swallows rejected sendLoggingMessage promise', () => {
      const mockServer = {
        sendLoggingMessage: vi.fn().mockRejectedValue(new Error('disconnected')),
      };
      const ctx = factory.createContext({
        sessionId: 'sess-abcd1234',
        transport: McpTransportType.SSE,
        mcpServer: mockServer as never,
      });

      // Should not throw
      expect(() => ctx.log.info('test')).not.toThrow();
    });

    it('does not call sendLoggingMessage when mcpServer is not provided', () => {
      const ctx = factory.createContext({
        sessionId: 'sess-1',
        transport: McpTransportType.STDIO,
      });

      // Should not throw, just writes to NestJS logger
      expect(() => ctx.log.debug('test')).not.toThrow();
      expect(() => ctx.log.info('test')).not.toThrow();
      expect(() => ctx.log.warn('test')).not.toThrow();
      expect(() => ctx.log.error('test')).not.toThrow();
    });
  });
});
