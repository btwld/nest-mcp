import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`MCP Client app running on http://localhost:${port}`);
  console.log('Connecting to playground MCP server at http://localhost:3000/mcp');
  console.log('');
  console.log('REST endpoints:');
  console.log(`  GET  http://localhost:${port}/tools`);
  console.log(`  POST http://localhost:${port}/tools/:name`);
  console.log(`  GET  http://localhost:${port}/resources`);
  console.log(`  GET  http://localhost:${port}/resources/read?uri=<uri>`);
  console.log(`  GET  http://localhost:${port}/prompts`);
  console.log(`  GET  http://localhost:${port}/prompts/:name`);
  console.log(`  GET  http://localhost:${port}/ping`);
  console.log(`  GET  http://localhost:${port}/status`);
}

bootstrap();
