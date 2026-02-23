import { Injectable, Logger, type OnModuleDestroy, Inject } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpModuleOptions } from '@btwld/mcp-common';
import { MCP_OPTIONS } from '@btwld/mcp-common';
import { McpRegistryService } from '../../discovery/registry.service';
import { McpExecutorService } from '../../execution/executor.service';
import { ExecutionPipelineService } from '../../execution/pipeline.service';
import { McpContextFactory } from '../../execution/context.factory';
import { McpTransportType } from '@btwld/mcp-common';
import { createMcpServer } from '../../server/server.factory';
import { randomUUID } from 'crypto';

@Injectable()
export class StreamableHttpService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamableHttpService.name);
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  private readonly servers = new Map<string, McpServer>();

  constructor(
    @Inject(MCP_OPTIONS) private readonly options: McpModuleOptions,
    private readonly registry: McpRegistryService,
    private readonly executor: McpExecutorService,
    private readonly pipeline: ExecutionPipelineService,
    private readonly contextFactory: McpContextFactory,
  ) {}

  get isStateless(): boolean {
    return this.options.transportOptions?.streamableHttp?.stateless ?? false;
  }

  async handlePostRequest(req: any, res: any): Promise<void> {
    try {
      if (this.isStateless) {
        await this.handleStatelessPost(req, res);
      } else {
        await this.handleStatefulPost(req, res);
      }
    } catch (error) {
      this.logger.error('Error handling POST request', error);
      if (!res.headersSent) {
        res.status?.(500).json?.({ error: 'Internal server error' }) ??
          res.code?.(500).send?.({ error: 'Internal server error' });
      }
    }
  }

  async handleGetRequest(req: any, res: any): Promise<void> {
    if (this.isStateless) {
      res.status?.(405).json?.({ error: 'SSE not supported in stateless mode' }) ??
        res.code?.(405).send?.({ error: 'SSE not supported in stateless mode' });
      return;
    }

    const sessionId = req.headers?.['mcp-session-id'];
    if (!sessionId || !this.transports.has(sessionId)) {
      res.status?.(404).json?.({ error: 'Session not found' }) ??
        res.code?.(404).send?.({ error: 'Session not found' });
      return;
    }

    const transport = this.transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  }

  async handleDeleteRequest(req: any, res: any): Promise<void> {
    const sessionId = req.headers?.['mcp-session-id'];
    if (sessionId && this.transports.has(sessionId)) {
      await this.cleanupSession(sessionId);
      res.status?.(204).end?.() ?? res.code?.(204).send?.();
    } else {
      res.status?.(404).json?.({ error: 'Session not found' }) ??
        res.code?.(404).send?.({ error: 'Session not found' });
    }
  }

  private async handleStatelessPost(req: any, res: any): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    const server = this.createAndConnectServer(transport, 'stateless-' + randomUUID().slice(0, 8));

    res.on?.('close', () => {
      transport.close();
      server.close();
    });

    await transport.handleRequest(req, res);
  }

  private async handleStatefulPost(req: any, res: any): Promise<void> {
    const existingSessionId = req.headers?.['mcp-session-id'];

    if (existingSessionId && this.transports.has(existingSessionId)) {
      const transport = this.transports.get(existingSessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) this.cleanupSession(sid);
    };

    const server = this.createAndConnectServer(transport, 'pending');

    await transport.handleRequest(req, res);

    const sessionId = transport.sessionId;
    if (sessionId) {
      this.transports.set(sessionId, transport);
      this.servers.set(sessionId, server);
      this.logger.log(`New session: ${sessionId}`);
    }
  }

  private createAndConnectServer(transport: StreamableHTTPServerTransport, label: string): McpServer {
    const server = createMcpServer(this.registry, this.options);
    this.registerHandlers(server, label);
    server.connect(transport);
    return server;
  }

  private registerHandlers(server: McpServer, sessionId: string): void {
    const ctx = this.contextFactory.createContext({
      sessionId,
      transport: McpTransportType.STREAMABLE_HTTP,
    });

    // Register tools
    for (const tool of this.registry.getAllTools()) {
      (server as any).tool(
        tool.name,
        tool.description,
        tool.parameters ? this.getInputSchema(tool) : {},
        async (args: any) => {
          return this.pipeline.callTool(tool.name, args, ctx) as any;
        },
      );
    }

    // Register resources
    for (const resource of this.registry.getAllResources()) {
      (server as any).resource(
        resource.name,
        resource.uri,
        resource.mimeType ? { mimeType: resource.mimeType } : {},
        async (uri: URL) => {
          return this.pipeline.readResource(uri.href, ctx) as any;
        },
      );
    }

    // Register resource templates
    for (const template of this.registry.getAllResourceTemplates()) {
      (server as any).resource(
        template.name,
        template.uriTemplate,
        template.mimeType ? { mimeType: template.mimeType } : {},
        async (uri: URL) => {
          return this.pipeline.readResource(uri.href, ctx) as any;
        },
      );
    }

    // Register prompts
    for (const prompt of this.registry.getAllPrompts()) {
      (server as any).prompt(
        prompt.name,
        prompt.description,
        prompt.parameters ? this.getPromptArgs(prompt) : {},
        async (args: any) => {
          return this.pipeline.getPrompt(prompt.name, args, ctx) as any;
        },
      );
    }
  }

  private getInputSchema(tool: any): Record<string, unknown> {
    if (!tool.parameters) return {};
    // Use the Zod schema directly - the SDK handles conversion
    const { zodToJsonSchema } = require('@btwld/mcp-common');
    return zodToJsonSchema(tool.parameters);
  }

  private getPromptArgs(prompt: any): Record<string, any> {
    if (!prompt.parameters) return {};
    const { extractZodDescriptions } = require('@btwld/mcp-common');
    const descriptions = extractZodDescriptions(prompt.parameters);
    const args: Record<string, any> = {};
    for (const desc of descriptions) {
      args[desc.name] = {
        description: desc.description,
        required: desc.required,
      };
    }
    return args;
  }

  private async cleanupSession(sessionId: string): Promise<void> {
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

    this.logger.log(`Session cleaned up: ${sessionId}`);
  }

  async onModuleDestroy(): Promise<void> {
    for (const sessionId of this.transports.keys()) {
      await this.cleanupSession(sessionId);
    }
  }
}
