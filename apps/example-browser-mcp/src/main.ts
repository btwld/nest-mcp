import 'reflect-metadata';
import { StdioService, bootstrapStdioApp } from '@btwld/mcp-server';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await bootstrapStdioApp(AppModule);

  const stdioService = app.get(StdioService);
  await stdioService.start();

  process.stderr.write('MCP browser server started. Communicating via stdin/stdout.\n');
  process.stderr.write('Tools available: fetch_url, fetch_urls, browser_install\n');

  process.on('SIGINT', async () => {
    process.stderr.write('Shutting down…\n');
    await app.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    process.stderr.write('Shutting down…\n');
    await app.close();
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
