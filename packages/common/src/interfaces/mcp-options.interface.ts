import type { LogLevel } from '@nestjs/common';
import type { McpGuardClass } from './mcp-auth.interface';
import type { ExposureStrategy, ExposureStrategyResolver } from './mcp-exposure.interface';
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
  transport: McpTransportType | McpTransportType[];
  transportOptions?: TransportOptions;

  // Auth
  guards?: McpGuardClass[];
  allowUnauthenticatedAccess?: boolean;

  // Resilience (global defaults)
  resilience?: {
    timeout?: number;
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
  /**
   * Log-level filtering for STDIO transport.
   *
   * - `LogLevel[]` — only these levels are emitted (e.g. `['error', 'warn']`).
   * - `false` — suppresses all logging.
   *
   * For HTTP transports, use the standard NestJS `app.useLogger()` at bootstrap.
   * This option is consumed automatically by `bootstrapStdioApp()` as a fallback
   * when `StdioBootstrapOptions.logLevels` is not explicitly provided.
   */
  logging?: false | LogLevel[];

  // Session
  session?: {
    timeout?: number;
    maxConcurrent?: number;
    cleanupInterval?: number;
  };

  // Pagination
  pagination?: {
    defaultPageSize?: number;
  };

  // Capabilities
  capabilities?: {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
    prompts?: { listChanged?: boolean };
    tasks?: { enabled?: boolean };
    /** Vendor-specific experimental capability flags passed verbatim to the SDK. */
    experimental?: Record<string, unknown>;
  };

  /**
   * Catalog-presentation strategy. Controls how `tools/list` surfaces tools
   * to clients (eager, deferred behind a search meta-tool, or on-demand via
   * a lazy index). Per-client tiering is expressed by passing a resolver
   * function instead of a static strategy. Defaults to `{ kind: 'eager' }`.
   */
  exposure?: ExposureStrategy | ExposureStrategyResolver;
}

export interface McpModuleAsyncOptions {
  // biome-ignore lint/suspicious/noExplicitAny: NestJS DynamicModule requires broad module types
  imports?: any[];
  transport: McpTransportType | McpTransportType[];
  transportOptions?: TransportOptions;
  // biome-ignore lint/suspicious/noExplicitAny: NestJS factory pattern requires broad parameter types
  useFactory: (...args: any[]) => McpModuleOptions | Promise<McpModuleOptions>;
  // biome-ignore lint/suspicious/noExplicitAny: NestJS injection tokens have broad types
  inject?: any[];
}
