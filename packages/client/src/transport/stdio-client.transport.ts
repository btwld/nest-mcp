import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClientStdioConnection } from '../interfaces/client-options.interface';

export function createStdioTransport(connection: McpClientStdioConnection): Transport {
  return new StdioClientTransport({
    command: connection.command,
    args: connection.args,
    env: connection.env,
    cwd: connection.cwd,
  });
}
