import type { ZodType } from 'zod';
import type { McpGuardClass } from './mcp-auth.interface';
import type { ToolExposure } from './mcp-exposure.interface';
import type { McpMiddleware } from './mcp-middleware.interface';
import type {
  CircuitBreakerConfig,
  RateLimitConfig,
  RetryConfig,
} from './mcp-resilience.interface';

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  /** Hint that this tool emits incremental content via streamContent (FastMCP convention). */
  streamingHint?: boolean;
}

export interface Icon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}

export interface ToolExecution {
  taskSupport?: 'forbidden' | 'optional' | 'required';
}

export interface ToolOptions {
  name?: string;
  /** Human-readable display title for the tool (distinct from the machine name). */
  title?: string;
  description: string;
  parameters?: ZodType;
  outputSchema?: ZodType;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  execution?: ToolExecution;
  _meta?: Record<string, unknown>;
  /**
   * Free-form labels used by selectors in {@link ExposureStrategy} (e.g.
   * `eager: { tags: ['core'] }`). Not transmitted over the wire.
   */
  tags?: string[];
  /**
   * Per-tool override for catalog presentation:
   * - `eager` keeps this tool's full schema in `tools/list` even when the module defers the rest.
   * - `deferred` removes this tool from the initial `tools/list` regardless of module strategy.
   * - `auto` (default) follows the module strategy.
   */
  exposure?: ToolExposure;
}

export interface ToolMetadata {
  name: string;
  /** Human-readable display title for the tool (distinct from the machine name). */
  title?: string;
  description: string;
  parameters?: ZodType;
  inputSchema?: Record<string, unknown>;
  outputSchema?: ZodType;
  /** Raw JSON schema for output — used when no Zod outputSchema is available (e.g. gateway-proxied tools). */
  rawOutputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  execution?: ToolExecution;
  _meta?: Record<string, unknown>;
  // Auth
  isPublic?: boolean;
  requiredScopes?: string[];
  requiredRoles?: string[];
  guards?: McpGuardClass[];
  // Resilience
  timeout?: number;
  rateLimit?: RateLimitConfig;
  retry?: RetryConfig;
  circuitBreaker?: CircuitBreakerConfig;
  // Middleware
  middleware?: McpMiddleware[];
  // Exposure
  tags?: string[];
  exposure?: ToolExposure;
  // Internal
  methodName: string;
  target: abstract new (...args: unknown[]) => unknown;
}

export interface ToolCallResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ResourceLink {
  type: 'resource_link';
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  annotations?: ContentAnnotations;
}

export type ToolContent =
  | TextContent
  | ImageContent
  | AudioContent
  | EmbeddedResource
  | ResourceLink;

export interface TextContent {
  type: 'text';
  text: string;
  annotations?: ContentAnnotations;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
  annotations?: ContentAnnotations;
}

export interface AudioContent {
  type: 'audio';
  data: string;
  mimeType: string;
  annotations?: ContentAnnotations;
}

export interface EmbeddedResource {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
  annotations?: ContentAnnotations;
}

export interface ContentAnnotations {
  audience?: Array<'user' | 'assistant'>;
  priority?: number;
}
