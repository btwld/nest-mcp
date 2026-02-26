import type { McpClient } from '../mcp-client.service';
import { formatErrorMessage } from '../utils/format-error-message';

export interface McpClientHealthStatus {
  name: string;
  connected: boolean;
  serverVersion?: { name: string; version: string };
  error?: string;
}

export interface McpClientHealthResult {
  status: 'up' | 'down';
  connections: McpClientHealthStatus[];
}

export class McpClientHealthIndicator {
  constructor(private readonly clients: McpClient[]) {}

  async check(): Promise<McpClientHealthResult> {
    const connections: McpClientHealthStatus[] = [];

    for (const client of this.clients) {
      if (!client.isConnected()) {
        connections.push({ name: client.name, connected: false });
        continue;
      }

      try {
        await client.ping();
        const version = client.getServerVersion();
        connections.push({
          name: client.name,
          connected: true,
          ...(version && { serverVersion: { name: version.name, version: version.version } }),
        });
      } catch (err: unknown) {
        connections.push({
          name: client.name,
          connected: false,
          error: formatErrorMessage(err),
        });
      }
    }

    const allUp = connections.length > 0 && connections.every((c) => c.connected);

    return {
      status: allUp ? 'up' : 'down',
      connections,
    };
  }
}
