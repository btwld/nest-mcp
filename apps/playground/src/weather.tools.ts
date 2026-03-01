import {
  CircuitBreaker,
  Prompt,
  Public,
  RateLimit,
  Resource,
  ResourceTemplate,
  Retry,
  Scopes,
  Tool,
  UseMiddleware,
} from '@nest-mcp/server';
import type { McpExecutionContext } from '@nest-mcp/server';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { timingMiddleware } from './middleware/timing.middleware';

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
  @CircuitBreaker({ errorThreshold: 3, halfOpenTimeout: 30000 })
  @UseMiddleware(timingMiddleware)
  async getWeather(args: { city: string; units?: string }, ctx: McpExecutionContext) {
    await ctx.reportProgress({ progress: 0.5, total: 1 });

    // Simulated weather data
    const temp = Math.round(15 + Math.random() * 20);
    const conditions = ['sunny', 'cloudy', 'rainy', 'windy'];
    const condition = conditions[Math.floor(Math.random() * conditions.length)];

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            city: args.city,
            temperature: args.units === 'fahrenheit' ? (temp * 9) / 5 + 32 : temp,
            units: args.units || 'celsius',
            condition,
          }),
        },
      ],
    };
  }

  @Tool({
    name: 'get_forecast',
    description: 'Get 5-day weather forecast for a city',
    parameters: z.object({
      city: z.string().describe('City name'),
      days: z.number().min(1).max(5).optional().describe('Number of days'),
    }),
  })
  @Scopes(['tools:read'])
  async getForecast(args: { city: string; days?: number }) {
    const days = args.days || 5;
    const forecast = Array.from({ length: days }, (_, i) => ({
      day: i + 1,
      high: Math.round(20 + Math.random() * 15),
      low: Math.round(5 + Math.random() * 10),
      condition: ['sunny', 'cloudy', 'rainy', 'windy'][Math.floor(Math.random() * 4)],
    }));
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ city: args.city, forecast }),
        },
      ],
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
      contents: [
        {
          uri: 'data://config/settings',
          mimeType: 'application/json',
          text: JSON.stringify({
            appName: 'MCP Playground',
            version: '1.0.0',
            features: ['tools', 'resources', 'prompts'],
          }),
        },
      ],
    };
  }

  @Resource({
    uri: 'data://metrics/summary',
    name: 'Metrics Summary',
    description: 'Server metrics summary',
    mimeType: 'application/json',
  })
  async getMetricsSummary() {
    return {
      contents: [
        {
          uri: 'data://metrics/summary',
          mimeType: 'application/json',
          text: JSON.stringify({
            totalRequests: 1542,
            avgResponseTime: 45,
            errorRate: 0.02,
            activeConnections: 3,
          }),
        },
      ],
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
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({
            id: params.userId,
            name: `User ${params.userId}`,
            email: `user${params.userId}@example.com`,
          }),
        },
      ],
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
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please review the following ${args.language} code for potential issues, bugs, and improvements:\n\n\`\`\`${args.language}\n${args.code}\n\`\`\``,
          },
        },
      ],
    };
  }

  @Prompt({
    name: 'summarize_data',
    description: 'Summarize a dataset',
    parameters: z.object({
      data: z.string().describe('Data to summarize'),
      format: z.enum(['brief', 'detailed']).optional().describe('Summary format'),
    }),
  })
  async summarizeData(args: { data: string; format?: string }) {
    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please summarize the following data in a ${args.format || 'brief'} format:\n\n${args.data}`,
          },
        },
      ],
    };
  }
}
