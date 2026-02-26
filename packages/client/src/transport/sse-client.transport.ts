import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClientSseConnection } from '../interfaces/client-options.interface';
import { applyAuthHeaders } from './apply-auth-headers';

export function createSseTransport(connection: McpClientSseConnection): Transport {
  const url = new URL(connection.url);
  const requestInit = applyAuthHeaders(connection.requestInit, connection.auth);
  return new SSEClientTransport(url, { requestInit });
}
