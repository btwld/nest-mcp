import 'reflect-metadata';
import { MCP_GATEWAY_OPTIONS, McpTransportType } from '@nest-mcp/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistryService } from '../../server/src/discovery/registry.service';
import { McpPromptBuilder } from '../../server/src/dynamic/prompt-builder.service';
import { McpResourceBuilder } from '../../server/src/dynamic/resource-builder.service';
import { McpToolBuilder } from '../../server/src/dynamic/tool-builder.service';
import { ResponseCacheService } from './cache/response-cache.service';
import { GatewayService } from './gateway.service';
import { McpGatewayModule } from './mcp-gateway.module';
import { PolicyEngineService } from './policies/policy-engine.service';
import { PromptAggregatorService } from './routing/prompt-aggregator.service';
import { ResourceAggregatorService } from './routing/resource-aggregator.service';
import { ResourceTemplateAggregatorService } from './routing/resource-template-aggregator.service';
import { RouterService } from './routing/router.service';
import { ToolAggregatorService } from './routing/tool-aggregator.service';
import { TaskAggregatorService } from './task/task-aggregator.service';
import { HealthCheckerService } from './upstream/health-checker.service';
import { UpstreamManagerService } from './upstream/upstream-manager.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const baseOptions = {
  server: {
    name: 'test-gateway',
    version: '1.0',
    transport: McpTransportType.STREAMABLE_HTTP,
  },
  upstreams: [],
} as const;

function providerNames(mod: ReturnType<typeof McpGatewayModule.forRoot>): (string | symbol)[] {
  return (mod.providers ?? []).map((p: Record<string, unknown>) => {
    if (typeof p === 'function') return (p as { name?: string }).name ?? '';
    return p.provide ?? p.name ?? '';
  });
}

