import { InjectMcpClient } from '@btwld/mcp-client';
import type { McpClient } from '@btwld/mcp-client';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  constructor(
    @InjectMcpClient('playground') private readonly playground: McpClient,
    @InjectMcpClient('sse-server') private readonly sseServer: McpClient,
    @InjectMcpClient('stdio-server') private readonly stdioServer: McpClient,
    @Inject('MCP_CLIENT_CONNECTIONS') private readonly allClients: McpClient[],
  ) {}

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
    const results = await Promise.allSettled(
      this.allClients.map(async (client) => {
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
            connection: this.allClients[i].name,
            error: (result.reason as Error).message,
            tools: [],
          },
    );
  }

  getConnectionStatus() {
    return this.allClients.map((client) => ({
      name: client.name,
      connected: client.isConnected(),
      serverVersion: client.getServerVersion(),
      serverCapabilities: client.getServerCapabilities(),
    }));
  }
}
