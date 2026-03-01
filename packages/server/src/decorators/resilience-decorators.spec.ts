import 'reflect-metadata';
import {
  MCP_CIRCUIT_BREAKER_METADATA,
  MCP_MIDDLEWARE_METADATA,
  MCP_RATE_LIMIT_METADATA,
  MCP_RETRY_METADATA,
  MCP_TIMEOUT_METADATA,
} from '@nest-mcp/common';
import type { McpMiddleware } from '@nest-mcp/common';
import { CircuitBreaker } from './circuit-breaker.decorator';
import { RateLimit } from './rate-limit.decorator';
import { Retry } from './retry.decorator';
import { Timeout } from './timeout.decorator';
import { UseMiddleware } from './use-middleware.decorator';

describe('Resilience decorators', () => {
  describe('@UseMiddleware', () => {
    it('stores middleware array and preserves order', () => {
      const mw1: McpMiddleware = async (_ctx, _args, next) => next();
      const mw2: McpMiddleware = async (_ctx, _args, next) => next();
      const mw3: McpMiddleware = async (_ctx, _args, next) => next();

      class TestService {
        @UseMiddleware(mw1, mw2, mw3)
        myMethod() {
          return 'ok';
        }
      }

      const value = Reflect.getMetadata(MCP_MIDDLEWARE_METADATA, TestService.prototype, 'myMethod');

      expect(value).toHaveLength(3);
      expect(value[0]).toBe(mw1);
      expect(value[1]).toBe(mw2);
      expect(value[2]).toBe(mw3);
    });
  });

  describe('@RateLimit', () => {
    it('stores RateLimitConfig with max, window, and perUser', () => {
      class TestService {
        @RateLimit({ max: 100, window: '1m', perUser: true })
        rateLimited() {
          return 'ok';
        }
      }

      const config = Reflect.getMetadata(
        MCP_RATE_LIMIT_METADATA,
        TestService.prototype,
        'rateLimited',
      );

      expect(config).toEqual({ max: 100, window: '1m', perUser: true });
    });
  });

  describe('@Retry', () => {
    it('stores RetryConfig with maxAttempts, backoff, initialDelay, maxDelay', () => {
      class TestService {
        @Retry({
          maxAttempts: 3,
          backoff: 'exponential',
          initialDelay: 100,
          maxDelay: 5000,
        })
        retryable() {
          return 'ok';
        }
      }

      const config = Reflect.getMetadata(MCP_RETRY_METADATA, TestService.prototype, 'retryable');

      expect(config).toEqual({
        maxAttempts: 3,
        backoff: 'exponential',
        initialDelay: 100,
        maxDelay: 5000,
      });
    });
  });

  describe('@CircuitBreaker', () => {
    it('stores CircuitBreakerConfig with errorThreshold, timeWindow, minRequests, halfOpenTimeout', () => {
      class TestService {
        @CircuitBreaker({
          errorThreshold: 5,
          timeWindow: 60000,
          minRequests: 10,
          halfOpenTimeout: 30000,
        })
        breakable() {
          return 'ok';
        }
      }

      const config = Reflect.getMetadata(
        MCP_CIRCUIT_BREAKER_METADATA,
        TestService.prototype,
        'breakable',
      );

      expect(config).toEqual({
        errorThreshold: 5,
        timeWindow: 60000,
        minRequests: 10,
        halfOpenTimeout: 30000,
      });
    });
  });

  describe('@Timeout', () => {
    it('stores timeout value in milliseconds', () => {
      class TestService {
        @Timeout(5000)
        slowMethod() {
          return 'ok';
        }
      }

      const value = Reflect.getMetadata(MCP_TIMEOUT_METADATA, TestService.prototype, 'slowMethod');

      expect(value).toBe(5000);
    });

    it('does not affect other methods on same class', () => {
      class TestService {
        @Timeout(1000)
        timed() {
          return 'ok';
        }

        untimed() {
          return 'ok';
        }
      }

      expect(
        Reflect.getMetadata(MCP_TIMEOUT_METADATA, TestService.prototype, 'untimed'),
      ).toBeUndefined();
    });
  });

  describe('decorator isolation', () => {
    it('@UseMiddleware with a single middleware', () => {
      const mw: McpMiddleware = async (_ctx, _args, next) => next();

      class TestService {
        @UseMiddleware(mw)
        singleMw() {
          return 'ok';
        }
      }

      const value = Reflect.getMetadata(MCP_MIDDLEWARE_METADATA, TestService.prototype, 'singleMw');
      expect(value).toHaveLength(1);
      expect(value[0]).toBe(mw);
    });

    it('@Retry with minimal config', () => {
      class TestService {
        @Retry({ maxAttempts: 1, backoff: 'linear', initialDelay: 50 })
        minimal() {
          return 'ok';
        }
      }

      const config = Reflect.getMetadata(MCP_RETRY_METADATA, TestService.prototype, 'minimal');
      expect(config.maxAttempts).toBe(1);
      expect(config.backoff).toBe('linear');
    });

    it('@RateLimit without perUser defaults to undefined', () => {
      class TestService {
        @RateLimit({ max: 10, window: '30s' })
        limited() {
          return 'ok';
        }
      }

      const config = Reflect.getMetadata(MCP_RATE_LIMIT_METADATA, TestService.prototype, 'limited');
      expect(config.max).toBe(10);
      expect(config.window).toBe('30s');
      expect(config.perUser).toBeUndefined();
    });

    it('@CircuitBreaker does not affect other methods', () => {
      class TestService {
        @CircuitBreaker({ errorThreshold: 3, timeWindow: 30000 })
        breaker() {
          return 'ok';
        }

        normal() {
          return 'ok';
        }
      }

      expect(
        Reflect.getMetadata(MCP_CIRCUIT_BREAKER_METADATA, TestService.prototype, 'normal'),
      ).toBeUndefined();
    });
  });
});
