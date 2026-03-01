import 'reflect-metadata';
import { McpTransportType } from '@btwld/mcp-common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistryService } from '../../server/src/discovery/registry.service';
import { McpToolBuilder } from '../../server/src/dynamic/tool-builder.service';
import { McpGatewayModule } from './mcp-gateway.module';

describe('McpGatewayModule', () => {
  describe('forRootAsync with multiple transports', () => {
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
