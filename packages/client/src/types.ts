import type {
	CacheableRequestOptions,
	CallToolRequestOptions,
	Client,
	ClientOptions,
	ConnectOptions,
	DiscoverResult,
	Implementation,
	InputRequiredResult,
	McpSubscription,
	PriorDiscovery,
	ProtocolEra,
	RequestMethod,
	RequestOptions,
	RequestTypeMap,
	ResultTypeMap,
	ServerCapabilities,
	StandardSchemaV1,
	Tool,
} from "@modelcontextprotocol/client";
import type {
	MaybePromise,
	McpAttributes,
	McpErrorDetails,
	McpLifecycleMiddlewareOptions,
	McpLifecycleObserver,
	McpOperationContext,
	McpOperationMiddleware,
	McpPassthroughMiddleware,
} from "@nest-mcp/core";

import type { McpClientTransportDefinition, McpClientTransportFactory } from "./transport.ts";

export type McpClientConnectionState =
	"disconnected" | "connecting" | "connected" | "disconnecting" | "failed";

/** Official MCP tool shape returned by client discovery. */
export type McpClientTool = Tool;

/** Official JSON Schema shape accepted for MCP tool input. */
export type McpClientToolInputSchema = McpClientTool["inputSchema"];

/** Official JSON Schema shape accepted for MCP tool structured output. */
export type McpClientToolOutputSchema = NonNullable<McpClientTool["outputSchema"]>;

/** An exact method/params pair accepted by the official protocol request funnel. */
export type McpClientProtocolRequest<Method extends RequestMethod = RequestMethod> =
	Method extends RequestMethod
		? { readonly method: Method } & Omit<RequestTypeMap[Method], "method">
		: never;

/** Official request methods eligible for operation-specific transforms. */
export type McpClientRequestMethod = RequestMethod;

/** Recursive readonly view for detached transform input while preserving live control objects. */
export type McpClientReadonly<Value> = Value extends AbortSignal
	? Value
	: Value extends (...arguments_: never[]) => unknown
		? Value
		: Value extends readonly unknown[]
			? { readonly [Index in keyof Value]: McpClientReadonly<Value[Index]> }
			: Value extends object
				? { readonly [Key in keyof Value]: McpClientReadonly<Value[Key]> }
				: Value;

type CompleteResultOptions<Options extends RequestOptions> = Omit<Options, "allowInputRequired"> & {
	readonly allowInputRequired?: false | undefined;
};

/** Exact SDK option family associated with one transformable request method. */
export type McpClientTransformOptions<Method extends McpClientRequestMethod> =
	Method extends "tools/call"
		? CompleteResultOptions<CallToolRequestOptions>
		: Method extends "resources/read"
			? CompleteResultOptions<CacheableRequestOptions>
			: Method extends "prompts/get"
				? CompleteResultOptions<RequestOptions>
				: Method extends
							"tools/list" | "prompts/list" | "resources/list" | "resources/templates/list"
					? CacheableRequestOptions
					: RequestOptions;

/** Exact middleware input for one official request method. */
export type McpClientTransformInput<Method extends McpClientRequestMethod> = McpClientReadonly<
	{
		readonly serverName: string;
		readonly options?: McpClientTransformOptions<Method>;
	} & McpClientProtocolRequest<Method>
>;

/** Exact official result for one request method. */
export type McpClientTransformResult<Method extends McpClientRequestMethod> = ResultTypeMap[Method];

/** Modern methods whose results may request another client-input round. */
export type McpClientMrtrMethod = "prompts/get" | "resources/read" | "tools/call";

/** An official, method-keyed request that supports modern multi-round trips. */
export type McpClientMrtrRequest<Method extends McpClientMrtrMethod = McpClientMrtrMethod> =
	RequestTypeMap[Method];

/**
 * Per-leg request controls for manual MRTR calls.
 *
 * `allowInputRequired` is runtime-owned and always enabled by the manual APIs.
 */
export type McpClientMrtrRequestOptions = Omit<RequestOptions, "allowInputRequired">;

/** The complete result or the official modern continuation payload. */
export type McpClientMrtrResult<Schema extends StandardSchemaV1> =
	StandardSchemaV1.InferOutput<Schema> | InputRequiredResult;

/**
 * A modern `subscriptions/listen` handle owned by this runtime.
 *
 * The handle remains structurally compatible with the official SDK handle,
 * adds its logical server name, and is closed during server disconnect.
 */
export interface McpClientSubscription extends McpSubscription {
	readonly serverName: string;
}

export interface McpClientConfigurationContext {
	readonly serverName: string;
	readonly definition: McpClientServerDefinition;
}