function exportNames(mod: ReturnType<typeof McpGatewayModule.forRoot>): unknown[] {
  return (mod.exports ?? []).map((e: unknown) => {
    if (typeof e === 'function') return (e as { name?: string }).name;
    return e;
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('McpGatewayModule', () => {
  describe('forRoot', () => {
    it('returns McpGatewayModule as the module class', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      expect(mod.module).toBe(McpGatewayModule);
    });

    it('has imports defined (McpModule)', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      expect(mod.imports).toBeDefined();
      expect((mod.imports as unknown[]).length).toBeGreaterThan(0);
    });

    it('registers MCP_GATEWAY_OPTIONS provider with options value', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      const optionsProvider = (mod.providers as { provide: unknown; useValue: unknown }[]).find(
        (p) => p.provide === MCP_GATEWAY_OPTIONS,
      );
      expect(optionsProvider).toBeDefined();
      expect(optionsProvider?.useValue).toBe(baseOptions);
    });

    it('includes GatewayService in providers', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      const names = providerNames(mod);
      expect(names).toContain('GatewayService');
    });

    it('includes UpstreamManagerService in providers', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      const names = providerNames(mod);
      expect(names).toContain('UpstreamManagerService');
    });

    it('includes HealthCheckerService in providers', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      const names = providerNames(mod);
      expect(names).toContain('HealthCheckerService');
    });

    it('includes RouterService in providers', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      const names = providerNames(mod);
      expect(names).toContain('RouterService');
    });

    it('includes PolicyEngineService in providers', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      const names = providerNames(mod);
      expect(names).toContain('PolicyEngineService');
    });

    it('includes ResponseCacheService in providers', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      const names = providerNames(mod);
      expect(names).toContain('ResponseCacheService');
    });

    it('includes TaskAggregatorService in providers', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      const names = providerNames(mod);
      expect(names).toContain('TaskAggregatorService');
    });

    it('exports GatewayService', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      expect(mod.exports).toContain(GatewayService);
    });

    it('exports UpstreamManagerService', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      expect(mod.exports).toContain(UpstreamManagerService);
    });

    it('exports MCP_GATEWAY_OPTIONS', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      expect(mod.exports).toContain(MCP_GATEWAY_OPTIONS);
    });

    it('exports TaskAggregatorService', () => {
      const mod = McpGatewayModule.forRoot(baseOptions);
      expect(mod.exports).toContain(TaskAggregatorService);
    });

    it('defaults transport to STREAMABLE_HTTP when not specified', () => {
      const opts = { server: { name: 'gw', version: '1.0' }, upstreams: [] } as never;
      // Should not throw; default applies internally
      expect(() => McpGatewayModule.forRoot(opts)).not.toThrow();
    });

    it('works with SSE transport', () => {
      const mod = McpGatewayModule.forRoot({
        server: { name: 'gw', version: '1.0', transport: McpTransportType.SSE },
        upstreams: [],
      });
      expect(mod.module).toBe(McpGatewayModule);
    });

    it('works with STDIO transport', () => {
      const mod = McpGatewayModule.forRoot({
        server: { name: 'gw', version: '1.0', transport: McpTransportType.STDIO },
        upstreams: [],
      });
      expect(mod.module).toBe(McpGatewayModule);
    });

    it('works with array of transports', () => {
      const mod = McpGatewayModule.forRoot({
        server: {
          name: 'gw',
          version: '1.0',
          transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
        },
        upstreams: [],
      });
      expect(mod.module).toBe(McpGatewayModule);
    });
  });

  describe('forRootAsync', () => {
    it('returns McpGatewayModule as the module class', () => {
      const mod = McpGatewayModule.forRootAsync({
        server: { transport: McpTransportType.STREAMABLE_HTTP },
        useFactory: () => ({ ...baseOptions }),
      });
      expect(mod.module).toBe(McpGatewayModule);
    });

    it('has imports and providers defined', () => {
      const mod = McpGatewayModule.forRootAsync({
        server: { transport: McpTransportType.STREAMABLE_HTTP },
        useFactory: () => ({ ...baseOptions }),
      });
      expect(mod.imports).toBeDefined();
      expect(mod.providers).toBeDefined();
    });

    it('accepts an array of transports in server config', () => {
      const mod = McpGatewayModule.forRootAsync({
        server: {
          transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
        },
        useFactory: () => ({
          server: {
            name: 'test-gateway',
            version: '1.0',
            transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
          },
          upstreams: [],
        }),
      });

      expect(mod.imports).toBeDefined();
      expect(mod.providers).toBeDefined();
    });

    it('registers async MCP_GATEWAY_OPTIONS provider with useFactory', () => {
      const factory = () => ({ ...baseOptions });
      const mod = McpGatewayModule.forRootAsync({
        server: { transport: McpTransportType.STREAMABLE_HTTP },
        useFactory: factory,
      });
      const optionsProvider = (mod.providers as { provide: unknown; useFactory?: unknown }[]).find(
        (p) => p.provide === MCP_GATEWAY_OPTIONS,
      );
      expect(optionsProvider).toBeDefined();
      expect(optionsProvider?.useFactory).toBe(factory);
    });

    it('passes inject tokens to async options provider', () => {
      const mod = McpGatewayModule.forRootAsync({
        server: { transport: McpTransportType.STREAMABLE_HTTP },
        useFactory: () => ({ ...baseOptions }),
        inject: ['CONFIG_SERVICE'],
      });
      const optionsProvider = (mod.providers as { provide: unknown; inject?: unknown[] }[]).find(
        (p) => p.provide === MCP_GATEWAY_OPTIONS,
      );
      expect(optionsProvider?.inject).toEqual(['CONFIG_SERVICE']);
    });

    it('passes through extra imports', () => {
      const fakeModule = { module: class FakeModule {} };
      const mod = McpGatewayModule.forRootAsync({
        server: { transport: McpTransportType.STREAMABLE_HTTP },
        imports: [fakeModule as never],
        useFactory: () => ({ ...baseOptions }),
      });
      expect(mod.imports).toContain(fakeModule);
    });

    it('includes GatewayService in providers', () => {
      const mod = McpGatewayModule.forRootAsync({
        server: { transport: McpTransportType.STREAMABLE_HTTP },
        useFactory: () => ({ ...baseOptions }),
      });
      const names = providerNames(mod);
      expect(names).toContain('GatewayService');
    });

    it('includes TaskAggregatorService in providers', () => {
      const mod = McpGatewayModule.forRootAsync({
        server: { transport: McpTransportType.STREAMABLE_HTTP },
        useFactory: () => ({ ...baseOptions }),
      });
      const names = providerNames(mod);
      expect(names).toContain('TaskAggregatorService');
    });

    it('exports GatewayService', () => {
      const mod = McpGatewayModule.forRootAsync({
        server: { transport: McpTransportType.STREAMABLE_HTTP },
        useFactory: () => ({ ...baseOptions }),
      });
      expect(mod.exports).toContain(GatewayService);
    });

    it('exports MCP_GATEWAY_OPTIONS', () => {
      const mod = McpGatewayModule.forRootAsync({
        server: { transport: McpTransportType.STREAMABLE_HTTP },
        useFactory: () => ({ ...baseOptions }),
      });
      expect(mod.exports).toContain(MCP_GATEWAY_OPTIONS);
    });

    it('exports TaskAggregatorService', () => {
      const mod = McpGatewayModule.forRootAsync({
        server: { transport: McpTransportType.STREAMABLE_HTTP },
        useFactory: () => ({ ...baseOptions }),
      });
      expect(mod.exports).toContain(TaskAggregatorService);
    });

    it('defaults inject to empty array when not provided', () => {
      const mod = McpGatewayModule.forRootAsync({
        server: { transport: McpTransportType.STREAMABLE_HTTP },
        useFactory: () => ({ ...baseOptions }),
      });
      const optionsProvider = (mod.providers as { provide: unknown; inject?: unknown[] }[]).find(
        (p) => p.provide === MCP_GATEWAY_OPTIONS,
      );
      expect(optionsProvider?.inject).toEqual([]);
    });
  });
});

