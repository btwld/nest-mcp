import { Inject, Injectable, Logger } from '@nestjs/common';
import type { McpClientConnection } from './interfaces/client-options.interface';
import { McpClient } from './mcp-client.service';

@Injectable()
export class McpClientsService {
  private readonly logger = new Logger('McpClientsService');
  // In-flight connects keyed by connection name, so concurrent addConnection/getOrCreate calls
  // for the same name share a single connect instead of racing to create duplicate clients.
  private readonly pending = new Map<string, Promise<McpClient>>();

  constructor(@Inject('MCP_CLIENT_CONNECTIONS') private readonly clients: McpClient[]) {}

  getClient(name: string): McpClient {
    const client = this.clients.find((c) => c.name === name);
    if (!client) {
      throw new Error(`McpClientsService: No client named "${name}" found.`);
    }
    return client;
  }

  getClients(): McpClient[] {
    return this.clients;
  }

  /** Whether a client is currently registered under `name` (regardless of connection state). */
  has(name: string): boolean {
    return this.clients.some((c) => c.name === name);
  }

  /**
   * Idempotently ensure a connected client for `connection.name`, creating and connecting one if
   * absent. This is the runtime counterpart to the static `connections` passed to
   * `McpClientModule.forRoot` — use it when upstreams are discovered at runtime (e.g. per-tenant
   * MCP servers registered by users).
   *
   * - If a client with that name exists and is connected, it is returned unchanged.
   * - If a client with that name exists but is disconnected, it is dropped and replaced with a
   *   fresh connection.
   * - Concurrent calls for the same name share a single connect.
   *
   * The new client is registered in the same collection as the static ones, so it is returned by
   * `getClient`/`getClients` and torn down on application shutdown. A client that fails to connect
   * is NOT registered (the rejection propagates).
   *
   * @throws the underlying connect error if the upstream cannot be reached.
   */
  async addConnection(connection: McpClientConnection): Promise<McpClient> {
    const existing = this.clients.find((c) => c.name === connection.name);
    if (existing?.isConnected()) return existing;

    const inFlight = this.pending.get(connection.name);
    if (inFlight) return inFlight;

    const promise = (async () => {
      // Replace a stale (disconnected) client with the same name before reconnecting fresh.
      if (existing) await this.removeConnection(connection.name);
      const client = new McpClient(connection.name, connection);
      await client.connect();
      this.clients.push(client);
      this.logger.log(`Registered runtime MCP client "${connection.name}"`);
      return client;
    })().finally(() => this.pending.delete(connection.name));

    this.pending.set(connection.name, promise);
    return promise;
  }

  /** Alias for {@link addConnection}: return the connected client for `connection`, creating it if needed. */
  getOrCreate(connection: McpClientConnection): Promise<McpClient> {
    return this.addConnection(connection);
  }

  /**
   * Disconnect and unregister every client registered under `name` (idempotent — a no-op if none
   * exist). Mutates the registered collection in place so existing `getClients()` references stay
   * valid.
   */
  async removeConnection(name: string): Promise<void> {
    const removed: McpClient[] = [];
    for (let i = this.clients.length - 1; i >= 0; i--) {
      if (this.clients[i].name === name) removed.push(...this.clients.splice(i, 1));
    }
    await Promise.all(
      removed.map((c) =>
        c
          .disconnect()
          .catch((e) => this.logger.warn(`Failed to disconnect "${name}": ${String(e)}`)),
      ),
    );
  }
}
