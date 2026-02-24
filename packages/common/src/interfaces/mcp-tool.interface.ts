import type { ZodType } from 'zod';
import type { RateLimitConfig, RetryConfig, CircuitBreakerConfig } from './mcp-resilience.interface';
import type { McpMiddleware } from './mcp-middleware.interface';

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolOptions {
  name?: string;
  description: string;
  parameters?: ZodType;
  outputSchema?: ZodType;
  annotations?: ToolAnnotations;
}

export interface ToolMetadata {
  name: string;
  description: string;
  parameters?: ZodType;
  inputSchema?: Record<string, unknown>;
  outputSchema?: ZodType;
  annotations?: ToolAnnotations;
  // Auth
  isPublic?: boolean;
  requiredScopes?: string[];
  requiredRoles?: string[];
  guards?: Function[];
  // Resilience
  rateLimit?: RateLimitConfig;
  retry?: RetryConfig;
  circuitBreaker?: CircuitBreakerConfig;
  // Middleware
  middleware?: McpMiddleware[];
  // Internal
  methodName: string;
  target: Function;
}

export interface ToolCallResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type ToolContent =
  | TextContent
  | ImageContent
  | AudioContent
  | EmbeddedResource;

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
