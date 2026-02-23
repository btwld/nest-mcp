import { ResponseCacheService } from './response-cache.service';

describe('ResponseCacheService', () => {
  let service: ResponseCacheService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new ResponseCacheService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  describe('configure', () => {
    it('should enable the cache', () => {
      service.configure({ enabled: true, defaultTtl: 5000 });

      service.set('key', 'value');
      expect(service.get('key')).toBe('value');
    });

    it('should not store entries when disabled', () => {
      service.configure({ enabled: false, defaultTtl: 5000 });

      service.set('key', 'value');
      expect(service.get('key')).toBeUndefined();
    });
  });

  describe('get / set', () => {
    beforeEach(() => {
      service.configure({ enabled: true, defaultTtl: 10000 });
    });

    it('should store and retrieve a value', () => {
      service.set('k1', { data: 42 });
      expect(service.get('k1')).toEqual({ data: 42 });
    });

    it('should return undefined for missing key', () => {
      expect(service.get('nonexistent')).toBeUndefined();
    });

    it('should return undefined for expired entries', () => {
      service.set('k1', 'val');

      vi.advanceTimersByTime(10001);

      expect(service.get('k1')).toBeUndefined();
    });

    it('should return value before expiration', () => {
      service.set('k1', 'val');

      vi.advanceTimersByTime(9999);

      expect(service.get('k1')).toBe('val');
    });
  });

  describe('buildKey', () => {
    it('should produce deterministic keys regardless of argument order', () => {
      const key1 = service.buildKey('tool', { b: 2, a: 1 });
      const key2 = service.buildKey('tool', { a: 1, b: 2 });

      expect(key1).toBe(key2);
    });

    it('should produce different keys for different tools', () => {
      const key1 = service.buildKey('tool1', { a: 1 });
      const key2 = service.buildKey('tool2', { a: 1 });

      expect(key1).not.toBe(key2);
    });
  });

  describe('invalidate', () => {
    beforeEach(() => {
      service.configure({ enabled: true, defaultTtl: 60000 });
    });

    it('should remove a specific key', () => {
      service.set('k1', 'v1');
      service.set('k2', 'v2');

      service.invalidate('k1');

      expect(service.get('k1')).toBeUndefined();
      expect(service.get('k2')).toBe('v2');
    });
  });

  describe('invalidateByPattern', () => {
    beforeEach(() => {
      service.configure({ enabled: true, defaultTtl: 60000 });
    });

    it('should remove keys matching a regex pattern', () => {
      service.set('gh_listRepos:{}', 'v1');
      service.set('gh_getRepo:{}', 'v2');
      service.set('sl_send:{}', 'v3');

      service.invalidateByPattern('^gh_');

      expect(service.get('gh_listRepos:{}')).toBeUndefined();
      expect(service.get('gh_getRepo:{}')).toBeUndefined();
      expect(service.get('sl_send:{}')).toBe('v3');
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      service.configure({ enabled: true, defaultTtl: 60000 });
      service.set('k1', 'v1');
      service.set('k2', 'v2');

      service.clear();

      expect(service.size).toBe(0);
    });
  });

  describe('maxSize eviction', () => {
    it('should evict oldest entry when maxSize is reached', () => {
      service.configure({ enabled: true, defaultTtl: 60000, maxSize: 2 });

      service.set('k1', 'v1');
      service.set('k2', 'v2');
      service.set('k3', 'v3');

      expect(service.get('k1')).toBeUndefined();
      expect(service.get('k2')).toBe('v2');
      expect(service.get('k3')).toBe('v3');
      expect(service.size).toBe(2);
    });
  });

  describe('custom TTL rules', () => {
    it('should use rule-based TTL when tool matches a rule pattern', () => {
      service.configure({
        enabled: true,
        defaultTtl: 60000,
        rules: [{ pattern: 'fast_*', ttl: 1000 }],
      });

      service.set('key', 'value', 'fast_query');

      vi.advanceTimersByTime(1001);

      expect(service.get('key')).toBeUndefined();
    });

    it('should use default TTL when no rule matches', () => {
      service.configure({
        enabled: true,
        defaultTtl: 60000,
        rules: [{ pattern: 'fast_*', ttl: 1000 }],
      });

      service.set('key', 'value', 'slow_query');

      vi.advanceTimersByTime(1001);

      expect(service.get('key')).toBe('value');
    });
  });

  describe('onModuleDestroy', () => {
    it('should clear the store and cleanup interval', () => {
      service.configure({ enabled: true, defaultTtl: 5000 });
      service.set('k1', 'v1');

      service.onModuleDestroy();

      expect(service.size).toBe(0);
    });
  });
});
