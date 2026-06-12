import 'reflect-metadata';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpTransportType } from '@nest-mcp/common';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { McpModule, Tool } from '../../src';
import { connectSse, createMcpApp } from './helpers';
import type { E2eApp } from './helpers';

@Injectable()
class SseTools {
  @Tool({ name: 'echo', description: 'Echo input', parameters: z.object({ text: z.string() }) })
  echo({ text }: { text: string }) {
    return text;
  }
}

describe('legacy HTTP+SSE e2e', () => {
  let server: E2eApp;
  let client: Client;

  beforeAll(async () => {
    server = await createMcpApp({
      imports: [
        McpModule.forRoot({
          name: 'sse-server',
          version: '1.0.0',
          transport: McpTransportType.SSE,
        }),
      ],
      providers: [SseTools],
    });
    client = await connectSse(server.baseUrl);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('lists tools over SSE', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('echo');
  });

  it('calls tools over SSE', async () => {
    const result = await client.callTool({ name: 'echo', arguments: { text: 'ping' } });
    expect(result.content).toEqual([{ type: 'text', text: 'ping' }]);
  });
});
