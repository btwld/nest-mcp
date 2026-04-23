import type { ToolMetadata } from './mcp-tool.interface';
import type { McpTransportType } from './mcp-transport.interface';

/**
 * Per-tool exposure override carried in tool decorator metadata.
 * Precedence: decorator > module strategy.
 * - `eager`    — always surface the full schema in `tools/list`.
 * - `deferred` — never surface the full schema; only reachable via the strategy-specific meta-tool.
 * - `auto`     — follow the module-level strategy (default).
 */
export type ToolExposure = 'eager' | 'deferred' | 'auto';

/**
 * A selector describes which tools are the "eager" subset under a strategy that
 * defers the long tail. All three forms are supported:
 * - list of exact tool names
 * - list of tags to match (inclusive OR)
 * - arbitrary predicate over tool metadata
 */
export type ToolSelector = string[] | { tags: string[] } | ((meta: ToolMetadata) => boolean);

export interface SearchStrategyOptions {
  kind: 'search';
  /** Anthropic Tool Search Tool variant. See the beta spec for details. */
  variant: 'regex' | 'bm25';
  eager?: ToolSelector;
  /** Behaviour when no tool resolves to eager. `throw` is the safe default. */
  onAllDeferred?: 'throw' | 'promoteFirst' | 'warn';
}

export interface LazyStrategyOptions {
  kind: 'lazy';
  eager?: ToolSelector;
  /** Name of the index meta-tool. Default: `list_available_tools`. */
  indexToolName?: string;
  /** Name of the schema-fetch meta-tool. Default: `get_tool_schema`. */
  schemaToolName?: string;
  /** Fields included in the index response. Default: name, description, tags. */
  indexFields?: Array<'name' | 'description' | 'tags'>;
  /** Maximum batch size for `get_tool_schema`. Default: 20. */
  maxBatchSize?: number;
  /**
   * When true, `tools/call` on a deferred tool whose schema has not been
   * fetched in this session is rejected. Default: false (advisory only).
   */
  requireDiscovery?: boolean;
}

export interface TypedApiStrategyOptions {
  kind: 'typed-api';
  eager?: ToolSelector;
  apiName?: string;
}

/**
 * Catalog-presentation strategy. Applied to `tools/list` responses; does not
 * change how `tools/call` executes.
 *
 * See `@nest-mcp/common` exposure-presets for the recommended factories.
 */
export type ExposureStrategy =
  | { kind: 'eager' }
  | SearchStrategyOptions
  | LazyStrategyOptions
  | TypedApiStrategyOptions;

/**
 * Minimal context a resolver sees when picking a strategy for an incoming
 * client. Populated by the transport layer before `tools/list` is handled.
 */
export interface ClientContext {
  /** MCP `clientInfo` from InitializeRequest, if known. */
  clientInfo?: { name: string; version: string };
  /** Model identifier if surfaced by the transport (best-effort, often absent). */
  model?: string;
  /** Values parsed from the `anthropic-beta` request header. */
  betaHeaders?: string[];
  transport: McpTransportType;
}

/**
 * Either a plain strategy or a function that picks one from client context.
 * The function form is how per-client tiering is expressed.
 */
export type ExposureStrategyResolver = (ctx: ClientContext) => ExposureStrategy;

/** Shape carried in `_meta.defer_loading` on deferred tool entries for `kind: 'search'`. */
export const META_DEFER_LOADING = 'defer_loading' as const;
