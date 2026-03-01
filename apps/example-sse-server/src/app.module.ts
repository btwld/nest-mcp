import { McpTransportType } from '@nest-mcp/common';
import { McpModule } from '@nest-mcp/server';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CatalogResources } from './catalog.resources';
import { InventoryTools } from './inventory.tools';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    McpModule.forRootAsync({
      transport: McpTransportType.SSE,
      transportOptions: {
        sse: {
          endpoint: '/sse',
          messagesEndpoint: '/messages',
        },
      },
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        name: config.get('MCP_SERVER_NAME', 'inventory-sse-server'),
        version: config.get('MCP_SERVER_VERSION', '1.0.0'),
        description: 'MCP server using SSE transport with async configuration',
        transport: McpTransportType.SSE,
        transportOptions: {
          sse: {
            endpoint: '/sse',
            messagesEndpoint: '/messages',
          },
        },
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: false, listChanged: true },
          prompts: { listChanged: true },
        },
        session: {
          timeout: 600000, // 10 minutes
          maxConcurrent: 20,
          cleanupInterval: 30000,
        },
        metrics: {
          enabled: true,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [InventoryTools, CatalogResources],
})
export class AppModule {}
