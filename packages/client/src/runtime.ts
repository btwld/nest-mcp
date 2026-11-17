import { randomUUID } from "node:crypto";

import {
	Client,
	type CacheableRequestOptions,
	type CallToolRequest,
	type CallToolRequestOptions,
	type CallToolResult,
	type ClientOptions,
	type CompleteRequest,
	type CompleteResult,
	type ConnectOptions,
	type DiscoverResult,
	type EmptyResult,
	type GetPromptRequest,
	type GetPromptResult,
	type Implementation,
	type InputRequiredResult,
	type InputResponses,
	type ListPromptsRequest,
	type ListPromptsResult,
	type ListResourcesRequest,
	type ListResourcesResult,
	type ListResourceTemplatesRequest,
	type ListResourceTemplatesResult,
	type ListToolsRequest,
	type ListToolsResult,
	type LoggingLevel,
	type McpSubscription,
	type Notification,
	type NotificationOptions,
	type PriorDiscovery,
	type ReadResourceRequest,
	type ReadResourceResult,
	type Request,
	type RequestMethod,
	type RequestOptions,
	type ResultTypeMap,
	type StandardSchemaV1,
	type SubscribeRequest,
	type SubscriptionFilter,
	type Transport,
	type UnsubscribeRequest,
	withInputRequired,
} from "@modelcontextprotocol/client";
import {
	composeMcpMiddleware,
	createMcpLifecycleMiddleware,
	createMcpOperation,
	createMcpOperationContext,
	toMcpErrorDetails,
	type McpAttributes,
} from "@nest-mcp/core";

import {
	clientNotConnectedError,
	runtimeClosedError,
	serverExistsError,
	serverNotFoundError,
	shutdownTimeoutError,
} from "./errors.ts";
import { markExactMcpClientResult } from "./exact-result-profile.ts";
import { isExactMcpClientTransform } from "./middleware.ts";
import { defaultMcpClientTransportFactory } from "./transport.ts";
import type {
	McpClientConnectionSnapshot,
	McpClientConnectionState,
	McpClientMiddleware,
	McpClientMrtrMethod,
	McpClientMrtrRequest,
	McpClientMrtrRequestOptions,
	McpClientMrtrResult,
	McpClientOperationContext,
	McpClientOperationInput,
	McpClientProtocolRequest,
	McpClientRuntimeOptions,
	McpClientServerDefinition,
	McpClientSubscription,
	McpSdkClientFactory,
} from "./types.ts";
import packageMetadata from "../package.json" with { type: "json" };

const DEFAULT_CLIENT_INFO = Object.freeze({
	name: "@nest-mcp/client",
	version: packageMetadata.version,
}) satisfies Implementation;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

const MRTR_CAPABILITY = Object.freeze({
	"prompts/get": "prompts",
	"resources/read": "resources",
	"tools/call": "tools",
}) satisfies Readonly<Record<McpClientMrtrMethod, string>>;

interface ConnectionMetadata {
	sessionId: string | undefined;
	negotiatedProtocolVersion: string | undefined;
	protocolEra: McpClientConnectionSnapshot["protocolEra"] | undefined;
	serverInfo: McpClientConnectionSnapshot["serverInfo"] | undefined;
	serverCapabilities: McpClientConnectionSnapshot["serverCapabilities"] | undefined;
	instructions: string | undefined;
	discoverResult: DiscoverResult | undefined;
}

interface RegistryEntry {
	readonly definition: McpClientServerDefinition;
	state: McpClientConnectionState;
	prior: PriorDiscovery | undefined;
	client: Client | undefined;
	transport: Transport | undefined;
	connectTask: Promise<EstablishedConnection> | undefined;
	connectAbortController: AbortController | undefined;
	connectAttemptToken: symbol | undefined;
	connectDetachment: ConnectAttemptDetachment | undefined;
	connectUnlinkCallerSignal: (() => void) | undefined;
	disconnectTask: Promise<void> | undefined;
	disconnectToken: symbol | undefined;
	connectedAt: number | undefined;
	disconnectedAt: number | undefined;
	lastError: ReturnType<typeof toMcpErrorDetails> | undefined;
	readonly metadata: ConnectionMetadata;
	readonly subscriptions: Set<ManagedSubscription>;
	autoOpenedSubscription: McpClientSubscription | undefined;
	connectionGeneration: number;
	connectionToken: symbol | undefined;
	retired: boolean;
}

interface ConnectAttemptDetachment {
	readonly promise: Promise<never>;
	detach(error: unknown): void;
}

interface EstablishedConnection {
	readonly client: Client;
	readonly generation: number;
	readonly connectionToken: symbol;
}

interface ConnectAttemptResult {
	readonly client: Client;
	readonly generation: number;
	/** Present only when this caller atomically created the shared connection task. */
	readonly ownedConnectionToken?: symbol;
}

interface OperationDescriptor {
	readonly method: string;
	/** Runtime-owned proof that the ordinary ResultTypeMap entry is returned. */
	readonly exactResultMethod?: RequestMethod;
	readonly kind?: "request" | "notification";
	readonly capability?: string;
	readonly params?: unknown;
	readonly options?: unknown;
	readonly signal?: AbortSignal | undefined;
}

interface ManagedSubscription {
	readonly sdk: McpSubscription;
	readonly handle: McpClientSubscription;
}

const defaultSdkClientFactory = Object.freeze({
	createClient(clientInfo: Implementation, options: ClientOptions): Client {
		return new Client(clientInfo, options);
	},
}) satisfies McpSdkClientFactory;

/**
 * Owns a registry of named MCP servers and their independent official Client
 * instances. One runtime may safely connect, disconnect, and inspect many
 * upstreams while applying a shared middleware and lifecycle policy.
 */
export class McpClientRuntime<Principal = unknown> implements AsyncDisposable {
	readonly #entries = new Map<string, RegistryEntry>();
	readonly #clientInfo: Implementation;
	readonly #clientFactory: McpSdkClientFactory;
	readonly #transportFactory: NonNullable<McpClientRuntimeOptions["transportFactory"]>;
	readonly #middleware: readonly McpClientMiddleware<Principal>[];
	readonly #transforms: readonly McpClientMiddleware<Principal>[];
	readonly #lifecycleMiddleware: McpClientMiddleware<Principal> | undefined;
	readonly #principal: Principal | undefined;
	readonly #resolvePrincipal: McpClientRuntimeOptions<Principal>["resolvePrincipal"];
	readonly #attributes: McpAttributes;
	readonly #resolveAttributes: McpClientRuntimeOptions<Principal>["resolveAttributes"];
	readonly #operationIdFactory: () => string;
	readonly #shutdownTimeoutMs: number;
	readonly #now: () => number;
	#closed = false;
	#lifecycleEpoch = 0;
	#closeTask: Promise<void> | undefined;

