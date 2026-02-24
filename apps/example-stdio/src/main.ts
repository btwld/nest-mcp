import 'reflect-metadata';
import { StdioService } from '@btwld/mcp-server';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // Use createApplicationContext — no HTTP server needed for stdio
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'], // Minimize logging to avoid polluting stdout
  });

  const stdioService = app.get(StdioService);
  await stdioService.start();

  // Use console.error — stdout is reserved for MCP protocol
  console.error('MCP stdio server started. Communicating via stdin/stdout.');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.error('Shutting down...');
    await app.close();
    process.exit(0);
  });
}

bootstrap();
