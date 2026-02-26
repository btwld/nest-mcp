import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  CallToolRequest,
  GetPromptRequest,
  ListPromptsRequest,
  ListResourcesRequest,
  ListToolsRequest,
  ReadResourceRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '@nestjs/common';
import type {
  McpClientConnection,
  McpClientReconnectOptions,
} from './interfaces/client-options.interface';
import { createClientTransport } from './transport/client-transport.factory';

export class McpClient {
  private readonly logger: Logger;
  private client: Client;
  private transport: Transport | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private reconnecting = false;

  constructor(
    readonly name: string,
    private readonly connection: McpClientConnection,
  ) {
    this.logger = new Logger(`McpClient[${name}]`);
    this.client = new Client(
      { name: `nestjs-mcp-client-${name}`, version: '1.0.0' },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    this.transport = createClientTransport(this.connection);
    this.transport.onclose = () => this.handleDisconnect();
    this.transport.onerror = (err) => this.logger.error(`Transport error: ${err.message}`);

    try {
      const connectPromise = this.client.connect(this.transport);
      const connectTimeout = this.connection.connectTimeout ?? 10_000;
      await this.withTimeout(connectPromise, connectTimeout);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.logger.log(`Connected to MCP server "${this.name}"`);
    } catch (err: unknown) {
      this.logger.error(
        `Failed to connect to "${this.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // ignore close errors
      }
      this.transport = null;
    }
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

  async getPrompt(params: GetPromptRequest['params'], options?: RequestOptions) {
    this.assertConnected();
    return this.client.getPrompt(params, options);
  }

  async listPrompts(params?: ListPromptsRequest['params'], options?: RequestOptions) {
    this.assertConnected();
    return this.client.listPrompts(params, options);
  }

  async ping(options?: RequestOptions) {
    this.assertConnected();
    return this.client.ping(options);
  }

  getServerCapabilities() {
    return this.client.getServerCapabilities();
  }

  getServerVersion() {
    return this.client.getServerVersion();
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error(`McpClient "${this.name}" is not connected`);
    }
  }

  private async handleDisconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.logger.warn(`Connection lost to "${this.name}"`);

    const reconnect = this.connection.reconnect;
    if (reconnect) {
      await this.attemptReconnect(reconnect);
    }
  }

  private async attemptReconnect(options: McpClientReconnectOptions): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    const maxAttempts = options.maxAttempts ?? 5;
    const delay = options.delay ?? 1000;

    while (this.reconnectAttempts < maxAttempts) {
      this.reconnectAttempts++;
      this.logger.log(
        `Reconnecting to "${this.name}" (attempt ${this.reconnectAttempts}/${maxAttempts})...`,
      );

      const backoff = Math.min(30_000, delay * 2 ** (this.reconnectAttempts - 1));
      await this.sleep(Math.random() * backoff);

      try {
        this.client = new Client(
          { name: `nestjs-mcp-client-${this.name}`, version: '1.0.0' },
          { capabilities: {} },
        );
        this.transport = createClientTransport(this.connection);
        this.transport.onclose = () => this.handleDisconnect();
        this.transport.onerror = (err) => this.logger.error(`Transport error: ${err.message}`);

        const reconnectTimeout = this.connection.connectTimeout ?? 10_000;
        await this.withTimeout(this.client.connect(this.transport), reconnectTimeout);
        this.connected = true;
        this.reconnectAttempts = 0;
        this.reconnecting = false;
        this.logger.log(`Reconnected to "${this.name}"`);
        return;
      } catch (err: unknown) {
        this.logger.warn(
          `Reconnection attempt ${this.reconnectAttempts} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.reconnecting = false;
    this.logger.error(`Failed to reconnect to "${this.name}" after ${maxAttempts} attempts`);
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Connection to "${this.name}" timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
