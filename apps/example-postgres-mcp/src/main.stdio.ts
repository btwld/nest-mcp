import { NestFactory } from '@nestjs/core';
import { AppStdioModule } from './app-stdio.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppStdioModule, { logger: false });

  process.stderr.write('Postgres MCP stdio server started. Communicating via stdin/stdout.\n');
  process.stderr.write(
    `Read-only mode: ${process.env['POSTGRES_READONLY'] === 'true' ? 'enabled' : 'disabled'}\n`,
  );

  process.on('SIGINT', async () => {
    process.stderr.write('Shutting down...\n');
    await app.close();
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
