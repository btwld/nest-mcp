import type { McpModuleOptions } from '@btwld/mcp-common';
import { MCP_OPTIONS, McpTransportType } from '@btwld/mcp-common';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { McpRegistryService } from '../../discovery/registry.service';
import { McpContextFactory } from '../../execution/context.factory';
import { McpExecutorService } from '../../execution/executor.service';
import { ExecutionPipelineService } from '../../execution/pipeline.service';
import { createMcpServer } from '../../server/server.factory';
import { registerHandlers } from '../register-handlers';

@Injectable()
export class StdioService {
  private readonly logger = new Logger(StdioService.name);

  constructor(
    @Inject(MCP_OPTIONS) private readonly options: McpModuleOptions,
    @Inject(McpRegistryService) private readonly registry: McpRegistryService,
    @Inject(McpExecutorService) private readonly executor: McpExecutorService,
    @Inject(ExecutionPipelineService) private readonly pipeline: ExecutionPipelineService,
    @Inject(McpContextFactory) private readonly contextFactory: McpContextFactory,
  ) {}

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    const server = createMcpServer(this.registry, this.options);

    const ctx = this.contextFactory.createContext({
      sessionId: 'stdio',
      transport: McpTransportType.STDIO,
    });

    registerHandlers(server, this.registry, this.pipeline, ctx);

    await server.connect(transport);
    this.logger.log('STDIO transport connected');
  }
}
