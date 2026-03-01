import { McpError } from '@nest-mcp/common';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  DEFAULT_CLEANUP_INTERVAL,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  DEFAULT_SESSION_TIMEOUT,
} from '../constants/module.constants';

export interface McpSession {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  metadata: Record<string, unknown>;
}

@Injectable()
export class SessionManager implements OnModuleDestroy {
  private readonly logger = new Logger(SessionManager.name);
  private readonly sessions = new Map<string, McpSession>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  private timeout = DEFAULT_SESSION_TIMEOUT;
  private maxConcurrent = DEFAULT_MAX_CONCURRENT_SESSIONS;

  configure(options: {
    timeout?: number;
    maxConcurrent?: number;
    cleanupInterval?: number;
  }): void {
    this.timeout = options.timeout ?? DEFAULT_SESSION_TIMEOUT;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SESSIONS;

    const interval = options.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL;
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.cleanupInterval = setInterval(() => this.cleanup(), interval);
  }

  createSession(id: string): McpSession {
    if (this.sessions.size >= this.maxConcurrent) {
      this.logger.warn(`Max concurrent sessions (${this.maxConcurrent}) reached`);
      this.cleanup(); // Force cleanup before rejecting
      if (this.sessions.size >= this.maxConcurrent) {
        throw new McpError(`Maximum concurrent sessions (${this.maxConcurrent}) exceeded`);
      }
    }

    const session: McpSession = {
      id,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      metadata: {},
    };

    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): McpSession | undefined {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActivityAt = Date.now();
    }
    return session;
  }

  removeSession(id: string): void {
    this.sessions.delete(id);
  }

  getActiveSessions(): number {
    return this.sessions.size;
  }

  private cleanup(): void {
    const now = Date.now();
    const sizeBefore = this.sessions.size;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > this.timeout) this.sessions.delete(id);
    }
    const cleaned = sizeBefore - this.sessions.size;
    if (cleaned > 0) {
      this.logger.log(`Cleaned up ${cleaned} expired sessions`);
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
  }
}
