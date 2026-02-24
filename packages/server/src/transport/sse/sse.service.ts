import type { McpModuleOptions } from '@btwld/mcp-common';
import { MCP_OPTIONS, McpTransportType } from '@btwld/mcp-common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  DEFAULT_PING_INTERVAL,
  DEFAULT_SSE_MESSAGES_ENDPOINT,
} from '../../constants/module.constants';
import type { McpRegistryService } from '../../discovery/registry.service';
import type { McpContextFactory } from '../../execution/context.factory';
import type { McpExecutorService } from '../../execution/executor.service';
import type { ExecutionPipelineService } from '../../execution/pipeline.service';
import { createMcpServer } from '../../server/server.factory';
import { registerHandlers } from '../register-handlers';

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

  async createConnection(req: unknown, res: unknown): Promise<void> {
    const messagesEndpoint =
      this.options.transportOptions?.sse?.messagesEndpoint ?? DEFAULT_SSE_MESSAGES_ENDPOINT;

    const transport = new SSEServerTransport(messagesEndpoint, res as Response);
    const sessionId = transport.sessionId;

    const server = createMcpServer(this.registry, this.options);
    this.registerServerHandlers(server, sessionId);

    this.transports.set(sessionId, transport);
    this.servers.set(sessionId, server);

    // Setup ping
    const resObj = res as Record<string, unknown>;
    const pingInterval = this.options.transportOptions?.sse?.pingInterval ?? DEFAULT_PING_INTERVAL;
    if (pingInterval > 0) {
      const interval = setInterval(() => {
        try {
          (resObj.write as (chunk: string) => void)?.(':ping\n\n');
        } catch {
          clearInterval(interval);
        }
      }, pingInterval);
      this.pingIntervals.set(sessionId, interval);
    }

    // Cleanup on close
    const cleanup = () => this.cleanupSession(sessionId);
    (resObj.on as (event: string, cb: () => void) => void)?.('close', cleanup);
    if (resObj.raw) {
      ((resObj.raw as Record<string, unknown>).on as (event: string, cb: () => void) => void)?.(
        'close',
        cleanup,
      );
    }

    await server.connect(transport);
    this.logger.log(`SSE connection: ${sessionId}`);
  }

  async handleMessage(req: unknown, res: unknown): Promise<void> {
    const reqObj = req as { url: string; headers: { host: string } };
    const url = new URL(reqObj.url, `http://${reqObj.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId || !this.transports.has(sessionId)) {
      const resObj = res as Record<string, ((...args: unknown[]) => unknown) | undefined>;
      resObj.status?.(404)?.json?.({ error: 'Session not found' }) ??
        resObj.code?.(404)?.send?.({ error: 'Session not found' });
      return;
    }

    const transport = this.transports.get(sessionId);
    if (transport) {
      await transport.handlePostMessage(req as Request, res as Response);
    }
  }

  private registerServerHandlers(server: McpServer, sessionId: string): void {
    const ctx = this.contextFactory.createContext({
      sessionId,
      transport: McpTransportType.SSE,
    });

    registerHandlers(server, this.registry, this.pipeline, ctx);
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
