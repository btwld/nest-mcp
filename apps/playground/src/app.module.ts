import { Module } from '@nestjs/common';
import { McpModule, McpTransportType } from '@btwld/mcp-server';
import { WeatherTools, DataResources, AssistantPrompts } from './weather.tools';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'playground-server',
      version: '1.0.0',
      description: 'A playground MCP server demonstrating @btwld/mcp features',
      transport: McpTransportType.STREAMABLE_HTTP,
      transportOptions: {
        streamableHttp: {
          endpoint: '/mcp',
          stateless: false,
        },
      },
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: false, listChanged: true },
        prompts: { listChanged: true },
      },
    }),
  ],
  providers: [WeatherTools, DataResources, AssistantPrompts],
})
export class AppModule {}
