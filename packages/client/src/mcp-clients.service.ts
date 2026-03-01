import { Inject, Injectable } from '@nestjs/common';
import { McpClient } from './mcp-client.service';

@Injectable()
export class McpClientsService {
  constructor(@Inject('MCP_CLIENT_CONNECTIONS') private readonly clients: McpClient[]) {}

  getClient(name: string): McpClient {
    const client = this.clients.find((c) => c.name === name);
    if (!client) {
      throw new Error(`McpClientsService: No client named "${name}" found.`);
    }
    return client;
  }

  getClients(): McpClient[] {
    return this.clients;
  }
}
