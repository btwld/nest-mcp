import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpAuthInfo, McpExecutionContext, McpModuleOptions } from '@nest-mcp/common';
import { MCP_OPTIONS } from '@nest-mcp/common';
import { McpTransportType } from '@nest-mcp/common';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { MCP_BEARER_TOKEN_VERIFIER } from '../../auth/auth.constants';
import type { BearerTokenVerifier } from '../../auth/verifiers/bearer-verifier.interface';
import type {
  RegisteredPrompt,
  RegisteredResource,
  RegisteredResourceTemplate,
  RegisteredTool,
} from '../../discovery/registry.service';
import { McpRegistryService } from '../../discovery/registry.service';
import { McpContextFactory } from '../../execution/context.factory';
import { McpExecutorService } from '../../execution/executor.service';
import { ExecutionPipelineService } from '../../execution/pipeline.service';
import { createMcpServer } from '../../server/server.factory';
import { ResourceSubscriptionManager } from '../../subscription/resource-subscription.manager';
import { TaskManager } from '../../task/task.manager';
import { rawRequestOf, rawResponseOf } from '../raw-http.util';
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
  /** Verified bearer identity; the SDK transport reads this and surfaces it as `authInfo`. */
  auth?: McpAuthInfo;
  /**
   * Body parsed by an upstream middleware (global `express.json()`, Fastify's
   * built-in parser, …). When set, the raw stream is already consumed, so it
   * must be handed to the SDK as `parsedBody` — reading the stream again would
   * hang the request.
   */
  body?: unknown;
}

interface HttpResponse {
  headersSent?: boolean;
  status?: (code: number) => { json?: (body: unknown) => void; end?: () => void };
  code?: (code: number) => { send?: (body?: unknown) => void };
  on?: (event: string, cb: () => void) => void;
  /** Express / Node `ServerResponse` header setter. */
  setHeader?: (name: string, value: string) => unknown;
  /** Fastify reply header setter. */
  header?: (name: string, value: string) => unknown;
}

/** JSON-RPC server-error codes the SDK transport uses for its own HTTP-level errors. */
const RPC_BAD_REQUEST = -32000;
const RPC_SESSION_NOT_FOUND = -32001;
const RPC_INTERNAL_ERROR = -32603;

