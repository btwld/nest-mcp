import type {
	CompleteRequest,
	CompleteResult,
	GetPromptResult,
	InputRequiredResult,
	ListPromptsResult,
	ListResourceTemplatesResult,
	ListResourcesResult,
	Prompt,
	ReadResourceResult,
	RequestTypeMap,
	Resource,
	ResultTypeMap,
	ServerCapabilities,
	Tool,
	Variables,
} from "@modelcontextprotocol/server";
import type {
	McpAuthorizationPolicy,
	McpAttributes,
	McpLifecycleObserver,
	McpOperationContext,
	McpOperationMiddleware,
	McpPassthroughMiddleware,
	MaybePromise,
} from "@nest-mcp/core";
import type { McpClientRuntime } from "@nest-mcp/client";
import type { AuthInfo, CallToolResult, McpServerPrincipal } from "@nest-mcp/server";

export interface McpGatewayDecodedName {
	readonly upstreamName: string;
	readonly toolName: string;
}

export interface McpGatewayNameCodec {
	encode(upstreamName: string, toolName: string): string;
	decode(projectedName: string): McpGatewayDecodedName;
	tryDecode(projectedName: string): McpGatewayDecodedName | undefined;
}

export interface McpGatewayDecodedPromptName {
	readonly upstreamName: string;
	readonly promptName: string;
}

export interface McpGatewayPromptNameCodec {
	encode(upstreamName: string, promptName: string): string;
	decode(projectedName: string): McpGatewayDecodedPromptName;
	tryDecode(projectedName: string): McpGatewayDecodedPromptName | undefined;
}

export interface McpGatewayDecodedResourceUri {
	readonly upstreamName: string;
	readonly resourceUri: string;
}

export interface McpGatewayResourceUriCodec {
	encode(upstreamName: string, resourceUri: string): string;
	decode(projectedUri: string): McpGatewayDecodedResourceUri;
	tryDecode(projectedUri: string): McpGatewayDecodedResourceUri | undefined;
}

export interface McpGatewayDecodedResourceTemplateUri {
	readonly upstreamName: string;
	readonly resourceTemplate: string;
}

export interface McpGatewayResourceTemplateUriCodec {
	encode(upstreamName: string, resourceTemplate: string): string;
	decode(projectedTemplateUri: string): McpGatewayDecodedResourceTemplateUri;
	tryDecode(projectedTemplateUri: string): McpGatewayDecodedResourceTemplateUri | undefined;
}

export interface McpGatewayClientRequestOptions {
	readonly signal?: AbortSignal;
	/** Gateway-owned manual-MRTR switch; upstream interactions are never auto-fulfilled. */
	readonly allowInputRequired?: true;
}

export interface McpGatewayCallToolOptions extends McpGatewayClientRequestOptions {
	/** Structural clients may use this for official header mirroring/output validation. */
	readonly toolDefinition?: Tool;
}

/** One raw upstream tools page. Official v2 clients preserve `nextCursor`. */
export interface McpGatewayListToolsResult {
	readonly tools: readonly Tool[];
	readonly nextCursor?: string | undefined;
}

/** One raw upstream prompts page. */
export type McpGatewayListPromptsResult = Pick<ListPromptsResult, "nextCursor"> & {
	readonly prompts: readonly Prompt[];
};

/** One raw upstream concrete-resources page. */
export type McpGatewayListResourcesResult = Pick<ListResourcesResult, "nextCursor"> & {
	readonly resources: readonly Resource[];
};

export type McpGatewayResourceTemplateDefinition =
	ListResourceTemplatesResult["resourceTemplates"][number];

/** One raw upstream resource-template page. */
export type McpGatewayListResourceTemplatesResult = Pick<
	ListResourceTemplatesResult,
	"nextCursor"
> & {
	readonly resourceTemplates: readonly McpGatewayResourceTemplateDefinition[];
};

/**
 * Structural subset implemented by the official v2 `Client`.
 *
 * Tool methods stay required for backward compatibility. Prompt/resource
 * pairs are optional so existing tool-only structural clients remain valid;
 * a capability is projected only when both its list and execution method exist.
 */
