import { Guards, Roles, Scopes, Tool } from '@btwld/mcp-server';
import type { McpExecutionContext } from '@btwld/mcp-server';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApiKeyGuard } from './guards/api-key.guard';

@Injectable()
export class AdminTools {
  @Tool({
    name: 'admin_stats',
    description: 'Get server statistics (admin only)',
    parameters: z.object({}),
  })
  @Roles(['admin'])
  @Scopes(['admin:read'])
  async getStats(_args: Record<string, unknown>, ctx: McpExecutionContext) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage().heapUsed,
            sessionId: ctx.sessionId,
          }),
        },
      ],
    };
  }

  @Tool({
    name: 'admin_reset_cache',
    description: 'Reset server cache (requires API key)',
    parameters: z.object({
      target: z.enum(['all', 'tools', 'resources']).describe('Cache target to reset'),
    }),
  })
  @Guards([ApiKeyGuard])
  async resetCache(args: { target: string }) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Cache "${args.target}" has been reset`,
        },
      ],
    };
  }
}
