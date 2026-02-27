import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const port = process.env.PORT || 3100;
  await app.listen(port);
  console.log(`MCP browser server running on http://localhost:${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
}

bootstrap().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
