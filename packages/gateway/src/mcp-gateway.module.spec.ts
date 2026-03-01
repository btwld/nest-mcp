import 'reflect-metadata';
import { MCP_GATEWAY_OPTIONS, McpTransportType } from '@nest-mcp/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistryService } from '../../server/src/discovery/registry.service';
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
