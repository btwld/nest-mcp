import { InjectMcpClient } from '@btwld/mcp-client';
import type { McpClient } from '@btwld/mcp-client';
import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  constructor(@InjectMcpClient('playground') private readonly client: McpClient) {}

  async listTools() {
    return this.client.listTools();
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    return this.client.callTool({ name, arguments: args });
  }

  async listResources() {
    return this.client.listResources();
  }

  async readResource(uri: string) {
    return this.client.readResource({ uri });
  }

  async listPrompts() {
    return this.client.listPrompts();
  }

  async getPrompt(name: string, args: Record<string, string> = {}) {
    return this.client.getPrompt({ name, arguments: args });
  }

  async ping() {
    return this.client.ping();
  }

  getStatus() {
    return {
      connected: this.client.isConnected(),
      serverCapabilities: this.client.getServerCapabilities(),
      serverVersion: this.client.getServerVersion(),
    };
  }
}