	constructor(options: McpClientRuntimeOptions<Principal> = {}) {
		assertPositiveFinite(
			options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
			"shutdownTimeoutMs",
		);
		this.#clientInfo = Object.freeze({ ...(options.clientInfo ?? DEFAULT_CLIENT_INFO) });
		this.#clientFactory = options.clientFactory ?? defaultSdkClientFactory;
		this.#transportFactory = options.transportFactory ?? defaultMcpClientTransportFactory;
		this.#principal = options.principal;
		this.#resolvePrincipal = options.resolvePrincipal;
		this.#attributes = Object.freeze({ ...options.attributes });
		this.#resolveAttributes = options.resolveAttributes;
		this.#operationIdFactory = options.operationIdFactory ?? randomUUID;
		this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
		this.#now = options.now ?? Date.now;

		const middleware = [...(options.middleware ?? [])];
		this.#middleware = Object.freeze(
			middleware.filter((entry) => !isExactMcpClientTransform(entry)),
		);
		this.#transforms = Object.freeze(
			middleware.filter((entry) => isExactMcpClientTransform(entry)),
		);
		this.#lifecycleMiddleware =
			options.observer === undefined
				? undefined
				: createMcpLifecycleMiddleware<
						McpClientOperationInput,
						unknown,
						McpClientOperationContext<Principal>
					>(options.observer, options.lifecycle);

		for (const definition of options.servers ?? []) this.register(definition);
	}

	get closed(): boolean {
		return this.#closed;
	}

	get size(): number {
		return this.names().length;
	}

	register(definition: McpClientServerDefinition): this {
		this.#assertOpen();
		const normalized = normalizeServerDefinition(definition);
		if (this.#entries.has(normalized.name)) throw serverExistsError(normalized.name);
		this.#entries.set(normalized.name, createRegistryEntry(normalized));
		return this;
	}

	async unregister(serverName: string): Promise<boolean> {
		this.#assertOpen();
		const entry = this.#entries.get(serverName);
		if (entry === undefined || entry.retired) return false;
		entry.retired = true;
		try {
			const operation = this.#runOperation(
				entry,
				{ method: "runtime/disconnect" },
				() => this.#disconnectEntry(entry),
				true,
			);
			this.#abortConnectAttempt(entry, serverNotFoundError(serverName));
			await operation;
		} finally {
			// Identity-aware removal never deletes a replacement entry, should a
			// future registry operation allow one before old cleanup settles.
			if (this.#entries.get(serverName) === entry) this.#entries.delete(serverName);
		}
		return true;
	}

	has(serverName: string): boolean {
		return this.#entries.get(serverName)?.retired === false;
	}

	names(): readonly string[] {
		return Object.freeze(
			[...this.#entries].filter(([, entry]) => !entry.retired).map(([serverName]) => serverName),
		);
	}

	getDefinition(serverName: string): McpClientServerDefinition {
		return this.#entry(serverName).definition;
	}

	setPriorDiscovery(serverName: string, prior: PriorDiscovery | undefined): this {
		this.#entry(serverName).prior = prior;
		return this;
	}

	/** Returns a persistable current verdict without automatically reusing it. */
	getPriorDiscovery(serverName: string): PriorDiscovery | undefined {
		const entry = this.#entry(serverName);
		this.#refreshMetadata(entry);
		if (entry.metadata.discoverResult !== undefined) {
			return Object.freeze({ kind: "modern", discover: entry.metadata.discoverResult });
		}
		if (entry.metadata.protocolEra === "legacy") return Object.freeze({ kind: "legacy" });
		return entry.prior;
	}

	getClient(serverName: string): Client | undefined {
		const entry = this.#entries.get(serverName);
		return entry?.retired === false && entry.state === "connected" ? entry.client : undefined;
	}

	requireClient(serverName: string): Client {
		const client = this.getClient(serverName);
		if (client === undefined) throw clientNotConnectedError(serverName);
		return client;
	}

	snapshot(): readonly McpClientConnectionSnapshot[];
	snapshot(serverName: string): McpClientConnectionSnapshot;
	snapshot(
		serverName?: string,
	): McpClientConnectionSnapshot | readonly McpClientConnectionSnapshot[] {
		if (serverName !== undefined) return this.#snapshotEntry(this.#entry(serverName));
		return Object.freeze(
			[...this.#entries.values()]
				.filter((entry) => !entry.retired)
				.map((entry) => this.#snapshotEntry(entry)),
		);
	}

	async connect(serverName: string, options?: ConnectOptions): Promise<Client> {
		return (await this.#connectAttempt(serverName, options)).client;
	}

	async connectAll(
		options: Readonly<Record<string, ConnectOptions | undefined>> = {},
	): Promise<ReadonlyMap<string, Client>> {
		this.#assertOpen();
		const attempts = this.names().map((name) => {
			const entry = this.#entry(name);
			return { name, entry, promise: this.#connectAttempt(name, options[name]) };
		});
		const settled = await Promise.allSettled(attempts.map((attempt) => attempt.promise));
		const connectFailures = settled
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason as unknown);

		if (connectFailures.length > 0) {
			const rollback = attempts.flatMap((attempt, index) => {
				const result = settled[index];
				if (
					result?.status !== "fulfilled" ||
					result.value.ownedConnectionToken === undefined ||
					attempt.entry.state !== "connected" ||
					attempt.entry.client !== result.value.client ||
					attempt.entry.connectionGeneration !== result.value.generation ||
					attempt.entry.connectionToken !== result.value.ownedConnectionToken
				) {
					return [];
				}
				return [
					this.#runOperation(
						attempt.entry,
						{ method: "runtime/disconnect" },
						() => this.#disconnectEntry(attempt.entry),
						true,
					),
				];
			});
			const rollbackSettled = await Promise.allSettled(rollback);
			const rollbackFailures = rollbackSettled
				.filter((result): result is PromiseRejectedResult => result.status === "rejected")
				.map((result) => result.reason as unknown);
			throwFailures(
				[...connectFailures, ...rollbackFailures],
				"One or more MCP clients failed to connect, and rollback may also have failed.",
			);
		}

		const connected = new Map<string, Client>();
		for (const [index, attempt] of attempts.entries()) {
			const result = settled[index];
			if (result?.status === "fulfilled") connected.set(attempt.name, result.value.client);
		}
		return connected;
	}

	async disconnect(serverName: string): Promise<void> {
		const entry = this.#entry(serverName, true);
		const operation = this.#runOperation(
			entry,
			{ method: "runtime/disconnect" },
			() => this.#disconnectEntry(entry),
			true,
		);
		this.#abortConnectAttempt(entry, connectionAbortedError(serverName));
		await operation;
	}

	async disconnectAll(): Promise<void> {
		const settled = await Promise.allSettled(
			[...this.#entries.keys()].map((name) => this.disconnect(name)),
		);
		throwSettledFailures(settled, "One or more MCP clients failed to disconnect.");
	}

	close(): Promise<void> {
		if (this.#closeTask !== undefined) return this.#closeTask;
		this.#closed = true;
		this.#lifecycleEpoch += 1;
		// Assign the shared promise before executing cleanup. A resolver,
		// observer, or middleware invoked by disconnectAll may re-enter close().
		this.#closeTask = Promise.resolve().then(() => this.disconnectAll());
		for (const entry of this.#entries.values()) {
			this.#abortConnectAttempt(entry, runtimeClosedError());
		}
		return this.#closeTask;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	async discover(serverName: string, options?: RequestOptions): Promise<DiscoverResult> {
		const stableOptions = snapshotRequestOptions(options);
		const result = await this.#delegate<DiscoverResult>(
			serverName,
			{
				method: "server/discover",
				exactResultMethod: "server/discover",
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.discover(stableOptions),
		);
		this.#refreshMetadata(this.#entry(serverName));
		return result;
	}

	/** Checks that a connected server is responsive. */
	ping(serverName: string, options?: RequestOptions): Promise<EmptyResult> {
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "ping",
				exactResultMethod: "ping",
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.ping(stableOptions),
		);
	}

	/** Sends any official method-keyed request through runtime policy and lifecycle hooks. */
	request<const RequestValue extends McpClientProtocolRequest>(
		serverName: string,
		request: RequestValue,
		options: RequestOptions & { readonly allowInputRequired: true },
	): Promise<
		ResultTypeMap[RequestValue["method"]] | InputRequiredResultForMethod<RequestValue["method"]>
	>;
	request<const RequestValue extends McpClientProtocolRequest>(
		serverName: string,
		request: RequestValue,
		options?: RequestOptions & { readonly allowInputRequired?: false | undefined },
	): Promise<ResultTypeMap[RequestValue["method"]]>;
	request<const RequestValue extends McpClientProtocolRequest>(
		serverName: string,
		request: RequestValue,
		options?: RequestOptions,
	): Promise<
		ResultTypeMap[RequestValue["method"]] | InputRequiredResultForMethod<RequestValue["method"]>
	>;
	request<const RequestValue extends McpClientProtocolRequest>(
		serverName: string,
		request: RequestValue,
		options?: RequestOptions,
	): Promise<ResultTypeMap[RequestValue["method"]] | InputRequiredResult> {
		const stableRequest = snapshotProtocolValue(request, "MCP client request");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: stableRequest.method,
				exactResultMethod: stableRequest.method,
				params: stableRequest.params,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.request(toOfficialProtocolRequest(stableRequest), stableOptions),
		);
	}

	/** Sends a custom extension request and validates its result with a Standard Schema. */
	requestWithSchema<Schema extends StandardSchemaV1>(
		serverName: string,
		request: Request,
		resultSchema: Schema,
		options?: RequestOptions,
	): Promise<StandardSchemaV1.InferOutput<Schema>> {
		const stableRequest = snapshotProtocolValue(request, "MCP client extension request");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: stableRequest.method,
				params: stableRequest.params,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.request(stableRequest, resultSchema, stableOptions),
		);
	}

	/**
	 * Sends a modern multi-round-trip request in manual mode.
	 *
	 * A complete response is validated by `resultSchema`; an `input_required`
	 * response is returned as the official typed continuation payload.
	 */
	requestWithInputRequired<Method extends McpClientMrtrMethod, Schema extends StandardSchemaV1>(
		serverName: string,
		request: McpClientMrtrRequest<Method>,
		resultSchema: Schema,
		options?: McpClientMrtrRequestOptions,
	): Promise<McpClientMrtrResult<Schema>> {
		return this.#requestWithInputRequired(serverName, request, resultSchema, options);
	}

	/**
	 * Resumes one manual modern multi-round-trip round through a fresh official
	 * request. The server-owned `requestState` is echoed without interpretation.
	 * Only this round's `inputResponses` are included.
	 */
	resumeInputRequired<Method extends McpClientMrtrMethod, Schema extends StandardSchemaV1>(
		serverName: string,
		originalRequest: McpClientMrtrRequest<Method>,
		inputRequired: InputRequiredResult,
		inputResponses: InputResponses,
		resultSchema: Schema,
		options?: McpClientMrtrRequestOptions,
	): Promise<McpClientMrtrResult<Schema>> {
		const stableOriginalRequest = snapshotProtocolValue(
			originalRequest,
			"MCP input-required original request",
		);
		const stableInputResponses = snapshotProtocolValue(
			inputResponses,
			"MCP input-required responses",
		);
		const params: Record<string, unknown> = { ...stableOriginalRequest.params };
		// A caller may retain the immutable original across rounds. Never carry
		// continuation material from an earlier round into the next one.
		Reflect.deleteProperty(params, "inputResponses");
		Reflect.deleteProperty(params, "requestState");
		if (Object.keys(stableInputResponses).length > 0) {
			params.inputResponses = stableInputResponses;
		}
		if (inputRequired.requestState !== undefined) {
			params.requestState = inputRequired.requestState;
		}
		return this.#requestWithInputRequired(
			serverName,
			{ method: stableOriginalRequest.method, params },
			resultSchema,
			options,
		);
	}

	/** Sends an official notification through runtime policy and lifecycle hooks. */
	notification(
		serverName: string,
		notification: Notification,
		options?: NotificationOptions,
	): Promise<void> {
		const stableNotification = snapshotProtocolValue(notification, "MCP client notification");
		const stableOptions = snapshotProtocolValue(options, "MCP notification options");
		return this.#delegate(
			serverName,
			{
				method: stableNotification.method,
				kind: "notification",
				params: stableNotification.params,
				options: stableOptions,
			},
			(client) => client.notification(stableNotification, stableOptions),
		);
	}

	/** Requests argument suggestions for a prompt or resource template. */
	complete(
		serverName: string,
		params: CompleteRequest["params"],
		options?: RequestOptions,
	): Promise<CompleteResult> {
		const stableParams = snapshotProtocolValue(params, "MCP completion parameters");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "completion/complete",
				exactResultMethod: "completion/complete",
				capability: "completions",
				params: stableParams,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.complete(stableParams, stableOptions),
		);
	}

	/**
	 * Sets the minimum server log level on protocol eras that support it.
	 *
	 * @deprecated Deprecated by MCP 2026-07-28. Prefer stderr or OpenTelemetry.
	 */
	setLoggingLevel(
		serverName: string,
		level: LoggingLevel,
		options?: RequestOptions,
	): Promise<EmptyResult> {
		const stableParams = snapshotProtocolValue({ level }, "MCP logging/setLevel parameters");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "logging/setLevel",
				exactResultMethod: "logging/setLevel",
				capability: "logging",
				params: stableParams,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.setLoggingLevel(stableParams.level, stableOptions),
		);
	}

	listTools(
		serverName: string,
		params?: ListToolsRequest["params"],
		options?: CacheableRequestOptions,
	): Promise<ListToolsResult> {
		const stableParams = snapshotProtocolValue(params, "MCP tools/list parameters");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "tools/list",
				exactResultMethod: "tools/list",
				capability: "tools",
				params: stableParams,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.listTools(stableParams, stableOptions),
		);
	}

	callTool(
		serverName: string,
		params: CallToolRequest["params"],
		options: CallToolRequestOptions & { readonly allowInputRequired: true },
	): Promise<CallToolResult | InputRequiredResult>;
	callTool(
		serverName: string,
		params: CallToolRequest["params"],
		options?: CallToolRequestOptions & {
			readonly allowInputRequired?: false | undefined;
		},
	): Promise<CallToolResult>;
	callTool(
		serverName: string,
		params: CallToolRequest["params"],
		options: CallToolRequestOptions,
	): Promise<CallToolResult | InputRequiredResult>;
	callTool(
		serverName: string,
		params: CallToolRequest["params"],
		options?: CallToolRequestOptions,
	): Promise<CallToolResult | InputRequiredResult> {
		const stableParams = snapshotProtocolValue(params, "MCP tools/call parameters");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "tools/call",
				exactResultMethod: "tools/call",
				capability: "tools",
				params: stableParams,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.callTool(stableParams, stableOptions),
		);
	}

	listResources(
		serverName: string,
		params?: ListResourcesRequest["params"],
		options?: CacheableRequestOptions,
	): Promise<ListResourcesResult> {
		const stableParams = snapshotProtocolValue(params, "MCP resources/list parameters");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "resources/list",
				exactResultMethod: "resources/list",
				capability: "resources",
				params: stableParams,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.listResources(stableParams, stableOptions),
		);
	}

	listResourceTemplates(
		serverName: string,
		params?: ListResourceTemplatesRequest["params"],
		options?: CacheableRequestOptions,
	): Promise<ListResourceTemplatesResult> {
		const stableParams = snapshotProtocolValue(params, "MCP resources/templates/list parameters");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "resources/templates/list",
				exactResultMethod: "resources/templates/list",
				capability: "resources",
				params: stableParams,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.listResourceTemplates(stableParams, stableOptions),
		);
	}

	readResource(
		serverName: string,
		params: ReadResourceRequest["params"],
		options: CacheableRequestOptions & { readonly allowInputRequired: true },
	): Promise<ReadResourceResult | InputRequiredResult>;
	readResource(
		serverName: string,
		params: ReadResourceRequest["params"],
		options?: CacheableRequestOptions & {
			readonly allowInputRequired?: false | undefined;
		},
	): Promise<ReadResourceResult>;
	readResource(
		serverName: string,
		params: ReadResourceRequest["params"],
		options: CacheableRequestOptions,
	): Promise<ReadResourceResult | InputRequiredResult>;
	readResource(
		serverName: string,
		params: ReadResourceRequest["params"],
		options?: CacheableRequestOptions,
	): Promise<ReadResourceResult | InputRequiredResult> {
		const stableParams = snapshotProtocolValue(params, "MCP resources/read parameters");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "resources/read",
				exactResultMethod: "resources/read",
				capability: "resources",
				params: stableParams,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.readResource(stableParams, stableOptions),
		);
	}

	/** Uses the legacy-era per-resource subscription request. */
	subscribeResource(
		serverName: string,
		params: SubscribeRequest["params"],
		options?: RequestOptions,
	): Promise<EmptyResult> {
		const stableParams = snapshotProtocolValue(params, "MCP resources/subscribe parameters");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "resources/subscribe",
				exactResultMethod: "resources/subscribe",
				capability: "resources",
				params: stableParams,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.subscribeResource(stableParams, stableOptions),
		);
	}

	/** Uses the legacy-era per-resource unsubscribe request. */
	unsubscribeResource(
		serverName: string,
		params: UnsubscribeRequest["params"],
		options?: RequestOptions,
	): Promise<EmptyResult> {
		const stableParams = snapshotProtocolValue(params, "MCP resources/unsubscribe parameters");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "resources/unsubscribe",
				exactResultMethod: "resources/unsubscribe",
				capability: "resources",
				params: stableParams,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.unsubscribeResource(stableParams, stableOptions),
		);
	}

	/**
	 * Opens a modern change-notification stream and binds it to this runtime's
	 * connection lifecycle. Register notification handlers in `configureClient`
	 * before connecting.
	 */
	async listen(
		serverName: string,
		filter: SubscriptionFilter,
		options?: RequestOptions,
	): Promise<McpClientSubscription> {
		const stableFilter = snapshotProtocolValue(filter, "MCP subscription filter");
		const stableOptions = snapshotRequestOptions(options);
		const lifecycleEpoch = this.#lifecycleEpoch;
		const entry = this.#entry(serverName);
		return this.#delegate(
			serverName,
			{
				method: "subscriptions/listen",
				capability: "subscriptions",
				params: stableFilter,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			async (client) => {
				const subscription = await client.listen(stableFilter, stableOptions);
				try {
					this.#assertOperationCurrent(entry, lifecycleEpoch);
				} catch (entryError) {
					return closeUnmanagedSubscription(subscription, entryError);
				}
				return this.#manageSubscription(entry, subscription);
			},
		);
	}

	/** Returns runtime-opened subscription streams for one logical server. */
	activeSubscriptions(serverName: string): readonly McpClientSubscription[] {
		return Object.freeze(
			[...this.#entry(serverName).subscriptions].map((subscription) => subscription.handle),
		);
	}

	/** Returns the runtime-owned stream opened by `ClientOptions.listChanged`, when present. */
	getAutoOpenedSubscription(serverName: string): McpClientSubscription | undefined {
		return this.#entry(serverName).autoOpenedSubscription;
	}

	listPrompts(
		serverName: string,
		params?: ListPromptsRequest["params"],
		options?: CacheableRequestOptions,
	): Promise<ListPromptsResult> {
		const stableParams = snapshotProtocolValue(params, "MCP prompts/list parameters");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "prompts/list",
				exactResultMethod: "prompts/list",
				capability: "prompts",
				params: stableParams,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.listPrompts(stableParams, stableOptions),
		);
	}

	getPrompt(
		serverName: string,
		params: GetPromptRequest["params"],
		options: RequestOptions & { readonly allowInputRequired: true },
	): Promise<GetPromptResult | InputRequiredResult>;
	getPrompt(
		serverName: string,
		params: GetPromptRequest["params"],
		options?: RequestOptions & {
			readonly allowInputRequired?: false | undefined;
		},
	): Promise<GetPromptResult>;
	getPrompt(
		serverName: string,
		params: GetPromptRequest["params"],
		options: RequestOptions,
	): Promise<GetPromptResult | InputRequiredResult>;
	getPrompt(
		serverName: string,
		params: GetPromptRequest["params"],
		options?: RequestOptions,
	): Promise<GetPromptResult | InputRequiredResult> {
		const stableParams = snapshotProtocolValue(params, "MCP prompts/get parameters");
		const stableOptions = snapshotRequestOptions(options);
		return this.#delegate(
			serverName,
			{
				method: "prompts/get",
				exactResultMethod: "prompts/get",
				capability: "prompts",
				params: stableParams,
				options: stableOptions,
				signal: stableOptions?.signal,
			},
			(client) => client.getPrompt(stableParams, stableOptions),
		);
	}

	/**
	 * Notifies a legacy-era server that the client's roots changed.
	 *
	 * @deprecated Deprecated by MCP 2026-07-28. Pass paths through tool inputs,
	 * resource URIs, or configuration instead.
	 */
	sendRootsListChanged(serverName: string): Promise<void> {
		return this.#delegate(
			serverName,
			{
				method: "notifications/roots/list_changed",
				kind: "notification",
				capability: "roots",
			},
			(client) => client.sendRootsListChanged(),
		);
	}

	#manageSubscription(
		entry: RegistryEntry,
		sdkSubscription: McpSubscription,
	): McpClientSubscription {
		let closeTask: Promise<void> | undefined;
		let settled = false;
		let managed: ManagedSubscription;

		const handle: McpClientSubscription = Object.freeze({
			serverName: entry.definition.name,
			honoredFilter: sdkSubscription.honoredFilter,
			closed: sdkSubscription.closed,
			close: () => {
				if (settled) return Promise.resolve();
				if (closeTask !== undefined) return closeTask;
				const task = this.#runOperation(
					entry,
					{
						method: "notifications/cancelled",
						kind: "notification",
						capability: "subscriptions",
					},
					() => sdkSubscription.close(),
					true,
				);
				closeTask = task;
				void task.catch(() => {
					if (closeTask === task) closeTask = undefined;
				});
				return task;
			},
		});
		managed = Object.freeze({ sdk: sdkSubscription, handle });
		entry.subscriptions.add(managed);
		void sdkSubscription.closed.then(() => {
			settled = true;
			entry.subscriptions.delete(managed);
			if (entry.autoOpenedSubscription === handle) entry.autoOpenedSubscription = undefined;
		});
		return handle;
	}

	#requestWithInputRequired<Schema extends StandardSchemaV1>(
		serverName: string,
		request: Request & { readonly method: McpClientMrtrMethod },
		resultSchema: Schema,
		options?: McpClientMrtrRequestOptions,
	): Promise<McpClientMrtrResult<Schema>> {
		const stableRequest = snapshotProtocolValue(request, "MCP input-required request");
		const requestOptions = snapshotRequestOptions({ ...options, allowInputRequired: true });
		return this.#delegate(
			serverName,
			{
				method: stableRequest.method,
				capability: MRTR_CAPABILITY[stableRequest.method],
				params: stableRequest.params,
				options: requestOptions,
				signal: requestOptions.signal,
			},
			(client) => client.request(stableRequest, withInputRequired(resultSchema), requestOptions),
		);
	}

	#connectAttempt(
		serverName: string,
		options: ConnectOptions | undefined,
	): Promise<ConnectAttemptResult> {
		this.#assertOpen();
		const lifecycleEpoch = this.#lifecycleEpoch;
		const entry = this.#entry(serverName);
		this.#assertConnectAttemptCurrent(entry, lifecycleEpoch);
		const connectOptions = mergeConnectOptions(entry, options);
		const operation = this.#runOperation(
			entry,
			{
				method: "runtime/connect",
				params: connectOptions.prior === undefined ? undefined : { prior: connectOptions.prior },
				options: connectOptions,
				signal: connectOptions.signal,
			},
			() => {
				this.#assertConnectAttemptCurrent(entry, lifecycleEpoch);
				return this.#connectEntry(entry, connectOptions, lifecycleEpoch);
			},
		);
		const attempt = operation.then((result) => {
			// A middleware may hold the pipeline open after `next()` while close()
			// disconnects the connection established by the terminal.
			this.#assertConnectAttemptCurrent(entry, lifecycleEpoch);
			return result;
		});
		return attempt;
	}

	async #delegate<Output>(
		serverName: string,
		descriptor: OperationDescriptor,
		terminal: (client: Client) => Promise<Output>,
	): Promise<Output> {
		this.#assertOpen();
		const lifecycleEpoch = this.#lifecycleEpoch;
		const entry = this.#entry(serverName);
		this.#assertOperationCurrent(entry, lifecycleEpoch);
		const result = await this.#runOperation(entry, descriptor, () => {
			this.#assertOperationCurrent(entry, lifecycleEpoch);
			const client =
				entry.state === "connected" && entry.client !== undefined ? entry.client : undefined;
			if (client === undefined) throw clientNotConnectedError(serverName);
			return terminal(client);
		});
		// Do not let a middleware-held operation from a retired entry appear to
		// succeed after that logical server has been unregistered.
		this.#assertOperationCurrent(entry, lifecycleEpoch);
		return result;
	}

	async #runOperation<Output>(
		entry: RegistryEntry,
		descriptor: OperationDescriptor,
		terminal: () => Promise<Output>,
		requireTerminal = false,
	): Promise<Output> {
		let terminalTask: Promise<Output> | undefined;
		const invokeTerminal = (): Promise<Output> => {
			terminalTask ??= Promise.resolve().then(terminal);
			return terminalTask;
		};

		try {
			const operationInput = freezeOperationInput(entry.definition.name, descriptor);
			if (
				descriptor.exactResultMethod !== undefined &&
				!canReturnInputRequired(descriptor.exactResultMethod, descriptor.options)
			) {
				markExactMcpClientResult(operationInput, descriptor.exactResultMethod);
			}
			const resolvedPrincipal =
				this.#resolvePrincipal === undefined
					? this.#principal
					: await this.#resolvePrincipal(operationInput);
			const resolvedAttributes =
				this.#resolveAttributes === undefined ? {} : await this.#resolveAttributes(operationInput);
			const context = createMcpOperationContext<Principal>({
				operationId: this.#operationIdFactory(),
				role: "client",
				operation: {
					name: descriptor.method,
					kind: descriptor.kind ?? "request",
					...(descriptor.capability === undefined ? {} : { capability: descriptor.capability }),
					target: entry.definition.name,
					attributes: { transportKind: entry.definition.transport.kind },
				},
				...(descriptor.signal === undefined ? {} : { signal: descriptor.signal }),
				...(entry.transport?.sessionId === undefined
					? {}
					: { sessionId: entry.transport.sessionId }),
				...(resolvedPrincipal === undefined ? {} : { principal: resolvedPrincipal }),
				attributes: {
					...this.#attributes,
					...entry.definition.attributes,
					...resolvedAttributes,
				},
			});
			const operation = createMcpOperation(operationInput, context);
			const middleware: McpClientMiddleware<Principal>[] =
				this.#lifecycleMiddleware === undefined ? [] : [this.#lifecycleMiddleware];
			if (requireTerminal) {
				middleware.push(async (_operation, next) => {
					try {
						await next();
					} catch (middlewareError) {
						return invokeRequiredTerminal(invokeTerminal, middlewareError);
					}
					return invokeTerminal();
				});
			}
			middleware.push(...this.#middleware, ...this.#transforms);
			const pipeline = composeMcpMiddleware<
				McpClientOperationInput,
				unknown,
				McpClientOperationContext<Principal>
			>(middleware, requireTerminal ? invokeTerminal : terminal);
			// The shared chain deliberately erases per-method output shapes; the terminal preserves Output.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
			return (await pipeline(operation)) as Output;
		} catch (operationError) {
			if (!requireTerminal || terminalTask !== undefined) throw operationError;
			return invokeRequiredTerminal(invokeTerminal, operationError);
		}
	}

	async #connectEntry(
		entry: RegistryEntry,
		options: ConnectOptions,
		lifecycleEpoch: number,
	): Promise<ConnectAttemptResult> {
		this.#assertConnectAttemptCurrent(entry, lifecycleEpoch);
		options.signal?.throwIfAborted();
		if (entry.state === "connected" && entry.client !== undefined) {
			return { client: entry.client, generation: entry.connectionGeneration };
		}
		if (entry.connectTask !== undefined) {
			const { client, generation } = await observeConnectAttempt(
				entry.connectTask,
				entry.connectDetachment?.promise,
				options.signal,
			);
			return { client, generation };
		}
		if (entry.disconnectTask !== undefined) {
			await entry.disconnectTask;
			// Another caller may have won the connection transition while this
			// caller was waiting for teardown. Re-enter the atomic checks.
			this.#assertConnectAttemptCurrent(entry, lifecycleEpoch);
			return this.#connectEntry(entry, options, lifecycleEpoch);
		}

		entry.state = "connecting";
		entry.connectedAt = undefined;
		entry.disconnectedAt = undefined;
		entry.lastError = undefined;

		const connectionToken = Symbol(entry.definition.name);
		const connectAttemptToken = Symbol(`${entry.definition.name}:connect-attempt`);
		const connectAbortController = new AbortController();
		const connectDetachment = createConnectAttemptDetachment();
		const unlinkCallerSignal = linkAbortSignal(options.signal, connectAbortController);
		const connectOptions: ConnectOptions & { readonly signal: AbortSignal } = {
			...options,
			signal: connectAbortController.signal,
		};
		entry.connectAttemptToken = connectAttemptToken;
		entry.connectAbortController = connectAbortController;
		entry.connectDetachment = connectDetachment;
		entry.connectUnlinkCallerSignal = unlinkCallerSignal;
		const task = this.#establishConnection(
			entry,
			connectOptions,
			connectionToken,
			connectAttemptToken,
			lifecycleEpoch,
		);
		entry.connectTask = task;
		void task.then(
			() => {
				this.#releaseConnectAttempt(entry, task, connectAttemptToken);
			},
			() => {
				this.#releaseConnectAttempt(entry, task, connectAttemptToken);
			},
		);
		const established = await observeConnectAttempt(
			task,
			connectDetachment.promise,
			options.signal,
		);
		return {
			client: established.client,
			generation: established.generation,
			ownedConnectionToken: established.connectionToken,
		};
	}

	async #establishConnection(
		entry: RegistryEntry,
		options: ConnectOptions & { readonly signal: AbortSignal },
		connectionToken: symbol,
		connectAttemptToken: symbol,
		lifecycleEpoch: number,
	): Promise<EstablishedConnection> {
		const definition = entry.definition;
		const clientOptions = resolveClientOptions(definition.clientOptions);
		const client = this.#clientFactory.createClient(
			definition.clientInfo ?? this.#clientInfo,
			clientOptions,
			{ serverName: definition.name, definition },
		);
		entry.client = client;
		let unownedTransport: Transport | undefined;

		try {
			options.signal.throwIfAborted();
			await definition.configureClient?.(client, {
				serverName: definition.name,
				definition,
			});
			options.signal.throwIfAborted();
			this.#assertConnectAttemptCurrent(entry, lifecycleEpoch, connectAttemptToken);
			this.#attachClientLifecycle(entry, client);
			const transportFactory = definition.transportFactory ?? this.#transportFactory;
			unownedTransport = await transportFactory.createTransport(definition.transport, {
				serverName: definition.name,
				signal: options.signal,
			});
			options.signal.throwIfAborted();
			this.#assertConnectAttemptCurrent(entry, lifecycleEpoch, connectAttemptToken);
			const transport = unownedTransport;
			entry.transport = transport;
			// Client.connect synchronously takes ownership before its first await.
			unownedTransport = undefined;
			await client.connect(transport, options);
			options.signal.throwIfAborted();
			this.#assertConnectAttemptCurrent(entry, lifecycleEpoch, connectAttemptToken);
			if (client.autoOpenedSubscription !== undefined) {
				entry.autoOpenedSubscription = this.#manageSubscription(
					entry,
					client.autoOpenedSubscription,
				);
			}
			entry.connectionGeneration += 1;
			entry.connectionToken = connectionToken;
			entry.state = "connected";
			entry.connectedAt = this.#timestamp();
			entry.lastError = undefined;
			this.#refreshMetadata(entry);
			return { client, generation: entry.connectionGeneration, connectionToken };
		} catch (error) {
			const failure = await closeAfterFailedConnect(client, error, unownedTransport);
			if (entry.connectAttemptToken === connectAttemptToken) {
				entry.state = "failed";
				entry.lastError = toMcpErrorDetails(failure);
				if (entry.client === client) {
					entry.client = undefined;
					entry.transport = undefined;
					entry.connectionToken = undefined;
					entry.subscriptions.clear();
					entry.autoOpenedSubscription = undefined;
				}
			}
			throw failure;
		}
	}

	#attachClientLifecycle(entry: RegistryEntry, client: Client): void {
		const configuredOnClose = client.onclose;
		// The official SDK exposes callback slots rather than EventTarget listeners.
		// oxlint-disable-next-line unicorn/prefer-add-event-listener
		client.onclose = () => {
			if (entry.client === client && entry.state === "connected") {
				this.#refreshMetadata(entry);
				entry.state = "disconnected";
				entry.disconnectedAt = this.#timestamp();
				entry.client = undefined;
				entry.transport = undefined;
				entry.connectionToken = undefined;
				entry.subscriptions.clear();
				entry.autoOpenedSubscription = undefined;
			}
			configuredOnClose?.();
		};

		const configuredOnError = client.onerror;
		// The official SDK exposes callback slots rather than EventTarget listeners.
		// oxlint-disable-next-line unicorn/prefer-add-event-listener
		client.onerror = (error) => {
			entry.lastError = toMcpErrorDetails(error);
			configuredOnError?.(error);
		};
	}

	#disconnectEntry(entry: RegistryEntry): Promise<void> {
		if (entry.disconnectTask !== undefined) return entry.disconnectTask;
		const disconnectToken = Symbol(`${entry.definition.name}:disconnect`);
		entry.disconnectToken = disconnectToken;
		const task = this.#performDisconnect(entry, disconnectToken);
		entry.disconnectTask = task;
		void task.then(
			() => {
				this.#releaseDisconnect(entry, task, disconnectToken);
			},
			() => {
				this.#releaseDisconnect(entry, task, disconnectToken);
			},
		);
		return task;
	}

	async #performDisconnect(entry: RegistryEntry, disconnectToken: symbol): Promise<void> {
		const failures: unknown[] = [];
		const deadline = performance.now() + this.#shutdownTimeoutMs;
		let timedOut = false;
		const connectTask = entry.connectTask;
		const connectAttemptToken = entry.connectAttemptToken;
		if (connectTask !== undefined) {
			const outcome = await settleTaskWithin(connectTask, remainingTime(deadline));
			if (outcome.status === "timeout") {
				timedOut = true;
				const timeoutError = shutdownTimeoutError(entry.definition.name, this.#shutdownTimeoutMs);
				failures.push(timeoutError);
				entry.connectDetachment?.detach(timeoutError);
				this.#releaseConnectAttempt(entry, connectTask, connectAttemptToken);
			}
		}

		const client = entry.client;
		if (client === undefined) {
			entry.state = "disconnected";
			entry.disconnectedAt = this.#timestamp();
			entry.transport = undefined;
			entry.connectionToken = undefined;
			entry.subscriptions.clear();
			entry.autoOpenedSubscription = undefined;
		} else {
			entry.state = "disconnecting";
			this.#refreshMetadata(entry);
			const cleanupFailures: unknown[] = [];
			const cleanupTimedOut = await this.#closeConnection(
				entry,
				client,
				disconnectToken,
				cleanupFailures,
				deadline,
			);
			failures.push(...cleanupFailures);
			if (cleanupTimedOut && !timedOut) {
				timedOut = true;
				failures.push(shutdownTimeoutError(entry.definition.name, this.#shutdownTimeoutMs));
			}
		}

		if (failures.length === 0) return;
		const failure =
			failures.length === 1
				? failures[0]
				: new AggregateError(
						failures,
						`The MCP server ${JSON.stringify(entry.definition.name)} did not shut down cleanly.`,
					);
		entry.state = "failed";
		entry.lastError = toMcpErrorDetails(failure);
		throw failure;
	}

	async #closeConnection(
		entry: RegistryEntry,
		client: Client,
		disconnectToken: symbol,
		failures: unknown[],
		deadline: number,
	): Promise<boolean> {
		let timedOut = false;
		const subscriptionTask = Promise.all(
			[...entry.subscriptions].map(async (subscription) => {
				try {
					await subscription.handle.close();
				} catch (error) {
					failures.push(error);
				}
			}),
		);
		const subscriptionOutcome = await settleTaskWithin(subscriptionTask, remainingTime(deadline));
		switch (subscriptionOutcome.status) {
			case "fulfilled":
				break;
			case "rejected":
				failures.push(subscriptionOutcome.reason);
				break;
			case "timeout":
				timedOut = true;
				break;
		}

		const clientCloseTask = Promise.resolve().then(() => client.close());
		const clientCloseOutcome = await settleTaskWithin(clientCloseTask, remainingTime(deadline));
		switch (clientCloseOutcome.status) {
			case "fulfilled":
				break;
			case "rejected":
				failures.push(clientCloseOutcome.reason);
				break;
			case "timeout":
				timedOut = true;
				break;
		}
		if (entry.disconnectToken === disconnectToken) this.#detachConnection(entry, client);

		if (entry.disconnectToken !== disconnectToken) return timedOut;
		entry.disconnectedAt = this.#timestamp();
		if (failures.length === 0) entry.state = "disconnected";
		return timedOut;
	}

	#detachConnection(entry: RegistryEntry, client: Client): void {
		entry.subscriptions.clear();
		entry.autoOpenedSubscription = undefined;
		if (entry.client === client) {
			entry.client = undefined;
			entry.transport = undefined;
			entry.connectionToken = undefined;
		}
	}

	#releaseDisconnect(entry: RegistryEntry, task: Promise<void>, disconnectToken: symbol): void {
		if (entry.disconnectTask === task) entry.disconnectTask = undefined;
		if (entry.disconnectToken === disconnectToken) entry.disconnectToken = undefined;
	}

	#snapshotEntry(entry: RegistryEntry): McpClientConnectionSnapshot {
		this.#refreshMetadata(entry);
		return Object.freeze({
			name: entry.definition.name,
			state: entry.state,
			transportKind: entry.definition.transport.kind,
			...(entry.metadata.sessionId === undefined ? {} : { sessionId: entry.metadata.sessionId }),
			...(entry.connectedAt === undefined ? {} : { connectedAt: entry.connectedAt }),
			...(entry.disconnectedAt === undefined ? {} : { disconnectedAt: entry.disconnectedAt }),
			...(entry.metadata.negotiatedProtocolVersion === undefined
				? {}
				: { negotiatedProtocolVersion: entry.metadata.negotiatedProtocolVersion }),
			...(entry.metadata.protocolEra === undefined
				? {}
				: { protocolEra: entry.metadata.protocolEra }),
			...(entry.metadata.serverInfo === undefined ? {} : { serverInfo: entry.metadata.serverInfo }),
			...(entry.metadata.serverCapabilities === undefined
				? {}
				: { serverCapabilities: entry.metadata.serverCapabilities }),
			...(entry.metadata.instructions === undefined
				? {}
				: { instructions: entry.metadata.instructions }),
			...(entry.metadata.discoverResult === undefined
				? {}
				: { discoverResult: entry.metadata.discoverResult }),
			...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
		});
	}

	#refreshMetadata(entry: RegistryEntry): void {
		const client = entry.client;
		if (client === undefined) return;
		entry.metadata.sessionId = entry.transport?.sessionId;
		entry.metadata.negotiatedProtocolVersion = client.getNegotiatedProtocolVersion();
		entry.metadata.protocolEra = client.getProtocolEra();
		entry.metadata.serverInfo = client.getServerVersion();
		entry.metadata.serverCapabilities = client.getServerCapabilities();
		entry.metadata.instructions = client.getInstructions();
		entry.metadata.discoverResult = client.getDiscoverResult();
	}

	#entry(serverName: string, allowRetired = false): RegistryEntry {
		const entry = this.#entries.get(serverName);
		if (entry === undefined || (!allowRetired && entry.retired)) {
			throw serverNotFoundError(serverName);
		}
		return entry;
	}

	#assertOpen(): void {
		if (this.#closed) throw runtimeClosedError();
	}

	#abortConnectAttempt(entry: RegistryEntry, reason: unknown): void {
		entry.connectAbortController?.abort(reason);
	}

	#releaseConnectAttempt(
		entry: RegistryEntry,
		task: Promise<EstablishedConnection>,
		connectAttemptToken: symbol | undefined,
	): void {
		if (entry.connectTask === task) entry.connectTask = undefined;
		if (connectAttemptToken !== undefined && entry.connectAttemptToken === connectAttemptToken) {
			entry.connectUnlinkCallerSignal?.();
			entry.connectAttemptToken = undefined;
			entry.connectAbortController = undefined;
			entry.connectDetachment = undefined;
			entry.connectUnlinkCallerSignal = undefined;
		}
	}

	#assertConnectAttemptCurrent(
		entry: RegistryEntry,
		lifecycleEpoch: number,
		connectAttemptToken?: symbol,
	): void {
		if (connectAttemptToken !== undefined && entry.connectAttemptToken !== connectAttemptToken) {
			throw staleConnectAttemptError(entry, this.#closed);
		}
		this.#assertOperationCurrent(entry, lifecycleEpoch);
	}

	#assertOperationCurrent(entry: RegistryEntry, lifecycleEpoch: number): void {
		if (this.#closed || lifecycleEpoch !== this.#lifecycleEpoch) throw runtimeClosedError();
		this.#assertEntryActive(entry);
	}

	#assertEntryActive(entry: RegistryEntry): void {
		if (entry.retired || this.#entries.get(entry.definition.name) !== entry) {
			throw serverNotFoundError(entry.definition.name);
		}
	}

	#timestamp(): number {
		const timestamp = this.#now();
		if (!Number.isFinite(timestamp))
			throw new TypeError("Runtime clock must return a finite timestamp.");
		return timestamp;
	}
}

