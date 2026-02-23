import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClientSseConnection } from '../interfaces/client-options.interface';

export function createSseTransport(connection: McpClientSseConnection): Transport {
  const url = new URL(connection.url);

  const requestInit: RequestInit = { ...(connection.requestInit ?? {}) };
  if (connection.auth) {
    const headers = new Headers(requestInit.headers);
    headers.set('Authorization', `Bearer ${connection.auth.token}`);
    requestInit.headers = headers;
  }

  return new SSEClientTransport(url, { requestInit });
}
