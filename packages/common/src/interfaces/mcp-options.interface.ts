import type { McpMiddleware } from './mcp-middleware.interface';
import type {
  CircuitBreakerConfig,
  RateLimitConfig,
  RetryConfig,
} from './mcp-resilience.interface';
import type { McpTransportType, TransportOptions } from './mcp-transport.interface';

export interface McpModuleOptions {
  name: string;
  version: string;
  description?: string;

  // Transport
  transport: McpTransportType;
  transportOptions?: TransportOptions;

  // Auth
  guards?: Array<abstract new (...args: unknown[]) => unknown>;
  allowUnauthenticatedAccess?: boolean;

  // Resilience (global defaults)
  resilience?: {
    rateLimit?: RateLimitConfig;
    retry?: RetryConfig;
    circuitBreaker?: CircuitBreakerConfig;
  };

  // Middleware (global)
  middleware?: McpMiddleware[];

  // Observability
  metrics?: {
    enabled?: boolean;
    endpoint?: string;
  };
  logging?: {
    level?: 'debug' | 'info' | 'warn' | 'error';
  };

  // Session
  session?: {
    timeout?: number;
    maxConcurrent?: number;
    cleanupInterval?: number;
  };

  // Capabilities
  capabilities?: {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
    prompts?: { listChanged?: boolean };
  };
}

export interface McpModuleAsyncOptions {
  imports?: unknown[];
  transport: McpTransportType;
  transportOptions?: TransportOptions;
  useFactory: (...args: unknown[]) => McpModuleOptions | Promise<McpModuleOptions>;
  inject?: unknown[];
}