function createRegistryEntry(definition: McpClientServerDefinition): RegistryEntry {
	return {
		definition,
		state: "disconnected",
		prior: definition.prior ?? definition.connectOptions?.prior,
		client: undefined,
		transport: undefined,
		connectTask: undefined,
		connectAbortController: undefined,
		connectAttemptToken: undefined,
		connectDetachment: undefined,
		connectUnlinkCallerSignal: undefined,
		disconnectTask: undefined,
		disconnectToken: undefined,
		connectedAt: undefined,
		disconnectedAt: undefined,
		lastError: undefined,
		subscriptions: new Set(),
		autoOpenedSubscription: undefined,
		connectionGeneration: 0,
		connectionToken: undefined,
		retired: false,
		metadata: {
			sessionId: undefined,
			negotiatedProtocolVersion: undefined,
			protocolEra: undefined,
			serverInfo: undefined,
			serverCapabilities: undefined,
			instructions: undefined,
			discoverResult: undefined,
		},
	};
}

async function invokeRequiredTerminal<Output>(
	terminal: () => Promise<Output>,
	primaryError: unknown,
): Promise<never> {
	try {
		await terminal();
	} catch (cleanupError) {
		if (cleanupError !== primaryError) {
			// Both caught failures are retained explicitly in AggregateError.errors.
			// oxlint-disable-next-line eslint/preserve-caught-error
			throw new AggregateError(
				[primaryError, cleanupError],
				"MCP cleanup middleware and its required terminal both failed.",
				{ cause: cleanupError },
			);
		}
	}
	throw primaryError;
}

