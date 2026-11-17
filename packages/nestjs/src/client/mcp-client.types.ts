import type {
	AuthProvider,
	Client,
	ClientOptions,
	ConnectOptions,
	FetchLike,
	Middleware,
	OAuthClientProvider,
	Progress,
	ReconnectionScheduler,
	ResponseCacheStore,
	StreamableHTTPClientTransportOptions,
	jsonSchemaValidator,
} from "@modelcontextprotocol/client";
import type { Stream } from "node:stream";
import type {
	McpClientAttributesResolver,
	McpClientConfigurationContext,
	McpClientMiddleware,
	McpClientPrincipalResolver,
	McpClientRuntimeOptions,
	McpClientServerDefinition,
	McpClientTransportFactory,
	McpHttpClientTransportDefinition,
	McpSdkClientFactory,
	McpStdioClientTransportDefinition,
} from "@nest-mcp/client";
import type { MaybePromise, McpLifecycleEvent, McpLifecycleObserver } from "@nest-mcp/core";
import type { McpNestCollaborators, McpProviderToken } from "../mcp-provider.types.ts";

export interface McpClientConfiguratorProvider {
	configure(client: Client, context: McpClientConfigurationContext): MaybePromise<void>;
}

export interface McpClientMiddlewareProvider {
	handle: McpClientMiddleware;
}

export interface McpClientPrincipalResolverProvider {
	resolvePrincipal: McpClientPrincipalResolver<unknown>;
}

export interface McpClientAttributesResolverProvider {
	resolveAttributes: McpClientAttributesResolver;
}

export interface McpClientFetchProvider {
	fetch: FetchLike;
}

export interface McpClientFetchMiddlewareProvider {
	handle: Middleware;
}

export interface McpClientProgressObserver {
	onProgress(progress: Progress): void;
}

export interface McpClientOperationIdFactory {
	createOperationId(): string;
}

export interface McpClientClock {
	now(): number;
}

export interface McpClientLifecycleErrorReporter {
	report(error: unknown, event: McpLifecycleEvent): MaybePromise<void>;
}

export interface McpClientReconnectionSchedulerProvider {
	schedule: ReconnectionScheduler;
}

export interface McpNestClientOptions extends Omit<
	ClientOptions,
	"jsonSchemaValidator" | "listChanged" | "responseCacheStore"
> {
	readonly jsonSchemaValidator?: McpProviderToken<jsonSchemaValidator>;
	readonly responseCacheStore?: McpProviderToken<ResponseCacheStore>;
}

export interface McpNestClientConnectOptions extends Omit<ConnectOptions, "onprogress" | "signal"> {
	readonly progressObserver?: McpProviderToken<McpClientProgressObserver>;
}

type McpHttpTransportOptions = Omit<
	StreamableHTTPClientTransportOptions,
	"authProvider" | "fetch" | "reconnectionScheduler" | "requestInit"
>;

export interface McpNestHttpClientTransportDefinition extends Omit<
	McpHttpClientTransportDefinition,
	"authProvider" | "fetch" | "middleware" | "options" | "requestInit"
> {
	readonly authProvider?: McpProviderToken<AuthProvider | OAuthClientProvider>;
	readonly fetch?: McpProviderToken<McpClientFetchProvider>;
	readonly middleware?: readonly McpProviderToken<McpClientFetchMiddlewareProvider>[];
	readonly requestInit?: McpProviderToken<RequestInit>;
	readonly options?: McpHttpTransportOptions & {
		readonly reconnectionScheduler?: McpProviderToken<McpClientReconnectionSchedulerProvider>;
	};
}

export interface McpNestStdioClientTransportDefinition extends Omit<
	McpStdioClientTransportDefinition,
	"stderr"
> {
	/** Passive child-process stdio modes stay inline. */
	readonly stderr?: Exclude<McpStdioClientTransportDefinition["stderr"], Stream>;
	/** Live Node streams are owned and resolved through Nest. */
	readonly stderrStream?: McpProviderToken<Stream>;
}

export type McpNestClientTransportDefinition =
	McpNestHttpClientTransportDefinition | McpNestStdioClientTransportDefinition;

export interface McpNestClientDefinition extends Omit<
	McpClientServerDefinition,
	"clientOptions" | "configureClient" | "connectOptions" | "transport" | "transportFactory"
> {
	readonly transport: McpNestClientTransportDefinition;
	readonly clientOptions?: McpNestClientOptions;
	readonly connectOptions?: McpNestClientConnectOptions;
	readonly configureClient?: McpProviderToken<McpClientConfiguratorProvider>;
	readonly transportFactory?: McpProviderToken<McpClientTransportFactory>;
}

export interface McpNestClientLifecycleOptions {
	readonly clock?: McpProviderToken<McpClientClock>;
	readonly errorReporter?: McpProviderToken<McpClientLifecycleErrorReporter>;
}

export interface McpNestClientRuntimeOptions extends Omit<
	McpClientRuntimeOptions,
	| "clientFactory"
	| "lifecycle"
	| "middleware"
	| "now"
	| "observer"
	| "operationIdFactory"
	| "principal"
	| "resolveAttributes"
	| "resolvePrincipal"
	| "servers"
	| "transportFactory"
> {
	readonly clientFactory?: McpProviderToken<McpSdkClientFactory>;
	readonly transportFactory?: McpProviderToken<McpClientTransportFactory>;
	readonly middleware?: readonly McpProviderToken<McpClientMiddlewareProvider>[];
	readonly observer?: McpProviderToken<McpLifecycleObserver>;
	readonly lifecycle?: McpNestClientLifecycleOptions;
	readonly principalResolver?: McpProviderToken<McpClientPrincipalResolverProvider>;
	readonly attributesResolver?: McpProviderToken<McpClientAttributesResolverProvider>;
	readonly operationIdFactory?: McpProviderToken<McpClientOperationIdFactory>;
	readonly clock?: McpProviderToken<McpClientClock>;
}

export interface McpClientBootstrapOptions {
	/** Establish all configured upstreams during application bootstrap. Defaults to false. */
	readonly connectAll?: boolean;
}

export interface McpClientModuleOptions {
	/** Named upstream servers owned by this Nest module. */
	readonly servers?: readonly McpNestClientDefinition[];
	/** Shared client policy, telemetry, factories, identity, and timing. */
	readonly runtime?: McpNestClientRuntimeOptions;
	/** Nest application-bootstrap behavior for module-owned clients. */
	readonly bootstrap?: McpClientBootstrapOptions;
}

export interface McpClientModuleExtras {
	/** Make the client service globally injectable. Defaults to false. */
	readonly isGlobal?: boolean;
	/** Singleton providers referenced by the client module's provider-token options. */
	readonly collaborators?: McpNestCollaborators;
}
