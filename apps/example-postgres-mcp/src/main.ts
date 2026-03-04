import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

function resolvePort(): number {
  const argIndex = process.argv.findIndex((a) => a === '--port' || a === '-p');
  if (argIndex !== -1 && process.argv[argIndex + 1]) {
    return Number.parseInt(process.argv[argIndex + 1], 10);
  }
  return Number.parseInt(process.env['PORT'] ?? '3200', 10);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const port = resolvePort();
  await app.listen(port);
  console.log(`Postgres MCP server running on http://localhost:${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
  console.log(
    `Read-only mode: ${process.env['POSTGRES_READONLY'] === 'true' ? 'enabled' : 'disabled'}`,
  );
}

bootstrap().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
