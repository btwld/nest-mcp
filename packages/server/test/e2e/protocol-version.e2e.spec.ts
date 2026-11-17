import 'reflect-metadata';
import { McpTransportType } from '@nest-mcp/common';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { McpModule, Tool } from '../../src';
import { createMcpApp } from './helpers';
import type { E2eApp } from './helpers';

@Injectable()
class VersionedTools {
  @Tool({ name: 'noop', description: 'No-op', parameters: z.object({}) })
  noop() {
    return 'ok';
  }
}

/**
 * Pins the SDK transport's MCP-Protocol-Version header enforcement
 * (spec 2025-06-18) as it behaves through our stack: requests after
 * initialize carrying an unsupported version header must be rejected.
 */
describe('MCP-Protocol-Version header e2e', () => {
  let server: E2eApp;

  beforeAll(async () => {
    server = await createMcpApp({
      imports: [
        McpModule.forRoot({
          name: 'version-server',
          version: '1.0.0',
          transport: McpTransportType.STREAMABLE_HTTP,
        }),
      ],
      providers: [VersionedTools],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  async function initializeSession(): Promise<string> {
    const res = await fetch(`${server.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw-e2e', version: '1.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await res.body?.cancel();
    return sessionId as string;
  }

  function postToolsList(sessionId: string, protocolVersion?: string): Promise<Response> {
    return fetch(`${server.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
  }

  it('accepts requests carrying a supported protocol version header', async () => {
    const sessionId = await initializeSession();
    const res = await postToolsList(sessionId, '2025-06-18');
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it('rejects requests carrying an unsupported protocol version header with 400', async () => {
    const sessionId = await initializeSession();
    const res = await postToolsList(sessionId, '1999-01-01');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('protocol version');
  });
});
