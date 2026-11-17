import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  TaskStatusNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Root, ElicitResult as SdkElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  ElicitRequest,
  ElicitResult,
  McpSamplingParams,
  McpSamplingResult,
} from '@nest-mcp/common';
import { McpRegistryService } from '@nest-mcp/server';
import { Injectable, Logger, type OnModuleDestroy, Optional } from '@nestjs/common';
import { extractErrorMessage } from '../utils/error-utils';
import type {
  UpstreamChangeEvent,
  UpstreamChangeListener,
  UpstreamConfig,
  UpstreamListKind,
  UpstreamStatus,
} from './upstream.interface';

/** Defaults for `UpstreamConfig.reconnect`. */
export const DEFAULT_RECONNECT_MAX_RETRIES = 5;
export const DEFAULT_RECONNECT_DELAY_MS = 1000;
/** Upper bound for the exponential reconnect backoff. */
export const MAX_RECONNECT_DELAY_MS = 30000;

const ALL_LIST_KINDS: UpstreamListKind[] = ['tools', 'resources', 'prompts'];

interface ManagedUpstream {
  config: UpstreamConfig;
  client: Client;
  connected: boolean;
  healthy: boolean;
  lastHealthCheck?: Date;
  error?: string;
  /** Roots advertised to this upstream during the handshake (re-used on reconnect). */
  roots?: Root[];
  /** In-flight reconnect cycle, if any. */
  reconnecting?: Promise<boolean>;
  /** Wakes a pending reconnect backoff early (used on disconnect/shutdown). */
  cancelReconnectDelay?: () => void;
  /** Set once `disconnect()` starts; stops any reconnect cycle. */
  removed?: boolean;
}

