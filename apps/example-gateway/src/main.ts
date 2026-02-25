import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const port = process.env.PORT || 3002;
  await app.listen(port);
  console.log(`MCP Gateway running on http://localhost:${port}`);
  console.log(`Gateway MCP endpoint: http://localhost:${port}/mcp`);
  console.log('Upstreams: playground (:3000), inventory (:3003)');
  console.log('');
  console.log('REST endpoints:');
  console.log(`  GET http://localhost:${port}/gateway/status`);
  console.log(`  GET http://localhost:${port}/gateway/tools`);
  console.log(`  GET http://localhost:${port}/gateway/policy/:tool`);
}

bootstrap();
