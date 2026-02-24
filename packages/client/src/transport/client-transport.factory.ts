import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClientConnection } from '../interfaces/client-options.interface';
import { createSseTransport } from './sse-client.transport';
import { createStdioTransport } from './stdio-client.transport';
import { createStreamableHttpTransport } from './streamable-client.transport';

export function createClientTransport(connection: McpClientConnection): Transport {
  switch (connection.transport) {
    case 'streamable-http':
      return createStreamableHttpTransport(connection);
    case 'sse':
      return createSseTransport(connection);
    case 'stdio':
      return createStdioTransport(connection);
    default:
      throw new Error(
        `Unsupported transport type: ${(connection as Record<string, unknown>).transport}`,
      );
  }
}
