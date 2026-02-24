import type { McpTransportType, TransportOptions } from './mcp-transport.interface';
import type { RateLimitConfig, RetryConfig, CircuitBreakerConfig } from './mcp-resilience.interface';
import type { McpMiddleware } from './mcp-middleware.interface';

export interface McpModuleOptions {
  name: string;
  version: string;
  description?: string;

  // Transport
  transport: McpTransportType;
  transportOptions?: TransportOptions;

  // Auth
  guards?: Function[];
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
  imports?: any[];
  transport: McpTransportType;
  transportOptions?: TransportOptions;
  useFactory: (...args: any[]) => McpModuleOptions | Promise<McpModuleOptions>;
  inject?: any[];
}
