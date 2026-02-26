import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Tracks per-session resource subscriptions and dispatches
 * `notifications/resources/updated` to subscribed clients.
 */
@Injectable()
export class ResourceSubscriptionManager {
  private readonly logger = new Logger(ResourceSubscriptionManager.name);

  /** uri -> Map<sessionId, McpServer> */
  private readonly subscriptions = new Map<string, Map<string, McpServer>>();

  subscribe(sessionId: string, uri: string, server: McpServer): void {
    let sessions = this.subscriptions.get(uri);
    if (!sessions) {
      sessions = new Map();
      this.subscriptions.set(uri, sessions);
    }
    sessions.set(sessionId, server);
    this.logger.debug(`Session ${sessionId} subscribed to ${uri}`);
  }

  unsubscribe(sessionId: string, uri: string): boolean {
    const sessions = this.subscriptions.get(uri);
    if (!sessions) return false;
    const deleted = sessions.delete(sessionId);
    if (sessions.size === 0) {
      this.subscriptions.delete(uri);
    }
    if (deleted) {
      this.logger.debug(`Session ${sessionId} unsubscribed from ${uri}`);
    }
    return deleted;
  }

  /** Remove all subscriptions for a session (call on session close). */
  removeSession(sessionId: string): void {
    for (const [uri, sessions] of this.subscriptions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) {
        this.subscriptions.delete(uri);
      }
    }
  }

  /** Notify all sessions subscribed to the given URI that the resource has been updated. */
  async notifyResourceUpdated(uri: string): Promise<void> {
    const sessions = this.subscriptions.get(uri);
    if (!sessions || sessions.size === 0) return;

    const promises: Promise<void>[] = [];
    for (const [sessionId, server] of sessions) {
      promises.push(
        server.server.sendResourceUpdated({ uri }).catch((error) => {
          this.logger.warn(
            `Failed to notify session ${sessionId} about resource update for ${uri}: ${error}`,
          );
        }),
      );
    }
    await Promise.all(promises);
  }
}
