import { McpModule, McpTransportType } from '@btwld/mcp-server';
import { Module } from '@nestjs/common';
import { DatabaseService } from './database/database.service';
import { QueryPrompts } from './prompts/query.prompts';
import { SchemaResources } from './resources/schema.resources';
import { QueryTools } from './tools/query.tools';
import { SchemaTools } from './tools/schema.tools';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'postgres-mcp',
      version: '0.1.0',
      description:
        'MCP server for PostgreSQL: schema inspection, SQL execution, query analysis, and performance insights',
      transport: McpTransportType.STREAMABLE_HTTP,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
    }),
  ],
  providers: [DatabaseService, QueryTools, SchemaTools, SchemaResources, QueryPrompts],
})
export class AppModule {}
