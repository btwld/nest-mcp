import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';

export type OpenAPIDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

export interface BearerAuth {
  type: 'bearer';
  token: string | (() => string | Promise<string>);
}

export interface ApiKeyAuth {
  type: 'apiKey';
  in: 'header' | 'query';
  name: string;
  value: string | (() => string | Promise<string>);
}

export interface BasicAuth {
  type: 'basic';
  username: string;
  password: string;
}

export interface CustomAuth {
  type: 'custom';
  apply: (req: NormalizedRequest) => NormalizedRequest | Promise<NormalizedRequest>;
}

export interface NoAuth {
  type: 'none';
}

export type AuthConfig = BearerAuth | ApiKeyAuth | BasicAuth | CustomAuth | NoAuth;

export interface NormalizedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface OperationContext {
  operationId?: string;
  method: string;
  path: string;
  tags: string[];
  summary?: string;
  description?: string;
  sourceName?: string;
}

export interface SourceConfig {
  /**
   * Logical name for this OpenAPI source. Used as the namespace prefix for
   * tool names (`<name>.operationId`) and as the registry source tag
   * (`openapi:<name>`). Required when more than one source is mounted.
   */
  name?: string;
  /** Pre-loaded OpenAPI document. Mutually exclusive with the other inputs. */
  document?: OpenAPIDocument;
  /** Async factory; resolved once at boot. Mutually exclusive with `document`/`documentUrl`. */
  documentFactory?: () => OpenAPIDocument | Promise<OpenAPIDocument>;
  /** URL to fetch a JSON OpenAPI doc from. v1 supports JSON only — pre-bundle YAML. */
  documentUrl?: string;
  /** Required. Base URL for the upstream API (e.g., `https://api.example.com`). */
  baseUrl: string;
  /** Auth strategy for every outgoing call. Defaults to `none`. */
  auth?: AuthConfig;
  /**
   * Names of headers to forward from the inbound MCP request context to the
   * upstream API. Default: `[]`. The same allowlist is applied to every tool
   * call in this source.
   */
  forwardHeaders?: string[];
  /** Tag-based filters. `tagFilter` runs after include/exclude. */
  includeTags?: string[];
  excludeTags?: string[];
  tagFilter?: (op: OperationContext) => boolean;
  /** Override the default tool name (`<source>.<operationId>`). */
  nameFormatter?: (ctx: OperationContext) => string;
  /** Override the description used in `tools/list`. */
  descriptionFormatter?: (ctx: OperationContext) => string;
  /** Strip description and example fields from `tools/list` schemas. Default: false. */
  compactList?: boolean;
  /** Per-call timeout in milliseconds. Default: 30_000. */
  timeoutMs?: number;
  /** Redact request fields before any log/metric emission. */
  redact?: (req: NormalizedRequest) => NormalizedRequest;
}

export type OpenApiMcpOptions = SourceConfig | { sources: SourceConfig[] };

export function isMultiSource(options: OpenApiMcpOptions): options is { sources: SourceConfig[] } {
  return Array.isArray((options as { sources?: unknown }).sources);
}
