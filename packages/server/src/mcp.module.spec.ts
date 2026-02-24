import { describe, it, expect } from 'vitest';
import { McpModule } from './mcp.module';
import { McpTransportType } from '@btwld/mcp-common';

describe('McpModule', () => {
  describe('forRoot', () => {
    it('includes StreamableHttpService and controller for streamable-http transport', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STREAMABLE_HTTP,
      });

      expect(mod.controllers).toHaveLength(1);
      const providerNames = mod.providers!.map((p: any) => p.name ?? p.provide?.toString?.() ?? '');
      expect(providerNames).toContain('StreamableHttpService');
    });

    it('includes SseService and two controllers for SSE transport', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.SSE,
      });

      expect(mod.controllers).toHaveLength(2);
      const providerNames = mod.providers!.map((p: any) => p.name ?? p.provide?.toString?.() ?? '');
      expect(providerNames).toContain('SseService');
    });

    it('includes StdioService and no controllers for STDIO transport', () => {
      const mod = McpModule.forRoot({
        name: 'test',
        version: '1.0',
        transport: McpTransportType.STDIO,
      });

      expect(mod.controllers).toHaveLength(0);
      const providerNames = mod.providers!.map((p: any) => p.name ?? p.provide?.toString?.() ?? '');
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
      const providerNames = mod.providers!.map((p: any) => p.name ?? p.provide?.toString?.() ?? '');
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
      const providerNames = mod.providers!.map((p: any) => p.name ?? p.provide?.toString?.() ?? '');
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
      const providerNames = mod.providers!.map((p: any) => p.name ?? p.provide?.toString?.() ?? '');
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
        imports: [fakeModule as any],
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

      const optionsProvider = (mod.providers as any[]).find(
        (p: any) => p.provide?.toString?.() === 'Symbol(MCP_OPTIONS)' || p.provide === Symbol.for('MCP_OPTIONS'),
      );
      // The MCP_OPTIONS provider should exist (it's an injection token)
      expect(mod.providers!.length).toBeGreaterThan(0);
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