export interface McpGatewayToolClient {
	/** Official-client capability introspection; used to avoid strict unsupported calls. */
	getServerCapabilities?(): ServerCapabilities | undefined;
	listTools(
		params?: { readonly cursor?: string },
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<McpGatewayListToolsResult>;
	callTool(
		params: {
			readonly name: string;
			readonly arguments?: Readonly<Record<string, unknown>>;
		},
		options?: McpGatewayCallToolOptions,
	): MaybePromise<CallToolResult | InputRequiredResult>;
	listPrompts?(
		params?: { readonly cursor?: string },
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<McpGatewayListPromptsResult>;
	getPrompt?(
		params: {
			readonly name: string;
			readonly arguments?: Readonly<Record<string, string>>;
		},
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<GetPromptResult | InputRequiredResult>;
	listResources?(
		params?: { readonly cursor?: string },
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<McpGatewayListResourcesResult>;
	readResource?(
		params: { readonly uri: string },
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<InputRequiredResult | ReadResourceResult>;
	listResourceTemplates?(
		params?: { readonly cursor?: string },
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<McpGatewayListResourceTemplatesResult>;
	complete?(
		params: CompleteRequest["params"],
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<CompleteResult>;
}

/** Capability-complete structural client for tools, prompts, and resources. */
export interface McpGatewayClient extends McpGatewayToolClient {
	listPrompts(
		params?: { readonly cursor?: string },
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<McpGatewayListPromptsResult>;
	getPrompt(
		params: {
			readonly name: string;
			readonly arguments?: Readonly<Record<string, string>>;
		},
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<GetPromptResult | InputRequiredResult>;
	listResources(
		params?: { readonly cursor?: string },
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<McpGatewayListResourcesResult>;
	readResource(
		params: { readonly uri: string },
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<InputRequiredResult | ReadResourceResult>;
	listResourceTemplates(
		params?: { readonly cursor?: string },
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<McpGatewayListResourceTemplatesResult>;
	complete(
		params: CompleteRequest["params"],
		options?: McpGatewayClientRequestOptions,
	): MaybePromise<CompleteResult>;
}

export interface McpGatewayRequestContext {
	readonly authInfo?: AuthInfo;
	/** Pre-resolved token-free identity; preferred over deriving the basic principal from authInfo. */
	readonly principal?: McpServerPrincipal;
	readonly request?: Request;
	readonly signal?: AbortSignal;
	readonly requestId?: string;
	readonly attributes?: McpAttributes;
}

export interface McpGatewayResolvedRequestContext extends McpGatewayRequestContext {
	readonly authorizationContext: string;
	readonly signal: AbortSignal;
}

export type McpGatewayClientResolver = (
	context: McpGatewayResolvedRequestContext,
) => MaybePromise<McpGatewayToolClient>;

export interface McpGatewayUpstream {
	/** Stable routing identifier used in projected names/URIs and cache keys. */
	readonly name: string;
	readonly client: McpGatewayToolClient | McpGatewayClientResolver;
}

/** Immutable, credential-free view of the gateway's current upstream topology. */
export interface McpGatewayTopologySnapshot {
	/** Monotonic process-local revision. Initial configuration is revision zero. */
	readonly revision: number;
	readonly upstreamNames: readonly string[];
}

export interface McpGatewayTopologyMutationOptions {
	/** Optional compare-and-swap fence for concurrent control-plane writers. */
	readonly expectedRevision?: number;
}

/** Public runtime surface consumed by the first-party gateway adapter. */
export type McpGatewayClientRuntime = Pick<
	McpClientRuntime,
	| "callTool"
	| "getPrompt"
	| "listPrompts"
	| "listResources"
	| "listResourceTemplates"
	| "listTools"
	| "readResource"
	| "request"
	| "requestWithInputRequired"
	| "snapshot"
	| "complete"
>;

export interface McpGatewayDiscoveryCacheKey {
	readonly upstreamName: string;
	/** Opaque, non-secret identity for every authorization dimension affecting discovery. */
	readonly authorizationContext: string;
}

export interface McpGatewayDiscoverySnapshot {
	readonly tools: readonly Tool[];
	/** Optional for compatibility with tool-only custom cache implementations. */
	readonly prompts?: readonly Prompt[];
	/** Optional for compatibility with tool-only custom cache implementations. */
	readonly resources?: readonly Resource[];
	/** Optional for compatibility with pre-template custom cache implementations. */
	readonly resourceTemplates?: readonly McpGatewayResourceTemplateDefinition[];
	readonly discoveredAt: number;
}

/** Store contract suitable for in-memory, Redis, or application-specific implementations. */
export interface McpGatewayDiscoveryCache {
	get(key: McpGatewayDiscoveryCacheKey): MaybePromise<McpGatewayDiscoverySnapshot | undefined>;
	set(key: McpGatewayDiscoveryCacheKey, snapshot: McpGatewayDiscoverySnapshot): MaybePromise<void>;
	delete(key: McpGatewayDiscoveryCacheKey): MaybePromise<boolean>;
	clear(): MaybePromise<void>;
}

export type McpGatewayAuthorizationContextResolver = (
	context: McpGatewayRequestContext,
) => MaybePromise<string>;

export interface McpGatewayProjectedTool {
	readonly projectedName: string;
	readonly upstreamName: string;
	readonly toolName: string;
	readonly tool: Tool;
	readonly definition: Tool;
}

export interface McpGatewayProjectedPrompt {
	readonly projectedName: string;
	readonly upstreamName: string;
	readonly promptName: string;
	readonly prompt: Prompt;
	readonly definition: Prompt;
}

export interface McpGatewayProjectedResource {
	/** Reversible, bounded resource name exposed in `resources/list`. */
	readonly projectedName: string;
	readonly projectedUri: string;
	readonly upstreamName: string;
	readonly resourceName: string;
	readonly resource: Resource;
	readonly definition: Resource;
}

export interface McpGatewayProjectedResourceTemplate {
	readonly projectedName: string;
	readonly projectedTemplateUri: string;
	readonly upstreamName: string;
	readonly resourceTemplateName: string;
	readonly resourceTemplate: McpGatewayResourceTemplateDefinition;
	readonly definition: McpGatewayResourceTemplateDefinition;
}

/** Existing tool-policy input; retained unchanged for source compatibility. */
export interface McpGatewayPolicyInput {
	readonly action: "discover" | "invoke";
	readonly upstreamName: string;
	readonly toolName: string;
	readonly projectedName: string;
	readonly tool: Tool;
	readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface McpGatewayPromptPolicyInput {
	readonly action: "discover" | "get" | "complete";
	readonly upstreamName: string;
	readonly promptName: string;
	readonly projectedName: string;
	readonly prompt: Prompt;
	readonly arguments?: Readonly<Record<string, string>>;
	readonly completion?: Readonly<Pick<CompleteRequest["params"], "argument" | "context">>;
}

export interface McpGatewayResourceTemplatePolicyInput {
	readonly action: "discover" | "read" | "complete";
	readonly upstreamName: string;
	readonly resourceTemplateName: string;
	readonly projectedName: string;
	readonly projectedTemplateUri: string;
	readonly resourceTemplate: McpGatewayResourceTemplateDefinition;
	readonly variables?: Variables;
	readonly completion?: Readonly<Pick<CompleteRequest["params"], "argument" | "context">>;
}

export interface McpGatewayResourcePolicyInput {
	readonly action: "discover" | "read";
	readonly upstreamName: string;
	readonly resourceName: string;
	readonly projectedName: string;
	readonly projectedUri: string;
	/** Raw URI is not copied into telemetry attributes; the projected URI remains reversible. */
	readonly resource: Resource;
}

/**
 * Identity exposed to policy, middleware, and lifecycle observers. Credentials
 * and arbitrary token metadata are deliberately absent.
 */
export interface McpGatewayPrincipal {
	readonly clientId: McpServerPrincipal["clientId"];
	readonly scopes: readonly string[];
	readonly expiresAt?: NonNullable<McpServerPrincipal["expiresAt"]>;
	readonly resource?: NonNullable<McpServerPrincipal["resource"]>;
	readonly subject?: NonNullable<McpServerPrincipal["subject"]>;
	readonly tenantId?: NonNullable<McpServerPrincipal["tenantId"]>;
}
export type McpGatewayOperationContext = McpOperationContext<McpGatewayPrincipal>;
export type McpGatewayPromptPolicy = McpAuthorizationPolicy<
	McpGatewayPromptPolicyInput,
	McpGatewayOperationContext
>;
export type McpGatewayResourcePolicy = McpAuthorizationPolicy<
	McpGatewayResourcePolicyInput,
	McpGatewayOperationContext
>;
export type McpGatewayResourceTemplatePolicy = McpAuthorizationPolicy<
	McpGatewayResourceTemplatePolicyInput,
	McpGatewayOperationContext
>;

/**
 * Tool authorization remains the required base contract. New capability hooks
 * are opt-in and fail closed when absent, so an existing policy cannot
 * accidentally expose prompts or resources after an upgrade.
 */
export interface McpGatewayPolicy extends McpAuthorizationPolicy<
	McpGatewayPolicyInput,
	McpGatewayOperationContext
> {
	readonly authorizePrompt?: McpGatewayPromptPolicy["authorize"];
	readonly authorizeResource?: McpGatewayResourcePolicy["authorize"];
	readonly authorizeResourceTemplate?: McpGatewayResourceTemplatePolicy["authorize"];
}

export interface McpGatewayDiscoveryOperationInput {
	readonly type: "gateway.discovery";
	readonly upstreamName: string;
	/** Capability whose public operation triggered the shared discovery snapshot. */
	readonly capability?: "tools" | "prompts" | "resources" | "resourceTemplates";
}

export interface McpGatewayInvocationOperationInput {
	readonly type: "gateway.invocation";
	readonly upstreamName: string;
	readonly toolName: RequestTypeMap["tools/call"]["params"]["name"];
	readonly projectedName: string;
	readonly tool: Tool;
	readonly arguments?: RequestTypeMap["tools/call"]["params"]["arguments"];
}

export interface McpGatewayPromptGetOperationInput {
	readonly type: "gateway.prompt.get";
	readonly upstreamName: string;
	readonly promptName: RequestTypeMap["prompts/get"]["params"]["name"];
	readonly projectedName: string;
	readonly prompt: Prompt;
	readonly arguments?: RequestTypeMap["prompts/get"]["params"]["arguments"];
}

export interface McpGatewayResourceReadOperationInput {
	readonly type: "gateway.resource.read";
	readonly upstreamName: string;
	readonly projectedName: string;
	readonly projectedUri: RequestTypeMap["resources/read"]["params"]["uri"];
	/** Contains only the projected URI and reversible projected name. */
	readonly resource: Resource;
}

export interface McpGatewayResourceTemplateReadOperationInput {
	readonly type: "gateway.resource-template.read";
	readonly upstreamName: string;
	readonly projectedName: string;
	readonly projectedTemplateUri: string;
	readonly variables: Variables;
	readonly resourceTemplate: McpGatewayResourceTemplateDefinition;
}

export interface McpGatewayCompletionOperationInput {
	readonly type: "gateway.completion";
	readonly upstreamName: string;
	readonly projectedIdentifier: string;
	readonly params: RequestTypeMap["completion/complete"]["params"];
}

export type McpGatewayOperationInput =
	| McpGatewayDiscoveryOperationInput
	| McpGatewayInvocationOperationInput
	| McpGatewayPromptGetOperationInput
	| McpGatewayResourceReadOperationInput
	| McpGatewayResourceTemplateReadOperationInput
	| McpGatewayCompletionOperationInput;

/** Public gateway operation discriminators eligible for exact transforms. */
export type McpGatewayOperationKind = McpGatewayOperationInput["type"];

/** Recursive readonly view for detached gateway transform input. */
export type McpGatewayReadonly<Value> = Value extends (...arguments_: never[]) => unknown
	? Value
	: Value extends readonly unknown[]
		? { readonly [Index in keyof Value]: McpGatewayReadonly<Value[Index]> }
		: Value extends object
			? { readonly [Key in keyof Value]: McpGatewayReadonly<Value[Key]> }
			: Value;

/** Exact gateway input selected by one operation discriminator. */
export type McpGatewayOperationInputFor<Kind extends McpGatewayOperationKind> = McpGatewayReadonly<
	Extract<McpGatewayOperationInput, { readonly type: Kind }>
>;

/** Exact result contract for every gateway operation discriminator. */
export type McpGatewayOperationOutputMap = Readonly<{
	"gateway.discovery": McpGatewayDiscoverySnapshot;
	"gateway.invocation": ResultTypeMap["tools/call"];
	"gateway.prompt.get": ResultTypeMap["prompts/get"];
	"gateway.resource.read": ResultTypeMap["resources/read"];
	"gateway.resource-template.read": ResultTypeMap["resources/read"];
	"gateway.completion": ResultTypeMap["completion/complete"];
}>;

/** Exact gateway result selected by one operation discriminator. */
export type McpGatewayOperationOutputForKind<Kind extends McpGatewayOperationKind> =
	McpGatewayOperationOutputMap[Kind];

/** Result corresponding to one gateway operation input (or input union). */
export type McpGatewayOperationOutputFor<Input extends McpGatewayOperationInput> =
	McpGatewayOperationOutputMap[Input["type"]];

export type McpGatewayOperationOutput = McpGatewayOperationOutputFor<McpGatewayOperationInput>;
/**
 * Transforming gateway middleware retained for deliberate result replacement
 * and successful short-circuiting. Prefer `McpGatewayPassthroughMiddleware`
 * when discriminator-specific results should remain opaque.
 */
export type McpGatewayMiddleware = McpOperationMiddleware<
	McpGatewayOperationInput,
	McpGatewayOperationOutput,
	McpGatewayOperationContext
>;

/** Transforming middleware scoped to one exact gateway input/result pair. */
export type McpGatewayTransform<Kind extends McpGatewayOperationKind> = McpOperationMiddleware<
	McpGatewayOperationInputFor<Kind>,
	McpGatewayOperationOutputForKind<Kind>,
	McpGatewayOperationContext
>;

/**
 * Result-opaque gateway middleware for concerns that must never substitute one
 * operation's result with the shape belonging to another discriminator.
 */
export type McpGatewayPassthroughMiddleware = McpPassthroughMiddleware<
	McpGatewayOperationInput,
	McpGatewayOperationContext
>;
export type McpGatewayLifecycleObserver = McpLifecycleObserver<McpGatewayOperationContext>;

/** Select which gateway capabilities are installed into a server. */
export interface McpGatewayServerFeatureOptions {
	/** Install tools before local SDK registrations; reject duplicate tool names. */
	readonly toolsOnly?: boolean;
}

export interface McpGatewayOptions {
	readonly upstreams: readonly McpGatewayUpstream[];
	/**
	 * Enables runtime attach/detach and advertises tools, prompts, and resources even while empty.
	 * Completion and notification/subscription bridging remain deliberately unavailable.
	 */
	readonly dynamicUpstreams?: boolean;
	/** Required and fail-closed. Use `allowAllMcpGatewayPolicy()` only for trusted deployments. */
	readonly policy: McpGatewayPolicy;
	readonly nameCodec?: McpGatewayNameCodec;
	readonly promptNameCodec?: McpGatewayPromptNameCodec;
	readonly resourceUriCodec?: McpGatewayResourceUriCodec;
	readonly resourceTemplateUriCodec?: McpGatewayResourceTemplateUriCodec;
	readonly resourceTemplateNameCodec?: McpGatewayNameCodec;
	readonly discoveryCache?: McpGatewayDiscoveryCache;
	/** Used only by the default in-memory discovery cache. Defaults to 30 seconds. */
	readonly discoveryTtlMs?: number;
	/** Maximum upstream discovery pages followed per capability and refresh. Defaults to 64. */
	readonly discoveryMaxPages?: number;
	/** Maximum discovered items per capability and upstream. Defaults to 10,000. */
	readonly discoveryMaxItemsPerCapability?: number;
	/** Maximum duration of one shared upstream discovery refresh. Defaults to 60 seconds. */
	readonly discoveryTimeoutMs?: number;
	/** Maximum UTF-8 JSON size of one discovered definition. Defaults to 256 KiB. */
	readonly discoveryMaxItemBytes?: number;
	/** Maximum UTF-8 JSON size of one upstream snapshot. Defaults to 8 MiB. */
	readonly discoveryMaxSnapshotBytes?: number;
	/** Maximum nested object/array depth in discovered definitions. Defaults to 64. */
	readonly discoveryMaxDepth?: number;
	/** Maximum UTF-8 size of one string/key in discovery. Defaults to 64 KiB. */
	readonly discoveryMaxStringBytes?: number;
	/** Maximum shared refreshes running across all authorization contexts. Defaults to 64. */
	readonly discoveryMaxConcurrentFlights?: number;
	/** Maximum time close waits for accepted gateway work and cache mutations. Defaults to 30 seconds. */
	readonly shutdownTimeoutMs?: number;
	readonly authorizationContextResolver?: McpGatewayAuthorizationContextResolver;
	/** Runs around upstream discovery and execution after mandatory execution authorization. */
	readonly middleware?: readonly McpGatewayMiddleware[];
	/** Payload-safe start/success/failure/cancellation operation events. */
	readonly lifecycleObserver?: McpGatewayLifecycleObserver;
	readonly onObserverError?: (error: unknown) => MaybePromise<void>;
}
