export interface CacheRule {
  pattern: string;
  ttl: number;
}

export interface CacheConfig {
  enabled: boolean;
  defaultTtl: number;
  maxSize?: number;
  rules?: CacheRule[];
}

export interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
}
