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
import { registerHandlers } from '../register-handlers';
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
    this.registerServerHandlers(server, label);
    server.connect(transport);
    return server;
  }

  private registerServerHandlers(server: McpServer, sessionId: string): void {
    const ctx = this.contextFactory.createContext({
      sessionId,
      transport: McpTransportType.STREAMABLE_HTTP,
    });

    registerHandlers(server, this.registry, this.pipeline, ctx);
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
