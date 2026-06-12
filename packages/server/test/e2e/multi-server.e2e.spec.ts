import 'reflect-metadata';
import { McpTransportType } from '@nest-mcp/common';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { McpModule, Tool } from '../../src';
import { connectStreamable, createMcpApp } from './helpers';
import type { E2eApp } from './helpers';

@Injectable()
class WeatherTools {
  @Tool({ name: 'get-weather', description: 'Weather', parameters: z.object({}) })
  getWeather() {
    return 'sunny';
  }
}

@Injectable()
class AdminTools {
  @Tool({ name: 'admin-action', description: 'Admin', parameters: z.object({}) })
  adminAction() {
    return 'done';
  }
}

/**
 * Two McpModule.forRoot() instances in one app, each with its own endpoint
 * and forFeature(serverName)-scoped tools, must stay fully isolated.
 */
describe('multi-server e2e', () => {
  let server: E2eApp;

  beforeAll(async () => {
    server = await createMcpApp({
      imports: [
        McpModule.forRoot({
          name: 'weather-server',
          version: '1.0.0',
          transport: McpTransportType.STREAMABLE_HTTP,
          transportOptions: { streamableHttp: { endpoint: '/weather-mcp' } },
        }),
        McpModule.forRoot({
          name: 'admin-server',
          version: '2.0.0',
          transport: McpTransportType.STREAMABLE_HTTP,
          transportOptions: { streamableHttp: { endpoint: '/admin-mcp' } },
        }),
        McpModule.forFeature([WeatherTools], 'weather-server'),
        McpModule.forFeature([AdminTools], 'admin-server'),
      ],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves each endpoint with its own server identity', async () => {
    const weather = await connectStreamable(server.baseUrl, { endpoint: '/weather-mcp' });
    const admin = await connectStreamable(server.baseUrl, { endpoint: '/admin-mcp' });
    try {
      expect(weather.getServerVersion()).toMatchObject({ name: 'weather-server' });
      expect(admin.getServerVersion()).toMatchObject({ name: 'admin-server' });
    } finally {
      await weather.close();
      await admin.close();
    }
  });

  it('scopes forFeature tools to their target server', async () => {
    const weather = await connectStreamable(server.baseUrl, { endpoint: '/weather-mcp' });
    const admin = await connectStreamable(server.baseUrl, { endpoint: '/admin-mcp' });
    try {
      const weatherTools = (await weather.listTools()).tools.map((t) => t.name);
      const adminTools = (await admin.listTools()).tools.map((t) => t.name);

      expect(weatherTools).toContain('get-weather');
      expect(weatherTools).not.toContain('admin-action');
      expect(adminTools).toContain('admin-action');
      expect(adminTools).not.toContain('get-weather');
    } finally {
      await weather.close();
      await admin.close();
    }
  });

  it('routes tool calls to the right server', async () => {
    const weather = await connectStreamable(server.baseUrl, { endpoint: '/weather-mcp' });
    try {
      const result = await weather.callTool({ name: 'get-weather', arguments: {} });
      expect(result.content).toEqual([{ type: 'text', text: 'sunny' }]);
    } finally {
      await weather.close();
    }
  });
});
