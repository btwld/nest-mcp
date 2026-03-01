import { Scopes, Tool } from '@nest-mcp/server';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class AnalyticsTools {
  @Tool({
    name: 'get_analytics',
    description: 'Get analytics data for a metric (registered via forFeature)',
    parameters: z.object({
      metric: z.enum(['pageviews', 'users', 'events']).describe('Metric to query'),
      period: z.enum(['hour', 'day', 'week', 'month']).optional().describe('Time period'),
    }),
  })
  @Scopes(['analytics:read'])
  async getAnalytics(args: { metric: string; period?: string }) {
    const data = {
      pageviews: { current: 15420, previous: 13200, change: '+16.8%' },
      users: { current: 3847, previous: 3621, change: '+6.2%' },
      events: { current: 89453, previous: 76302, change: '+17.2%' },
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            metric: args.metric,
            period: args.period || 'day',
            ...(data[args.metric as keyof typeof data] || data.pageviews),
          }),
        },
      ],
    };
  }
}