@Injectable()
export class UpstreamManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(UpstreamManagerService.name);
  private readonly upstreams = new Map<string, ManagedUpstream>();
  private readonly samplingForwarders = new Map<
    string,
    (params: McpSamplingParams) => Promise<McpSamplingResult>
  >();
  private readonly elicitForwarders = new Map<
    string,
    (params: ElicitRequest, options?: { signal?: AbortSignal }) => Promise<ElicitResult>
  >();
  private readonly changeListeners = new Set<UpstreamChangeListener>();
  /** Clients closed on purpose (disconnect, replaced on reconnect) — their `onclose` is ignored. */
  private readonly retiredClients = new WeakSet<Client>();
  private shuttingDown = false;

  constructor(@Optional() private readonly registry?: McpRegistryService) {}

  async connectAll(configs: UpstreamConfig[], roots?: Root[]): Promise<void> {
    const enabled = configs.filter((c) => c.enabled !== false);
    await Promise.all(enabled.map((config) => this.connect(config, roots)));
  }

  async connect(config: UpstreamConfig, roots?: Root[]): Promise<void> {
    if (this.upstreams.has(config.name)) {
      this.logger.warn(`Upstream "${config.name}" already connected, skipping`);
      return;
    }

    const client = this.createClient(config, roots);
    const managed: ManagedUpstream = {
      config,
      client,
      connected: false,
      healthy: false,
      roots,
    };

    this.upstreams.set(config.name, managed);

    try {
      await this.openConnection(managed, client);
      const target = config.url ?? config.command ?? 'unknown';
      this.logger.log(`Connected to upstream "${config.name}" via ${config.transport} (${target})`);
    } catch (error) {
      managed.error = extractErrorMessage(error);
      this.logger.error(`Failed to connect to upstream "${config.name}": ${managed.error}`);
      if (this.isReconnectEnabled(config)) {
        void this.reconnect(config.name);
      }
    }
  }

  /**
   * Subscribe to upstream changes: list-changed notifications from an
   * upstream (`notifications/tools|resources|prompts/list_changed`) and
   * successful reconnects. Returns an unsubscribe function.
   */
  onUpstreamChange(listener: UpstreamChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Re-establish the connection to an upstream with a fresh client, retrying
   * with exponential backoff (`reconnect.delayMs`, doubling, capped at 30 s)
   * up to `reconnect.maxRetries` times. The upstream is reported as
   * disconnected and unhealthy until a reconnect succeeds; on success the
   * change listeners receive a `reconnected` event for every list kind.
   *
   * Concurrent calls share the in-flight attempt. Resolves to `true` when the
   * upstream is connected again.
   */
  reconnect(name: string): Promise<boolean> {
    const managed = this.upstreams.get(name);
    if (!managed || this.shuttingDown) return Promise.resolve(false);
    if (managed.reconnecting) return managed.reconnecting;

    // Mark the upstream down before the old client closes, so its `onclose`
    // (which may fire synchronously from close()) sees the cycle in progress.
    managed.connected = false;
    managed.healthy = false;
    const cycle = this.runReconnect(managed).finally(() => {
      managed.reconnecting = undefined;
    });
    managed.reconnecting = cycle;
    return cycle;
  }

  private async runReconnect(managed: ManagedUpstream): Promise<boolean> {
    const { name } = managed.config;
    const maxRetries = managed.config.reconnect?.maxRetries ?? DEFAULT_RECONNECT_MAX_RETRIES;
    const baseDelay = managed.config.reconnect?.delayMs ?? DEFAULT_RECONNECT_DELAY_MS;

    await this.retireClient(managed.client);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
      await this.waitForRetry(managed, delay);
      if (!this.isCurrent(managed)) return false;

      this.logger.log(`Reconnecting to upstream "${name}" (attempt ${attempt}/${maxRetries})`);
      const client = this.createClient(managed.config, managed.roots);
      try {
        await this.openConnection(managed, client);
      } catch (error) {
        managed.error = extractErrorMessage(error);
        this.logger.warn(
          `Reconnect attempt ${attempt}/${maxRetries} to upstream "${name}" failed: ${managed.error}`,
        );
        await this.retireClient(client);
        continue;
      }

      if (!this.isCurrent(managed)) {
        await this.retireClient(client);
        return false;
      }
      this.logger.log(`Reconnected to upstream "${name}"`);
      this.emitChange({ upstreamName: name, kinds: [...ALL_LIST_KINDS], reason: 'reconnected' });
      return true;
    }

    this.logger.error(
      `Giving up reconnecting to upstream "${name}" after ${maxRetries} attempt(s); it stays unhealthy`,
    );
    return false;
  }

  private waitForRetry(managed: ManagedUpstream, delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, delayMs);
      function done() {
        clearTimeout(timer);
        managed.cancelReconnectDelay = undefined;
        resolve();
      }
      managed.cancelReconnectDelay = done;
    });
  }

  /** Whether `managed` is still the registered entry and the service is running. */
  private isCurrent(managed: ManagedUpstream): boolean {
    return (
      !this.shuttingDown && !managed.removed && this.upstreams.get(managed.config.name) === managed
    );
  }

  private isReconnectEnabled(config: UpstreamConfig): boolean {
    return config.reconnect?.enabled === true;
  }

  private async retireClient(client: Client): Promise<void> {
    this.retiredClients.add(client);
    try {
      await client.close();
    } catch (error) {
      this.logger.debug(`Error closing replaced upstream client: ${extractErrorMessage(error)}`);
    }
  }

  private async openConnection(managed: ManagedUpstream, client: Client): Promise<void> {
    const transport = this.createTransport(managed.config);
    await client.connect(transport);
    client.onclose = () => this.handleClientClosed(managed.config.name, client);
    managed.client = client;
    managed.connected = true;
    managed.healthy = true;
    managed.lastHealthCheck = new Date();
    managed.error = undefined;
  }

  private handleClientClosed(name: string, client: Client): void {
    if (this.shuttingDown || this.retiredClients.has(client)) return;
    const managed = this.upstreams.get(name);
    if (!managed || managed.client !== client || managed.reconnecting) return;

    managed.connected = false;
    managed.healthy = false;
    managed.error = 'Connection closed';
    this.logger.warn(`Upstream "${name}" closed its connection`);

    if (this.isReconnectEnabled(managed.config)) {
      void this.reconnect(name);
    }
  }

  private emitChange(event: UpstreamChangeEvent): void {
    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(
          `Upstream change listener failed for "${event.upstreamName}": ${extractErrorMessage(error)}`,
        );
      }
    }
  }

  private createClient(config: UpstreamConfig, roots?: Root[]): Client {
    const client = new Client(
      { name: `gateway-to-${config.name}`, version: '1.0.0' },
      {
        capabilities: {
          sampling: {},
          elicitation: {},
          ...(roots?.length ? { roots: { listChanged: true } } : {}),
        },
      },
    );

    const upstreamName = config.name;

    // Forward sampling requests from the upstream to the active downstream client context.
    // The forwarder is set/cleared per tool call via activateSampling/deactivateSampling.
    client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
      const forwarder = this.samplingForwarders.get(upstreamName);
      if (!forwarder) {
        throw new Error(
          `Upstream "${upstreamName}" requested sampling but no downstream client context is active`,
        );
      }
      // The SDK SamplingMessage.content union is wider than McpSamplingContent (includes tool_use etc.).
      // Cast at the SDK→common boundary; runtime values will always be text/image/audio.
      const result = await forwarder(req.params as McpSamplingParams);
      return {
        role: result.role,
        content: result.content,
        model: result.model,
        stopReason: result.stopReason,
      };
    });

    // Forward elicitation requests from the upstream to the active downstream client context.
    // The forwarder is set/cleared per tool call via activateElicitation/deactivateElicitation.
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const forwarder = this.elicitForwarders.get(upstreamName);
      if (!forwarder) {
        throw new Error(
          `Upstream "${upstreamName}" requested elicitation but no downstream client context is active`,
        );
      }
      const result = await forwarder(req.params as ElicitRequest);
      return result as SdkElicitResult;
    });

    if (roots?.length) {
      client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots ?? [] }));
    }

    // Forward task status notifications from the upstream to all downstream sessions.
    if (this.registry) {
      client.setNotificationHandler(TaskStatusNotificationSchema, (notification) => {
        const prefixed = {
          ...notification.params,
          taskId: `${upstreamName}::${notification.params.taskId}`,
        };
        this.registry?.broadcastNotification(
          'notifications/tasks/status',
          prefixed as Record<string, unknown>,
        );
      });
    }

    // Surface upstream list changes so the gateway can re-aggregate this upstream.
    const listChanged = (kind: UpstreamListKind) => () => {
      this.emitChange({ upstreamName, kinds: [kind], reason: 'list_changed' });
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, listChanged('tools'));
    client.setNotificationHandler(ResourceListChangedNotificationSchema, listChanged('resources'));
    client.setNotificationHandler(PromptListChangedNotificationSchema, listChanged('prompts'));

    return client;
  }

  private createTransport(config: UpstreamConfig): Transport {
    switch (config.transport) {
      case 'stdio': {
        if (!config.command) {
          throw new Error(
            `Upstream "${config.name}" uses stdio transport but is missing required "command" field`,
          );
        }
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
        });
      }
      case 'streamable-http': {
        if (!config.url) {
          throw new Error(
            `Upstream "${config.name}" uses ${config.transport} transport but is missing required "url" field`,
          );
        }
        return new StreamableHTTPClientTransport(new URL(config.url));
      }
      case 'sse': {
        if (!config.url) {
          throw new Error(
            `Upstream "${config.name}" uses ${config.transport} transport but is missing required "url" field`,
          );
        }
        return new SSEClientTransport(new URL(config.url));
      }
      default:
        throw new Error(`Unsupported upstream transport: ${config.transport}`);
    }
  }

  getClient(name: string): Client | undefined {
    return this.upstreams.get(name)?.client;
  }

  getManaged(name: string): ManagedUpstream | undefined {
    return this.upstreams.get(name);
  }

  isConnected(name: string): boolean {
    return this.upstreams.get(name)?.connected ?? false;
  }

  isHealthy(name: string): boolean {
    return this.upstreams.get(name)?.healthy ?? false;
  }

  /** Whether a reconnect cycle is currently running for the upstream. */
  isReconnecting(name: string): boolean {
    return this.upstreams.get(name)?.reconnecting !== undefined;
  }

  setHealthy(name: string, healthy: boolean, error?: string): void {
    const managed = this.upstreams.get(name);
    if (managed) {
      managed.healthy = healthy;
      managed.lastHealthCheck = new Date();
      managed.error = error;
    }
  }

  getAllNames(): string[] {
    return Array.from(this.upstreams.keys());
  }

  getConfig(name: string): UpstreamConfig | undefined {
    return this.upstreams.get(name)?.config;
  }

  getAllConfigs(): UpstreamConfig[] {
    return Array.from(this.upstreams.values()).map((m) => m.config);
  }

  getStatus(name: string): UpstreamStatus | undefined {
    const managed = this.upstreams.get(name);
    if (!managed) return undefined;

    return {
      name: managed.config.name,
      connected: managed.connected,
      healthy: managed.healthy,
      lastHealthCheck: managed.lastHealthCheck,
      toolCount: 0,
      error: managed.error,
    };
  }

  getAllStatuses(): UpstreamStatus[] {
    return this.getAllNames()
      .map((name) => this.getStatus(name))
      .filter((s): s is UpstreamStatus => s !== undefined);
  }

  async disconnect(name: string): Promise<void> {
    const managed = this.upstreams.get(name);
    if (!managed) return;

    managed.removed = true;
    this.retiredClients.add(managed.client);
    managed.cancelReconnectDelay?.();
    try {
      await managed.client.close();
    } catch (error) {
      this.logger.warn(`Error disconnecting upstream "${name}": ${error}`);
    }

    this.upstreams.delete(name);
    this.logger.log(`Disconnected from upstream "${name}"`);
  }

  async disconnectAll(): Promise<void> {
    const names = this.getAllNames();
    await Promise.all(names.map((name) => this.disconnect(name)));
  }

  activateSampling(
    upstreamName: string,
    forwarder: (params: McpSamplingParams) => Promise<McpSamplingResult>,
  ): void {
    this.samplingForwarders.set(upstreamName, forwarder);
  }

  deactivateSampling(upstreamName: string): void {
    this.samplingForwarders.delete(upstreamName);
  }

  activateElicitation(
    upstreamName: string,
    forwarder: (params: ElicitRequest, options?: { signal?: AbortSignal }) => Promise<ElicitResult>,
  ): void {
    this.elicitForwarders.set(upstreamName, forwarder);
  }

  deactivateElicitation(upstreamName: string): void {
    this.elicitForwarders.delete(upstreamName);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.changeListeners.clear();
    await this.disconnectAll();
  }
}