async function closeUnmanagedSubscription(
	subscription: McpSubscription,
	primaryError: unknown,
): Promise<never> {
	try {
		await subscription.close();
	} catch (cleanupError) {
		// oxlint-disable-next-line eslint/preserve-caught-error
		throw new AggregateError(
			[primaryError, cleanupError],
			"The MCP subscription opened for a retired client failed to close.",
			{ cause: cleanupError },
		);
	}
	throw primaryError;
}

function toOfficialProtocolRequest<const RequestValue extends McpClientProtocolRequest>(
	request: RequestValue,
): {
	readonly method: RequestValue["method"];
	readonly params?: Record<string, unknown>;
} {
	return {
		method: request.method,
		...(!("params" in request) || request.params === undefined ? {} : { params: request.params }),
	};
}

function normalizeServerDefinition(
	definition: McpClientServerDefinition,
): McpClientServerDefinition {
	if (typeof definition !== "object" || definition === null) {
		throw new TypeError("MCP server definition must be an object.");
	}
	assertNonEmpty(definition.name, "server name");
	if (typeof definition.transport !== "object" || definition.transport === null) {
		throw new TypeError("MCP server transport definition must be an object.");
	}

	let transport: McpClientServerDefinition["transport"];
	switch (definition.transport.kind) {
		case "http":
			transport = Object.freeze({
				...definition.transport,
				...(definition.transport.middleware === undefined
					? {}
					: { middleware: Object.freeze([...definition.transport.middleware]) }),
			});
			break;
		case "stdio":
			transport = Object.freeze({
				...definition.transport,
				...(definition.transport.args === undefined
					? {}
					: { args: Object.freeze([...definition.transport.args]) }),
				...(definition.transport.env === undefined
					? {}
					: { env: Object.freeze({ ...definition.transport.env }) }),
			});
			break;
		default:
			throw new TypeError("MCP server transport kind must be http or stdio.");
	}

	return Object.freeze({
		...definition,
		transport,
		...(definition.clientInfo === undefined
			? {}
			: { clientInfo: Object.freeze({ ...definition.clientInfo }) }),
		...(definition.clientOptions === undefined
			? {}
			: { clientOptions: { ...definition.clientOptions } }),
		...(definition.connectOptions === undefined
			? {}
			: { connectOptions: { ...definition.connectOptions } }),
		...(definition.attributes === undefined
			? {}
			: { attributes: Object.freeze({ ...definition.attributes }) }),
	});
}

