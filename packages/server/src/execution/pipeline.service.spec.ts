import 'reflect-metadata';
import { MCP_OPTIONS, McpTimeoutError, ToolExecutionError } from '@btwld/mcp-common';
import type { McpExecutionContext, McpModuleOptions } from '@btwld/mcp-common';
import { mockMcpContext } from '../testing/mock-context';
import { ExecutionPipelineService } from './pipeline.service';

describe('ExecutionPipelineService', () => {
  let pipeline: ExecutionPipelineService;
  let ctx: McpExecutionContext;

  // Mocked dependencies
  let executor: Record<string, ReturnType<typeof vi.fn>>;
  let registry: Record<string, ReturnType<typeof vi.fn>>;
  let authGuard: Record<string, ReturnType<typeof vi.fn>>;
  let middlewareService: Record<string, ReturnType<typeof vi.fn>>;
  let rateLimiter: Record<string, ReturnType<typeof vi.fn>>;
  let circuitBreaker: Record<string, ReturnType<typeof vi.fn>>;
  let retry: Record<string, ReturnType<typeof vi.fn>>;
  let metrics: Record<string, ReturnType<typeof vi.fn>>;
  let moduleRef: Record<string, ReturnType<typeof vi.fn>>;
  let options: McpModuleOptions;

  beforeEach(() => {
    ctx = mockMcpContext();

    executor = {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      listTools: vi.fn().mockResolvedValue([]),
      listResources: vi.fn().mockResolvedValue([]),
      listResourceTemplates: vi.fn().mockResolvedValue([]),
      listPrompts: vi.fn().mockResolvedValue([]),
      readResource: vi.fn().mockResolvedValue({ contents: [{ uri: 'x', text: 'data' }] }),
      getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
    };

    registry = {
      getTool: vi.fn(),
      getResource: vi.fn(),
      getPrompt: vi.fn(),
    };

    authGuard = {
      checkAuthorization: vi.fn().mockResolvedValue(undefined),
    };

    middlewareService = {
      executeChain: vi
        .fn()
        .mockImplementation(
          (_mw: unknown, _ctx: unknown, _args: unknown, handler: () => Promise<unknown>) =>
            handler(),
        ),
    };

    rateLimiter = { checkLimit: vi.fn().mockResolvedValue(undefined) };
    circuitBreaker = {
      execute: vi
        .fn()
        .mockImplementation((_n: unknown, _c: unknown, fn: () => Promise<unknown>) => fn()),
    };
    retry = {
      execute: vi
        .fn()
        .mockImplementation((_n: unknown, _c: unknown, fn: () => Promise<unknown>) => fn()),
    };
    metrics = { recordCall: vi.fn() };
    moduleRef = { get: vi.fn() };

    options = {} as McpModuleOptions;

    pipeline = new ExecutionPipelineService(
      executor as unknown as ConstructorParameters<typeof ExecutionPipelineService>[0],
      registry as unknown as ConstructorParameters<typeof ExecutionPipelineService>[1],
      authGuard as unknown as ConstructorParameters<typeof ExecutionPipelineService>[2],
      middlewareService as unknown as ConstructorParameters<typeof ExecutionPipelineService>[3],
      rateLimiter as unknown as ConstructorParameters<typeof ExecutionPipelineService>[4],
      circuitBreaker as unknown as ConstructorParameters<typeof ExecutionPipelineService>[5],
      retry as unknown as ConstructorParameters<typeof ExecutionPipelineService>[6],
      metrics as unknown as ConstructorParameters<typeof ExecutionPipelineService>[7],
      options,
      moduleRef as unknown as ConstructorParameters<typeof ExecutionPipelineService>[9],
    );
  });

  // --- callTool ---

  describe('callTool', () => {
    it('throws ToolExecutionError when tool not found in registry', async () => {
      registry.getTool.mockReturnValue(undefined);

      await expect(pipeline.callTool('missing', {}, ctx)).rejects.toThrow(ToolExecutionError);
    });

    it('delegates to executor.callTool', async () => {
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true });

      await pipeline.callTool('test', { a: 1 }, ctx);

      expect(executor.callTool).toHaveBeenCalledWith('test', { a: 1 }, ctx);
    });

    it('skips auth for public tools', async () => {
      registry.getTool.mockReturnValue({ name: 'pub', isPublic: true });

      await pipeline.callTool('pub', {}, ctx);

      expect(authGuard.checkAuthorization).not.toHaveBeenCalled();
    });

    it('calls authGuard for non-public tools', async () => {
      registry.getTool.mockReturnValue({ name: 'priv', isPublic: false });

      await pipeline.callTool('priv', {}, ctx);

      expect(authGuard.checkAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'priv' }),
        expect.objectContaining({ sessionId: ctx.sessionId, toolName: 'priv' }),
      );
    });

    it('collects global + tool middleware and calls executeChain', async () => {
      const globalMw = vi.fn();
      const toolMw = vi.fn();
      options.middleware = [globalMw];
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true, middleware: [toolMw] });

      await pipeline.callTool('test', {}, ctx);

      expect(middlewareService.executeChain).toHaveBeenCalledWith(
        [globalMw, toolMw],
        ctx,
        {},
        expect.any(Function),
      );
    });

    it('checks rate limit when rateLimit config is present on tool', async () => {
      const rateLimitConfig = { max: 10, window: '1m' };
      registry.getTool.mockReturnValue({
        name: 'limited',
        isPublic: true,
        rateLimit: rateLimitConfig,
      });

      await pipeline.callTool('limited', {}, ctx);

      expect(rateLimiter.checkLimit).toHaveBeenCalledWith('limited', rateLimitConfig, undefined);
    });

    it('checks rate limit from global options when tool has none', async () => {
      const rateLimitConfig = { max: 5, window: '1s' };
      options.resilience = { rateLimit: rateLimitConfig };
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true });

      await pipeline.callTool('test', {}, ctx);

      expect(rateLimiter.checkLimit).toHaveBeenCalledWith('test', rateLimitConfig, undefined);
    });

    it('wraps with retry when retryConfig is present', async () => {
      const retryConfig = { maxAttempts: 3, backoff: 'fixed' as const };
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true, retry: retryConfig });

      await pipeline.callTool('test', {}, ctx);

      expect(retry.execute).toHaveBeenCalledWith('test', retryConfig, expect.any(Function));
    });

    it('wraps with circuit breaker when cbConfig is present', async () => {
      const cbConfig = { errorThreshold: 0.5, timeWindow: 60000 };
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true, circuitBreaker: cbConfig });

      await pipeline.callTool('test', {}, ctx);

      expect(circuitBreaker.execute).toHaveBeenCalledWith('test', cbConfig, expect.any(Function));
    });

    it('records metrics on success', async () => {
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true });

      await pipeline.callTool('test', {}, ctx);

      expect(metrics.recordCall).toHaveBeenCalledWith('test', expect.any(Number), true);
    });

    it('records metrics on failure', async () => {
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true });
      executor.callTool.mockRejectedValue(new Error('fail'));

      await expect(pipeline.callTool('test', {}, ctx)).rejects.toThrow('fail');

      expect(metrics.recordCall).toHaveBeenCalledWith('test', expect.any(Number), false);
    });
  });

  // --- readResource ---

  describe('readResource', () => {
    it('delegates to executor.readResource', async () => {
      registry.getResource.mockReturnValue(undefined);

      await pipeline.readResource('file:///data', ctx);

      expect(executor.readResource).toHaveBeenCalledWith('file:///data', ctx);
    });

    it('calls authGuard when resource is found in registry', async () => {
      registry.getResource.mockReturnValue({
        uri: 'file:///x',
        name: 'x',
        methodName: 'get',
        instance: {},
      });

      await pipeline.readResource('file:///x', ctx);

      expect(authGuard.checkAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'file:///x', isPublic: false }),
        expect.objectContaining({ resourceUri: 'file:///x' }),
      );
    });

    it('applies global middleware', async () => {
      const mw = vi.fn();
      options.middleware = [mw];
      registry.getResource.mockReturnValue(undefined);

      await pipeline.readResource('file:///data', ctx);

      expect(middlewareService.executeChain).toHaveBeenCalledWith(
        [mw],
        ctx,
        { uri: 'file:///data' },
        expect.any(Function),
      );
    });
  });

  // --- getPrompt ---

  describe('getPrompt', () => {
    it('delegates to executor.getPrompt', async () => {
      registry.getPrompt.mockReturnValue(undefined);

      await pipeline.getPrompt('greet', { name: 'world' }, ctx);

      expect(executor.getPrompt).toHaveBeenCalledWith('greet', { name: 'world' }, ctx);
    });

    it('calls authGuard when prompt is found in registry', async () => {
      registry.getPrompt.mockReturnValue({ name: 'greet', methodName: 'greet', instance: {} });

      await pipeline.getPrompt('greet', {}, ctx);

      expect(authGuard.checkAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'greet', isPublic: false }),
        expect.objectContaining({ promptName: 'greet' }),
      );
    });

    it('applies global middleware', async () => {
      const mw = vi.fn();
      options.middleware = [mw];
      registry.getPrompt.mockReturnValue(undefined);

      await pipeline.getPrompt('greet', {}, ctx);

      expect(middlewareService.executeChain).toHaveBeenCalledWith(
        [mw],
        ctx,
        {},
        expect.any(Function),
      );
    });
  });

  // --- global guards ---

  describe('applyGlobalGuards', () => {
    it('does nothing when no guards are configured', async () => {
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true });

      await pipeline.callTool('test', {}, ctx);

      expect(moduleRef.get).not.toHaveBeenCalled();
    });

    it('resolves guard from DI and calls canActivate', async () => {
      const mockGuard = { canActivate: vi.fn().mockResolvedValue(true) };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const GuardClass = class TestGuard {} as any;
      options.guards = [GuardClass];
      moduleRef.get.mockReturnValue(mockGuard);
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true });

      await pipeline.callTool('test', {}, ctx);

      expect(moduleRef.get).toHaveBeenCalledWith(GuardClass, { strict: false });
      expect(mockGuard.canActivate).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: ctx.sessionId, toolName: 'test' }),
      );
    });

    it('instantiates guard directly when not found in DI', async () => {
      const canActivate = vi.fn().mockResolvedValue(true);
      const GuardClass = class SimpleGuard {
        canActivate = canActivate;
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any;
      options.guards = [GuardClass];
      moduleRef.get.mockImplementation(() => {
        throw new Error('not found');
      });
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true });

      await pipeline.callTool('test', {}, ctx);

      expect(canActivate).toHaveBeenCalled();
    });

    it('syncs user back to context after guard populates it', async () => {
      const mockGuard = {
        canActivate: vi.fn().mockImplementation((guardCtx: { user?: unknown }) => {
          guardCtx.user = { id: 'authed-user', scopes: ['tools:read'] };
          return true;
        }),
      };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      options.guards = [class {} as any];
      moduleRef.get.mockReturnValue(mockGuard);
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true });

      expect(ctx.user).toBeUndefined();
      await pipeline.callTool('test', {}, ctx);

      expect(ctx.user).toEqual({ id: 'authed-user', scopes: ['tools:read'] });
    });

    it('runs global guards before tool-specific auth check', async () => {
      const callOrder: string[] = [];
      const mockGuard = {
        canActivate: vi.fn().mockImplementation((guardCtx: { user?: unknown }) => {
          callOrder.push('global-guard');
          guardCtx.user = { id: 'user1', scopes: ['tools:read'] };
          return true;
        }),
      };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      options.guards = [class {} as any];
      moduleRef.get.mockReturnValue(mockGuard);
      authGuard.checkAuthorization.mockImplementation(() => {
        callOrder.push('tool-auth');
        return Promise.resolve();
      });
      registry.getTool.mockReturnValue({ name: 'priv', isPublic: false });

      await pipeline.callTool('priv', {}, ctx);

      expect(callOrder).toEqual(['global-guard', 'tool-auth']);
    });

    it('runs global guards for readResource', async () => {
      const mockGuard = { canActivate: vi.fn().mockResolvedValue(true) };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      options.guards = [class {} as any];
      moduleRef.get.mockReturnValue(mockGuard);
      registry.getResource.mockReturnValue(undefined);

      await pipeline.readResource('file:///x', ctx);

      expect(mockGuard.canActivate).toHaveBeenCalledWith(
        expect.objectContaining({ resourceUri: 'file:///x' }),
      );
    });

    it('runs global guards for getPrompt', async () => {
      const mockGuard = { canActivate: vi.fn().mockResolvedValue(true) };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      options.guards = [class {} as any];
      moduleRef.get.mockReturnValue(mockGuard);
      registry.getPrompt.mockReturnValue(undefined);

      await pipeline.getPrompt('greet', {}, ctx);

      expect(mockGuard.canActivate).toHaveBeenCalledWith(
        expect.objectContaining({ promptName: 'greet' }),
      );
    });

    it('runs multiple guards in order', async () => {
      const order: number[] = [];
      const guard1 = {
        canActivate: vi.fn().mockImplementation(() => {
          order.push(1);
          return true;
        }),
      };
      const guard2 = {
        canActivate: vi.fn().mockImplementation(() => {
          order.push(2);
          return true;
        }),
      };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const G1 = class {} as any;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const G2 = class {} as any;
      options.guards = [G1, G2];
      moduleRef.get.mockImplementation((cls: unknown) => (cls === G1 ? guard1 : guard2));
      registry.getTool.mockReturnValue({ name: 'test', isPublic: true });

      await pipeline.callTool('test', {}, ctx);

      expect(order).toEqual([1, 2]);
    });
  });

  // --- timeouts ---

  describe('timeouts', () => {
    it('throws McpTimeoutError when tool execution exceeds timeout', async () => {
      options.resilience = { timeout: 10 };
      registry.getTool.mockReturnValue({ name: 'slow', isPublic: true });
      executor.callTool.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ content: [] }), 500)),
      );

      await expect(pipeline.callTool('slow', {}, ctx)).rejects.toThrow(McpTimeoutError);
    });

    it('uses per-tool timeout over global timeout', async () => {
      options.resilience = { timeout: 5000 };
      registry.getTool.mockReturnValue({ name: 'slow', isPublic: true, timeout: 10 });
      executor.callTool.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ content: [] }), 500)),
      );

      await expect(pipeline.callTool('slow', {}, ctx)).rejects.toThrow(McpTimeoutError);
    });

    it('does not timeout when execution is fast enough', async () => {
      options.resilience = { timeout: 5000 };
      registry.getTool.mockReturnValue({ name: 'fast', isPublic: true });

      const result = await pipeline.callTool('fast', {}, ctx);
      expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    });

    it('throws McpTimeoutError when readResource exceeds timeout', async () => {
      options.resilience = { timeout: 10 };
      registry.getResource.mockReturnValue(undefined);
      executor.readResource.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ contents: [] }), 500)),
      );

      await expect(pipeline.readResource('file:///slow', ctx)).rejects.toThrow(McpTimeoutError);
    });

    it('throws McpTimeoutError when getPrompt exceeds timeout', async () => {
      options.resilience = { timeout: 10 };
      registry.getPrompt.mockReturnValue(undefined);
      executor.getPrompt.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ messages: [] }), 500)),
      );

      await expect(pipeline.getPrompt('slow-prompt', {}, ctx)).rejects.toThrow(McpTimeoutError);
    });
  });

  // --- list methods ---

  describe('list methods', () => {
    it('listTools delegates to executor', async () => {
      const expected = [{ name: 'a' }];
      executor.listTools.mockResolvedValue(expected);

      const result = await pipeline.listTools();

      expect(result).toBe(expected);
      expect(executor.listTools).toHaveBeenCalled();
    });

    it('listResources delegates to executor', async () => {
      const expected = [{ uri: 'x' }];
      executor.listResources.mockResolvedValue(expected);

      const result = await pipeline.listResources();

      expect(result).toBe(expected);
    });

    it('listResourceTemplates delegates to executor', async () => {
      const expected = [{ uriTemplate: 'x' }];
      executor.listResourceTemplates.mockResolvedValue(expected);

      const result = await pipeline.listResourceTemplates();

      expect(result).toBe(expected);
    });

    it('listPrompts delegates to executor', async () => {
      const expected = [{ name: 'p' }];
      executor.listPrompts.mockResolvedValue(expected);

      const result = await pipeline.listPrompts();

      expect(result).toBe(expected);
    });
  });

  // --- complete ---

  describe('complete', () => {
    it('delegates to executor.complete', async () => {
      const expected = { values: ['a', 'b'] };
      executor.complete = vi.fn().mockResolvedValue(expected);

      const request = {
        ref: { type: 'ref/prompt' as const, name: 'test' },
        argument: { name: 'arg', value: 'a' },
      };

      const result = await pipeline.complete(request);

      expect(result).toBe(expected);
      expect(executor.complete).toHaveBeenCalledWith(request);
    });
  });
});
