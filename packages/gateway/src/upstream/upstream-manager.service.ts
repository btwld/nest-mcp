import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
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

  async connectAll(configs: UpstreamConfig[]): Promise<void> {
    const enabled = configs.filter((c) => c.enabled !== false);
    await Promise.all(enabled.map((config) => this.connect(config)));
  }

  async connect(config: UpstreamConfig): Promise<void> {
    if (this.upstreams.has(config.name)) {
      this.logger.warn(`Upstream "${config.name}" already connected, skipping`);
      return;
    }

    const client = new Client(
      { name: `gateway-to-${config.name}`, version: '1.0.0' },
      { capabilities: {} },
    );

    const managed: ManagedUpstream = {
      config,
      client,
      connected: false,
      healthy: false,
    };

    this.upstreams.set(config.name, managed);

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

  async onModuleDestroy(): Promise<void> {
    await this.disconnectAll();
  }
}
