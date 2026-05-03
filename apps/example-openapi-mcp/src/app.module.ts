import { OpenApiMcpModule } from '@nest-mcp/openapi-mcp';
import { McpModule, McpTransportType } from '@nest-mcp/server';
import { Module } from '@nestjs/common';
import { petstoreDoc } from './petstore-doc';

/**
 * Wires:
 *   1. `McpModule.forRoot(...)` — the existing MCP server (stdio transport).
 *   2. `OpenApiMcpModule.forRoot(...)` — converts every operation in the
 *      embedded Petstore doc into an MCP tool that proxies HTTP requests
 *      to `https://petstore3.swagger.io/api/v3`.
 *
 * The same module supports `documentUrl` (fetch JSON from a URL) and
 * `documentFactory` (lazy in-memory).
 */
@Module({
  imports: [
    McpModule.forRoot({
      name: 'openapi-mcp-example',
      version: '1.0.0',
      description: 'Example: external OpenAPI document exposed as MCP via @nest-mcp/openapi-mcp',
      transport: McpTransportType.STDIO,
      capabilities: { tools: { listChanged: false } },
    }),
    OpenApiMcpModule.forRoot({
      name: 'petstore',
      document: petstoreDoc,
      baseUrl: 'https://petstore3.swagger.io/api/v3',
    }),
  ],
})
export class AppModule {}
