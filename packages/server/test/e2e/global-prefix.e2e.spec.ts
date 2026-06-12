import 'reflect-metadata';
import { McpTransportType } from '@nest-mcp/common';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { McpModule, Tool } from '../../src';
import { connectSse, connectStreamable, createMcpApp } from './helpers';
import type { E2eApp } from './helpers';

@Injectable()
class PrefixedTools {
  @Tool({ name: 'echo', description: 'Echo input', parameters: z.object({ text: z.string() }) })
  echo({ text }: { text: string }) {
    return text;
  }
}

/** Both HTTP transports must work behind `app.setGlobalPrefix()`. */
describe('global prefix e2e', () => {
  let server: E2eApp;

  beforeAll(async () => {
    server = await createMcpApp(
      {
        imports: [
          McpModule.forRoot({
            name: 'prefixed-server',
            version: '1.0.0',
            transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
          }),
        ],
        providers: [PrefixedTools],
      },
      (app) => app.setGlobalPrefix('api'),
    );
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves streamable HTTP under the prefix', async () => {
    const client = await connectStreamable(server.baseUrl, { endpoint: '/api/mcp' });
    try {
      const result = await client.callTool({ name: 'echo', arguments: { text: 'prefixed' } });
      expect(result.content).toEqual([{ type: 'text', text: 'prefixed' }]);
    } finally {
      await client.close();
    }
  });

  it('serves SSE under the prefix and advertises a prefixed messages endpoint', async () => {
    // callTool only works if the SSE `endpoint` event pointed the client at
    // /api/messages (a bare /messages would 404).
    const client = await connectSse(server.baseUrl, '/api/sse');
    try {
      const result = await client.callTool({ name: 'echo', arguments: { text: 'sse-prefixed' } });
      expect(result.content).toEqual([{ type: 'text', text: 'sse-prefixed' }]);
    } finally {
      await client.close();
    }
  });
});
