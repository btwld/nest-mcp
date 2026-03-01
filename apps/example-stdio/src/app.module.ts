import { McpModule, McpTransportType } from '@nest-mcp/server';
import { Module } from '@nestjs/common';
import { CalculatorTools } from './calculator.tools';
import { ServerResources } from './file.resources';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'stdio-example-server',
      version: '1.0.0',
      description: 'A CLI-compatible MCP server using stdio transport',
      transport: McpTransportType.STDIO,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
    }),
  ],
  providers: [CalculatorTools, ServerResources],
})
export class AppModule {}
