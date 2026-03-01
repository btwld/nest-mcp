import type { McpGuard, McpGuardContext } from '@nest-mcp/server';
import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiKeyGuard implements McpGuard {
  private readonly validKeys = new Set(
    ['playground-demo-key-12345', process.env.MCP_API_KEY].filter(Boolean),
  );

  canActivate(context: McpGuardContext): boolean {
    // Check for API key in request metadata
    const apiKey = context.metadata?.['x-api-key'] as string | undefined;
    if (!apiKey) return false;
    return this.validKeys.has(apiKey);
  }
}
