import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  TaskStatusNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ElicitResult as SdkElicitResult, Root } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitRequest, ElicitResult, McpSamplingParams, McpSamplingResult } from '@nest-mcp/common';
import { Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { McpRegistryService } from '@nest-mcp/server';
import type { UpstreamConfig, UpstreamStatus } from './upstream.interface';

interface ManagedUpstream {
  config: UpstreamConfig;
  client: Client;
  connected: boolean;
  healthy: boolean;
  lastHealthCheck?: Date;
  error?: string;
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
      return { role: result.role, content: result.content, model: result.model, stopReason: result.stopReason };
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

    const managed: ManagedUpstream = {
      config,
      client,
      connected: false,
      healthy: false,
    };

    this.upstreams.set(config.name, managed);

    // Forward task status notifications from the upstream to all downstream sessions.
    if (this.registry) {
      client.setNotificationHandler(TaskStatusNotificationSchema, (notification) => {
        const prefixed = {
          ...notification.params,
          taskId: `${upstreamName}::${notification.params.taskId}`,
        };
        this.registry!.broadcastNotification('notifications/tasks/status', prefixed as Record<string, unknown>);
      });
    }

    try {
      const transport = this.createTransport(config);
      await client.connect(transport);
      managed.connected = true;
      managed.healthy = true;
      managed.lastHealthCheck = new Date();
      const target = config.url ?? config.command ?? 'unknown';
      this.logger.log(`Connected to upstream "${config.name}" via ${config.transport} (${target})`);
    } catch (error) {
      managed.error = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to connect to upstream "${config.name}": ${managed.error}`);
    }
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
    await this.disconnectAll();
  }
}