describe('Gateway tool registration with inputSchema', () => {
  let registry: McpRegistryService;
  let toolBuilder: McpToolBuilder;

  beforeEach(() => {
    registry = new McpRegistryService();
    toolBuilder = new McpToolBuilder(registry);
  });

  it('registers tool with pre-converted inputSchema from upstream', () => {
    const inputSchema = {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
      },
      required: ['city'],
    };

    // Simulates what the gateway does: register with inputSchema, no Zod parameters
    toolBuilder.register({
      name: 'upstream-weather',
      description: 'Get weather from upstream',
      inputSchema,
      handler: async () => 'sunny',
    });

    const tool = registry.getTool('upstream-weather');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toEqual(inputSchema);
    expect(tool?.parameters).toBeUndefined();
  });

  it('stores inputSchema on the registered tool in the registry', () => {
    const inputSchema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    };

    toolBuilder.register({
      name: 'search',
      description: 'Search upstream',
      inputSchema,
      handler: async () => ({ content: [] }),
    });

    const allTools = registry.getAllTools();
    expect(allTools).toHaveLength(1);
    expect(allTools[0].inputSchema).toEqual(inputSchema);
    expect(allTools[0].name).toBe('search');
  });

  it('handler still works correctly with inputSchema tools', async () => {
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    toolBuilder.register({
      name: 'proxy-tool',
      description: 'Proxied tool',
      inputSchema: { type: 'object', properties: {} },
      handler,
    });

    const tool = registry.getTool('proxy-tool');
    if (!tool) throw new Error('Tool not found');
    const result = await tool.instance[tool.methodName]({ key: 'val' });
    expect(handler).toHaveBeenCalledWith({ key: 'val' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });
});

// ─── Bootstrap registration and upstream sync ───────────────────────────────

