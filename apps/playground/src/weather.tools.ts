import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Tool, Resource, ResourceTemplate, Prompt, Public, RateLimit, Retry } from '@btwld/mcp-server';
import type { McpExecutionContext } from '@btwld/mcp-server';

@Injectable()
export class WeatherTools {
  @Tool({
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: z.object({
      city: z.string().describe('City name'),
      units: z.enum(['celsius', 'fahrenheit']).optional().describe('Temperature units'),
    }),
    annotations: { readOnlyHint: true },
  })
  @RateLimit({ max: 60, window: '1m' })
  @Retry({ maxAttempts: 2, backoff: 'exponential' })
  async getWeather(args: { city: string; units?: string }, ctx: McpExecutionContext) {
    await ctx.reportProgress({ progress: 0.5, total: 1 });

    // Simulated weather data
    const temp = Math.round(15 + Math.random() * 20);
    const conditions = ['sunny', 'cloudy', 'rainy', 'windy'];
    const condition = conditions[Math.floor(Math.random() * conditions.length)];

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          city: args.city,
          temperature: args.units === 'fahrenheit' ? temp * 9 / 5 + 32 : temp,
          units: args.units || 'celsius',
          condition,
        }),
      }],
    };
  }

  @Tool({
    name: 'echo',
    description: 'Echo back a message',
    parameters: z.object({
      message: z.string().describe('Message to echo'),
    }),
  })
  @Public()
  async echo(args: { message: string }) {
    return `Echo: ${args.message}`;
  }
}

@Injectable()
export class DataResources {
  @Resource({
    uri: 'data://config/settings',
    name: 'App Settings',
    description: 'Application configuration settings',
    mimeType: 'application/json',
  })
  async getSettings() {
    return {
      contents: [{
        uri: 'data://config/settings',
        mimeType: 'application/json',
        text: JSON.stringify({
          appName: 'MCP Playground',
          version: '1.0.0',
          features: ['tools', 'resources', 'prompts'],
        }),
      }],
    };
  }

  @ResourceTemplate({
    uriTemplate: 'data://users/{userId}/profile',
    name: 'User Profile',
    description: 'Get a user profile by ID',
    mimeType: 'application/json',
  })
  async getUserProfile(uri: URL, params: { userId: string }) {
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          id: params.userId,
          name: `User ${params.userId}`,
          email: `user${params.userId}@example.com`,
        }),
      }],
    };
  }
}

@Injectable()
export class AssistantPrompts {
  @Prompt({
    name: 'code_review',
    description: 'Review code for issues and suggest improvements',
    parameters: z.object({
      language: z.string().describe('Programming language'),
      code: z.string().describe('Code to review'),
    }),
  })
  async codeReview(args: { language: string; code: string }) {
    return {
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Please review the following ${args.language} code for potential issues, bugs, and improvements:\n\n\`\`\`${args.language}\n${args.code}\n\`\`\``,
        },
      }],
    };
  }
}
