import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpModuleOptions } from '@btwld/mcp-common';
import { MCP_OPTIONS } from '@btwld/mcp-common';
import { McpTransportType } from '@btwld/mcp-common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { McpRegistryService } from '../../discovery/registry.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { McpContextFactory } from '../../execution/context.factory';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { McpExecutorService } from '../../execution/executor.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { ExecutionPipelineService } from '../../execution/pipeline.service';
import { createMcpServer } from '../../server/server.factory';
import { registerHandlers } from '../register-handlers';

interface HttpRequest {
  headers?: Record<string, string | string[] | undefined>;
  headersSent?: boolean;
}

interface HttpResponse {
  headersSent?: boolean;
  status?: (code: number) => { json?: (body: unknown) => void; end?: () => void };
  code?: (code: number) => { send?: (body?: unknown) => void };
  on?: (event: string, cb: () => void) => void;
}

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

  async handlePostRequest(req: unknown, res: unknown): Promise<void> {
    try {
      if (this.isStateless) {
        await this.handleStatelessPost(req, res);
      } else {
        await this.handleStatefulPost(req, res);
      }
    } catch (error) {
      this.logger.error('Error handling POST request', error);
      const resObj = res as HttpResponse;
      if (!resObj.headersSent) {
        resObj.status?.(500).json?.({ error: 'Internal server error' }) ??
          resObj.code?.(500).send?.({ error: 'Internal server error' });
      }
    }
  }

  async handleGetRequest(req: unknown, res: unknown): Promise<void> {
    const resObj = res as HttpResponse;
    if (this.isStateless) {
      resObj.status?.(405).json?.({ error: 'SSE not supported in stateless mode' }) ??
        resObj.code?.(405).send?.({ error: 'SSE not supported in stateless mode' });
      return;
    }

    const reqObj = req as HttpRequest;
    const sessionId = reqObj.headers?.['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.transports.has(sessionId)) {
      resObj.status?.(404).json?.({ error: 'Session not found' }) ??
        resObj.code?.(404).send?.({ error: 'Session not found' });
      return;
    }

    const transport = this.transports.get(sessionId);
    if (transport) {
      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      );
    }
  }

  async handleDeleteRequest(req: unknown, res: unknown): Promise<void> {
    const reqObj = req as HttpRequest;
    const resObj = res as HttpResponse;
    const sessionId = reqObj.headers?.['mcp-session-id'] as string | undefined;
    if (sessionId && this.transports.has(sessionId)) {
      await this.cleanupSession(sessionId);
      resObj.status?.(204).end?.() ?? resObj.code?.(204).send?.();
    } else {
      resObj.status?.(404).json?.({ error: 'Session not found' }) ??
        resObj.code?.(404).send?.({ error: 'Session not found' });
    }
  }

  private async handleStatelessPost(req: unknown, res: unknown): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    const server = this.createAndConnectServer(
      transport,
      `stateless-${randomUUID().slice(0, 8)}`,
      req,
    );

    const resObj = res as HttpResponse;
    resObj.on?.('close', () => {
      transport.close();
      server.close();
    });

    await transport.handleRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
  }

  private async handleStatefulPost(req: unknown, res: unknown): Promise<void> {
    const reqObj = req as HttpRequest;
    const existingSessionId = reqObj.headers?.['mcp-session-id'] as string | undefined;

    if (existingSessionId && this.transports.has(existingSessionId)) {
      const transport = this.transports.get(existingSessionId);
      if (transport) {
        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
        );
      }
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

    const server = this.createAndConnectServer(transport, 'pending', req);

    await transport.handleRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );

    const sessionId = transport.sessionId;
    if (sessionId) {
      this.transports.set(sessionId, transport);
      this.servers.set(sessionId, server);
      this.logger.log(`New session: ${sessionId}`);
    }
  }

  private createAndConnectServer(
    transport: StreamableHTTPServerTransport,
    label: string,
    req?: unknown,
  ): McpServer {
    const server = createMcpServer(this.registry, this.options);
    this.registerServerHandlers(server, label, req);
    server.connect(transport);
    return server;
  }

  private registerServerHandlers(server: McpServer, sessionId: string, req?: unknown): void {
    const ctx = this.contextFactory.createContext({
      sessionId,
      transport: McpTransportType.STREAMABLE_HTTP,
      request: req,
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