describe('McpGatewayModule bootstrap and upstream sync', () => {
  type Fn = ReturnType<typeof vi.fn>;
  let registry: McpRegistryService;
  let gatewayService: Record<string, Fn>;
  let upstreamManager: Record<string, Fn>;
  let toolAggregator: Record<string, Fn>;
  let resourceAggregator: Record<string, Fn>;
  let promptAggregator: Record<string, Fn>;
  let templateAggregator: Record<string, Fn>;
  let changeListener: ((event: unknown) => void) | undefined;
  let unsubscribe: Fn;
  let mod: McpGatewayModule;

  const ctx = (overrides: Record<string, unknown> = {}) =>
    ({
      sessionId: 's',
      reportProgress: vi.fn(),
      signal: new AbortController().signal,
      ...overrides,
    }) as never;

  const tool = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object' },
    upstreamName: 'up',
    originalName: name.replace(/^up_/, ''),
    ...extra,
  });

  beforeEach(() => {
    registry = new McpRegistryService();
    unsubscribe = vi.fn();
    changeListener = undefined;
    gatewayService = {
      listTools: vi.fn().mockResolvedValue([]),
      listResources: vi.fn().mockResolvedValue([]),
      listPrompts: vi.fn().mockResolvedValue([]),
      listResourceTemplates: vi.fn().mockResolvedValue([]),
      getCachedPrompts: vi.fn().mockReturnValue([]),
      getCachedResourceTemplates: vi.fn().mockReturnValue([]),
      callTool: vi.fn(),
      getPrompt: vi.fn(),
      readResource: vi.fn(),
      readResourceTemplate: vi.fn(),
      complete: vi.fn().mockResolvedValue({ values: [] }),
    };
    upstreamManager = {
      connectAll: vi.fn().mockResolvedValue(undefined),
      onUpstreamChange: vi.fn((listener: (event: unknown) => void) => {
        changeListener = listener;
        return unsubscribe;
      }),
    };
    toolAggregator = { getCachedTools: vi.fn().mockReturnValue([]), refreshUpstream: vi.fn() };
    resourceAggregator = {
      getCachedResources: vi.fn().mockReturnValue([]),
      refreshUpstream: vi.fn(),
    };
    promptAggregator = { getCachedPrompts: vi.fn().mockReturnValue([]), refreshUpstream: vi.fn() };
    templateAggregator = {
      getCachedTemplates: vi.fn().mockReturnValue([]),
      refreshUpstream: vi.fn(),
    };

    mod = new McpGatewayModule(
      { server: { name: 'gw', version: '1' }, upstreams: [] } as never,
      gatewayService as never,
      upstreamManager as never,
      { startAll: vi.fn() } as never,
      { configure: vi.fn() } as never,
      { configure: vi.fn() } as never,
      { configure: vi.fn() } as never,
      new McpToolBuilder(registry),
      new McpResourceBuilder(registry),
      new McpPromptBuilder(registry),
      resourceAggregator as never,
      promptAggregator as never,
      templateAggregator as never,
      registry,
      {} as never,
      toolAggregator as never,
    );
  });

  describe('tools', () => {
    it('registers display metadata and the output schema', async () => {
      gatewayService.listTools.mockResolvedValue([
        tool('up_a', {
          title: 'A',
          outputSchema: { type: 'object' },
          icons: [{ src: 'https://example.com/a.png' }],
          execution: { taskSupport: 'forbidden' },
          _meta: { k: 1 },
        }),
      ]);

      await mod.onApplicationBootstrap();

      expect(registry.getTool('up_a')).toMatchObject({
        title: 'A',
        rawOutputSchema: { type: 'object' },
        icons: [{ src: 'https://example.com/a.png' }],
        execution: { taskSupport: 'forbidden' },
        _meta: { k: 1 },
      });
    });

    it('returns structuredContent and _meta from the proxied call and forwards progress', async () => {
      gatewayService.listTools.mockResolvedValue([tool('up_a')]);
      gatewayService.callTool.mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
        structuredContent: { ok: true },
        _meta: { m: 1 },
      });
      await mod.onApplicationBootstrap();

      const registered = registry.getTool('up_a');
      const context = ctx();
      const result = await registered?.instance?.[registered.methodName]({ x: 1 }, context);

      expect(result).toEqual({
        content: [{ type: 'text', text: '{}' }],
        isError: undefined,
        structuredContent: { ok: true },
        _meta: { m: 1 },
      });
      expect(gatewayService.callTool).toHaveBeenCalledWith(
        'up_a',
        { x: 1 },
        undefined,
        (context as { signal: AbortSignal }).signal,
        undefined,
        undefined,
        { onProgress: (context as { reportProgress: unknown }).reportProgress },
      );
    });
  });

  describe('prompts', () => {
    it('registers upstream arguments and forwards the caller arguments unchanged', async () => {
      const prompt = {
        name: 'up_p',
        title: 'P',
        description: 'Prompt',
        upstreamName: 'up',
        originalName: 'p',
        arguments: [
          { name: 'text', description: 'Text', required: true },
          { name: 'lang', required: false },
        ],
      };
      gatewayService.listPrompts.mockResolvedValue([prompt]);
      gatewayService.getPrompt.mockResolvedValue({ messages: [] });
      await mod.onApplicationBootstrap();

      const registered = registry.getPrompt('up_p');
      expect(registered?.title).toBe('P');
      expect(Object.keys(registered?.parameters?.shape ?? {})).toEqual(['text', 'lang']);
      expect(registered?.parameters?.safeParse({}).success).toBe(false);

      const context = ctx();
      await registered?.instance?.[registered.methodName]({ text: 'hi', lang: undefined }, context);
      expect(gatewayService.getPrompt).toHaveBeenCalledWith(
        'up_p',
        { text: 'hi' },
        (context as { signal: AbortSignal }).signal,
      );
    });

    it('gives argument-less prompts an empty argument schema', async () => {
      gatewayService.listPrompts.mockResolvedValue([
        { name: 'up_p', upstreamName: 'up', originalName: 'p' },
      ]);

      await mod.onApplicationBootstrap();

      expect(registry.getPrompt('up_p')?.parameters).toBeDefined();
    });
  });

  describe('resources and templates', () => {
    it('registers resource and template display metadata', async () => {
      gatewayService.listResources.mockResolvedValue([
        {
          uri: 'up://file:///a',
          name: 'a',
          title: 'A',
          icons: [{ src: 'https://example.com/a.png' }],
          _meta: { k: 1 },
          upstreamName: 'up',
          originalUri: 'file:///a',
        },
      ]);
      gatewayService.listResourceTemplates.mockResolvedValue([
        {
          uriTemplate: 'up://file:///{p}',
          name: 'file',
          title: 'File',
          _meta: { t: 1 },
          upstreamName: 'up',
          originalUriTemplate: 'file:///{p}',
        },
      ]);

      await mod.onApplicationBootstrap();

      expect(registry.getResource('up://file:///a')).toMatchObject({
        title: 'A',
        icons: [{ src: 'https://example.com/a.png' }],
        _meta: { k: 1 },
      });
      expect(registry.getResourceTemplate('up://file:///{p}')).toMatchObject({
        title: 'File',
        _meta: { t: 1 },
      });
    });
  });

  describe('completions', () => {
    it('forwards the completion context to the gateway service', async () => {
      const prompt = { name: 'up_p', upstreamName: 'up', originalName: 'p' };
      gatewayService.getCachedPrompts.mockReturnValue([prompt]);
      await mod.onApplicationBootstrap();

      const handler = registry.getCompletionHandler('ref/prompt', 'up_p');
      await handler?.instance?.complete('lang', 'e', { arguments: { text: 'hi' } });

      expect(gatewayService.complete).toHaveBeenCalledWith(
        { type: 'ref/prompt', name: 'up_p' },
        { name: 'lang', value: 'e' },
        { arguments: { text: 'hi' } },
      );
    });
  });

  describe('upstream sync', () => {
    beforeEach(async () => {
      await mod.onApplicationBootstrap();
    });

    it('subscribes to upstream changes and unsubscribes on destroy', () => {
      expect(upstreamManager.onUpstreamChange).toHaveBeenCalled();
      mod.onModuleDestroy();
      expect(unsubscribe).toHaveBeenCalled();
    });

    it('unregisters removed tools, registers new and changed ones, and broadcasts list_changed', async () => {
      const keep = tool('up_keep');
      const gone = tool('up_gone');
      const changedBefore = tool('up_changed', { description: 'old' });
      const changedAfter = tool('up_changed', { description: 'new' });
      const added = tool('up_added');
      for (const t of [keep, gone, changedBefore]) {
        new McpToolBuilder(registry).register({ ...t, handler: async () => 'x' });
      }
      toolAggregator.getCachedTools.mockReturnValue([keep, gone, changedBefore]);
      toolAggregator.refreshUpstream.mockResolvedValue([keep, changedAfter, added]);
      const broadcast = vi.spyOn(registry, 'broadcastNotification');
      const registered = vi.fn();
      registry.events.on('tool.registered', registered);

      await mod.syncUpstream('up', ['tools']);

      expect(registry.getTool('up_gone')).toBeUndefined();
      expect(registry.getTool('up_added')).toBeDefined();
      expect(registry.getTool('up_changed')?.description).toBe('new');
      expect(registered.mock.calls.map(([t]) => (t as { name: string }).name).sort()).toEqual([
        'up_added',
        'up_changed',
      ]);
      expect(broadcast).toHaveBeenCalledWith('notifications/tools/list_changed', {});
    });

    it('does nothing when the refreshed list is unchanged', async () => {
      const same = tool('up_same');
      toolAggregator.getCachedTools.mockReturnValue([same]);
      toolAggregator.refreshUpstream.mockResolvedValue([{ ...same }]);
      const broadcast = vi.spyOn(registry, 'broadcastNotification');

      await mod.syncUpstream('up', ['tools']);

      expect(broadcast).not.toHaveBeenCalled();
    });

    it('leaves the registry alone when the refresh fails', async () => {
      new McpToolBuilder(registry).register({ ...tool('up_a'), handler: async () => 'x' });
      toolAggregator.getCachedTools.mockReturnValue([tool('up_a')]);
      toolAggregator.refreshUpstream.mockResolvedValue(undefined);

      await mod.syncUpstream('up', ['tools']);

      expect(registry.getTool('up_a')).toBeDefined();
    });

    it('keeps going when a transport refuses to re-add a name', async () => {
      toolAggregator.getCachedTools.mockReturnValue([tool('up_a', { description: 'old' })]);
      toolAggregator.refreshUpstream.mockResolvedValue([
        tool('up_a', { description: 'new' }),
        tool('up_b'),
      ]);
      registry.events.on('tool.registered', (t: { name: string }) => {
        if (t.name === 'up_a') throw new Error('Tool up_a is already registered');
      });
      const broadcast = vi.spyOn(registry, 'broadcastNotification');

      await mod.syncUpstream('up', ['tools']);

      expect(registry.getTool('up_a')?.description).toBe('new');
      expect(registry.getTool('up_b')).toBeDefined();
      expect(broadcast).toHaveBeenCalledWith('notifications/tools/list_changed', {});
    });

    it('syncs resources and templates under the resources list', async () => {
      resourceAggregator.refreshUpstream.mockResolvedValue([
        { uri: 'up://r', name: 'r', upstreamName: 'up', originalUri: 'r' },
      ]);
      templateAggregator.getCachedTemplates.mockReturnValue([
        {
          uriTemplate: 'up://{old}',
          name: 'old',
          upstreamName: 'up',
          originalUriTemplate: '{old}',
        },
      ]);
      templateAggregator.refreshUpstream.mockResolvedValue([
        {
          uriTemplate: 'up://{new}',
          name: 'new',
          upstreamName: 'up',
          originalUriTemplate: '{new}',
        },
      ]);
      const broadcast = vi.spyOn(registry, 'broadcastNotification');

      await mod.syncUpstream('up', ['resources']);

      expect(registry.getResource('up://r')).toBeDefined();
      expect(registry.getResourceTemplate('up://{new}')).toBeDefined();
      expect(registry.getCompletionHandler('ref/resource', 'up://{new}')).toBeDefined();
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith('notifications/resources/list_changed', {});
    });

    it('syncs prompts and their completion handlers', async () => {
      promptAggregator.refreshUpstream.mockResolvedValue([
        { name: 'up_p', upstreamName: 'up', originalName: 'p', arguments: [{ name: 'a' }] },
      ]);
      const broadcast = vi.spyOn(registry, 'broadcastNotification');

      await mod.syncUpstream('up', ['prompts']);

      expect(registry.getPrompt('up_p')).toBeDefined();
      expect(registry.getCompletionHandler('ref/prompt', 'up_p')).toBeDefined();
      expect(broadcast).toHaveBeenCalledWith('notifications/prompts/list_changed', {});
    });

    it('re-syncs every list after a reconnect event', async () => {
      toolAggregator.refreshUpstream.mockResolvedValue([tool('up_new')]);
      resourceAggregator.refreshUpstream.mockResolvedValue([]);
      templateAggregator.refreshUpstream.mockResolvedValue([]);
      promptAggregator.refreshUpstream.mockResolvedValue([]);

      changeListener?.({
        upstreamName: 'up',
        kinds: ['tools', 'resources', 'prompts'],
        reason: 'reconnected',
      });
      await vi.waitFor(() => expect(registry.getTool('up_new')).toBeDefined());

      expect(resourceAggregator.refreshUpstream).toHaveBeenCalledWith('up');
      expect(templateAggregator.refreshUpstream).toHaveBeenCalledWith('up');
      expect(promptAggregator.refreshUpstream).toHaveBeenCalledWith('up');
    });

    it('runs syncs for the same upstream one after another', async () => {
      const order: string[] = [];
      let release: () => void = () => {};
      toolAggregator.refreshUpstream
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => {
                order.push('first');
                resolve([]);
              };
            }),
        )
        .mockImplementationOnce(async () => {
          order.push('second');
          return [];
        });

      changeListener?.({ upstreamName: 'up', kinds: ['tools'], reason: 'list_changed' });
      changeListener?.({ upstreamName: 'up', kinds: ['tools'], reason: 'list_changed' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual([]);

      release();
      await vi.waitFor(() => expect(order).toEqual(['first', 'second']));
    });
  });
});