function resolveClientOptions(options: ClientOptions | undefined): ClientOptions {
	return {
		...options,
		versionNegotiation: {
			...options?.versionNegotiation,
			mode: options?.versionNegotiation?.mode ?? "auto",
		},
	};
}

function mergeConnectOptions(
	entry: RegistryEntry,
	override: ConnectOptions | undefined,
): ConnectOptions {
	const configured = entry.definition.connectOptions;
	const prior = override?.prior ?? entry.prior ?? configured?.prior;
	return {
		...configured,
		...override,
		...(prior === undefined ? {} : { prior }),
	};
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
	if (source === undefined) return () => undefined;
	const abort = (): void => target.abort(source.reason);
	if (source.aborted) {
		abort();
		return () => undefined;
	}
	source.addEventListener("abort", abort, { once: true });
	return () => source.removeEventListener("abort", abort);
}

function observeConnectAttempt<Value>(
	task: Promise<Value>,
	detachment: Promise<never> | undefined,
	callerSignal: AbortSignal | undefined,
): Promise<Value> {
	const alternatives: Array<Promise<Value>> = [task];
	if (detachment !== undefined) alternatives.push(detachment);
	if (callerSignal === undefined) {
		return alternatives.length === 1 ? task : Promise.race(alternatives);
	}
	if (callerSignal.aborted) return Promise.reject(abortReason(callerSignal));
	return new Promise<Value>((resolve, reject) => {
		const aborted = (): void => reject(abortReason(callerSignal));
		callerSignal.addEventListener("abort", aborted, { once: true });
		void Promise.race(alternatives).then(
			(value) => {
				callerSignal.removeEventListener("abort", aborted);
				resolve(value);
			},
			(error: unknown) => {
				callerSignal.removeEventListener("abort", aborted);
				reject(error);
			},
		);
	});
}

