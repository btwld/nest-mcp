import { Injectable, Logger, type OnModuleDestroy, Inject } from '@nestjs/common';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpModuleOptions } from '@btwld/mcp-common';
import { MCP_OPTIONS, McpTransportType } from '@btwld/mcp-common';
import { McpRegistryService } from '../../discovery/registry.service';
import { McpExecutorService } from '../../execution/executor.service';
import { ExecutionPipelineService } from '../../execution/pipeline.service';
import { McpContextFactory } from '../../execution/context.factory';
import { createMcpServer } from '../../server/server.factory';
import {
  DEFAULT_SSE_MESSAGES_ENDPOINT,
  DEFAULT_PING_INTERVAL,
} from '../../constants/module.constants';

@Injectable()
export class SseService implements OnModuleDestroy {
  private readonly logger = new Logger(SseService.name);
  private readonly transports = new Map<string, SSEServerTransport>();
  private readonly servers = new Map<string, McpServer>();
  private readonly pingIntervals = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(MCP_OPTIONS) private readonly options: McpModuleOptions,
    private readonly registry: McpRegistryService,
    private readonly executor: McpExecutorService,
    private readonly pipeline: ExecutionPipelineService,
    private readonly contextFactory: McpContextFactory,
  ) {}

  async createConnection(req: any, res: any): Promise<void> {
    const messagesEndpoint =
      this.options.transportOptions?.sse?.messagesEndpoint ?? DEFAULT_SSE_MESSAGES_ENDPOINT;

    const transport = new SSEServerTransport(messagesEndpoint, res);
    const sessionId = transport.sessionId;

    const server = createMcpServer(this.registry, this.options);
    this.registerHandlers(server, sessionId);

    this.transports.set(sessionId, transport);
    this.servers.set(sessionId, server);

    // Setup ping
    const pingInterval =
      this.options.transportOptions?.sse?.pingInterval ?? DEFAULT_PING_INTERVAL;
    if (pingInterval > 0) {
      const interval = setInterval(() => {
        try {
          res.write?.(':ping\n\n');
        } catch {
          clearInterval(interval);
        }
      }, pingInterval);
      this.pingIntervals.set(sessionId, interval);
    }

    // Cleanup on close
    const cleanup = () => this.cleanupSession(sessionId);
    res.on?.('close', cleanup);
    if (res.raw) res.raw.on?.('close', cleanup);

    await server.connect(transport);
    this.logger.log(`SSE connection: ${sessionId}`);
  }

  async handleMessage(req: any, res: any): Promise<void> {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId || !this.transports.has(sessionId)) {
      res.status?.(404).json?.({ error: 'Session not found' }) ??
        res.code?.(404).send?.({ error: 'Session not found' });
      return;
    }

    const transport = this.transports.get(sessionId)!;
    await transport.handlePostMessage(req, res);
  }

  private registerHandlers(server: McpServer, sessionId: string): void {
    const ctx = this.contextFactory.createContext({
      sessionId,
      transport: McpTransportType.SSE,
    });

    for (const tool of this.registry.getAllTools()) {
      (server as any).tool(tool.name, tool.description, async (args: any) => {
        return this.pipeline.callTool(tool.name, args, ctx) as any;
      });
    }

    for (const resource of this.registry.getAllResources()) {
      (server as any).resource(resource.name, resource.uri, async (uri: URL) => {
        return this.pipeline.readResource(uri.href, ctx) as any;
      });
    }

    for (const template of this.registry.getAllResourceTemplates()) {
      (server as any).resource(template.name, template.uriTemplate, async (uri: URL) => {
        return this.pipeline.readResource(uri.href, ctx) as any;
      });
    }

    for (const prompt of this.registry.getAllPrompts()) {
      (server as any).prompt(prompt.name, prompt.description, async (args: any) => {
        return this.pipeline.getPrompt(prompt.name, args, ctx) as any;
      });
    }
  }

  private async cleanupSession(sessionId: string): Promise<void> {
    const pingInterval = this.pingIntervals.get(sessionId);
    if (pingInterval) {
      clearInterval(pingInterval);
      this.pingIntervals.delete(sessionId);
    }

    const transport = this.transports.get(sessionId);
    const server = this.servers.get(sessionId);

    if (transport) {
      await transport.close();
      this.transports.delete(sessionId);
    }
    if (server) {
      await server.close();
      this.servers.delete(sessionId);
    }

    this.logger.log(`SSE session cleaned up: ${sessionId}`);
  }

  async onModuleDestroy(): Promise<void> {
    for (const sessionId of this.transports.keys()) {
      await this.cleanupSession(sessionId);
    }
  }
}
