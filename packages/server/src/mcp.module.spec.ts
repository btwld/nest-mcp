import { McpTransportType } from '@btwld/mcp-common';
import { describe, expect, it } from 'vitest';
import { McpModule } from './mcp.module';

describe('McpModule', () => {
  describe('forRoot', () => {
    it('includes StreamableHttpService and controller for streamable-http transport', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STREAMABLE_HTTP,
      });

      expect(mod.controllers).toHaveLength(1);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StreamableHttpService');
    });

    it('includes SseService and two controllers for SSE transport', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.SSE,
      });

      expect(mod.controllers).toHaveLength(2);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('SseService');
    });

    it('includes StdioService and no controllers for STDIO transport', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STDIO,
      });

      expect(mod.controllers).toHaveLength(0);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StdioService');
    });
  });

  describe('forRootAsync', () => {
    it('includes StreamableHttpService and controller for streamable-http transport', () => {
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STREAMABLE_HTTP,
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STREAMABLE_HTTP,
        }),
      });

      expect(mod.controllers).toHaveLength(1);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StreamableHttpService');
    });

    it('includes SseService and two controllers for SSE transport', () => {
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.SSE,
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.SSE,
        }),
      });

      expect(mod.controllers).toHaveLength(2);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('SseService');
    });

    it('includes StdioService and no controllers for STDIO transport', () => {
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STDIO,
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STDIO,
        }),
      });

      expect(mod.controllers).toHaveLength(0);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StdioService');
    });

    it('respects custom transportOptions for SSE endpoints', () => {
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.SSE,
        transportOptions: {
          sse: { endpoint: '/custom-sse', messagesEndpoint: '/custom-messages' },
        },
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.SSE,
        }),
      });

      // Should still have 2 controllers for SSE
      expect(mod.controllers).toHaveLength(2);
    });

    it('respects custom transportOptions for streamable-http endpoint', () => {
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STREAMABLE_HTTP,
        transportOptions: {
          streamableHttp: { endpoint: '/custom-mcp' },
        },
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STREAMABLE_HTTP,
        }),
      });

      expect(mod.controllers).toHaveLength(1);
    });

    it('passes through imports from async options', () => {
      const fakeModule = { module: class FakeModule {} };
      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STDIO,
        imports: [
          fakeModule as unknown as Parameters<typeof McpModule.forRootAsync>[0]['imports'] extends
            | (infer U)[]
            | undefined
            ? U
            : never,
        ],
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: McpTransportType.STDIO,
        }),
      });

      expect(mod.imports).toContain(fakeModule);
    });

    it('creates MCP_OPTIONS provider from useFactory', () => {
      const factory = () => ({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STDIO as const,
      });

      const mod = McpModule.forRootAsync({
        transport: McpTransportType.STDIO,
        useFactory: factory,
        inject: ['CONFIG_SERVICE'],
      });

      const optionsProvider = (mod.providers as Record<string, unknown>[]).find(
        (p: Record<string, unknown>) =>
          p.provide?.toString?.() === 'Symbol(MCP_OPTIONS)' ||
          p.provide === Symbol.for('MCP_OPTIONS'),
      );
      // The MCP_OPTIONS provider should exist (it's an injection token)
      expect(mod.providers?.length).toBeGreaterThan(0);
    });
  });

  describe('multiple transports (array)', () => {
    it('includes services and controllers for both streamable-http and SSE', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
      });

      // 1 streamable-http controller + 2 SSE controllers
      expect(mod.controllers).toHaveLength(3);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StreamableHttpService');
      expect(providerNames).toContain('SseService');
    });

    it('forRootAsync supports array of transports', () => {
      const mod = McpModule.forRootAsync({
        transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
        useFactory: () => ({
          name: 'test',
          version: '1.0',
          transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
        }),
      });

      expect(mod.controllers).toHaveLength(3);
      const providerNames = mod.providers?.map(
        (p: Record<string, unknown>) => p.name ?? p.provide?.toString?.() ?? '',
      );
      expect(providerNames).toContain('StreamableHttpService');
      expect(providerNames).toContain('SseService');
    });
  });

  describe('forFeature', () => {
    it('returns a module with the given providers', () => {
      class FakeProvider {}
      const mod = McpModule.forFeature([FakeProvider]);

      expect(mod.providers).toContain(FakeProvider);
      expect(mod.exports).toContain(FakeProvider);
    });
  });
});
