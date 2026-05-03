import 'reflect-metadata';
import { bootstrapStdioApp } from '@nest-mcp/server';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await bootstrapStdioApp(AppModule);

  process.stderr.write('auto-mcp example: stdio MCP server started.\n');

  process.on('SIGINT', async () => {
    process.stderr.write('Shutting down...\n');
    await app.close();
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  process.stderr.write(`Bootstrap failed: ${(err as Error).message}\n`);
  process.exit(1);
});
