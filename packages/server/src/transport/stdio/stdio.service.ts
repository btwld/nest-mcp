import { Injectable, Logger, Inject } from '@nestjs/common';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpModuleOptions } from '@btwld/mcp-common';
import { MCP_OPTIONS, McpTransportType } from '@btwld/mcp-common';
import { McpRegistryService } from '../../discovery/registry.service';
import { McpExecutorService } from '../../execution/executor.service';
import { ExecutionPipelineService } from '../../execution/pipeline.service';
import { McpContextFactory } from '../../execution/context.factory';
import { createMcpServer } from '../../server/server.factory';

@Injectable()
export class StdioService {
  private readonly logger = new Logger(StdioService.name);

  constructor(
    @Inject(MCP_OPTIONS) private readonly options: McpModuleOptions,
    private readonly registry: McpRegistryService,
    private readonly executor: McpExecutorService,
    private readonly pipeline: ExecutionPipelineService,
    private readonly contextFactory: McpContextFactory,
  ) {}

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    const server = createMcpServer(this.registry, this.options);

    const ctx = this.contextFactory.createContext({
      sessionId: 'stdio',
      transport: McpTransportType.STDIO,
    });

    // Register all tools
    for (const tool of this.registry.getAllTools()) {
      (server as any).tool(tool.name, tool.description, async (args: any) => {
        return this.pipeline.callTool(tool.name, args, ctx) as any;
      });
    }

    // Register all resources
    for (const resource of this.registry.getAllResources()) {
      (server as any).resource(resource.name, resource.uri, async (uri: URL) => {
        return this.pipeline.readResource(uri.href, ctx) as any;
      });
    }

    // Register all resource templates
    for (const template of this.registry.getAllResourceTemplates()) {
      (server as any).resource(template.name, template.uriTemplate, async (uri: URL) => {
        return this.pipeline.readResource(uri.href, ctx) as any;
      });
    }

    // Register all prompts
    for (const prompt of this.registry.getAllPrompts()) {
      (server as any).prompt(prompt.name, prompt.description, async (args: any) => {
        return this.pipeline.getPrompt(prompt.name, args, ctx) as any;
      });
    }

    await server.connect(transport);
    this.logger.log('STDIO transport connected');
  }
}
