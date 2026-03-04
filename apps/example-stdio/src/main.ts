import { bootstrapStdioApp } from '@nest-mcp/server';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await bootstrapStdioApp(AppModule);

  process.stderr.write('MCP stdio server started. Communicating via stdin/stdout.\n');

  process.on('SIGINT', async () => {
    process.stderr.write('Shutting down...\n');
    await app.close();
    process.exit(0);
  });
}

bootstrap();
