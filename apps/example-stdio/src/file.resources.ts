import { Prompt, Resource } from '@nest-mcp/server';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class ServerResources {
  @Resource({
    uri: 'data://server/info',
    name: 'Server Info',
    description: 'Information about the stdio MCP server',
    mimeType: 'application/json',
  })
  async getServerInfo() {
    return {
      contents: [
        {
          uri: 'data://server/info',
          mimeType: 'application/json',
          text: JSON.stringify({
            name: 'stdio-example-server',
            version: '1.0.0',
            transport: 'stdio',
            capabilities: ['calculator', 'unit-conversion'],
          }),
        },
      ],
    };
  }

  @Prompt({
    name: 'math_helper',
    description: 'Help solve a math problem step by step',
    parameters: z.object({
      problem: z.string().describe('Math problem to solve'),
    }),
  })
  async mathHelper(args: { problem: string }) {
    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please solve the following math problem step by step, showing your work:\n\n${args.problem}`,
          },
        },
      ],
    };
  }
}
