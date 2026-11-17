import 'reflect-metadata';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpTransportType } from '@nest-mcp/common';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { McpModule, McpToolBuilder, Tool } from '../../src';
import { connectStreamable, createMcpApp, waitFor } from './helpers';
import type { E2eApp } from './helpers';

@Injectable()
class StaticTools {
  @Tool({ name: 'static-tool', description: 'Always there', parameters: z.object({}) })
  staticTool() {
    return 'static';
  }
}

describe('dynamic capabilities e2e', () => {
  let server: E2eApp;
  let client: Client;

  beforeAll(async () => {
    server = await createMcpApp({
      imports: [
        McpModule.forRoot({
          name: 'dynamic-server',
          version: '1.0.0',
          transport: McpTransportType.STREAMABLE_HTTP,
        }),
      ],
      providers: [StaticTools],
    });
    client = await connectStreamable(server.baseUrl);
    // The client opens its standalone GET notification stream asynchronously
    // after initialize; notifications sent before it connects are dropped
    // (no event store configured). Give it a moment to attach.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('registers a tool at runtime, notifies clients, and serves calls to it', async () => {
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanged++;
    });

    const builder = server.app.get(McpToolBuilder);
    builder.register({
      name: 'runtime-tool',
      description: 'Registered after boot',
      parameters: z.object({ value: z.string() }),
      handler: async (args) => `runtime:${String(args.value)}`,
    });

    await waitFor(() => listChanged >= 1);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['static-tool', 'runtime-tool']),
    );

    const result = await client.callTool({ name: 'runtime-tool', arguments: { value: 'x' } });
    expect(result.content).toEqual([{ type: 'text', text: 'runtime:x' }]);
  });

  it('unregisters a tool at runtime and notifies clients again', async () => {
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanged++;
    });

    const builder = server.app.get(McpToolBuilder);
    builder.unregister('runtime-tool');

    await waitFor(() => listChanged >= 1);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('runtime-tool');
  });
});
