import { McpClientModule } from '@nest-mcp/client';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health.controller';
import { NotificationHandler } from './notification.handler';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    McpClientModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        connections: [
          {
            name: 'playground',
            transport: 'streamable-http' as const,
            url: config.get('PLAYGROUND_URL', 'http://localhost:3000/mcp'),
            auth: {
              type: 'bearer' as const,
              token: config.get('PLAYGROUND_TOKEN', 'demo-bearer-token'),
            },
            reconnect: { maxAttempts: 5, delay: 2000 },
          },
          {
            name: 'sse-server',
            transport: 'sse' as const,
            url: config.get('SSE_SERVER_URL', 'http://localhost:3003/sse'),
            reconnect: { maxAttempts: 3, delay: 1000 },
          },
          {
            name: 'stdio-server',
            transport: 'stdio' as const,
            command: 'node',
            args: [config.get('STDIO_SERVER_PATH', './apps/example-stdio/dist/main.js')],
          },
        ],
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AppController, HealthController],
  providers: [AppService, NotificationHandler],
})
export class AppModule {}
