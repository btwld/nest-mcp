import { McpClientsService } from '@nest-mcp/client';
import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  constructor(private readonly mcpClients: McpClientsService) {}

  private get playground() {
    return this.mcpClients.getClient('playground');
  }

  private get sseServer() {
    return this.mcpClients.getClient('sse-server');
  }

  private get stdioServer() {
    return this.mcpClients.getClient('stdio-server');
  }

  // --- Playground operations ---

  async listTools() {
    return this.playground.listTools();
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    return this.playground.callTool({ name, arguments: args });
  }

  async listResources() {
    return this.playground.listResources();
  }

  async readResource(uri: string) {
    return this.playground.readResource({ uri });
  }

  async listPrompts() {
    return this.playground.listPrompts();
  }

  async getPrompt(name: string, args: Record<string, string> = {}) {
    return this.playground.getPrompt({ name, arguments: args });
  }

  async ping() {
    return this.playground.ping();
  }

  getStatus() {
    return {
      connected: this.playground.isConnected(),
      serverCapabilities: this.playground.getServerCapabilities(),
      serverVersion: this.playground.getServerVersion(),
    };
  }

  // --- SSE Server operations ---

  async listSseTools() {
    return this.sseServer.listTools();
  }

  async callSseTool(name: string, args: Record<string, unknown> = {}) {
    return this.sseServer.callTool({ name, arguments: args });
  }

  async listSseResources() {
    return this.sseServer.listResources();
  }

  // --- Stdio Server operations ---

  async listStdioTools() {
    return this.stdioServer.listTools();
  }

  async callStdioTool(name: string, args: Record<string, unknown> = {}) {
    return this.stdioServer.callTool({ name, arguments: args });
  }

  async listStdioResources() {
    return this.stdioServer.listResources();
  }

  async listStdioPrompts() {
    return this.stdioServer.listPrompts();
  }

  // --- Multi-client operations ---

  async listAllTools() {
    const allClients = this.mcpClients.getClients();
    const results = await Promise.allSettled(
      allClients.map(async (client) => {
        const tools = await client.listTools();
        return {
          connection: client.name,
          tools: tools.tools ?? [],
        };
      }),
    );

    return results.map((result, i) =>
      result.status === 'fulfilled'
        ? result.value
        : {
            connection: allClients[i]?.name,
            error: (result.reason as Error).message,
            tools: [],
          },
    );
  }

  getConnectionStatus() {
    return this.mcpClients.getClients().map((client) => ({
      name: client.name,
      connected: client.isConnected(),
      serverVersion: client.getServerVersion(),
      serverCapabilities: client.getServerCapabilities(),
    }));
  }
}
