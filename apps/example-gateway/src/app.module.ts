import { McpTransportType } from '@nest-mcp/common';
import { McpGatewayModule } from '@nest-mcp/gateway';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GatewayStatusController } from './gateway-status.controller';
import { TransformService } from './transforms';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    McpGatewayModule.forRootAsync({
      imports: [ConfigModule],
      server: {
        transport: McpTransportType.STREAMABLE_HTTP,
        transportOptions: {
          streamableHttp: {
            endpoint: '/mcp',
            stateless: false,
          },
        },
      },
      useFactory: (config: ConfigService) => ({
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
            url: config.get('PLAYGROUND_URL', 'http://localhost:3000/mcp'),
            transport: 'streamable-http' as const,
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
          {
            name: 'inventory',
            url: config.get('SSE_SERVER_URL', 'http://localhost:3003/sse'),
            transport: 'sse' as const,
            toolPrefix: 'inventory',
            enabled: true,
            healthCheck: {
              enabled: true,
              intervalMs: 30000,
              timeoutMs: 5000,
            },
            reconnect: {
              enabled: true,
              maxRetries: 3,
              delayMs: 2000,
            },
          },
        ],
        routing: {
          toolRouting: 'prefix' as const,
          aggregateToolLists: true,
        },
        policies: {
          defaultEffect: 'allow' as const,
          rules: [
            {
              pattern: 'playground_admin_*',
              effect: 'deny' as const,
              reason: 'Admin tools are not exposed through the gateway',
            },
            {
              pattern: 'playground_echo',
              effect: 'allow' as const,
            },
            {
              pattern: 'inventory_check_stock',
              effect: 'require_approval' as const,
              reason: 'Stock checks require approval before execution',
            },
          ],
        },
        cache: {
          enabled: true,
          defaultTtl: 30000,
          maxSize: 100,
          rules: [
            { pattern: 'playground_get_weather', ttl: 60000 },
            { pattern: 'playground_get_analytics', ttl: 120000 },
            { pattern: 'inventory_lookup_product', ttl: 30000 },
          ],
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [GatewayStatusController],
  providers: [TransformService],
})
export class AppModule {}
