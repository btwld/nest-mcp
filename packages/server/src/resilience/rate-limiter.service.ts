import { Injectable, Logger } from '@nestjs/common';
import { McpError, MCP_RATE_LIMIT_EXCEEDED, type RateLimitConfig } from '@btwld/mcp-common';

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
    const windowMs = parseWindow(config.window);
    const now = Date.now();

    let entry = this.buckets.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, entry);
    }

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

function parseWindow(window: string): number {
  const match = window.match(/^(\d+)(s|m|h)$/);
  if (!match) throw new Error(`Invalid rate limit window: ${window}`);
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: return value * 1000;
  }
}
