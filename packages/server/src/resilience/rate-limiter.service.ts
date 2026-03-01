import {
  MCP_RATE_LIMIT_EXCEEDED,
  McpError,
  type RateLimitConfig,
  parseDurationMs,
} from '@nest-mcp/common';
import { Injectable, Logger } from '@nestjs/common';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly buckets = new Map<string, RateLimitEntry>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  async checkLimit(toolName: string, config: RateLimitConfig, userId?: string): Promise<void> {
    const key = config.perUser && userId ? `${toolName}:${userId}` : toolName;
    const windowMs = parseDurationMs(config.window, 1_000);
    const now = Date.now();

    const entry = this.getOrCreateEntry(key, windowMs);
    entry.count++;

    if (entry.count > config.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      throw new McpError(
        `Rate limit exceeded for '${toolName}'. Retry after ${retryAfter}s`,
        MCP_RATE_LIMIT_EXCEEDED,
        { retryAfter },
      );
    }
  }

  private getOrCreateEntry(key: string, windowMs: number): RateLimitEntry {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (existing && now < existing.resetAt) return existing;
    const entry: RateLimitEntry = { count: 0, resetAt: now + windowMs };
    this.buckets.set(key, entry);
    return entry;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.buckets) {
      if (now >= entry.resetAt) {
        this.buckets.delete(key);
      }
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
