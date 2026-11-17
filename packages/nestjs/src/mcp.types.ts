import type {
	MaybePromise,
	McpAuthorizationPolicy,
	McpLifecycleObserver,
	McpOperationContext,
	McpOperationMiddleware,
	McpPassthroughMiddleware,
} from "@nest-mcp/core";
import type {
	CallToolResult,
	GetPromptResult,
	InputRequiredResult,
	McpServer,
	McpServerBuildContext,
	McpServerDefinition,
	McpServerMiddleware,
	McpServerOperationContext,
	McpServerPrincipal,
	McpServerPrincipalClaimsResolver,
	McpServerRuntimeEvent,
	ReadResourceResult,
} from "@nest-mcp/server";
import type { McpNestServerOAuthOptions } from "./oauth/mcp-oauth.types.ts";
import type { ModuleMetadata } from "@nestjs/common";
import type {
	McpGatewayAuthorizationContextResolver,
	McpGatewayClientResolver,
	McpGatewayDiscoveryCache,
	McpGatewayLifecycleObserver,
	McpGatewayMiddleware,
	McpGatewayNameCodec,
	McpGatewayOptions,
	McpGatewayPolicy,
	McpGatewayPromptNameCodec,
	McpGatewayResourceTemplateUriCodec,
	McpGatewayResourceUriCodec,
} from "@nest-mcp/gateway";
import type { McpCatalogExposurePolicy } from "./mcp-catalog-exposure.ts";
import type { McpNestCollaborators, McpProviderToken } from "./mcp-provider.types.ts";
import type { McpNestServerHttpOptions, McpNestServerOptions } from "./server/mcp-server.types.ts";

export interface McpHandlerInvocationInput {
	readonly kind: "tool" | "resource" | "prompt";
	readonly name: string;
	readonly serverName: string;
	readonly source: string;
	/** Validated callback arguments, excluding the official SDK handler context. */
	readonly arguments: readonly unknown[];
}

export type McpHandlerOperationContext = McpOperationContext<McpServerPrincipal>;
export type McpHandlerInvocationOutputMap = Readonly<{
	tool: CallToolResult | InputRequiredResult;
	resource: ReadResourceResult;
	prompt: GetPromptResult | InputRequiredResult;
}>;
export type McpHandlerInvocationOutputFor<Input extends McpHandlerInvocationInput> =
	McpHandlerInvocationOutputMap[Input["kind"]];
export type McpHandlerInvocationOutput = McpHandlerInvocationOutputFor<McpHandlerInvocationInput>;
export type McpHandlerMiddleware = McpOperationMiddleware<
	McpHandlerInvocationInput,
	McpHandlerInvocationOutput,
	McpHandlerOperationContext
>;
export type McpHandlerPassthroughMiddleware = McpPassthroughMiddleware<
	McpHandlerInvocationInput,
	McpHandlerOperationContext
>;
export type McpHandlerAuthorizationPolicy = McpAuthorizationPolicy<
	McpHandlerInvocationInput,
	McpHandlerOperationContext
>;
export type McpHandlerLifecycleObserver = McpLifecycleObserver<McpHandlerOperationContext>;

export interface McpHandlerMiddlewareProvider {
	handle: McpHandlerMiddleware;
}

export interface McpServerMiddlewareProvider {
	handle: McpServerMiddleware;
}

export type McpServerLifecycleObserver = McpLifecycleObserver<McpServerOperationContext>;

export interface McpServerPrincipalClaimsProvider {
	resolvePrincipalClaims: McpServerPrincipalClaimsResolver;
}

export interface McpServerRuntimeObserverProvider {
	observe(event: McpServerRuntimeEvent): MaybePromise<void>;
}

export interface McpServerErrorReporter {
	report(error: Error): MaybePromise<void>;
}

/** Nest provider that contributes low-level capabilities to one configured server. */
export interface McpServerContributor {
	contribute(server: McpServer, context: McpServerBuildContext): MaybePromise<void>;
}

export interface McpNestGatewayUpstream {
	/** Name of a client configured in the imported `McpClientModule`. */
	readonly clientName: string;
	/** Optional public namespace exposed by the aggregate gateway. */
	readonly gatewayName?: string;
}

/** Nest provider that selects an authorization-isolated gateway client per request. */
export interface McpGatewayClientProvider {
	resolveClient: McpGatewayClientResolver;
}

/** Context-aware upstream whose client selection is owned by a Nest provider. */
export interface McpNestGatewayProviderUpstream {
	readonly name: string;
	readonly clientProvider: McpProviderToken<McpGatewayClientProvider>;
}

export type McpNestGatewayUpstreamDefinition =
	string | McpNestGatewayUpstream | McpNestGatewayProviderUpstream;

export interface McpGatewayNameCodecProvider extends McpGatewayNameCodec {}

export interface McpGatewayPromptNameCodecProvider extends McpGatewayPromptNameCodec {}

export interface McpGatewayResourceUriCodecProvider extends McpGatewayResourceUriCodec {}

export interface McpGatewayResourceTemplateUriCodecProvider extends McpGatewayResourceTemplateUriCodec {}

export interface McpGatewayDiscoveryCacheProvider extends McpGatewayDiscoveryCache {}

export interface McpGatewayAuthorizationContextProvider {
	resolveAuthorizationContext: McpGatewayAuthorizationContextResolver;
}

