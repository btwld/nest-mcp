import type { MaybePromise } from "@nest-mcp/core";
import type { McpServerBuildContext, McpServerPrincipal } from "@nest-mcp/server";
import type { Tool } from "@modelcontextprotocol/server";

export const MCP_CATALOG_SEARCH_TOOL_NAME = "nest-mcp.catalog.search";
export const MCP_CATALOG_SCHEMAS_TOOL_NAME = "nest-mcp.catalog.schemas";

export type McpCatalogExposureKind = "eager" | "search" | "lazy";

/** Recursive readonly view used for detached catalog values. */
export type McpCatalogReadonly<Value> = Value extends readonly unknown[]
	? { readonly [Index in keyof Value]: McpCatalogReadonly<Value[Index]> }
	: Value extends object
		? { readonly [Key in keyof Value]: McpCatalogReadonly<Value[Key]> }
		: Value;

/** A detached, deeply frozen public projection of one visible SDK tool. */
export interface McpCatalogTool {
	readonly tool: McpCatalogReadonly<Tool>;
	readonly tags: readonly string[];
}

export interface McpCatalogNameSelector {
	readonly kind: "name";
	readonly name: string;
}

export interface McpCatalogTagSelector {
	readonly kind: "tag";
	readonly tag: string;
}

export interface McpCatalogPredicateSelector {
	readonly kind: "predicate";
	readonly predicate: (tool: McpCatalogTool) => boolean;
}

export type McpCatalogToolSelector =
	McpCatalogNameSelector | McpCatalogTagSelector | McpCatalogPredicateSelector;

export interface McpCatalogEagerExposure {
	readonly kind: "eager";
}

export interface McpCatalogSearchExposure {
	readonly kind: "search";
	/** Selectors for tools advertised eagerly. Every other visible tool receives deferredMetadata. */
	readonly eager?: readonly McpCatalogToolSelector[];
	/** Explicit vendor-specific marker merged into deferred tools' existing `_meta`. */
	readonly deferredMetadata: Readonly<Record<string, unknown>>;
}

export interface McpCatalogLazyExposure {
	readonly kind: "lazy";
	/** Selectors for ordinary tools included in `tools/list` beside the bounded meta-tools. */
	readonly eager?: readonly McpCatalogToolSelector[];
}

export type McpCatalogExposureStrategy<
	Kind extends McpCatalogExposureKind = McpCatalogExposureKind,
> = Extract<
	McpCatalogEagerExposure | McpCatalogSearchExposure | McpCatalogLazyExposure,
	{ readonly kind: Kind }
>;

/** Deliberately omits raw auth info, requests, callbacks, policies and registry definitions. */
export interface McpCatalogExposureResolverInput {
	readonly runtimeName: string;
	readonly era: McpServerBuildContext["era"];
	readonly principal?: Readonly<McpServerPrincipal>;
	readonly signal?: AbortSignal;
	readonly tools: readonly McpCatalogTool[];
}

export type McpCatalogExposureResolver<
	Strategy extends McpCatalogExposureStrategy = McpCatalogExposureStrategy,
> = (input: McpCatalogExposureResolverInput) => MaybePromise<Strategy>;

/** Injectable Nest policy that selects the catalog projection for one serving unit. */
export interface McpCatalogExposurePolicy<
	Strategy extends McpCatalogExposureStrategy = McpCatalogExposureStrategy,
> {
	resolve(input: McpCatalogExposureResolverInput): MaybePromise<Strategy>;
}

/** Framework-internal callback adapter. Nest applications configure a policy provider token. */
export interface McpCatalogExposureOptions {
	readonly resolver: McpCatalogExposureResolver;
}

export interface McpCatalogSearchResultTool {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly tags: readonly string[];
}

export interface McpCatalogSearchResult {
	readonly tools: readonly McpCatalogSearchResultTool[];
	readonly nextCursor?: string;
}

export interface McpCatalogSchemasResult {
	readonly tools: readonly McpCatalogReadonly<Tool>[];
}