function staleConnectAttemptError(entry: RegistryEntry, runtimeClosed: boolean): Error {
	if (runtimeClosed) return runtimeClosedError();
	return entry.retired
		? serverNotFoundError(entry.definition.name)
		: connectionAbortedError(entry.definition.name);
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The MCP connection was aborted.", "AbortError");
}

function createConnectAttemptDetachment(): ConnectAttemptDetachment {
	let detach: ((error: unknown) => void) | undefined;
	let detached = false;
	const promise = new Promise<never>((_resolve, reject) => {
		detach = reject;
	});
	return {
		promise,
		detach(error: unknown): void {
			if (detached) return;
			detached = true;
			detach?.(error);
		},
	};
}

type TaskOutcome<Value> =
	| { readonly status: "fulfilled"; readonly value: Value }
	| { readonly status: "rejected"; readonly reason: unknown }
	| { readonly status: "timeout" };

async function settleTaskWithin<Value>(
	task: Promise<Value>,
	timeoutMs: number,
): Promise<TaskOutcome<Value>> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<TaskOutcome<Value>>((resolve) => {
		timeout = setTimeout(resolve, timeoutMs, { status: "timeout" });
	});
	try {
		return await Promise.race([
			task.then(
				(value): TaskOutcome<Value> => ({ status: "fulfilled", value }),
				(reason: unknown): TaskOutcome<Value> => ({ status: "rejected", reason }),
			),
			expired,
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function remainingTime(deadline: number): number {
	return Math.max(0, deadline - performance.now());
}

function connectionAbortedError(serverName: string): DOMException {
	return new DOMException(
		`The MCP server ${JSON.stringify(serverName)} connection was disconnected.`,
		"AbortError",
	);
}

function freezeOperationInput(
	serverName: string,
	descriptor: OperationDescriptor,
): McpClientOperationInput {
	return Object.freeze({
		serverName,
		method: descriptor.method,
		...(descriptor.params === undefined ? {} : { params: descriptor.params }),
		...(descriptor.options === undefined ? {} : { options: descriptor.options }),
	});
}

function snapshotRequestOptions<Options extends RequestOptions | undefined>(
	options: Options,
): Options {
	if (options === undefined) return options;
	const toolDefinition =
		"toolDefinition" in options ? Reflect.get(options, "toolDefinition") : undefined;
	const snapshot = Object.freeze({
		...options,
		...(options.headers === undefined ? {} : { headers: Object.freeze({ ...options.headers }) }),
		...(toolDefinition === undefined
			? {}
			: {
					toolDefinition: snapshotProtocolValue(toolDefinition, "MCP call tool definition"),
				}),
	});
	// A shallow option snapshot preserves callback/signal identities and every
	// subtype field while making result-affecting flags immutable for this call.
	return snapshot;
}

function snapshotProtocolValue<Value>(value: Value, label: string): Value {
	let snapshot: Value;
	try {
		snapshot = structuredClone(value);
	} catch (cause) {
		throw new TypeError(`${label} must be structured-cloneable JSON.`, { cause });
	}
	freezeProtocolValue(snapshot, label, new Set(), new Set());
	return snapshot;
}

function freezeProtocolValue(
	value: unknown,
	label: string,
	ancestors: Set<object>,
	visited: Set<object>,
): void {
	if (
		value === undefined ||
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return;
	}
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw new TypeError(`${label} must not contain non-finite numbers.`);
	}
	if (typeof value !== "object") {
		throw new TypeError(`${label} must contain only JSON-compatible values.`);
	}
	if (visited.has(value)) return;
	if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles.`);
	if (!Array.isArray(value)) {
		const prototype = Object.getPrototypeOf(value) as unknown;
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError(`${label} must contain only JSON arrays and objects.`);
		}
	}
	ancestors.add(value);
	for (const entry of Array.isArray(value) ? value : Object.values(value)) {
		freezeProtocolValue(entry, label, ancestors, visited);
	}
	ancestors.delete(value);
	visited.add(value);
	Object.freeze(value);
}

function canReturnInputRequired(method: RequestMethod, options: unknown): boolean {
	return (
		(method === "tools/call" || method === "prompts/get" || method === "resources/read") &&
		typeof options === "object" &&
		options !== null &&
		"allowInputRequired" in options &&
		options.allowInputRequired === true
	);
}

type InputRequiredResultForMethod<Method extends RequestMethod> = Method extends McpClientMrtrMethod
	? InputRequiredResult
	: never;

async function closeAfterFailedConnect(
	client: Client,
	primary: unknown,
	unownedTransport?: Transport,
): Promise<unknown> {
	const failures: unknown[] = [primary];
	if (unownedTransport !== undefined) {
		try {
			await unownedTransport.close();
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
	}
	try {
		await client.close();
	} catch (cleanupError) {
		failures.push(cleanupError);
	}
	return failures.length === 1
		? primary
		: new AggregateError(
				failures,
				"The MCP connection failed and one or more owned resources failed to close.",
			);
}

function throwSettledFailures(
	settled: readonly PromiseSettledResult<unknown>[],
	message: string,
): void {
	const failures = settled
		.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		.map((result) => result.reason as unknown);
	throwFailures(failures, message);
}

function throwFailures(failures: readonly unknown[], message: string): void {
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, message);
}

function assertNonEmpty(value: string, field: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${field} must be a non-empty string.`);
	}
}

function assertPositiveFinite(value: number, field: string): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new TypeError(`MCP client ${field} must be a positive finite number.`);
	}
}
