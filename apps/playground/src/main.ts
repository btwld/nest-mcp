import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // Disable body parsing so MCP SDK can read the raw request stream
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`MCP Playground server running on http://localhost:${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
}

bootstrap();
