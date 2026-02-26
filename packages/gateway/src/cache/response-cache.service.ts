import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { matchGlobPattern } from '../utils/pattern-matcher';
import type { CacheConfig, CacheEntry, CacheRule } from './cache.interface';

@Injectable()
export class ResponseCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(ResponseCacheService.name);
  private readonly store = new Map<string, CacheEntry>();
  private enabled = false;
  private defaultTtl = 60000;
  private maxSize = 1000;
  private rules: CacheRule[] = [];
  private cleanupInterval?: ReturnType<typeof setInterval>;

  configure(config: CacheConfig): void {
    this.enabled = config.enabled;
    this.defaultTtl = config.defaultTtl;
    this.maxSize = config.maxSize ?? 1000;
    this.rules = config.rules ?? [];

    if (this.enabled) {
      this.cleanupInterval = setInterval(() => this.evictExpired(), this.defaultTtl);
      this.logger.log(`Cache enabled: ttl=${this.defaultTtl}ms, maxSize=${this.maxSize}`);
    }
  }

  get<T>(key: string): T | undefined {
    if (!this.enabled) return undefined;

    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T, toolName?: string): void {
    if (!this.enabled) return;

    if (this.store.size >= this.maxSize) {
      this.evictOldest();
    }

    const ttl = toolName ? this.getTtlForTool(toolName) : this.defaultTtl;

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
  }

  buildKey(toolName: string, args: Record<string, unknown>): string {
    const sortedArgs = JSON.stringify(args, Object.keys(args).sort());
    return `${toolName}:${sortedArgs}`;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidateByPattern(pattern: string): void {
    const regex = new RegExp(pattern);
    for (const key of this.store.keys()) {
      if (regex.test(key)) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  private getTtlForTool(toolName: string): number {
    for (const rule of this.rules) {
      if (matchGlobPattern(toolName, rule.pattern)) {
        return rule.ttl;
      }
    }
    return this.defaultTtl;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  private evictOldest(): void {
    const firstKey = this.store.keys().next().value;
    if (firstKey !== undefined) {
      this.store.delete(firstKey);
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
  }
}