@Injectable()
export class StreamableHttpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamableHttpService.name);
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  private readonly servers = new Map<string, McpServer>();
  private readonly contexts = new Map<string, McpExecutionContext>();
  /** SDK handles per session, keyed by item name/uri for removal. */
  private readonly sdkHandles = new Map<string, Map<string, SdkHandle>>();
  /** Principal each stateful session was initialized by (oauth session binding). */
  private readonly sessionAuth = new Map<string, { sub?: string; clientId: string }>();
  /** Lazily resolved bearer-token verifier (cached on first successful resolution). */
  private bearerVerifier?: BearerTokenVerifier;
  /** Time of the last client request per stateful session (`session.timeout`). */
  private readonly lastActivity = new Map<string, number>();
  private idleSweep?: NodeJS.Timeout;

  private readonly registryListeners: Array<{
    event: string;
    listener: (...args: unknown[]) => void;
  }> = [];

  constructor(
    @Inject(MCP_OPTIONS) private readonly options: McpModuleOptions,
    private readonly registry: McpRegistryService,
    private readonly executor: McpExecutorService,
    private readonly pipeline: ExecutionPipelineService,
    private readonly contextFactory: McpContextFactory,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly subscriptionManager?: ResourceSubscriptionManager,
    @Optional() private readonly taskManager?: TaskManager,
  ) {
    this.subscribeToRegistryEvents();
  }

  onModuleInit(): void {
    if (this.oauthOptions?.enabled && !this.resolveBearerVerifier()) {
      this.logger.warn(
        'streamableHttp.oauth.enabled is set but no MCP_BEARER_TOKEN_VERIFIER provider could be resolved. ' +
          'Import McpAuthModule.forRoot({ resource, authorizationServers, jwks | introspection | verifier }) — ' +
          'requests will fail until then.',
      );
    }

    const timeout = this.options.session?.timeout;
    if (!this.isStateless && timeout && timeout > 0) {
      const interval = this.options.session?.cleanupInterval ?? Math.min(timeout, 60_000);
      this.idleSweep = setInterval(() => {
        this.expireIdleSessions().catch((error) =>
          this.logger.warn(`Idle session sweep failed: ${String(error)}`),
        );
      }, interval);
      // Housekeeping only — never the reason a process stays alive.
      this.idleSweep.unref?.();
    }
  }

  /**
   * Close stateful sessions that have had no client request for longer than
   * `session.timeout`. A later request for such a session gets 404, which
   * tells the client to start a new one. Returns the number of sessions closed.
   */
  async expireIdleSessions(now = Date.now()): Promise<number> {
    const timeout = this.options.session?.timeout;
    if (!timeout || timeout <= 0) return 0;

    const idle = [...this.lastActivity]
      .filter(([, last]) => now - last > timeout)
      .map(([sessionId]) => sessionId);
    for (const sessionId of idle) {
      this.logger.log(`Session idle for more than ${timeout}ms, closing: ${sessionId}`);
      await this.cleanupSession(sessionId);
    }
    return idle.length;
  }

  get isStateless(): boolean {
    return this.options.transportOptions?.streamableHttp?.stateless ?? false;
  }

  private get oauthOptions() {
    return this.options.transportOptions?.streamableHttp?.oauth;
  }

  private resolveBearerVerifier(): BearerTokenVerifier | undefined {
    if (this.bearerVerifier) return this.bearerVerifier;
    try {
      this.bearerVerifier = this.moduleRef.get<BearerTokenVerifier>(MCP_BEARER_TOKEN_VERIFIER, {
        strict: false,
      });
    } catch {
      // Not registered — handled by the caller.
    }
    return this.bearerVerifier;
  }

  async handlePostRequest(req: unknown, res: unknown, parsedBody?: unknown): Promise<void> {
    try {
      // Prefer the body the generated controller received via @Body() (works on Express
      // AND Fastify); fall back to the framework request's own parsed body for direct
      // service callers (custom controllers). Undefined → the SDK reads the raw stream.
      const body = parsedBody ?? (req as HttpRequest).body;
      if (this.isStateless) {
        await this.handleStatelessPost(req, res, body);
      } else {
        await this.handleStatefulPost(req, res, body);
      }
    } catch (error) {
      this.logger.error('Error handling POST request', error);
      this.sendError(res, 500, RPC_INTERNAL_ERROR, 'Internal server error');
    }
  }

  async handleGetRequest(req: unknown, res: unknown): Promise<void> {
    if (this.isStateless) {
      this.sendError(
        res,
        405,
        RPC_BAD_REQUEST,
        'Method not allowed: stateless mode has no stream',
        {
          Allow: 'POST',
        },
      );
      return;
    }

    const transport = this.resolveSessionTransport(req, res);
    if (!transport) return;
    await transport.handleRequest(rawRequestOf(req), rawResponseOf(res));
  }

  async handleDeleteRequest(req: unknown, res: unknown): Promise<void> {
    if (this.isStateless) {
      this.sendError(
        res,
        405,
        RPC_BAD_REQUEST,
        'Method not allowed: stateless mode has no session',
        {
          Allow: 'POST',
        },
      );
      return;
    }

    const transport = this.resolveSessionTransport(req, res);
    if (!transport) return;
    // Let the SDK transport terminate the session: it validates the protocol
    // version, invokes `onsessionclosed`, and closes — which fires `onclose`
    // and runs our session cleanup.
    await transport.handleRequest(rawRequestOf(req), rawResponseOf(res));
  }

  /**
   * Look up the transport for the request's `Mcp-Session-Id`, answering the
   * request itself when there is none: 400 for a missing header, 404 for an
   * unknown or terminated session (the status that tells clients to start a
   * new session), 403 when the session belongs to another principal.
   */
  private resolveSessionTransport(
    req: unknown,
    res: unknown,
  ): StreamableHTTPServerTransport | undefined {
    const sessionId = (req as HttpRequest).headers?.['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      this.sendError(res, 400, RPC_BAD_REQUEST, 'Bad Request: Mcp-Session-Id header is required');
      return undefined;
    }
    const transport = this.transports.get(sessionId);
    if (!transport) {
      this.sendError(res, 404, RPC_SESSION_NOT_FOUND, 'Session not found');
      return undefined;
    }
    if (!this.enforceSessionBinding(sessionId, req, res)) return undefined;
    this.lastActivity.set(sessionId, Date.now());
    return transport;
  }

  /** Answer with a JSON-RPC error body, the shape the SDK transport itself uses. */
  private sendError(
    res: unknown,
    status: number,
    code: number,
    message: string,
    headers?: Record<string, string>,
  ): void {
    const resObj = res as HttpResponse;
    if (resObj.headersSent) return;
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (resObj.setHeader) resObj.setHeader(name, value);
      else resObj.header?.(name, value);
    }
    const body = { jsonrpc: '2.0', error: { code, message }, id: null };
    resObj.status?.(status).json?.(body) ?? resObj.code?.(status).send?.(body);
  }

  private buildTransportOptions(stateless: boolean): StreamableHTTPServerTransportOptions {
    const opts = this.options.transportOptions?.streamableHttp;
    return {
      sessionIdGenerator: stateless
        ? undefined
        : (opts?.sessionIdGenerator ?? (() => randomUUID())),
      enableJsonResponse: opts?.enableJsonResponse,
      eventStore: opts?.eventStore,
      onsessioninitialized: opts?.onsessioninitialized,
      onsessionclosed: opts?.onsessionclosed,
      retryInterval: opts?.retryInterval,
      allowedHosts: opts?.allowedHosts,
      allowedOrigins: opts?.allowedOrigins,
      enableDnsRebindingProtection: opts?.enableDnsRebindingProtection,
    };
  }

  /**
   * Verifies the current request's principal matches the one the session was
   * initialized by. Responds 403 and returns false on mismatch. No-op unless
   * oauth is enabled, binding is on, and a binding was recorded.
   */
  private enforceSessionBinding(sessionId: string, req: unknown, res: unknown): boolean {
    const oauth = this.oauthOptions;
    if (!oauth?.enabled || oauth.bindSessionToUser === false) return true;

    const bound = this.sessionAuth.get(sessionId);
    if (!bound) return true;

    const auth = (req as HttpRequest).auth;
    const sub = auth?.extra?.sub as string | undefined;
    if (auth && auth.clientId === bound.clientId && sub === bound.sub) return true;

    this.sendError(res, 403, RPC_BAD_REQUEST, 'Session does not belong to this principal');
    return false;
  }

  private async handleStatelessPost(req: unknown, res: unknown, body: unknown): Promise<void> {
    const transport = new StreamableHTTPServerTransport(this.buildTransportOptions(true));

    const { server } = this.createAndConnectServer(
      transport,
      `stateless-${randomUUID().slice(0, 8)}`,
      req,
    );

    // Attach cleanup to the RAW response: under Fastify the reply wrapper has no `on`.
    rawResponseOf(res).on?.('close', () => {
      transport.close();
      server.close();
    });

    await transport.handleRequest(rawRequestOf(req), rawResponseOf(res), body);
  }

  private async handleStatefulPost(req: unknown, res: unknown, body: unknown): Promise<void> {
    const reqObj = req as HttpRequest;
    const existingSessionId = reqObj.headers?.['mcp-session-id'] as string | undefined;

    if (existingSessionId) {
      // A request for a terminated or unknown session gets 404 — the status
      // that tells clients to re-initialize — without building a server for it.
      const transport = this.resolveSessionTransport(req, res);
      if (transport) {
        await transport.handleRequest(rawRequestOf(req), rawResponseOf(res), body);
      }
      return;
    }

    // New session — refuse it when the configured session limit is reached.
    const maxConcurrent = this.options.session?.maxConcurrent;
    if (maxConcurrent && this.transports.size >= maxConcurrent) {
      await this.expireIdleSessions();
      if (this.transports.size >= maxConcurrent) {
        this.logger.warn(`Session limit reached (${maxConcurrent}); refusing a new session`);
        this.sendError(res, 503, RPC_BAD_REQUEST, 'Maximum concurrent sessions reached', {
          'Retry-After': '30',
        });
        return;
      }
    }

    const transport = new StreamableHTTPServerTransport(this.buildTransportOptions(false));

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) this.cleanupSession(sid);
    };

    const { server, ctx } = this.createAndConnectServer(transport, 'pending', req);

    await transport.handleRequest(rawRequestOf(req), rawResponseOf(res), body);

    const sessionId = transport.sessionId;
    if (sessionId) {
      ctx.sessionId = sessionId;
      this.transports.set(sessionId, transport);
      this.servers.set(sessionId, server);
      this.contexts.set(sessionId, ctx);
      this.sdkHandles.set(sessionId, new Map());
      this.lastActivity.set(sessionId, Date.now());

      const oauth = this.oauthOptions;
      const auth = reqObj.auth;
      if (oauth?.enabled && oauth.bindSessionToUser !== false && auth) {
        this.sessionAuth.set(sessionId, {
          sub: auth.extra?.sub as string | undefined,
          clientId: auth.clientId,
        });
      }

      this.logger.log(`New session: ${sessionId}`);
    }
  }

  private createAndConnectServer(
    transport: StreamableHTTPServerTransport,
    label: string,
    req?: unknown,
  ): { server: McpServer; ctx: McpExecutionContext } {
    const server = createMcpServer(this.registry, this.options, this.taskManager);
    const subMgr = this.subscriptionManager;
    const ctx = this.contextFactory.createContext({
      sessionId: label,
      transport: McpTransportType.STREAMABLE_HTTP,
      request: req,
      mcpServer: server,
      notifyResourceUpdated: subMgr ? (uri) => subMgr.notifyResourceUpdated(uri) : undefined,
    });

    registerHandlers(
      server,
      this.registry,
      this.pipeline,
      ctx,
      this.options,
      this.subscriptionManager,
    );

    server.connect(transport);
    // The caller stores ctx under the real session id once the transport
    // assigns one — stateful session ids only exist after the initialize
    // request is handled, so keying here (under a placeholder label) would
    // orphan the entry and break registry-event propagation to the session.
    return { server, ctx };
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

    const onOutboundNotification = ({
      method,
      params,
    }: { method: string; params: Record<string, unknown> }) => {
      for (const server of this.servers.values()) {
        (server.server as unknown as { notification: (n: unknown) => Promise<void> })
          .notification({ method, params })
          .catch((err: unknown) =>
            this.logger.warn(`Failed to forward notification to session: ${err}`),
          );
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
    this.registry.events.on('notification.outbound', onOutboundNotification);

    this.registryListeners.push(
      { event: 'tool.registered', listener: onToolRegistered as (...args: unknown[]) => void },
      { event: 'tool.unregistered', listener: onToolUnregistered as (...args: unknown[]) => void },
      {
        event: 'resource.registered',
        listener: onResourceRegistered as (...args: unknown[]) => void,
      },
      {
        event: 'resource.unregistered',
        listener: onResourceUnregistered as (...args: unknown[]) => void,
      },
      { event: 'prompt.registered', listener: onPromptRegistered as (...args: unknown[]) => void },
      {
        event: 'prompt.unregistered',
        listener: onPromptUnregistered as (...args: unknown[]) => void,
      },
      {
        event: 'resourceTemplate.registered',
        listener: onResourceTemplateRegistered as (...args: unknown[]) => void,
      },
      {
        event: 'resourceTemplate.unregistered',
        listener: onResourceTemplateUnregistered as (...args: unknown[]) => void,
      },
      {
        event: 'notification.outbound',
        listener: onOutboundNotification as (...args: unknown[]) => void,
      },
    );
  }

  private async cleanupSession(sessionId: string): Promise<void> {
    // Guard: remove from maps first to prevent re-entrant cleanup when
    // transport.close() fires onclose, which would call cleanupSession again.
    if (!this.transports.has(sessionId) && !this.servers.has(sessionId)) {
      return;
    }

    this.subscriptionManager?.removeSession(sessionId);
    this.taskManager?.removeSession(sessionId);

    const transport = this.transports.get(sessionId);
    const server = this.servers.get(sessionId);

    this.transports.delete(sessionId);
    this.servers.delete(sessionId);
    this.contexts.delete(sessionId);
    this.sdkHandles.delete(sessionId);
    this.sessionAuth.delete(sessionId);
    this.lastActivity.delete(sessionId);

    if (transport) {
      await transport.close();
    }
    if (server) {
      await server.close();
    }

    this.logger.log(`Session cleaned up: ${sessionId}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.idleSweep) clearInterval(this.idleSweep);
    for (const { event, listener } of this.registryListeners) {
      this.registry.events.removeListener(event, listener);
    }
    this.registryListeners.length = 0;

    for (const sessionId of this.transports.keys()) {
      await this.cleanupSession(sessionId);
    }
  }
}
