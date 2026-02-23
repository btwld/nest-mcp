import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClientStreamableHttpConnection } from '../interfaces/client-options.interface';

export function createStreamableHttpTransport(
  connection: McpClientStreamableHttpConnection,
): Transport {
  const url = new URL(connection.url);

  const requestInit: RequestInit = { ...(connection.requestInit ?? {}) };
  if (connection.auth) {
    const headers = new Headers(requestInit.headers);
    headers.set('Authorization', `Bearer ${connection.auth.token}`);
    requestInit.headers = headers;
  }

  return new StreamableHTTPClientTransport(url, { requestInit });
}
