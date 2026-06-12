import 'reflect-metadata';
import { McpTransportType } from '@nest-mcp/common';
import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { z } from 'zod';
import { McpModule, Tool } from '../../src';
import { connectStreamable, createMcpApp } from './helpers';
import type { E2eApp } from './helpers';

/**
 * The MCP request context registered for scoped providers is the transport's
 * request info (`{ headers }`), not a full Express request.
 */
interface McpRequestInfo {
  headers?: Record<string, string | string[] | undefined>;
}

@Injectable({ scope: Scope.REQUEST })
class TenantTools {
  constructor(@Inject(REQUEST) private readonly request: McpRequestInfo) {}

  @Tool({ name: 'whoami', description: 'Echo the calling tenant', parameters: z.object({}) })
  whoami() {
    const tenant = this.request?.headers?.['x-tenant'] ?? 'anonymous';
    return `tenant:${String(tenant)}`;
  }
}

describe('request-scoped provider e2e', () => {
  let server: E2eApp;

  beforeAll(async () => {
    server = await createMcpApp({
      imports: [
        McpModule.forRoot({
          name: 'scoped-server',
          version: '1.0.0',
          transport: McpTransportType.STREAMABLE_HTTP,
        }),
      ],
      providers: [TenantTools],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('discovers tools on request-scoped providers', async () => {
    const client = await connectStreamable(server.baseUrl);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('whoami');
    } finally {
      await client.close();
    }
  });

  it('resolves a fresh provider per call with the caller request injected', async () => {
    const acme = await connectStreamable(server.baseUrl, { headers: { 'x-tenant': 'acme' } });
    const globex = await connectStreamable(server.baseUrl, { headers: { 'x-tenant': 'globex' } });
    try {
      const acmeResult = await acme.callTool({ name: 'whoami', arguments: {} });
      const globexResult = await globex.callTool({ name: 'whoami', arguments: {} });

      expect(acmeResult.content).toEqual([{ type: 'text', text: 'tenant:acme' }]);
      expect(globexResult.content).toEqual([{ type: 'text', text: 'tenant:globex' }]);
    } finally {
      await acme.close();
      await globex.close();
    }
  });
});
