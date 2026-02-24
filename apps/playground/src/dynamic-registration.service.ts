import type { McpPromptBuilder, McpResourceBuilder, McpToolBuilder } from '@btwld/mcp-server';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class DynamicRegistrationService implements OnModuleInit {
  constructor(
    private readonly toolBuilder: McpToolBuilder,
    private readonly resourceBuilder: McpResourceBuilder,
    private readonly promptBuilder: McpPromptBuilder,
  ) {}

  onModuleInit() {
    // Dynamic tool
    this.toolBuilder.register({
      name: 'dynamic_timestamp',
      description: 'Get the current server timestamp (dynamically registered)',
      handler: async () => ({
        content: [{ type: 'text' as const, text: new Date().toISOString() }],
      }),
    });

    // Dynamic resource
    this.resourceBuilder.register({
      uri: 'data://dynamic/server-info',
      name: 'Dynamic Server Info',
      description: 'Server information (dynamically registered)',
      mimeType: 'application/json',
      handler: async () => ({
        contents: [
          {
            uri: 'data://dynamic/server-info',
            mimeType: 'application/json',
            text: JSON.stringify({
              name: 'playground-server',
              startedAt: new Date().toISOString(),
              nodeVersion: process.version,
            }),
          },
        ],
      }),
    });

    // Dynamic prompt
    this.promptBuilder.register({
      name: 'dynamic_greeting',
      description: 'Generate a greeting (dynamically registered)',
      parameters: z.object({
        name: z.string().describe('Name to greet'),
      }),
      handler: async (args: { name: string }) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Generate a creative greeting for ${args.name}`,
            },
          },
        ],
      }),
    });
  }
}
