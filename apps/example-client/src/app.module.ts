import { McpClientModule } from '@btwld/mcp-client';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { NotificationHandler } from './notification.handler';

@Module({
  imports: [
    McpClientModule.forRoot({
      connections: [
        {
          name: 'playground',
          transport: 'streamable-http',
          url: 'http://localhost:3000/mcp',
          reconnect: {
            maxAttempts: 5,
            delay: 2000,
          },
        },
      ],
    }),
  ],
  controllers: [AppController],
  providers: [AppService, NotificationHandler],
})
export class AppModule {}
