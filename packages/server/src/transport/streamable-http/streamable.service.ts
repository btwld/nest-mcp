import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpExecutionContext, McpModuleOptions } from '@btwld/mcp-common';
import { MCP_OPTIONS } from '@btwld/mcp-common';
import { McpTransportType } from '@btwld/mcp-common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import type {
  RegisteredPrompt,
  RegisteredResource,
  RegisteredResourceTemplate,
  RegisteredTool,
} from '../../discovery/registry.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { McpRegistryService } from '../../discovery/registry.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { McpContextFactory } from '../../execution/context.factory';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { McpExecutorService } from '../../execution/executor.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { ExecutionPipelineService } from '../../execution/pipeline.service';
import { createMcpServer } from '../../server/server.factory';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { ResourceSubscriptionManager } from '../../subscription/resource-subscription.manager';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { TaskManager } from '../../task/task.manager';
import {
  registerHandlers,
  registerPromptOnServer,
  registerResourceOnServer,
  registerResourceTemplateOnServer,
  registerToolOnServer,
} from '../register-handlers';
import type { SdkHandle } from '../register-handlers';

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
  private readonly contexts = new Map<string, McpExecutionContext>();
  /** SDK handles per session, keyed by item name/uri for removal. */
  private readonly sdkHandles = new Map<string, Map<string, SdkHandle>>();

  private readonly registryListeners: Array<{ event: string; listener: (...args: unknown[]) => void }> = [];

  constructor(
    @Inject(MCP_OPTIONS) private readonly options: McpModuleOptions,
    private readonly registry: McpRegistryService,
    private readonly executor: McpExecutorService,
    private readonly pipeline: ExecutionPipelineService,
    private readonly contextFactory: McpContextFactory,
    @Optional() private readonly subscriptionManager?: ResourceSubscriptionManager,
    @Optional() private readonly taskManager?: TaskManager,
  ) {
    this.subscribeToRegistryEvents();
  }

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
    const server = createMcpServer(this.registry, this.options, this.taskManager);
    const ctx = this.contextFactory.createContext({
      sessionId: label,
      transport: McpTransportType.STREAMABLE_HTTP,
      request: req,
      mcpServer: server,
      notifyResourceUpdated: this.subscriptionManager
        ? (uri) => this.subscriptionManager!.notifyResourceUpdated(uri)
        : undefined,
    });

    registerHandlers(server, this.registry, this.pipeline, ctx, this.options, this.subscriptionManager);

    // Only store context/handles for stateful sessions (label !== stateless-*)
    if (!label.startsWith('stateless-')) {
      this.contexts.set(label, ctx);
      this.sdkHandles.set(label, new Map());
    }

    server.connect(transport);
    return server;
  }

  private subscribeToRegistryEvents(): void {
    const onToolRegistered = (tool: RegisteredTool) => {
      for (const [sessionId, server] of this.servers) {
        const ctx = this.contexts.get(sessionId);
        if (!ctx) continue;
        const handle = registerToolOnServer(server, tool, this.pipeline, ctx);
        this.sdkHandles.get(sessionId)?.set(`tool:${tool.name}`, handle);
      }
    };

    const onToolUnregistered = (name: string) => {
      for (const [sessionId] of this.servers) {
        const handle = this.sdkHandles.get(sessionId)?.get(`tool:${name}`);
        if (handle) {
          handle.remove();
          this.sdkHandles.get(sessionId)?.delete(`tool:${name}`);
        }
      }
    };

    const onResourceRegistered = (resource: RegisteredResource) => {
      for (const [sessionId, server] of this.servers) {
        const ctx = this.contexts.get(sessionId);
        if (!ctx) continue;
        const handle = registerResourceOnServer(server, resource, this.pipeline, ctx);
        this.sdkHandles.get(sessionId)?.set(`resource:${resource.uri}`, handle);
      }
    };

    const onResourceUnregistered = (uri: string) => {
      for (const [sessionId] of this.servers) {
        const handle = this.sdkHandles.get(sessionId)?.get(`resource:${uri}`);
        if (handle) {
          handle.remove();
          this.sdkHandles.get(sessionId)?.delete(`resource:${uri}`);
        }
      }
    };

    const onPromptRegistered = (prompt: RegisteredPrompt) => {
      for (const [sessionId, server] of this.servers) {
        const ctx = this.contexts.get(sessionId);
        if (!ctx) continue;
        const handle = registerPromptOnServer(server, prompt, this.pipeline, ctx);
        this.sdkHandles.get(sessionId)?.set(`prompt:${prompt.name}`, handle);
      }
    };

    const onPromptUnregistered = (name: string) => {
      for (const [sessionId] of this.servers) {
        const handle = this.sdkHandles.get(sessionId)?.get(`prompt:${name}`);
        if (handle) {
          handle.remove();
          this.sdkHandles.get(sessionId)?.delete(`prompt:${name}`);
        }
      }
    };

    const onResourceTemplateRegistered = (template: RegisteredResourceTemplate) => {
      for (const [sessionId, server] of this.servers) {
        const ctx = this.contexts.get(sessionId);
        if (!ctx) continue;
        const handle = registerResourceTemplateOnServer(server, template, this.pipeline, ctx);
        this.sdkHandles.get(sessionId)?.set(`resourceTemplate:${template.uriTemplate}`, handle);
      }
    };

    const onResourceTemplateUnregistered = (uriTemplate: string) => {
      for (const [sessionId] of this.servers) {
        const handle = this.sdkHandles.get(sessionId)?.get(`resourceTemplate:${uriTemplate}`);
        if (handle) {
          handle.remove();
          this.sdkHandles.get(sessionId)?.delete(`resourceTemplate:${uriTemplate}`);
        }
      }
    };

    this.registry.events.on('tool.registered', onToolRegistered);
    this.registry.events.on('tool.unregistered', onToolUnregistered);
    this.registry.events.on('resource.registered', onResourceRegistered);
    this.registry.events.on('resource.unregistered', onResourceUnregistered);
    this.registry.events.on('prompt.registered', onPromptRegistered);
    this.registry.events.on('prompt.unregistered', onPromptUnregistered);
    this.registry.events.on('resourceTemplate.registered', onResourceTemplateRegistered);
    this.registry.events.on('resourceTemplate.unregistered', onResourceTemplateUnregistered);

    this.registryListeners.push(
      { event: 'tool.registered', listener: onToolRegistered as (...args: unknown[]) => void },
      { event: 'tool.unregistered', listener: onToolUnregistered as (...args: unknown[]) => void },
      { event: 'resource.registered', listener: onResourceRegistered as (...args: unknown[]) => void },
      { event: 'resource.unregistered', listener: onResourceUnregistered as (...args: unknown[]) => void },
      { event: 'prompt.registered', listener: onPromptRegistered as (...args: unknown[]) => void },
      { event: 'prompt.unregistered', listener: onPromptUnregistered as (...args: unknown[]) => void },
      { event: 'resourceTemplate.registered', listener: onResourceTemplateRegistered as (...args: unknown[]) => void },
      { event: 'resourceTemplate.unregistered', listener: onResourceTemplateUnregistered as (...args: unknown[]) => void },
    );
  }

  private async cleanupSession(sessionId: string): Promise<void> {
    this.subscriptionManager?.removeSession(sessionId);
    this.taskManager?.removeSession(sessionId);

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

    this.contexts.delete(sessionId);
    this.sdkHandles.delete(sessionId);

    this.logger.log(`Session cleaned up: ${sessionId}`);
  }

  async onModuleDestroy(): Promise<void> {
    for (const { event, listener } of this.registryListeners) {
      this.registry.events.removeListener(event, listener);
    }
    this.registryListeners.length = 0;

    for (const sessionId of this.transports.keys()) {
      await this.cleanupSession(sessionId);
    }
  }
}
