import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  CallToolRequest,
  ClientCapabilities,
  CompleteRequest,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  GetPromptRequest,
  Implementation,
  ListPromptsRequest,
  ListResourceTemplatesRequest,
  ListResourcesRequest,
  ListToolsRequest,
  LoggingLevel,
  Prompt,
  ReadResourceRequest,
  Resource,
  ResourceTemplate,
  SubscribeRequest,
  Tool,
  UnsubscribeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { drainAllPages } from '@nest-mcp/common';
import { Logger } from '@nestjs/common';
import type {
  McpClientConnection,
  McpClientReconnectOptions,
  McpElicitationHandler,
  McpElicitationHandlerOptions,
  McpRootsHandler,
  McpSamplingHandler,
} from './interfaces/client-options.interface';
import { createClientTransport } from './transport/client-transport.factory';

/** Upper bound on the HTTP DELETE sent by `disconnect()`, so a silent server cannot stall shutdown. */
const TERMINATE_SESSION_TIMEOUT_MS = 5000;

type McpNotificationHandler = (notification: {
  method: string;
  params?: Record<string, unknown>;
}) => void | Promise<void>;

type SdkNotificationHandler = (notification: unknown) => Promise<void>;

/** Dispatchers installed by `onNotification`, so they are not wrapped twice on the same SDK client. */
const installedDispatchers = new WeakSet<SdkNotificationHandler>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge capabilities per key: nested objects are shallow-merged, `additional` wins on conflicts.
 * Same semantics as the SDK's `Client.registerCapabilities`.
 */
function mergeCapabilities(
  base: ClientCapabilities,
  additional: ClientCapabilities,
): ClientCapabilities {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(additional)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
  }
  return result as ClientCapabilities;
}

