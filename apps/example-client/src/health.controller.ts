import { McpClientHealthIndicator } from '@btwld/mcp-client';
import type { McpClient } from '@btwld/mcp-client';
import { Controller, Get, Inject } from '@nestjs/common';

@Controller()
export class HealthController {
  private readonly healthIndicator: McpClientHealthIndicator;

  constructor(@Inject('MCP_CLIENT_CONNECTIONS') clients: McpClient[]) {
    this.healthIndicator = new McpClientHealthIndicator(clients);
  }

  @Get('health')
  async check() {
    return this.healthIndicator.check();
  }
}
