import 'reflect-metadata';
import type { McpModuleOptions, McpOptionsFactory } from '@nest-mcp/common';
import { McpTransportType } from '@nest-mcp/common';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { McpModule, Tool } from '../../src';
import { connectStreamable, createMcpApp } from './helpers';
import type { E2eApp } from './helpers';

@Injectable()
class AsyncTools {
  @Tool({ name: 'ping', description: 'Ping', parameters: z.object({}) })
  ping() {
    return 'pong';
  }
}

@Injectable()
class OptionsFromClass implements McpOptionsFactory {
  constructor() {}

  createMcpOptions(): McpModuleOptions {
    return {
      name: 'use-class-server',
      version: '3.2.1',
      instructions: 'Built by an options factory class.',
      transport: McpTransportType.STREAMABLE_HTTP,
    };
  }
}

describe('forRootAsync useClass e2e', () => {
  let server: E2eApp;

  beforeAll(async () => {
    server = await createMcpApp({
      imports: [
        McpModule.forRootAsync({
          transport: McpTransportType.STREAMABLE_HTTP,
          useClass: OptionsFromClass,
        }),
      ],
      providers: [AsyncTools],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('boots controllers and serves options produced by the factory class', async () => {
    const client = await connectStreamable(server.baseUrl);
    try {
      expect(client.getServerVersion()).toMatchObject({
        name: 'use-class-server',
        version: '3.2.1',
      });
      expect(client.getInstructions()).toBe('Built by an options factory class.');

      const result = await client.callTool({ name: 'ping', arguments: {} });
      expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
    } finally {
      await client.close();
    }
  });
});
