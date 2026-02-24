import { McpTransportType } from '@btwld/mcp-common';
import { McpGatewayModule } from '@btwld/mcp-gateway';
import { Module } from '@nestjs/common';
import { GatewayStatusController } from './gateway-status.controller';
import { TransformService } from './transforms';

@Module({
  imports: [
    McpGatewayModule.forRoot({
      server: {
        name: 'gateway-server',
        version: '1.0.0',
        description: 'MCP Gateway aggregating upstream MCP servers',
        transport: McpTransportType.STREAMABLE_HTTP,
        transportOptions: {
          streamableHttp: {
            endpoint: '/mcp',
            stateless: false,
          },
        },
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: false, listChanged: true },
          prompts: { listChanged: true },
        },
      },
      upstreams: [
        {
          name: 'playground',
          url: 'http://localhost:3000/mcp',
          transport: 'streamable-http',
          toolPrefix: 'playground',
          enabled: true,
          healthCheck: {
            enabled: true,
            intervalMs: 30000,
            timeoutMs: 5000,
          },
          reconnect: {
            enabled: true,
            maxRetries: 5,
            delayMs: 2000,
          },
        },
      ],
      routing: {
        toolRouting: 'prefix',
        aggregateToolLists: true,
      },
      policies: {
        defaultEffect: 'allow',
        rules: [
          {
            pattern: 'playground__admin_*',
            effect: 'deny',
            reason: 'Admin tools are not exposed through the gateway',
          },
          {
            pattern: 'playground__echo',
            effect: 'allow',
          },
        ],
      },
      cache: {
        enabled: true,
        defaultTtl: 30000,
        maxSize: 100,
        rules: [
          { pattern: 'playground__get_weather', ttl: 60000 },
          { pattern: 'playground__get_analytics', ttl: 120000 },
        ],
      },
    }),
  ],
  controllers: [GatewayStatusController],
  providers: [TransformService],
})
export class AppModule {}
