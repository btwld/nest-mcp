import 'reflect-metadata';
import { McpTransportType } from '@nest-mcp/common';
import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { z } from 'zod';
import { Completion, McpModule, Prompt, Tool } from '../../src';
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

/** Registered under a string token rather than the class itself. */
@Injectable()
class RegionTools {
  constructor(@Inject(REQUEST) private readonly request: McpRequestInfo) {}

  @Tool({ name: 'region', description: 'Echo the calling region', parameters: z.object({}) })
  region() {
    return `region:${String(this.request?.headers?.['x-region'] ?? 'unknown')}`;
  }
}

@Injectable({ scope: Scope.REQUEST })
class TenantPrompts {
  constructor(@Inject(REQUEST) private readonly request: McpRequestInfo) {}

  @Prompt({
    name: 'tenant-report',
    description: 'Report for a project of the calling tenant',
    parameters: z.object({ project: z.string() }),
  })
  report(args: { project: string }) {
    return {
      messages: [{ role: 'user', content: { type: 'text', text: `Report on ${args.project}` } }],
    };
  }

  @Completion({ refType: 'ref/prompt', refName: 'tenant-report' })
  completeProject() {
    const tenant = String(this.request?.headers?.['x-tenant'] ?? 'anonymous');
    return { values: [`${tenant}-alpha`, `${tenant}-beta`] };
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
      providers: [
        TenantTools,
        TenantPrompts,
        { provide: 'REGION_TOOLS', useClass: RegionTools, scope: Scope.REQUEST },
      ],
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

  it('resolves a scoped provider registered under a custom injection token', async () => {
    const client = await connectStreamable(server.baseUrl, { headers: { 'x-region': 'eu' } });
    try {
      const result = await client.callTool({ name: 'region', arguments: {} });
      expect(result.content).toEqual([{ type: 'text', text: 'region:eu' }]);
    } finally {
      await client.close();
    }
  });

  it('injects the caller request into scoped completion providers', async () => {
    const client = await connectStreamable(server.baseUrl, { headers: { 'x-tenant': 'acme' } });
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'tenant-report' },
        argument: { name: 'project', value: '' },
      });
      expect(result.completion.values).toEqual(['acme-alpha', 'acme-beta']);
    } finally {
      await client.close();
    }
  });
});
