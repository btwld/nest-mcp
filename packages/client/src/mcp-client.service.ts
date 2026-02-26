import { drainAllPages } from '@btwld/mcp-common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  CallToolRequest,
  CompleteRequest,
  GetPromptRequest,
  ListPromptsRequest,
  ListResourcesRequest,
  ListResourceTemplatesRequest,
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
      await this.client.connect(this.transport);
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
    return drainAllPages(async (cursor) => {
      const result = await this.client.listTools(cursor ? { cursor } : undefined, options);
      return { data: (result.tools ?? []) as Tool[], nextCursor: result.nextCursor };
    });
  }

  async listAllResources(options?: RequestOptions): Promise<Resource[]> {
    this.assertConnected();
    return drainAllPages(async (cursor) => {
      const result = await this.client.listResources(cursor ? { cursor } : undefined, options);
      return { data: (result.resources ?? []) as Resource[], nextCursor: result.nextCursor };
    });
  }

  async listAllResourceTemplates(options?: RequestOptions): Promise<ResourceTemplate[]> {
    this.assertConnected();
    return drainAllPages(async (cursor) => {
      const result = await this.client.listResourceTemplates(
        cursor ? { cursor } : undefined,
        options,
      );
      return {
        data: (result.resourceTemplates ?? []) as ResourceTemplate[],
        nextCursor: result.nextCursor,
      };
    });
  }

  async listAllPrompts(options?: RequestOptions): Promise<Prompt[]> {
    this.assertConnected();
    return drainAllPages(async (cursor) => {
      const result = await this.client.listPrompts(cursor ? { cursor } : undefined, options);
      return { data: (result.prompts ?? []) as Prompt[], nextCursor: result.nextCursor };
    });
  }

  async ping(options?: RequestOptions) {
    this.assertConnected();
    return this.client.ping(options);
  }

  async subscribeResource(params: SubscribeRequest['params'], options?: RequestOptions) {
    this.assertConnected();
    return this.client.subscribeResource(params, options);
  }

  async unsubscribeResource(params: UnsubscribeRequest['params'], options?: RequestOptions) {
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

  onNotification(
    method: string,
    handler: (notification: { method: string; params?: Record<string, unknown> }) => void | Promise<void>,
  ): void {
    this.assertConnected();
    // Access the internal notification handlers map directly because the SDK's
    // setNotificationHandler() requires a Zod schema with a literal method field,
    // which is not practical for arbitrary notification method strings.
    const protocol = this.client as unknown as {
      _notificationHandlers: Map<
        string,
        (notification: unknown) => Promise<void>
      >;
    };
    protocol._notificationHandlers.set(method, (notification) =>
      Promise.resolve(
        handler(notification as { method: string; params?: Record<string, unknown> }),
      ),
    );
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

      await this.sleep(delay * this.reconnectAttempts);

      try {
        this.client = new Client(
          { name: `nestjs-mcp-client-${this.name}`, version: '1.0.0' },
          { capabilities: {} },
        );
        this.transport = createClientTransport(this.connection);
        this.transport.onclose = () => this.handleDisconnect();
        this.transport.onerror = (err) => this.logger.error(`Transport error: ${err.message}`);

        await this.client.connect(this.transport);
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
