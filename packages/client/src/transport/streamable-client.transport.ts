import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClientStreamableHttpConnection } from '../interfaces/client-options.interface';
import { applyAuthHeaders } from './apply-auth-headers';

export function createStreamableHttpTransport(
  connection: McpClientStreamableHttpConnection,
): Transport {
  const url = new URL(connection.url);
  const requestInit = applyAuthHeaders(connection.requestInit, connection.auth);
  return new StreamableHTTPClientTransport(url, {
    requestInit,
    authProvider: connection.authProvider,
  });
}
