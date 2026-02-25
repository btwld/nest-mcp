import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`MCP Client app running on http://localhost:${port}`);
  console.log('Connections: playground (:3000), sse-server (:3003)');
  console.log('');
  console.log('REST endpoints:');
  console.log(`  GET  http://localhost:${port}/health`);
  console.log(`  GET  http://localhost:${port}/connections`);
  console.log(`  GET  http://localhost:${port}/all-tools`);
  console.log(`  GET  http://localhost:${port}/tools`);
  console.log(`  POST http://localhost:${port}/tools/:name`);
  console.log(`  GET  http://localhost:${port}/sse-server/tools`);
  console.log(`  POST http://localhost:${port}/sse-server/tools/:name`);
  console.log(`  GET  http://localhost:${port}/status`);
}

bootstrap();