/** Streamable HTTP answers 404 to a request carrying an expired or unknown `Mcp-Session-Id`. */
function isSessionExpiredError(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) return err.code === 404;
  // Also recognise errors from another copy of the SDK (instanceof fails across copies).
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === 404 &&
    err.message.startsWith('Streamable HTTP error')
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class McpClient {
  private readonly logger: Logger;
  private client: Client;
  private transport: Transport | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private reconnecting = false;
  /** Set by `disconnect()`; stops reconnection and suppresses transport error handling. */
  private closing = false;
  /** Incremented by every `disconnect()`, so a reconnect loop started earlier can detect it. */
  private lifecycle = 0;
  /** Whether a transport has been created at least once (`sessionId` only applies to the first). */
  private transportCreated = false;
  private readonly _notificationHandlerStore = new Map<string, McpNotificationHandler[]>();
  /** URIs subscribed through `subscribeResource`, replayed after a reconnect. */
  private readonly _subscriptions = new Set<string>();
  /** Capabilities passed by the user in the connection options. */
  private readonly _userCapabilities: ClientCapabilities;
  /** Capabilities implied by registered handlers (sampling, elicitation, roots). */
  private _handlerCapabilities: ClientCapabilities = {};
  private _samplingHandler?: McpSamplingHandler;
  private _elicitationHandler?: McpElicitationHandler;
  private _rootsHandler?: McpRootsHandler;

  constructor(
    readonly name: string,
    private readonly connection: McpClientConnection,
  ) {
    this.logger = new Logger(`McpClient[${name}]`);
    this._userCapabilities = connection.capabilities ?? {};
    this.client = this._createClient();

    if (connection.samplingHandler) this.setSamplingHandler(connection.samplingHandler);
    if (connection.elicitationHandler) {
      this.setElicitationHandler(connection.elicitationHandler, {
        modes: connection.elicitationModes,
      });
    }
    if (connection.rootsHandler) this.setRootsHandler(connection.rootsHandler);
  }

  /** Capabilities advertised on the next handshake: handler defaults, overridden by user values. */
  private get _declaredCapabilities(): ClientCapabilities {
    return mergeCapabilities(this._handlerCapabilities, this._userCapabilities);
  }

  private _clientInfo(): Implementation {
    const info = this.connection.clientInfo ?? {};
    return {
      ...info,
      name: info.name ?? `nestjs-mcp-client-${this.name}`,
      version: info.version ?? '1.0.0',
    };
  }

  private _createClient(): Client {
    return new Client(this._clientInfo(), { capabilities: this._declaredCapabilities });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.closing = false;

    const transport = this._createTransport();
    this.transport = transport;
    this._bindTransport(transport);

    try {
      await this.client.connect(transport, this._connectOptions());
      this.connected = true;
      this._installNotificationDispatchers();
      this.reconnectAttempts = 0;
      this.logger.log(`Connected to MCP server "${this.name}"`);
      await this._replaySubscriptions();
    } catch (err: unknown) {
      this.logger.error(`Failed to connect to "${this.name}": ${errorMessage(err)}`);
      throw err;
    }
  }

  /**
   * Close the connection. For Streamable HTTP, the session is ended first with an HTTP DELETE
   * (errors, including a 405 from servers that do not support it, are ignored). Stops any
   * reconnection in progress and forgets tracked resource subscriptions.
   */
  async disconnect(): Promise<void> {
    this.closing = true;
    this.lifecycle++;
    this.connected = false;
    this._subscriptions.clear();

    const transport = this.transport;
    // Detach first so the transport's onclose does not re-enter handleDisconnect.
    this.transport = null;
    if (!transport) return;

    await this._terminateSession(transport);
    await this._closeQuietly(transport);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getClient(): Client {
    return this.client;
  }

  async callTool(params: CallToolRequest['params'], options?: RequestOptions) {
    this.assertConnected();
    return this.client.callTool(params, undefined, options);
  }

  async readResource(params: ReadResourceRequest['params'], options?: RequestOptions) {
    this.assertConnected();
    return this.client.readResource(params, options);
  }

  async listTools(params?: ListToolsRequest['params'], options?: RequestOptions) {
    this.assertConnected();
    return this.client.listTools(params, options);
  }

  async listResources(params?: ListResourcesRequest['params'], options?: RequestOptions) {
    this.assertConnected();
    return this.client.listResources(params, options);
  }

  async listResourceTemplates(
    params?: ListResourceTemplatesRequest['params'],
    options?: RequestOptions,
  ) {
    this.assertConnected();
    return this.client.listResourceTemplates(params, options);
  }

  async getPrompt(params: GetPromptRequest['params'], options?: RequestOptions) {
    this.assertConnected();
    return this.client.getPrompt(params, options);
  }

  async listPrompts(params?: ListPromptsRequest['params'], options?: RequestOptions) {
    this.assertConnected();
    return this.client.listPrompts(params, options);
  }

  async listAllTools(options?: RequestOptions): Promise<Tool[]> {
    this.assertConnected();
    return drainAllPages(
      async (cursor) => {
        const result = await this.client.listTools(cursor ? { cursor } : undefined, options);
        return { data: (result.tools ?? []) as Tool[], nextCursor: result.nextCursor };
      },
      { onTruncated: this._warnTruncated('tools') },
    );
  }

  async listAllResources(options?: RequestOptions): Promise<Resource[]> {
    this.assertConnected();
    return drainAllPages(
      async (cursor) => {
        const result = await this.client.listResources(cursor ? { cursor } : undefined, options);
        return { data: (result.resources ?? []) as Resource[], nextCursor: result.nextCursor };
      },
      { onTruncated: this._warnTruncated('resources') },
    );
  }

  async listAllResourceTemplates(options?: RequestOptions): Promise<ResourceTemplate[]> {
    this.assertConnected();
    return drainAllPages(
      async (cursor) => {
        const result = await this.client.listResourceTemplates(
          cursor ? { cursor } : undefined,
          options,
        );
        return {
          data: (result.resourceTemplates ?? []) as ResourceTemplate[],
          nextCursor: result.nextCursor,
        };
      },
      { onTruncated: this._warnTruncated('resource templates') },
    );
  }

  async listAllPrompts(options?: RequestOptions): Promise<Prompt[]> {
    this.assertConnected();
    return drainAllPages(
      async (cursor) => {
        const result = await this.client.listPrompts(cursor ? { cursor } : undefined, options);
        return { data: (result.prompts ?? []) as Prompt[], nextCursor: result.nextCursor };
      },
      { onTruncated: this._warnTruncated('prompts') },
    );
  }

  async ping(options?: RequestOptions) {
    this.assertConnected();
    return this.client.ping(options);
  }

  /**
   * Subscribe to updates for a resource. Successful subscriptions are remembered and
   * re-sent after the client reconnects.
   */
  async subscribeResource(params: SubscribeRequest['params'], options?: RequestOptions) {
    this.assertConnected();
    const result = await this.client.subscribeResource(params, options);
    this._subscriptions.add(params.uri);
    return result;
  }

  /**
   * Unsubscribe from a resource. The URI is always dropped from the set replayed on reconnect,
   * even if the request itself fails.
   */
  async unsubscribeResource(params: UnsubscribeRequest['params'], options?: RequestOptions) {
    this._subscriptions.delete(params.uri);
    this.assertConnected();
    return this.client.unsubscribeResource(params, options);
  }

  async setLoggingLevel(level: LoggingLevel, options?: RequestOptions) {
    this.assertConnected();
    return this.client.setLoggingLevel(level, options);
  }

  async complete(params: CompleteRequest['params'], options?: RequestOptions) {
    this.assertConnected();
    return this.client.complete(params, options);
  }

  async sendRootsListChanged(): Promise<void> {
    this.assertConnected();
    return this.client.sendRootsListChanged();
  }

  /**
   * Register a handler for server→client `sampling/createMessage` requests.
   * Automatically declares the `sampling` capability. Should be called before `connect()`
   * so the capability is advertised during initialization.
   */
  setSamplingHandler(handler: McpSamplingHandler): void {
    this._samplingHandler = handler;
    this._declareCapability('sampling', {});
    this._applySamplingHandler(handler);
  }

  /**
   * Register a handler for server→client `elicitation/create` requests.
   * Automatically declares the `elicitation` capability: form mode only by default, or the
   * modes listed in `options.modes` (e.g. `['form', 'url']` to also accept URL-mode requests).
   */
  setElicitationHandler(
    handler: McpElicitationHandler,
    options?: McpElicitationHandlerOptions,
  ): void {
    this._elicitationHandler = handler;
    const modes = options?.modes ?? [];
    const capability: Record<string, object> = {};
    for (const mode of modes) capability[mode] = {};
    this._declareCapability('elicitation', capability);
    this._applyElicitationHandler(handler);
  }

  /**
   * Register a handler for server→client `roots/list` requests.
   * Automatically declares the `roots` capability with `listChanged: true`.
   */
  setRootsHandler(handler: McpRootsHandler): void {
    this._rootsHandler = handler;
    this._declareCapability('roots', { listChanged: true });
    this._applyRootsHandler(handler);
  }

  /**
   * Register a handler for a server notification method. Several handlers can be registered for
   * the same method; they run in registration order, each isolated from the others' errors.
   * Handlers the SDK installs itself (e.g. for `notifications/progress` and
   * `notifications/cancelled`) keep running before them. Handlers survive reconnects.
   */
  onNotification(method: string, handler: McpNotificationHandler): void {
    const handlers = this._notificationHandlerStore.get(method);
    if (handlers) {
      handlers.push(handler);
    } else {
      this._notificationHandlerStore.set(method, [handler]);
    }
    this._installNotificationDispatcher(method);
  }

  getServerCapabilities() {
    return this.client.getServerCapabilities();
  }

  getServerVersion() {
    return this.client.getServerVersion();
  }

  getInstructions(): string | undefined {
    return this.client.getInstructions();
  }

  /**
   * Record a handler-implied capability and, while not connected, register the resulting
   * capability on the current SDK client. User-supplied values for the same key win.
   */
  private _declareCapability(key: 'sampling' | 'elicitation' | 'roots', value: object): void {
    this._handlerCapabilities = {
      ...this._handlerCapabilities,
      [key]: value,
    } as ClientCapabilities;
    if (this.connected) return;
    try {
      this.client.registerCapabilities({
        [key]: this._declaredCapabilities[key],
      } as ClientCapabilities);
    } catch {
      // A handshake is in progress; the capability is advertised on the next connect.
    }
  }

  private _applySamplingHandler(handler: McpSamplingHandler): void {
    this.client.setRequestHandler(CreateMessageRequestSchema, (req, extra) => handler(req, extra));
  }

  private _applyElicitationHandler(handler: McpElicitationHandler): void {
    this.client.setRequestHandler(ElicitRequestSchema, (req, extra) =>
      handler(req.params as ElicitRequestFormParams | ElicitRequestURLParams, extra),
    );
  }

  private _applyRootsHandler(handler: McpRootsHandler): void {
    this.client.setRequestHandler(ListRootsRequestSchema, (_req, extra) => handler(extra));
  }

  private _applyRequestHandlers(): void {
    if (this._samplingHandler) this._applySamplingHandler(this._samplingHandler);
    if (this._elicitationHandler) this._applyElicitationHandler(this._elicitationHandler);
    if (this._rootsHandler) this._applyRootsHandler(this._rootsHandler);
  }

  /**
   * The SDK only exposes `setNotificationHandler` with a schema carrying a literal method, so the
   * dispatcher is installed in its handler map directly. The handler already there (if any) is
   * kept and called first.
   */
  private _sdkNotificationHandlers(): Map<string, SdkNotificationHandler> | undefined {
    return (
      this.client as unknown as { _notificationHandlers?: Map<string, SdkNotificationHandler> }
    )._notificationHandlers;
  }

  private _installNotificationDispatcher(method: string): void {
    const sdkHandlers = this._sdkNotificationHandlers();
    if (!sdkHandlers) return;

    const previous = sdkHandlers.get(method);
    if (previous && installedDispatchers.has(previous)) return;

    const dispatcher: SdkNotificationHandler = async (notification) => {
      let previousFailed = false;
      let previousError: unknown;
      if (previous) {
        try {
          await previous(notification);
        } catch (err) {
          previousFailed = true;
          previousError = err;
        }
      }
      for (const handler of [...(this._notificationHandlerStore.get(method) ?? [])]) {
        try {
          await handler(notification as Parameters<McpNotificationHandler>[0]);
        } catch (err) {
          this.logger.error(`Notification handler for "${method}" failed: ${errorMessage(err)}`);
        }
      }
      // Surface the SDK handler's own failure the way the SDK would have.
      if (previousFailed) throw previousError;
    };
    installedDispatchers.add(dispatcher);
    sdkHandlers.set(method, dispatcher);
  }

  private _installNotificationDispatchers(): void {
    for (const method of this._notificationHandlerStore.keys()) {
      this._installNotificationDispatcher(method);
    }
  }

  private _warnTruncated(kind: string) {
    return ({ maxPages, itemCount }: { maxPages: number; itemCount: number }) =>
      this.logger.warn(
        `Listing ${kind} from "${this.name}" stopped after ${maxPages} pages (${itemCount} items); the result is incomplete`,
      );
  }

  private _connectOptions(): RequestOptions | undefined {
    const timeout = this.connection.connectTimeout;
    return timeout !== undefined ? { timeout } : undefined;
  }

  /** Create a transport; a configured `sessionId` is only used for the very first one. */
  private _createTransport(): Transport {
    const first = !this.transportCreated;
    this.transportCreated = true;
    if (!first && this.connection.transport === 'streamable-http' && this.connection.sessionId) {
      return createClientTransport({ ...this.connection, sessionId: undefined });
    }
    return createClientTransport(this.connection);
  }

  private _bindTransport(transport: Transport): void {
    // Events from a transport that has since been replaced or detached are ignored.
    transport.onclose = () => (this.transport === transport ? this.handleDisconnect() : undefined);
    transport.onerror = (err) => this._handleTransportError(transport, err);
  }

  private async _handleTransportError(transport: Transport, err: Error): Promise<void> {
    if (this.closing) {
      this.logger.debug(`Transport error while closing: ${err.message}`);
      return;
    }
    this.logger.error(`Transport error: ${err.message}`);
    if (!isSessionExpiredError(err) || transport !== this.transport || !this.connected) return;

    // The server no longer knows this session: the client must start a new one with a fresh
    // initialize. The SDK leaves the transport open, so close it and go through the
    // disconnect/reconnect path.
    this.logger.warn(`Session with "${this.name}" expired (HTTP 404); starting a new session`);
    this.transport = null;
    await this._closeQuietly(transport);
    await this.handleDisconnect();
  }

  private async _terminateSession(transport: Transport): Promise<void> {
    const terminate = (transport as { terminateSession?: () => Promise<void> }).terminateSession;
    if (typeof terminate !== 'function') return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        terminate.call(transport),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TERMINATE_SESSION_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (err: unknown) {
      this.logger.debug(`Session termination for "${this.name}" failed: ${errorMessage(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async _replaySubscriptions(): Promise<void> {
    for (const uri of [...this._subscriptions]) {
      try {
        await this.client.subscribeResource({ uri });
      } catch (err: unknown) {
        this.logger.warn(`Failed to re-subscribe to resource "${uri}": ${errorMessage(err)}`);
      }
    }
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error(`McpClient "${this.name}" is not connected`);
    }
  }

  private async handleDisconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    if (this.closing) return;
    this.logger.warn(`Connection lost to "${this.name}"`);

    const reconnect = this.connection.reconnect;
    if (reconnect) {
      await this.attemptReconnect(reconnect);
    }
  }

  /** Whether the reconnect loop started in `lifecycle` must stop. */
  private _reconnectCancelled(lifecycle: number): boolean {
    return this.closing || lifecycle !== this.lifecycle;
  }

  private async attemptReconnect(options: McpClientReconnectOptions): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const lifecycle = this.lifecycle;

    const maxAttempts = options.maxAttempts ?? 5;
    const delay = options.delay ?? 1000;
    this.reconnectAttempts = 0;

    try {
      while (this.reconnectAttempts < maxAttempts) {
        if (this._reconnectCancelled(lifecycle)) return;
        this.reconnectAttempts++;
        this.logger.log(
          `Reconnecting to "${this.name}" (attempt ${this.reconnectAttempts}/${maxAttempts})...`,
        );

        await this.sleep(delay * this.reconnectAttempts);
        // Stop if the client was closed, or connected again by an explicit connect(), meanwhile.
        if (this._reconnectCancelled(lifecycle) || this.connected) return;

        try {
          await this._reconnectOnce(lifecycle);
          return;
        } catch (err: unknown) {
          this.logger.warn(
            `Reconnection attempt ${this.reconnectAttempts} failed: ${errorMessage(err)}`,
          );
        }
      }

      this.logger.error(`Failed to reconnect to "${this.name}" after ${maxAttempts} attempts`);
    } finally {
      this.reconnecting = false;
    }
  }

  /** One reconnection attempt with a fresh SDK client and transport; throws if it fails. */
  private async _reconnectOnce(lifecycle: number): Promise<void> {
    this.client = this._createClient();
    this._applyRequestHandlers();
    this._installNotificationDispatchers();
    const transport = this._createTransport();
    this.transport = transport;
    this._bindTransport(transport);

    await this.client.connect(transport, this._connectOptions());

    if (this._reconnectCancelled(lifecycle)) {
      // disconnect() ran while the handshake was in flight: do not resurrect the connection.
      await this._closeQuietly(transport);
      return;
    }

    this.connected = true;
    this.reconnectAttempts = 0;
    this.logger.log(`Reconnected to "${this.name}"`);
    await this._replaySubscriptions();
  }

  private async _closeQuietly(transport: Transport): Promise<void> {
    try {
      await transport.close();
    } catch {
      // ignore close errors
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
