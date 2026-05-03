import { AutoMcpModule } from '@nest-mcp/auto-mcp';
import { McpModule, McpTransportType } from '@nest-mcp/server';
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';

/**
 * AppModule wires:
 *   1. `McpModule.forRoot(...)` — the existing MCP server (stdio transport here).
 *   2. `AutoMcpModule.forRoot(...)` — auto-discovers every controller route and
 *      registers it as an MCP tool. By default `mode: 'all'` exposes everything;
 *      individual handlers can opt out with `@McpHide()` from `@nest-mcp/auto-mcp`.
 *
 * No `@Tool` decorators are required on `UsersController`.
 */
@Module({
  imports: [
    McpModule.forRoot({
      name: 'auto-mcp-example',
      version: '1.0.0',
      description: 'Example: a NestJS REST API auto-exposed as MCP via @nest-mcp/auto-mcp',
      transport: McpTransportType.STDIO,
      capabilities: {
        tools: { listChanged: false },
      },
    }),
    AutoMcpModule.forRoot({
      // mode: 'all' is the default — every route is exposed unless @McpHide() is set.
      // Switch to 'opt-in' if you want only @McpExpose-marked routes.
    }),
  ],
  controllers: [UsersController],
})
export class AppModule {}
