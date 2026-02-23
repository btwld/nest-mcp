import { Logger } from '@nestjs/common';
import type { McpClient } from '../mcp-client.service';

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
  private readonly logger = new Logger('McpClientHealthIndicator');
  private readonly clients: McpClient[];

  constructor(clients: McpClient[]) {
    this.clients = clients;
  }

  async check(): Promise<McpClientHealthResult> {
    const connections: McpClientHealthStatus[] = [];

    for (const client of this.clients) {
      const status: McpClientHealthStatus = {
        name: client.name,
        connected: client.isConnected(),
      };

      if (client.isConnected()) {
        try {
          await client.ping();
          const version = client.getServerVersion();
          if (version) {
            status.serverVersion = {
              name: version.name,
              version: version.version,
            };
          }
        } catch (err: any) {
          status.connected = false;
          status.error = err.message;
        }
      }

      connections.push(status);
    }

    const allUp = connections.length > 0 && connections.every((c) => c.connected);

    return {
      status: allUp ? 'up' : 'down',
      connections,
    };
  }
}