export type McpClientConfigurator = (
	client: Client,
	context: McpClientConfigurationContext,
) => MaybePromise<void>;

/** Complete configuration for one logical upstream MCP server. */
export interface McpClientServerDefinition {
	readonly name: string;
	readonly transport: McpClientTransportDefinition;
	readonly clientInfo?: Implementation;
	readonly clientOptions?: ClientOptions;
	readonly connectOptions?: ConnectOptions;
	/**
	 * Cached discovery verdict. Reuse it only within the same authorization
	 * context; freshness remains the host application's responsibility.
	 */
	readonly prior?: PriorDiscovery;
	/** Installs SDK handlers and callbacks before the transport is connected. */
	readonly configureClient?: McpClientConfigurator;
	readonly transportFactory?: McpClientTransportFactory;
	readonly attributes?: McpAttributes;
}

export interface McpSdkClientFactoryContext {
	readonly serverName: string;
	readonly definition: McpClientServerDefinition;
}

/** Injectable official Client constructor seam, primarily useful for testing. */
export interface McpSdkClientFactory {
	createClient(
		clientInfo: Implementation,
		options: ClientOptions,
		context: McpSdkClientFactoryContext,
	): Client;
}

/** Stable operation envelope visible to client middleware. */
export interface McpClientOperationInput {
	readonly serverName: string;
	readonly method: string;
	readonly params?: unknown;
	readonly options?: unknown;
}

export type McpClientOperationContext<Principal = unknown> = McpOperationContext<Principal>;

/**
 * Transforming client middleware retained for deliberate result replacement
 * and successful short-circuiting. Prefer `McpClientPassthroughMiddleware`
 * when the method-specific result should remain opaque.
 */
export type McpClientMiddleware<Principal = unknown> = McpOperationMiddleware<
	McpClientOperationInput,
	unknown,
	McpClientOperationContext<Principal>
>;

/** Transforming middleware scoped to one exact official request/result pair. */
export type McpClientTransform<
	Method extends McpClientRequestMethod,
	Principal = unknown,
> = McpOperationMiddleware<
	McpClientTransformInput<Method>,
	McpClientTransformResult<Method>,
	McpClientOperationContext<Principal>
>;

/**
 * Result-opaque client middleware. Use this for cross-cutting concerns that
 * must observe or delay an operation without replacing its method-specific
 * result with an unrelated value.
 */
export type McpClientPassthroughMiddleware<Principal = unknown> = McpPassthroughMiddleware<
	McpClientOperationInput,
	McpClientOperationContext<Principal>
>;

export type McpClientPrincipalResolver<Principal> = (
	operation: McpClientOperationInput,
) => MaybePromise<Principal | undefined>;

export type McpClientAttributesResolver = (
	operation: McpClientOperationInput,
) => MaybePromise<McpAttributes>;

export interface McpClientRuntimeOptions<Principal = unknown> {
	readonly servers?: readonly McpClientServerDefinition[];
	readonly clientInfo?: Implementation;
	readonly clientFactory?: McpSdkClientFactory;
	readonly transportFactory?: McpClientTransportFactory;
	readonly middleware?: readonly McpClientMiddleware<Principal>[];
	readonly observer?: McpLifecycleObserver<McpClientOperationContext<Principal>>;
	readonly lifecycle?: McpLifecycleMiddlewareOptions<McpClientOperationContext<Principal>>;
	readonly principal?: Principal;
	readonly resolvePrincipal?: McpClientPrincipalResolver<Principal>;
	readonly attributes?: McpAttributes;
	readonly resolveAttributes?: McpClientAttributesResolver;
	readonly operationIdFactory?: () => string;
	/**
	 * Absolute deadline for disconnect/unregister/close connection quiescence,
	 * subscription teardown, and SDK client/transport close. Defaults to 30 seconds.
	 */
	readonly shutdownTimeoutMs?: number;
	/** Unix epoch milliseconds, injectable for deterministic snapshots. */
	readonly now?: () => number;
}

export interface McpClientConnectionSnapshot {
	readonly name: string;
	readonly state: McpClientConnectionState;
	readonly transportKind: McpClientTransportDefinition["kind"];
	readonly sessionId?: string;
	readonly connectedAt?: number;
	readonly disconnectedAt?: number;
	readonly negotiatedProtocolVersion?: string;
	readonly protocolEra?: ProtocolEra;
	readonly serverInfo?: Implementation;
	readonly serverCapabilities?: ServerCapabilities;
	readonly instructions?: string;
	readonly discoverResult?: DiscoverResult;
	readonly lastError?: McpErrorDetails;
}