export interface McpGatewayMiddlewareProvider {
	handle: McpGatewayMiddleware;
}

export interface McpGatewayLifecycleObserverProvider extends McpGatewayLifecycleObserver {}

export interface McpGatewayObserverErrorReporter {
	report(error: unknown): MaybePromise<void>;
}

/** Gateway options resolved against Nest-owned clients and an injectable policy. */
export interface McpNestGatewayOptions extends Omit<
	McpGatewayOptions,
	| "authorizationContextResolver"
	| "discoveryCache"
	| "lifecycleObserver"
	| "middleware"
	| "nameCodec"
	| "onObserverError"
	| "policy"
	| "promptNameCodec"
	| "resourceTemplateNameCodec"
	| "resourceTemplateUriCodec"
	| "resourceUriCodec"
	| "upstreams"
> {
	/** Compose gateway tools with local handlers on one server. Other gateway capabilities stay private. */
	readonly composition?: "tools";
	readonly upstreams: readonly McpNestGatewayUpstreamDefinition[];
	readonly policy: McpProviderToken<McpGatewayPolicy>;
	readonly nameCodec?: McpProviderToken<McpGatewayNameCodecProvider>;
	readonly promptNameCodec?: McpProviderToken<McpGatewayPromptNameCodecProvider>;
	readonly resourceUriCodec?: McpProviderToken<McpGatewayResourceUriCodecProvider>;
	readonly resourceTemplateUriCodec?: McpProviderToken<McpGatewayResourceTemplateUriCodecProvider>;
	readonly resourceTemplateNameCodec?: McpProviderToken<McpGatewayNameCodecProvider>;
	readonly discoveryCache?: McpProviderToken<McpGatewayDiscoveryCacheProvider>;
	readonly authorizationContextResolver?: McpProviderToken<McpGatewayAuthorizationContextProvider>;
	readonly middleware?: readonly McpProviderToken<McpGatewayMiddlewareProvider>[];
	readonly lifecycleObserver?: McpProviderToken<McpGatewayLifecycleObserverProvider>;
	readonly onObserverError?: McpProviderToken<McpGatewayObserverErrorReporter>;
}

export interface McpNestCatalogExposureOptions {
	/** Singleton Nest provider that selects the projection for each serving unit. */
	readonly policy: McpProviderToken<McpCatalogExposurePolicy>;
}

/** Nest-owned server configuration. Raw feature callbacks remain in `@nest-mcp/server`. */
export interface McpNestServerDefinition extends Omit<
	McpServerDefinition,
	| "features"
	| "http"
	| "lifecycleObserver"
	| "middleware"
	| "observer"
	| "onError"
	| "principalClaims"
	| "serverOptions"
> {
	readonly serverOptions?: McpNestServerOptions;
	readonly http?: McpNestServerHttpOptions;
	/** Injectable low-level contributors resolved once during application bootstrap. */
	readonly contributors?: readonly McpProviderToken<McpServerContributor>[];
	/** Injectable projection of verified provider claims onto the safe MCP principal. */
	readonly principalClaims?: McpProviderToken<McpServerPrincipalClaimsProvider>;
	/** Injectable HTTP-exchange middleware providers. */
	readonly middleware?: readonly McpProviderToken<McpServerMiddlewareProvider>[];
	readonly lifecycleObserver?: McpProviderToken<McpServerLifecycleObserver>;
	readonly observer?: McpProviderToken<McpServerRuntimeObserverProvider>;
	readonly onError?: McpProviderToken<McpServerErrorReporter>;
	/** Runs before custom handler middleware and cannot be bypassed by short-circuit middleware. */
	readonly handlerAuthorization?: McpProviderToken<McpHandlerAuthorizationPolicy>;
	readonly handlerMiddleware?: readonly McpProviderToken<McpHandlerMiddlewareProvider>[];
	/** Payload-free lifecycle events for validated tool/resource/prompt invocations. */
	readonly handlerLifecycleObserver?: McpProviderToken<McpHandlerLifecycleObserver>;
	/** Maximum duration of one per-request capability visibility wave. Defaults to 30 seconds. */
	readonly handlerVisibilityTimeoutMs?: number;
	/** Optional authorization-safe projection of the post-visibility tool catalog. */
	readonly catalogExposure?: McpNestCatalogExposureOptions;
	/** Optional aggregate gateway backed by clients owned by this Nest module. */
	readonly gateway?: McpNestGatewayOptions;
	/** Optional OAuth resource-server protection composed around the HTTP handler. */
	readonly oauth?: McpNestServerOAuthOptions;
}

export interface McpModuleOptions {
	/** Server runtimes compiled at application bootstrap. */
	readonly servers?: readonly McpNestServerDefinition[];
	/** Discover decorated Nest providers and attach them to matching servers. Defaults to true. */
	readonly autoDiscover?: boolean;
}

export interface McpModuleExtras {
	/** Static Nest routes generated at module registration, outside an async useFactory. */
	readonly httpRoutes?: readonly import("./http/mcp-http-route.types.ts").McpHttpRoute[];
	/** Make the runtime services globally injectable. Defaults to false. */
	readonly isGlobal?: boolean;
	/** Nest modules whose exported providers are consumed by the MCP root. */
	readonly imports?: ModuleMetadata["imports"];
	/** Singleton collaborators whose lifecycle must surround the MCP runtimes they serve. */
	readonly collaborators?: McpNestCollaborators;
}
