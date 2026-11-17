import type {
	CompleteRequest,
	CompleteResult,
	ContentBlock,
	GetPromptResult,
	JsonSchemaType,
	Prompt,
	ReadResourceResult,
	Resource,
	ServerCapabilities,
	StandardSchemaWithJSON,
	Tool,
	Variables,
} from "@modelcontextprotocol/server";
import { UriTemplate, isInputRequiredResult } from "@modelcontextprotocol/server";
import {
	McpAuthorizationError,
	allowMcpOperation,
	composeMcpMiddleware,
	createMcpLifecycleMiddleware,
	createMcpOperation,
	enforceMcpAuthorization,
} from "@nest-mcp/core";
import type {
	McpAuthorizationAllowDecision,
	McpOperation,
	McpOperationHandler,
	MaybePromise,
} from "@nest-mcp/core";
import { ResourceTemplate, fromJsonSchema } from "@nest-mcp/server";
import type { CallToolResult, McpServerBuildContext, McpServerFeature } from "@nest-mcp/server";
import {
	InMemoryMcpGatewayDiscoveryCache,
	freezeMcpGatewayDiscoverySnapshot,
} from "./discovery-cache.ts";
import { GatewayNameCodec } from "./gateway-name-codec.ts";
import { GatewayPromptNameCodec } from "./gateway-prompt-name-codec.ts";
import { GatewayLifecycle } from "./gateway-lifecycle.ts";
import { GatewayResourceTemplateUriCodec } from "./gateway-resource-template-uri-codec.ts";
import { GatewayResourceUriCodec } from "./gateway-resource-uri-codec.ts";
import { isExactMcpGatewayTransform } from "./gateway-middleware.ts";
import {
	createGatewayOperationContext,
	createGatewayPolicyContext,
	toSafeGatewayPrincipal,
} from "./gateway-operation.ts";
import { McpGatewayError } from "./mcp-gateway.errors.ts";
import type {
	McpGatewayAuthorizationContextResolver,
	McpGatewayDiscoveryCache,
	McpGatewayDiscoveryCacheKey,
	McpGatewayDiscoveryOperationInput,
	McpGatewayDiscoverySnapshot,
	McpGatewayInvocationOperationInput,
	McpGatewayLifecycleObserver,
	McpGatewayMiddleware,
	McpGatewayOperationContext,
	McpGatewayOperationInput,
	McpGatewayOperationOutput,
	McpGatewayOptions,
	McpGatewayServerFeatureOptions,
	McpGatewayPolicy,
	McpGatewayPolicyInput,
	McpGatewayProjectedPrompt,
	McpGatewayProjectedResource,
	McpGatewayProjectedResourceTemplate,
	McpGatewayProjectedTool,
	McpGatewayPromptGetOperationInput,
	McpGatewayPromptPolicyInput,
	McpGatewayRequestContext,
	McpGatewayResolvedRequestContext,
	McpGatewayResourcePolicyInput,
	McpGatewayResourceReadOperationInput,
	McpGatewayResourceTemplateDefinition,
	McpGatewayResourceTemplatePolicyInput,
	McpGatewayResourceTemplateReadOperationInput,
	McpGatewayToolClient,
	McpGatewayTopologyMutationOptions,
	McpGatewayTopologySnapshot,
	McpGatewayUpstream,
} from "./mcp-gateway.types.ts";

const GATEWAY_META_KEY = "nest-mcp/gateway";
const DEFAULT_DISCOVERY_MAX_PAGES = 64;
const DEFAULT_DISCOVERY_MAX_ITEMS = 10_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 60_000;
const DEFAULT_DISCOVERY_MAX_ITEM_BYTES = 256 * 1_024;
const DEFAULT_DISCOVERY_MAX_SNAPSHOT_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_DISCOVERY_MAX_DEPTH = 64;
const DEFAULT_DISCOVERY_MAX_STRING_BYTES = 64 * 1_024;
const DEFAULT_DISCOVERY_MAX_CONCURRENT_FLIGHTS = 64;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_OPERATION_INPUT_BYTES = 1_048_576;
const MAX_OPERATION_INPUT_DEPTH = 64;
const MAX_OPERATION_INPUT_NODES = 100_000;

type GatewayCompletionParams = CompleteRequest["params"];
type GatewayPromptCompletionParams = Omit<GatewayCompletionParams, "ref"> & {
	readonly ref: Extract<GatewayCompletionParams["ref"], { readonly type: "ref/prompt" }>;
};
type GatewayResourceTemplateCompletionParams = Omit<GatewayCompletionParams, "ref"> & {
	readonly ref: Extract<GatewayCompletionParams["ref"], { readonly type: "ref/resource" }>;
};

interface GatewayDiscoveryFlight {
	readonly controller: AbortController;
	readonly promise: Promise<McpGatewayDiscoverySnapshot>;
	readonly rawSettled: Promise<void>;
	settled: boolean;
	waiters: number;
}

/** Long-lived gateway runtime; expose it through one or more MCP server definitions. */
export class McpGateway implements AsyncDisposable {
	#upstreams: ReadonlyMap<string, McpGatewayUpstream>;
	readonly #dynamicUpstreams: boolean;
	readonly #policy: McpGatewayPolicy;
	readonly #nameCodec: NonNullable<McpGatewayOptions["nameCodec"]>;
	readonly #promptNameCodec: NonNullable<McpGatewayOptions["promptNameCodec"]>;
	readonly #resourceUriCodec: NonNullable<McpGatewayOptions["resourceUriCodec"]>;
	readonly #resourceTemplateUriCodec: NonNullable<McpGatewayOptions["resourceTemplateUriCodec"]>;
	readonly #resourceTemplateNameCodec: NonNullable<McpGatewayOptions["resourceTemplateNameCodec"]>;
	readonly #cache: McpGatewayDiscoveryCache;
	readonly #discoveryMaxPages: number;
	readonly #discoveryMaxItems: number;
	readonly #discoveryTimeoutMs: number;
	readonly #discoveryMaxItemBytes: number;
	readonly #discoveryMaxSnapshotBytes: number;
	readonly #discoveryMaxDepth: number;
	readonly #discoveryMaxStringBytes: number;
	readonly #discoveryMaxConcurrentFlights: number;
	readonly #discoveryInflight = new Map<string, GatewayDiscoveryFlight>();
	readonly #activeDiscoveryRefreshes = new Set<Promise<void>>();
	readonly #discoveryGenerations = new Map<string, number>();
	readonly #discoveryCacheQueues = new Map<string, Promise<void>>();
	readonly #resolveAuthorizationContext: McpGatewayAuthorizationContextResolver;
	readonly #middleware: readonly McpGatewayMiddleware[];
	readonly #transforms: readonly McpGatewayMiddleware[];
	readonly #lifecycleObserver: McpGatewayLifecycleObserver | undefined;
	readonly #onObserverError: ((error: unknown) => MaybePromise<void>) | undefined;
	readonly #feature: McpServerFeature;
	readonly #lifecycle: GatewayLifecycle;
	#discoveryCacheBarrier: Promise<void> = Promise.resolve();
	#discoveryEpoch = 0;
	readonly #fencedUpstreamNames = new Set<string>();
	#topologyRevision = 0;
	#topologyMutationTail: Promise<void> = Promise.resolve();

	constructor(options: McpGatewayOptions) {
		if (typeof options?.policy?.authorize !== "function") {
			throw new McpGatewayError("INVALID_OPTIONS", "A gateway authorization policy is required.");
		}
		this.#upstreams = snapshotUpstreams(options.upstreams);
		this.#dynamicUpstreams = options.dynamicUpstreams === true;
		this.#policy = options.policy;
		this.#nameCodec = options.nameCodec ?? new GatewayNameCodec();
		this.#promptNameCodec = options.promptNameCodec ?? new GatewayPromptNameCodec();
		this.#resourceUriCodec = options.resourceUriCodec ?? new GatewayResourceUriCodec();
		this.#resourceTemplateUriCodec =
			options.resourceTemplateUriCodec ?? new GatewayResourceTemplateUriCodec();
		this.#resourceTemplateNameCodec =
			options.resourceTemplateNameCodec ?? new GatewayNameCodec("gwrt1");
		this.#cache =
			options.discoveryCache ??
			(options.discoveryTtlMs === undefined
				? new InMemoryMcpGatewayDiscoveryCache()
				: new InMemoryMcpGatewayDiscoveryCache({ ttlMs: options.discoveryTtlMs }));
		this.#discoveryMaxPages = positiveIntegerOption(
			options.discoveryMaxPages,
			"discoveryMaxPages",
			DEFAULT_DISCOVERY_MAX_PAGES,
		);
		this.#discoveryMaxItems = positiveIntegerOption(
			options.discoveryMaxItemsPerCapability,
			"discoveryMaxItemsPerCapability",
			DEFAULT_DISCOVERY_MAX_ITEMS,
		);
		this.#discoveryTimeoutMs = positiveIntegerOption(
			options.discoveryTimeoutMs,
			"discoveryTimeoutMs",
			DEFAULT_DISCOVERY_TIMEOUT_MS,
		);
		this.#discoveryMaxItemBytes = positiveIntegerOption(
			options.discoveryMaxItemBytes,
			"discoveryMaxItemBytes",
			DEFAULT_DISCOVERY_MAX_ITEM_BYTES,
		);
		this.#discoveryMaxSnapshotBytes = positiveIntegerOption(
			options.discoveryMaxSnapshotBytes,
			"discoveryMaxSnapshotBytes",
			DEFAULT_DISCOVERY_MAX_SNAPSHOT_BYTES,
		);
		this.#discoveryMaxDepth = positiveIntegerOption(
			options.discoveryMaxDepth,
			"discoveryMaxDepth",
			DEFAULT_DISCOVERY_MAX_DEPTH,
		);
		this.#discoveryMaxStringBytes = positiveIntegerOption(
			options.discoveryMaxStringBytes,
			"discoveryMaxStringBytes",
			DEFAULT_DISCOVERY_MAX_STRING_BYTES,
		);
		this.#discoveryMaxConcurrentFlights = positiveIntegerOption(
			options.discoveryMaxConcurrentFlights,
			"discoveryMaxConcurrentFlights",
			DEFAULT_DISCOVERY_MAX_CONCURRENT_FLIGHTS,
		);
		const shutdownTimeoutMs = positiveIntegerOption(
			options.shutdownTimeoutMs,
			"shutdownTimeoutMs",
			DEFAULT_SHUTDOWN_TIMEOUT_MS,
		);
		this.#resolveAuthorizationContext =
			options.authorizationContextResolver ?? defaultMcpGatewayAuthorizationContext;
		const middleware = snapshotMiddleware(options.middleware ?? []);
		this.#middleware = Object.freeze(
			middleware.filter((entry) => !isExactMcpGatewayTransform(entry)),
		);
		this.#transforms = Object.freeze(middleware.filter(isExactMcpGatewayTransform));
		this.#lifecycleObserver = options.lifecycleObserver;
		this.#onObserverError = options.onObserverError;
		this.#lifecycle = new GatewayLifecycle({
			shutdownTimeoutMs,
			acceptedTasks: () => [
				...this.#activeDiscoveryRefreshes,
				...this.#discoveryCacheQueues.values(),
				this.#discoveryCacheBarrier,
			],
			onClosing: (closedError) => {
				this.#discoveryEpoch += 1;
				for (const [flightKey, flight] of this.#discoveryInflight) {
					this.#discoveryGenerations.set(flightKey, this.#discoveryGeneration(flightKey) + 1);
					flight.controller.abort(closedError);
				}
			},
			onClosed: () => {
				this.#discoveryInflight.clear();
				this.#discoveryCacheQueues.clear();
				this.#discoveryGenerations.clear();
			},
		});
		this.#feature = (server, context) =>
			this.#lifecycle.track(() => this.#install(server, context));
	}

	/** Install first; toolsOnly permits later local SDK capabilities with exact name collision checks. */
	asServerFeature(options: McpGatewayServerFeatureOptions = {}): McpServerFeature {
		this.#lifecycle.assertOpen();
		return options.toolsOnly === true
			? (server, context) => this.#lifecycle.track(() => this.#install(server, context, true))
			: this.#feature;
	}

	/** Credential-free, deterministic view of the current upstream membership. */
	topology(): McpGatewayTopologySnapshot {
		this.#lifecycle.assertOpen();
		return this.#topologySnapshot();
	}

	/** Attach one upstream without rebuilding the owning server runtime. */
	attachUpstream(
		upstream: McpGatewayUpstream,
		options: McpGatewayTopologyMutationOptions = {},
	): Promise<McpGatewayTopologySnapshot> {
		return this.#lifecycle.track(() => this.#attachTopology(upstream, options.expectedRevision));
	}

	/** Detach one namespace. Accepted operations retain their captured upstream snapshot. */
	detachUpstream(
		upstreamName: string,
		options: McpGatewayTopologyMutationOptions = {},
	): Promise<McpGatewayTopologySnapshot> {
		return this.#lifecycle.track(() =>
			this.#detachTopology(upstreamName, options.expectedRevision),
		);
	}

	/** Atomically replace one routing identity with a freshly prepared upstream. */
	replaceUpstream(
		upstreamName: string,
		replacement: McpGatewayUpstream,
		options: McpGatewayTopologyMutationOptions = {},
	): Promise<McpGatewayTopologySnapshot> {
		return this.#lifecycle.track(() =>
			this.#replaceTopology(upstreamName, replacement, options.expectedRevision),
		);
	}

	listProjectedTools(
		context: McpGatewayRequestContext = {},
	): Promise<readonly McpGatewayProjectedTool[]> {
		return this.#lifecycle.track(() => this.#listProjectedTools(context));
	}

	listProjectedPrompts(
		context: McpGatewayRequestContext = {},
	): Promise<readonly McpGatewayProjectedPrompt[]> {
		return this.#lifecycle.track(() => this.#listProjectedPrompts(context));
	}

	listProjectedResources(
		context: McpGatewayRequestContext = {},
	): Promise<readonly McpGatewayProjectedResource[]> {
		return this.#lifecycle.track(() => this.#listProjectedResources(context));
	}

	listProjectedResourceTemplates(
		context: McpGatewayRequestContext = {},
	): Promise<readonly McpGatewayProjectedResourceTemplate[]> {
		return this.#lifecycle.track(() => this.#listProjectedResourceTemplates(context));
	}

	callTool(
		projectedName: string,
		arguments_: Readonly<Record<string, unknown>> | undefined,
		context: McpGatewayRequestContext = {},
	): Promise<CallToolResult> {
		return this.#lifecycle.track(() => this.#callTool(projectedName, arguments_, context));
	}

	getPrompt(
		projectedName: string,
		arguments_: Readonly<Record<string, string>> | undefined,
		context: McpGatewayRequestContext = {},
	): Promise<GetPromptResult> {
		return this.#lifecycle.track(() => this.#getPrompt(projectedName, arguments_, context));
	}

	readResource(
		projectedUri: string,
		context: McpGatewayRequestContext = {},
	): Promise<ReadResourceResult> {
		return this.#lifecycle.track(() => this.#readResource(projectedUri, context));
	}

	readResourceTemplate(
		projectedTemplateUri: string,
		variables: Variables,
		context: McpGatewayRequestContext = {},
	): Promise<ReadResourceResult> {
		return this.#lifecycle.track(() =>
			this.#readResourceTemplate(projectedTemplateUri, variables, context),
		);
	}

	complete(
		params: CompleteRequest["params"],
		context: McpGatewayRequestContext = {},
	): Promise<CompleteResult> {
		return this.#lifecycle.track(() => this.#complete(params, context));
	}

	/** Evict discovery for exactly one upstream and authorization context. */
	invalidateDiscovery(key: McpGatewayDiscoveryCacheKey): Promise<boolean> {
		return this.#lifecycle.track(() => this.#invalidateDiscovery(key));
	}

	/** Evict every discovery partition without allowing older refreshes to repopulate it. */
	invalidateAllDiscovery(): Promise<void> {
		return this.#lifecycle.track(() => this.#invalidateAllDiscovery());
	}

	/** Discover, authorize, and project every visible upstream tool. */
	async #listProjectedTools(
		context: McpGatewayRequestContext = {},
		upstreams: ReadonlyMap<string, McpGatewayUpstream> = this.#upstreams,
	): Promise<readonly McpGatewayProjectedTool[]> {
		const resolved = await this.#resolveContext(context);
		const groups = await Promise.all(
			[...upstreams.values()].map(async (upstream) => {
				const snapshot = await this.#discover(upstream, resolved, "tools");
				const visible: McpGatewayProjectedTool[] = [];
				for (const tool of snapshot.tools) {
					const projected = this.#projectTool(upstream.name, tool);
					if (await this.#canDiscoverTool(projected, resolved)) visible.push(projected);
				}
				return visible;
			}),
		);
		return Object.freeze(groups.flat());
	}

	/** Discover, authorize, and project every visible upstream prompt. */
	async #listProjectedPrompts(
		context: McpGatewayRequestContext = {},
		upstreams: ReadonlyMap<string, McpGatewayUpstream> = this.#upstreams,
	): Promise<readonly McpGatewayProjectedPrompt[]> {
		const resolved = await this.#resolveContext(context);
		const groups = await Promise.all(
			[...upstreams.values()].map(async (upstream) => {
				const snapshot = await this.#discover(upstream, resolved, "prompts");
				const visible: McpGatewayProjectedPrompt[] = [];
				for (const prompt of snapshot.prompts ?? []) {
					const projected = this.#projectPrompt(upstream.name, prompt);
					if (await this.#canDiscoverPrompt(projected, resolved)) visible.push(projected);
				}
				return visible;
			}),
		);
		return Object.freeze(groups.flat());
	}

	/** Discover, authorize, and project every visible concrete upstream resource. */
	async #listProjectedResources(
		context: McpGatewayRequestContext = {},
		upstreams: ReadonlyMap<string, McpGatewayUpstream> = this.#upstreams,
	): Promise<readonly McpGatewayProjectedResource[]> {
		const resolved = await this.#resolveContext(context);
		const groups = await Promise.all(
			[...upstreams.values()].map(async (upstream) => {
				const snapshot = await this.#discover(upstream, resolved, "resources");
				const visible: McpGatewayProjectedResource[] = [];
				for (const resource of snapshot.resources ?? []) {
					const projected = this.#projectResource(upstream.name, resource);
					if (await this.#canDiscoverResource(projected, resolved)) visible.push(projected);
				}
				return visible;
			}),
		);
		return Object.freeze(groups.flat());
	}

	/** Discover, authorize, and project every visible upstream resource template. */
	async #listProjectedResourceTemplates(
		context: McpGatewayRequestContext = {},
		upstreams: ReadonlyMap<string, McpGatewayUpstream> = this.#upstreams,
	): Promise<readonly McpGatewayProjectedResourceTemplate[]> {
		const resolved = await this.#resolveContext(context);
		const groups = await Promise.all(
			[...upstreams.values()].map(async (upstream) => {
				const snapshot = await this.#discover(upstream, resolved, "resourceTemplates");
				const visible: McpGatewayProjectedResourceTemplate[] = [];
				for (const resourceTemplate of snapshot.resourceTemplates ?? []) {
					const projected = this.#projectResourceTemplate(upstream.name, resourceTemplate);
					if (await this.#canDiscoverResourceTemplate(projected, resolved)) {
						visible.push(projected);
					}
				}
				return visible;
			}),
		);
		return Object.freeze(groups.flat());
	}

	/** Route one canonical projected name to its upstream with mandatory call-time policy. */
	async #callTool(
		projectedName: string,
		arguments_: Readonly<Record<string, unknown>> | undefined,
		context: McpGatewayRequestContext = {},
	): Promise<CallToolResult> {
		const safeArguments = snapshotToolArguments(arguments_);
		const route = this.#nameCodec.decode(projectedName);
		const upstream = this.#requireUpstream(route.upstreamName);
		const resolved = await this.#resolveContext(context);
		const snapshot = await this.#discover(upstream, resolved, "tools");
		const tool = snapshot.tools.find((candidate) => candidate.name === route.toolName);
		if (tool === undefined) {
			throw new McpGatewayError(
				"UNKNOWN_TOOL",
				`Upstream "${route.upstreamName}" does not expose tool "${route.toolName}".`,
			);
		}
		const projected = this.#projectTool(route.upstreamName, tool);
		await this.#authorizeTool(toolPolicyInput("discover", projected), resolved);

		const input = Object.freeze({
			type: "gateway.invocation",
			upstreamName: projected.upstreamName,
			toolName: projected.toolName,
			projectedName,
			tool,
			...(safeArguments === undefined ? {} : { arguments: safeArguments }),
		}) satisfies McpGatewayInvocationOperationInput;
		const operation = createMcpOperation(input, createGatewayOperationContext(input, resolved));
		const authorize: McpGatewayMiddleware = async (_operation, next) => {
			await this.#authorizeTool(toolPolicyInput("invoke", projected, safeArguments), resolved);
			return next();
		};
		const terminal: McpOperationHandler<
			McpGatewayOperationInput,
			McpGatewayOperationOutput,
			McpGatewayOperationContext
		> = async () => {
			const client = await resolveClient(upstream, resolved);
			const visibleResourceUris = await this.#visibleResourceUris(
				upstream.name,
				snapshot,
				resolved,
			);
			const result = await client.callTool(
				{
					name: projected.toolName,
					...(safeArguments === undefined ? {} : { arguments: safeArguments }),
				},
				{ signal: resolved.signal, toolDefinition: tool, allowInputRequired: true },
			);
			assertUpstreamCompleteResult(result, projected.upstreamName, "tools/call");
			return rewriteCallToolResult(
				result,
				upstream.name,
				this.#nameCodec,
				this.#resourceUriCodec,
				visibleResourceUris,
			);
		};

		const result = await this.#runOperation(operation, terminal, [authorize]);
		if (!isCallToolResult(result)) {
			throw new McpGatewayError(
				"INVALID_INVOCATION_RESULT",
				`Gateway middleware returned an invalid invocation result for "${projectedName}".`,
			);
		}
		return result;
	}

	/** Resolve a projected prompt after authoritative discovery and get-time policy. */
	async #getPrompt(
		projectedName: string,
		arguments_: Readonly<Record<string, string>> | undefined,
		context: McpGatewayRequestContext = {},
	): Promise<GetPromptResult> {
		const safeArguments = snapshotStringArguments(arguments_, "Prompt arguments");
		const route = this.#promptNameCodec.decode(projectedName);
		const upstream = this.#requireUpstream(route.upstreamName);
		const resolved = await this.#resolveContext(context);
		const snapshot = await this.#discover(upstream, resolved, "prompts");
		const prompt = (snapshot.prompts ?? []).find(
			(candidate) => candidate.name === route.promptName,
		);
		if (prompt === undefined) {
			throw new McpGatewayError(
				"UNKNOWN_PROMPT",
				`Upstream "${route.upstreamName}" does not expose prompt "${route.promptName}".`,
			);
		}
		const projected = this.#projectPrompt(route.upstreamName, prompt);
		await this.#authorizePrompt(promptPolicyInput("discover", projected), resolved);

		const input = Object.freeze({
			type: "gateway.prompt.get",
			upstreamName: projected.upstreamName,
			promptName: projected.promptName,
			projectedName,
			prompt,
			...(safeArguments === undefined ? {} : { arguments: safeArguments }),
		}) satisfies McpGatewayPromptGetOperationInput;
		const operation = createMcpOperation(input, createGatewayOperationContext(input, resolved));
		const authorize: McpGatewayMiddleware = async (_operation, next) => {
			await this.#authorizePrompt(promptPolicyInput("get", projected, safeArguments), resolved);
			return next();
		};
		const terminal: McpOperationHandler<
			McpGatewayOperationInput,
			McpGatewayOperationOutput,
			McpGatewayOperationContext
		> = async () => {
			const client = await resolveClient(upstream, resolved);
			if (!hasPromptCapability(client)) throw unsupportedCapability(upstream.name, "prompts");
			const visibleResourceUris = await this.#visibleResourceUris(
				upstream.name,
				snapshot,
				resolved,
			);
			const result = await client.getPrompt(
				{
					name: projected.promptName,
					...(safeArguments === undefined ? {} : { arguments: safeArguments }),
				},
				{ signal: resolved.signal, allowInputRequired: true },
			);
			assertUpstreamCompleteResult(result, projected.upstreamName, "prompts/get");
			return rewritePromptResult(
				result,
				projected.upstreamName,
				this.#nameCodec,
				this.#resourceUriCodec,
				visibleResourceUris,
			);
		};

		const result = await this.#runOperation(operation, terminal, [authorize]);
		if (!isGetPromptResult(result)) {
			throw new McpGatewayError(
				"INVALID_PROMPT_RESULT",
				`Gateway middleware returned an invalid prompt result for "${projectedName}".`,
			);
		}
		return result;
	}

	/** Resolve a projected URI after authoritative discovery and read-time policy. */
	async #readResource(
		projectedUri: string,
		context: McpGatewayRequestContext = {},
	): Promise<ReadResourceResult> {
		const route = this.#resourceUriCodec.decode(projectedUri);
		const upstream = this.#requireUpstream(route.upstreamName);
		const resolved = await this.#resolveContext(context);
		const snapshot = await this.#discover(upstream, resolved, "resources");
		const resource = (snapshot.resources ?? []).find(
			(candidate) => candidate.uri === route.resourceUri,
		);
		if (resource === undefined) {
			throw new McpGatewayError(
				"UNKNOWN_RESOURCE",
				`Upstream "${route.upstreamName}" does not expose the requested concrete resource.`,
			);
		}
		const projected = this.#projectResource(route.upstreamName, resource);
		await this.#authorizeResource(resourcePolicyInput("discover", projected), resolved);

		const input = Object.freeze({
			type: "gateway.resource.read",
			upstreamName: projected.upstreamName,
			projectedName: projected.projectedName,
			projectedUri,
			resource: projected.definition,
		}) satisfies McpGatewayResourceReadOperationInput;
		const operation = createMcpOperation(input, createGatewayOperationContext(input, resolved));
		const authorize: McpGatewayMiddleware = async (_operation, next) => {
			await this.#authorizeResource(resourcePolicyInput("read", projected), resolved);
			return next();
		};
		const terminal: McpOperationHandler<
			McpGatewayOperationInput,
			McpGatewayOperationOutput,
			McpGatewayOperationContext
		> = async () => {
			const client = await resolveClient(upstream, resolved);
			if (!hasResourceCapability(client)) throw unsupportedCapability(upstream.name, "resources");
			const result = await client.readResource(
				{ uri: resource.uri },
				{ signal: resolved.signal, allowInputRequired: true },
			);
			assertUpstreamCompleteResult(result, projected.upstreamName, "resources/read");
			return rewriteReadResourceResult(result, resource.uri, projected.projectedUri);
		};

		const result = await this.#runOperation(operation, terminal, [authorize]);
		if (!isReadResourceResult(result)) {
			throw new McpGatewayError(
				"INVALID_RESOURCE_RESULT",
				"Gateway middleware returned an invalid resource-read result.",
			);
		}
		return result;
	}

	/** Expand and read one projected template after authoritative template policy. */
	async #readResourceTemplate(
		projectedTemplateUri: string,
		variables: Variables,
		context: McpGatewayRequestContext = {},
	): Promise<ReadResourceResult> {
		const route = this.#resourceTemplateUriCodec.decode(projectedTemplateUri);
		const upstream = this.#requireUpstream(route.upstreamName);
		const resolved = await this.#resolveContext(context);
		const snapshot = await this.#discover(upstream, resolved, "resourceTemplates");
		const resourceTemplate = (snapshot.resourceTemplates ?? []).find(
			(candidate) => candidate.uriTemplate === route.resourceTemplate,
		);
		if (resourceTemplate === undefined) {
			throw new McpGatewayError(
				"UNKNOWN_RESOURCE_TEMPLATE",
				`Upstream "${route.upstreamName}" does not expose the requested resource template.`,
			);
		}
		const projected = this.#projectResourceTemplate(route.upstreamName, resourceTemplate);
		await this.#authorizeResourceTemplate(
			resourceTemplatePolicyInput("discover", projected),
			resolved,
		);
		const safeVariables = validateTemplateVariables(resourceTemplate.uriTemplate, variables);

		const input = Object.freeze({
			type: "gateway.resource-template.read",
			upstreamName: projected.upstreamName,
			projectedName: projected.projectedName,
			projectedTemplateUri,
			variables: safeVariables,
			resourceTemplate: projected.definition,
		}) satisfies McpGatewayResourceTemplateReadOperationInput;
		const operation = createMcpOperation(input, createGatewayOperationContext(input, resolved));
		const authorize: McpGatewayMiddleware = async (_operation, next) => {
			await this.#authorizeResourceTemplate(
				resourceTemplatePolicyInput("read", projected, safeVariables),
				resolved,
			);
			return next();
		};
		const terminal: McpOperationHandler<
			McpGatewayOperationInput,
			McpGatewayOperationOutput,
			McpGatewayOperationContext
		> = async () => {
			const client = await resolveClient(upstream, resolved);
			if (!hasResourceTemplateCapability(client)) {
				throw unsupportedCapability(upstream.name, "resource templates");
			}
			const rawExpandedUri = new UriTemplate(resourceTemplate.uriTemplate).expand(safeVariables);
			const projectedExpandedUri = new UriTemplate(projectedTemplateUri).expand(safeVariables);
			const result = await client.readResource(
				{ uri: rawExpandedUri },
				{ signal: resolved.signal, allowInputRequired: true },
			);
			assertUpstreamCompleteResult(result, projected.upstreamName, "resources/read");
			return rewriteTemplateReadResult(result, rawExpandedUri, projectedExpandedUri);
		};

		const result = await this.#runOperation(operation, terminal, [authorize]);
		if (!isReadResourceResult(result)) {
			throw new McpGatewayError(
				"INVALID_RESOURCE_RESULT",
				"Gateway middleware returned an invalid resource-template read result.",
			);
		}
		return result;
	}

	/** Route official completion requests for projected prompt/template references. */
	async #complete(
		params: CompleteRequest["params"],
		context: McpGatewayRequestContext = {},
	): Promise<CompleteResult> {
		validateCompletionRequest(params);
		const safeParams = snapshotCompletionParams(params);
		const resolved = await this.#resolveContext(context);
		if (safeParams.ref.type === "ref/prompt") {
			return this.#completePrompt(Object.freeze({ ...safeParams, ref: safeParams.ref }), resolved);
		}
		if (safeParams.ref.type === "ref/resource") {
			return this.#completeResourceTemplate(
				Object.freeze({ ...safeParams, ref: safeParams.ref }),
				resolved,
			);
		}
		return assertNever(safeParams.ref);
	}

	async #completePrompt(
		params: GatewayPromptCompletionParams,
		resolved: McpGatewayResolvedRequestContext,
	): Promise<CompleteResult> {
		const route = this.#promptNameCodec.decode(params.ref.name);
		const upstream = this.#requireUpstream(route.upstreamName);
		const snapshot = await this.#discover(upstream, resolved, "prompts");
		const prompt = (snapshot.prompts ?? []).find(
			(candidate) => candidate.name === route.promptName,
		);
		if (prompt === undefined) {
			throw new McpGatewayError(
				"UNKNOWN_PROMPT",
				`Upstream "${route.upstreamName}" does not expose prompt "${route.promptName}".`,
			);
		}
		const projected = this.#projectPrompt(route.upstreamName, prompt);
		await this.#authorizePrompt(promptPolicyInput("discover", projected), resolved);
		if (!(prompt.arguments ?? []).some((argument) => argument.name === params.argument.name)) {
			throw invalidCompletionRequest("Prompt completion referenced an undeclared argument.");
		}
		const completion = completionPolicyData(params);
		const input = Object.freeze({
			type: "gateway.completion",
			upstreamName: projected.upstreamName,
			projectedIdentifier: projected.projectedName,
			params,
		}) satisfies McpGatewayOperationInput;
		const operation = createMcpOperation(input, createGatewayOperationContext(input, resolved));
		const authorize: McpGatewayMiddleware = async (_operation, next) => {
			await this.#authorizePrompt(
				promptPolicyInput("complete", projected, undefined, completion),
				resolved,
			);
			return next();
		};
		const terminal: McpOperationHandler<
			McpGatewayOperationInput,
			McpGatewayOperationOutput,
			McpGatewayOperationContext
		> = async () => {
			const client = await resolveClient(upstream, resolved);
			if (!hasCompletionCapability(client)) {
				throw unsupportedCapability(upstream.name, "completion");
			}
			return validateCompletionResult(
				await client.complete(
					{
						...params,
						ref: { type: "ref/prompt", name: projected.promptName },
					},
					{ signal: resolved.signal },
				),
			);
		};
		return this.#runCompletionOperation(operation, terminal, authorize);
	}

	async #completeResourceTemplate(
		params: GatewayResourceTemplateCompletionParams,
		resolved: McpGatewayResolvedRequestContext,
	): Promise<CompleteResult> {
		const route = this.#resourceTemplateUriCodec.decode(params.ref.uri);
		const upstream = this.#requireUpstream(route.upstreamName);
		const snapshot = await this.#discover(upstream, resolved, "resourceTemplates");
		const resourceTemplate = (snapshot.resourceTemplates ?? []).find(
			(candidate) => candidate.uriTemplate === route.resourceTemplate,
		);
		if (resourceTemplate === undefined) {
			throw new McpGatewayError(
				"UNKNOWN_RESOURCE_TEMPLATE",
				`Upstream "${route.upstreamName}" does not expose the requested resource template.`,
			);
		}
		const projected = this.#projectResourceTemplate(route.upstreamName, resourceTemplate);
		await this.#authorizeResourceTemplate(
			resourceTemplatePolicyInput("discover", projected),
			resolved,
		);
		if (
			!new UriTemplate(resourceTemplate.uriTemplate).variableNames.includes(params.argument.name)
		) {
			throw invalidCompletionRequest(
				"Resource-template completion referenced an undeclared variable.",
			);
		}
		const completion = completionPolicyData(params);
		const input = Object.freeze({
			type: "gateway.completion",
			upstreamName: projected.upstreamName,
			projectedIdentifier: projected.projectedName,
			params,
		}) satisfies McpGatewayOperationInput;
		const operation = createMcpOperation(input, createGatewayOperationContext(input, resolved));
		const authorize: McpGatewayMiddleware = async (_operation, next) => {
			await this.#authorizeResourceTemplate(
				resourceTemplatePolicyInput("complete", projected, undefined, completion),
				resolved,
			);
			return next();
		};
		const terminal: McpOperationHandler<
			McpGatewayOperationInput,
			McpGatewayOperationOutput,
			McpGatewayOperationContext
		> = async () => {
			const client = await resolveClient(upstream, resolved);
			if (!hasResourceTemplateCapability(client) || !hasCompletionCapability(client)) {
				throw unsupportedCapability(upstream.name, "resource-template completion");
			}
			return validateCompletionResult(
				await client.complete(
					{
						...params,
						ref: { type: "ref/resource", uri: resourceTemplate.uriTemplate },
					},
					{ signal: resolved.signal },
				),
			);
		};
		return this.#runCompletionOperation(operation, terminal, authorize);
	}

	async #runCompletionOperation(
		operation: McpOperation<McpGatewayOperationInput, McpGatewayOperationContext>,
		terminal: McpOperationHandler<
			McpGatewayOperationInput,
			McpGatewayOperationOutput,
			McpGatewayOperationContext
		>,
		authorize: McpGatewayMiddleware,
	): Promise<CompleteResult> {
		const result = await this.#runOperation(operation, terminal, [authorize]);
		if (!isCompleteResult(result)) {
			throw new McpGatewayError(
				"INVALID_COMPLETION_RESULT",
				"Gateway middleware returned an invalid completion result.",
			);
		}
		return result;
	}

	async #invalidateDiscovery(key: McpGatewayDiscoveryCacheKey): Promise<boolean> {
		const flightKey = discoveryFlightKey(key);
		// Bump before detaching: a refresh already inside an asynchronous cache write
		// will delete its stale write while holding the per-key mutation queue.
		this.#discoveryGenerations.set(flightKey, this.#discoveryGeneration(flightKey) + 1);
		this.#discoveryInflight.get(flightKey)?.controller.abort(abandonedDiscoveryError());
		this.#discoveryInflight.delete(flightKey);
		return this.#enqueueCacheMutation(flightKey, () => this.#cache.delete(key));
	}

	async #invalidateAllDiscovery(): Promise<void> {
		this.#discoveryEpoch += 1;
		const cancellation = abandonedDiscoveryError();
		for (const flight of this.#discoveryInflight.values()) {
			flight.controller.abort(cancellation);
		}
		this.#discoveryInflight.clear();

		// Publish the barrier synchronously. Mutations accepted after this point wait
		// until clear completes; mutations already queued settle before clear runs.
		const previousBarrier = this.#discoveryCacheBarrier;
		const priorMutations = [...this.#discoveryCacheQueues.values()];
		const clearTask = previousBarrier
			.catch(() => undefined)
			.then(async () => {
				await Promise.allSettled(priorMutations);
				await this.#cache.clear();
			});
		this.#discoveryCacheBarrier = clearTask.then(
			() => undefined,
			() => undefined,
		);
		await clearTask;
	}

	/** Stop accepting work, cancel owned operations, and wait a bounded time for quiescence. */
	close(): Promise<void> {
		return this.#lifecycle.close();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	async #install(
		server: Parameters<McpServerFeature>[0],
		buildContext: McpServerBuildContext,
		toolsOnly = false,
	): Promise<void> {
		const context = contextFromBuild(buildContext);
		const upstreams = this.#upstreams;
		const [projectedTools, projectedPrompts, projectedResources, projectedResourceTemplates] =
			await Promise.all([
				this.#listProjectedTools(context, upstreams),
				toolsOnly ? [] : this.#listProjectedPrompts(context, upstreams),
				toolsOnly ? [] : this.#listProjectedResources(context, upstreams),
				toolsOnly ? [] : this.#listProjectedResourceTemplates(context, upstreams),
			]);
		const resolved = await this.#resolveContext(context);
		const clients = new Map(
			await Promise.all(
				[...upstreams.values()].map(
					async (upstream) => [upstream.name, await resolveClient(upstream, resolved)] as const,
				),
			),
		);
		const promptsSupported =
			!toolsOnly && (this.#dynamicUpstreams || [...clients.values()].some(hasPromptCapability));
		const resourcesSupported =
			!toolsOnly &&
			(this.#dynamicUpstreams ||
				[...clients.values()].some(
					(client) => hasResourceCapability(client) || hasResourceTemplateCapability(client),
				));
		const completionSupported =
			!this.#dynamicUpstreams &&
			(projectedPrompts.some(
				(projected) =>
					(projected.prompt.arguments?.length ?? 0) > 0 &&
					hasCompletionCapability(requireInstalledClient(clients, projected.upstreamName)),
			) ||
				projectedResourceTemplates.some(
					(projected) =>
						new UriTemplate(projected.projectedTemplateUri).variableNames.length > 0 &&
						hasCompletionCapability(requireInstalledClient(clients, projected.upstreamName)),
				));
		// Dynamic HTTP hosts may emit list-changed invalidations through the owning
		// persistent runtime notifier. Resource subscriptions are still not bridged.
		const currentCapabilities = server.server.getCapabilities();
		assertGatewayCapabilityOwnership(currentCapabilities, {
			tools: true,
			prompts: promptsSupported,
			resources: resourcesSupported,
			completions: completionSupported,
		});
		assertGatewayHandlerOwnership(server.server, ["tools/list", "tools/call"]);
		if (promptsSupported) {
			assertGatewayHandlerOwnership(server.server, ["prompts/list", "prompts/get"]);
		}
		if (resourcesSupported) {
			assertGatewayHandlerOwnership(server.server, [
				"resources/list",
				"resources/templates/list",
				"resources/read",
			]);
		}
		if (completionSupported) {
			assertGatewayHandlerOwnership(server.server, ["completion/complete"]);
		}
		server.server.registerCapabilities({
			tools: { listChanged: this.#dynamicUpstreams },
			...(promptsSupported ? { prompts: { listChanged: this.#dynamicUpstreams } } : {}),
			...(resourcesSupported
				? {
						resources: {
							listChanged: this.#dynamicUpstreams,
							subscribe: false,
						},
					}
				: {}),
		});
		// High-level registrations install the official list/get/read handlers. A
		// disabled sentinel initializes those handlers while keeping filtered or
		// currently empty capabilities discoverable as empty lists.
		if (projectedTools.length === 0) {
			server
				.registerTool(
					"nest_mcp_gateway_internal_empty_tool",
					{ inputSchema: fromJsonSchema<Record<string, unknown>>({ type: "object" }) },
					async () => ({ content: [] }),
				)
				.disable();
		}
		if (promptsSupported && projectedPrompts.length === 0) {
			server
				.registerPrompt(
					"nest_mcp_gateway_internal_empty_prompt",
					{ argsSchema: fromJsonSchema<Record<string, string>>({ type: "object" }) },
					async () => ({ messages: [] }),
				)
				.disable();
		}
		if (resourcesSupported && projectedResources.length === 0) {
			server
				.registerResource(
					"nest_mcp_gateway_internal_empty_resource",
					"mcp-gateway://internal/empty/empty",
					{},
					async () => ({ contents: [] }),
				)
				.disable();
		}

		for (const projected of projectedTools) {
			const inputSchema = fromJsonSchema<Record<string, unknown>>(
				toJsonSchema(projected.tool.inputSchema, projected.upstreamName, projected.toolName),
			);
			const outputSchema =
				projected.tool.outputSchema === undefined
					? undefined
					: fromJsonSchema(
							toJsonSchema(projected.tool.outputSchema, projected.upstreamName, projected.toolName),
						);
			const metadata = projected.definition["_meta"];
			server.registerTool(
				projected.projectedName,
				{
					...(projected.tool.title === undefined ? {} : { title: projected.tool.title }),
					...(projected.tool.description === undefined
						? {}
						: { description: projected.tool.description }),
					inputSchema,
					...(outputSchema === undefined ? {} : { outputSchema }),
					...(projected.tool.annotations === undefined
						? {}
						: { annotations: projected.tool.annotations }),
					...(projected.tool.icons === undefined ? {} : { icons: projected.tool.icons }),
					...(metadata === undefined ? {} : { _meta: metadata }),
				},
				async (arguments_, handlerContext) =>
					this.callTool(
						projected.projectedName,
						arguments_,
						handlerRequestContext(handlerContext, buildContext),
					),
			);
		}

		for (const projected of projectedPrompts) {
			const argsSchema = createPromptArgumentsSchema(projected.prompt);
			const metadata = projected.definition["_meta"];
			server.registerPrompt(
				projected.projectedName,
				{
					...(projected.prompt.title === undefined ? {} : { title: projected.prompt.title }),
					...(projected.prompt.description === undefined
						? {}
						: { description: projected.prompt.description }),
					argsSchema,
					...(projected.prompt.icons === undefined ? {} : { icons: projected.prompt.icons }),
					...(metadata === undefined ? {} : { _meta: metadata }),
				},
				async (arguments_, handlerContext) =>
					this.getPrompt(
						projected.projectedName,
						arguments_,
						handlerRequestContext(handlerContext, buildContext),
					),
			);
		}

		for (const projected of projectedResources) {
			const resource = projected.definition;
			const metadata = resource["_meta"];
			server.registerResource(
				projected.projectedName,
				projected.projectedUri,
				{
					...(resource.title === undefined ? {} : { title: resource.title }),
					...(resource.description === undefined ? {} : { description: resource.description }),
					...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
					...(resource.annotations === undefined ? {} : { annotations: resource.annotations }),
					...(resource.size === undefined ? {} : { size: resource.size }),
					...(resource.icons === undefined ? {} : { icons: resource.icons }),
					...(metadata === undefined ? {} : { _meta: metadata }),
				},
				async (_uri, handlerContext) =>
					this.readResource(
						projected.projectedUri,
						handlerRequestContext(handlerContext, buildContext),
					),
			);
		}

		for (const projected of projectedResourceTemplates) {
			const resourceTemplate = projected.definition;
			const metadata = resourceTemplate["_meta"];
			server.registerResource(
				projected.projectedName,
				new ResourceTemplate(projected.projectedTemplateUri, {
					list: undefined,
				}),
				{
					...(resourceTemplate.title === undefined ? {} : { title: resourceTemplate.title }),
					...(resourceTemplate.description === undefined
						? {}
						: { description: resourceTemplate.description }),
					...(resourceTemplate.mimeType === undefined
						? {}
						: { mimeType: resourceTemplate.mimeType }),
					...(resourceTemplate.annotations === undefined
						? {}
						: { annotations: resourceTemplate.annotations }),
					...(resourceTemplate.icons === undefined ? {} : { icons: resourceTemplate.icons }),
					...(metadata === undefined ? {} : { _meta: metadata }),
				},
				async (uri, templateVariables, handlerContext) =>
					this.readResourceTemplate(
						projected.projectedTemplateUri,
						decodeProjectedTemplateVariables(
							projected.projectedTemplateUri,
							templateVariables,
							uri.href,
						),
						handlerRequestContext(handlerContext, buildContext),
					),
			);
		}

		if (completionSupported) {
			server.server.registerCapabilities({ completions: {} });
			server.server.setRequestHandler("completion/complete", (request, handlerContext) =>
				this.complete(request.params, handlerRequestContext(handlerContext, buildContext)),
			);
		}
	}

	async #discover(
		upstream: McpGatewayUpstream,
		context: McpGatewayResolvedRequestContext,
		capability: "tools" | "prompts" | "resources" | "resourceTemplates",
	): Promise<McpGatewayDiscoverySnapshot> {
		const cacheKey = {
			upstreamName: upstream.name,
			authorizationContext: context.authorizationContext,
		} satisfies McpGatewayDiscoveryCacheKey;
		const input = Object.freeze({
			type: "gateway.discovery",
			upstreamName: upstream.name,
			capability,
		}) satisfies McpGatewayDiscoveryOperationInput;
		const operation = createMcpOperation(input, createGatewayOperationContext(input, context));
		const terminal: McpOperationHandler<
			McpGatewayOperationInput,
			McpGatewayOperationOutput,
			McpGatewayOperationContext
		> = async () => {
			context.signal.throwIfAborted();
			const cached = await this.#readCachedDiscovery(cacheKey, context.signal);
			if (cached !== undefined) return cached;
			const flightKey = discoveryFlightKey(cacheKey);
			const flight =
				this.#discoveryInflight.get(flightKey) ??
				this.#createDiscoveryFlight(upstream, context, cacheKey, flightKey);
			return this.#waitForDiscovery(flight, context.signal);
		};

		const result = await this.#runOperation(operation, terminal);
		let detached: McpGatewayOperationOutput;
		try {
			detached = structuredClone(result);
		} catch (cause) {
			throw invalidDiscoveryWithCause(
				upstream.name,
				"returned a discovery middleware result that could not be detached",
				cause,
			);
		}
		if (!isDiscoverySnapshot(detached)) {
			throw new McpGatewayError(
				"INVALID_DISCOVERY",
				`Gateway middleware returned an invalid discovery snapshot for "${upstream.name}".`,
			);
		}
		const pages = [
			detached.tools,
			detached.prompts ?? [],
			detached.resources ?? [],
			detached.resourceTemplates ?? [],
		];
		if (pages.some((items) => items.length > this.#discoveryMaxItems)) {
			throw invalidDiscovery(
				upstream.name,
				`exceeded the ${String(this.#discoveryMaxItems)} discovery-item limit for one capability after middleware`,
			);
		}
		return validateDiscovery(
			upstream.name,
			detached.tools,
			detached.prompts ?? [],
			detached.resources ?? [],
			detached.resourceTemplates ?? [],
			{
				maxItemBytes: this.#discoveryMaxItemBytes,
				maxSnapshotBytes: this.#discoveryMaxSnapshotBytes,
				maxDepth: this.#discoveryMaxDepth,
				maxStringBytes: this.#discoveryMaxStringBytes,
			},
			detached.discoveredAt,
		);
	}

	#createDiscoveryFlight(
		upstream: McpGatewayUpstream,
		context: McpGatewayResolvedRequestContext,
		cacheKey: McpGatewayDiscoveryCacheKey,
		flightKey: string,
	): GatewayDiscoveryFlight {
		if (this.#activeDiscoveryRefreshes.size >= this.#discoveryMaxConcurrentFlights) {
			throw new McpGatewayError(
				"DISCOVERY_OVERLOADED",
				`MCP gateway discovery already has ${String(this.#activeDiscoveryRefreshes.size)} shared refreshes in flight.`,
			);
		}
		const controller = new AbortController();
		const sharedContext = Object.freeze({ ...context, signal: controller.signal });
		const generation = this.#discoveryGeneration(flightKey);
		const epoch = this.#discoveryEpoch;
		const timeout = setTimeout(() => {
			controller.abort(
				new McpGatewayError(
					"DISCOVERY_TIMEOUT",
					`Discovery for upstream "${upstream.name}" exceeded ${String(this.#discoveryTimeoutMs)}ms.`,
				),
			);
		}, this.#discoveryTimeoutMs);
		let flight: GatewayDiscoveryFlight;
		const raw = this.#fetchDiscovery(upstream, sharedContext);
		const rawSettled = raw.then(
			() => undefined,
			() => undefined,
		);
		this.#activeDiscoveryRefreshes.add(rawSettled);
		void rawSettled.then(() => this.#activeDiscoveryRefreshes.delete(rawSettled));
		const promise = raceDiscoveryWithSignal(raw, controller.signal)
			.then(async (snapshot) => {
				controller.signal.throwIfAborted();
				await this.#enqueueCacheMutation(flightKey, async () => {
					if (
						this.#discoveryEpoch !== epoch ||
						this.#discoveryGeneration(flightKey) !== generation
					) {
						return;
					}
					controller.signal.throwIfAborted();
					await this.#cache.set(cacheKey, snapshot);
					if (
						controller.signal.aborted ||
						this.#discoveryEpoch !== epoch ||
						this.#discoveryGeneration(flightKey) !== generation
					) {
						await this.#cache.delete(cacheKey);
						controller.signal.throwIfAborted();
					}
				});
				controller.signal.throwIfAborted();
				return snapshot;
			})
			.finally(() => {
				flight.settled = true;
				clearTimeout(timeout);
			});
		flight = { controller, promise, rawSettled, settled: false, waiters: 0 };
		this.#discoveryInflight.set(flightKey, flight);
		void Promise.allSettled([rawSettled, promise]).then(() => {
			if (this.#discoveryInflight.get(flightKey) === flight) {
				this.#discoveryInflight.delete(flightKey);
			}
		});
		// If every waiter cancels, the shared promise can still reject after the
		// final waiter detached. Keep that rejection observed.
		void promise.catch(() => undefined);
		return flight;
	}

	async #waitForDiscovery(
		flight: GatewayDiscoveryFlight,
		signal: AbortSignal,
	): Promise<McpGatewayDiscoverySnapshot> {
		flight.waiters += 1;
		try {
			return await waitForDiscovery(flight.promise, signal, flight.controller.signal);
		} finally {
			flight.waiters -= 1;
			if (flight.waiters === 0 && !flight.settled) {
				flight.controller.abort(abandonedDiscoveryError());
			}
		}
	}

	#discoveryGeneration(flightKey: string): number {
		return this.#discoveryGenerations.get(flightKey) ?? 0;
	}

	async #readCachedDiscovery(
		key: McpGatewayDiscoveryCacheKey,
		signal: AbortSignal,
	): Promise<McpGatewayDiscoverySnapshot | undefined> {
		for (;;) {
			const epoch = this.#discoveryEpoch;
			const barrier = this.#discoveryCacheBarrier;
			await barrier;
			signal.throwIfAborted();
			if (epoch !== this.#discoveryEpoch || barrier !== this.#discoveryCacheBarrier) continue;
			const cached = await this.#cache.get(key);
			signal.throwIfAborted();
			if (epoch === this.#discoveryEpoch) return cached;
		}
	}

	async #enqueueCacheMutation<Result>(
		flightKey: string,
		mutation: () => MaybePromise<Result>,
	): Promise<Result> {
		const barrier = this.#discoveryCacheBarrier;
		const previous = this.#discoveryCacheQueues.get(flightKey) ?? Promise.resolve();
		const current = Promise.all([barrier, previous.catch(() => undefined)]).then(async () =>
			mutation(),
		);
		const tail = current.then(
			() => undefined,
			() => undefined,
		);
		this.#discoveryCacheQueues.set(flightKey, tail);
		try {
			return await current;
		} finally {
			if (this.#discoveryCacheQueues.get(flightKey) === tail) {
				this.#discoveryCacheQueues.delete(flightKey);
			}
		}
	}

	async #fetchDiscovery(
		upstream: McpGatewayUpstream,
		context: McpGatewayResolvedRequestContext,
	): Promise<McpGatewayDiscoverySnapshot> {
		const client = await resolveClient(upstream, context);
		const byteBudget = { used: 2 };
		const settled = await Promise.allSettled([
			this.#listAllPages<Tool>(
				upstream.name,
				"tools",
				(params) => client.listTools(params, { signal: context.signal }),
				byteBudget,
			),
			hasPromptCapability(client)
				? this.#listAllPages<Prompt>(
						upstream.name,
						"prompts",
						(params) => client.listPrompts(params, { signal: context.signal }),
						byteBudget,
					)
				: Promise.resolve([]),
			hasResourceCapability(client)
				? this.#listAllPages<Resource>(
						upstream.name,
						"resources",
						(params) => client.listResources(params, { signal: context.signal }),
						byteBudget,
					)
				: Promise.resolve([]),
			hasResourceTemplateCapability(client)
				? this.#listAllPages<McpGatewayResourceTemplateDefinition>(
						upstream.name,
						"resourceTemplates",
						(params) => client.listResourceTemplates(params, { signal: context.signal }),
						byteBudget,
					)
				: Promise.resolve([]),
		]);
		const [toolsResult, promptsResult, resourcesResult, resourceTemplatesResult] = settled;
		const tools = settledValue(toolsResult);
		const prompts = settledValue(promptsResult);
		const resources = settledValue(resourcesResult);
		const resourceTemplates = settledValue(resourceTemplatesResult);
		return validateDiscovery(upstream.name, tools, prompts, resources, resourceTemplates, {
			maxItemBytes: this.#discoveryMaxItemBytes,
			maxSnapshotBytes: this.#discoveryMaxSnapshotBytes,
			maxDepth: this.#discoveryMaxDepth,
			maxStringBytes: this.#discoveryMaxStringBytes,
		});
	}

	async #listAllPages<Item>(
		upstreamName: string,
		capability: "tools" | "prompts" | "resources" | "resourceTemplates",
		load: (
			params: { readonly cursor?: string } | undefined,
		) => MaybePromise<
			{ readonly nextCursor?: string | undefined } & (
				| { readonly tools: readonly Item[] }
				| { readonly prompts: readonly Item[] }
				| { readonly resources: readonly Item[] }
				| { readonly resourceTemplates: readonly Item[] }
			)
		>,
		byteBudget: { used: number },
	): Promise<readonly Item[]> {
		const items: Item[] = [];
		const seenCursors = new Set<string>();
		const limits = {
			maxItemBytes: this.#discoveryMaxItemBytes,
			maxSnapshotBytes: this.#discoveryMaxSnapshotBytes,
			maxDepth: this.#discoveryMaxDepth,
			maxStringBytes: this.#discoveryMaxStringBytes,
		} satisfies DiscoveryStructuralLimits;
		let cursor: string | undefined;
		for (let page = 0; page < this.#discoveryMaxPages; page += 1) {
			const result = await load(cursor === undefined ? undefined : { cursor });
			const pageItems = readPageItems(result, capability);
			if (!Array.isArray(pageItems)) {
				throw invalidDiscovery(upstreamName, `returned an invalid ${capability} page`);
			}
			if (items.length + pageItems.length > this.#discoveryMaxItems) {
				throw invalidDiscovery(
					upstreamName,
					`exceeded the ${String(this.#discoveryMaxItems)} ${capability} discovery-item limit`,
				);
			}
			for (const item of pageItems) {
				const itemBytes = validateDiscoveryItem(upstreamName, item, limits) + 1;
				if (byteBudget.used + itemBytes > limits.maxSnapshotBytes) {
					throw invalidDiscovery(
						upstreamName,
						`exceeded the ${String(limits.maxSnapshotBytes)} UTF-8 byte discovery limit while listing ${capability}`,
					);
				}
				byteBudget.used += itemBytes;
				items.push(item);
			}
			const nextCursor = result.nextCursor;
			if (nextCursor === undefined) return Object.freeze(items);
			if (typeof nextCursor !== "string" || nextCursor.length === 0) {
				throw invalidDiscovery(upstreamName, `returned an invalid ${capability} discovery cursor`);
			}
			if (utf8Bytes(nextCursor) > this.#discoveryMaxStringBytes) {
				throw invalidDiscovery(
					upstreamName,
					`returned a ${capability} discovery cursor exceeding ${String(this.#discoveryMaxStringBytes)} UTF-8 bytes`,
				);
			}
			if (seenCursors.has(nextCursor)) {
				throw invalidDiscovery(
					upstreamName,
					`repeated discovery cursor "${nextCursor}" while listing ${capability}`,
				);
			}
			seenCursors.add(nextCursor);
			cursor = nextCursor;
		}
		throw invalidDiscovery(
			upstreamName,
			`exceeded the ${String(this.#discoveryMaxPages)} page discovery limit while listing ${capability}`,
		);
	}

	async #runOperation(
		operation: McpOperation<McpGatewayOperationInput, McpGatewayOperationContext>,
		terminal: McpOperationHandler<
			McpGatewayOperationInput,
			McpGatewayOperationOutput,
			McpGatewayOperationContext
		>,
		mandatoryMiddleware: readonly McpGatewayMiddleware[] = [],
	): Promise<McpGatewayOperationOutput> {
		this.#lifecycle.assertOpen();
		operation.context.signal.throwIfAborted();
		const guardedTerminal: typeof terminal = async (currentOperation) => {
			this.#lifecycle.assertOpen();
			currentOperation.context.signal.throwIfAborted();
			const result = await terminal(currentOperation);
			currentOperation.context.signal.throwIfAborted();
			this.#lifecycle.assertOpen();
			return result;
		};
		const securedWork = composeMcpMiddleware(
			[...mandatoryMiddleware, ...this.#middleware, ...this.#transforms],
			guardedTerminal,
		);
		if (this.#lifecycleObserver === undefined) {
			const result = await securedWork(operation);
			operation.context.signal.throwIfAborted();
			this.#lifecycle.assertOpen();
			return result;
		}
		const lifecycle =
			this.#onObserverError === undefined
				? createMcpLifecycleMiddleware<
						McpGatewayOperationInput,
						McpGatewayOperationOutput,
						McpGatewayOperationContext
					>(this.#lifecycleObserver)
				: createMcpLifecycleMiddleware<
						McpGatewayOperationInput,
						McpGatewayOperationOutput,
						McpGatewayOperationContext
					>(this.#lifecycleObserver, {
						onObserverError: async (error) => this.#onObserverError?.(error),
					});
		const result = await composeMcpMiddleware([lifecycle], securedWork)(operation);
		operation.context.signal.throwIfAborted();
		this.#lifecycle.assertOpen();
		return result;
	}

	async #canDiscoverTool(
		projected: McpGatewayProjectedTool,
		context: McpGatewayResolvedRequestContext,
	): Promise<boolean> {
		return canDiscover(() => this.#authorizeTool(toolPolicyInput("discover", projected), context));
	}

	async #canDiscoverPrompt(
		projected: McpGatewayProjectedPrompt,
		context: McpGatewayResolvedRequestContext,
	): Promise<boolean> {
		return canDiscover(() =>
			this.#authorizePrompt(promptPolicyInput("discover", projected), context),
		);
	}

	async #canDiscoverResource(
		projected: McpGatewayProjectedResource,
		context: McpGatewayResolvedRequestContext,
	): Promise<boolean> {
		return canDiscover(() =>
			this.#authorizeResource(resourcePolicyInput("discover", projected), context),
		);
	}

	async #canDiscoverResourceTemplate(
		projected: McpGatewayProjectedResourceTemplate,
		context: McpGatewayResolvedRequestContext,
	): Promise<boolean> {
		return canDiscover(() =>
			this.#authorizeResourceTemplate(resourceTemplatePolicyInput("discover", projected), context),
		);
	}

	async #visibleResourceUris(
		upstreamName: string,
		snapshot: McpGatewayDiscoverySnapshot,
		context: McpGatewayResolvedRequestContext,
	): Promise<ReadonlySet<string>> {
		const visible = new Set<string>();
		for (const resource of snapshot.resources ?? []) {
			const projected = this.#projectResource(upstreamName, resource);
			if (await this.#canDiscoverResource(projected, context)) visible.add(resource.uri);
		}
		return visible;
	}

	#authorizeTool(
		input: McpGatewayPolicyInput,
		context: McpGatewayResolvedRequestContext,
	): Promise<McpAuthorizationAllowDecision> {
		return enforceMcpAuthorization(
			this.#policy,
			createMcpOperation(Object.freeze(input), createGatewayPolicyContext(input, context)),
		);
	}

	#authorizePrompt(
		input: McpGatewayPromptPolicyInput,
		context: McpGatewayResolvedRequestContext,
	): Promise<McpAuthorizationAllowDecision> {
		const authorize = this.#policy.authorizePrompt;
		return enforceMcpAuthorization(
			authorize === undefined ? undefined : { authorize },
			createMcpOperation(Object.freeze(input), createGatewayPolicyContext(input, context)),
		);
	}

	#authorizeResource(
		input: McpGatewayResourcePolicyInput,
		context: McpGatewayResolvedRequestContext,
	): Promise<McpAuthorizationAllowDecision> {
		const authorize = this.#policy.authorizeResource;
		return enforceMcpAuthorization(
			authorize === undefined ? undefined : { authorize },
			createMcpOperation(Object.freeze(input), createGatewayPolicyContext(input, context)),
		);
	}

	#authorizeResourceTemplate(
		input: McpGatewayResourceTemplatePolicyInput,
		context: McpGatewayResolvedRequestContext,
	): Promise<McpAuthorizationAllowDecision> {
		const authorize = this.#policy.authorizeResourceTemplate;
		return enforceMcpAuthorization(
			authorize === undefined ? undefined : { authorize },
			createMcpOperation(Object.freeze(input), createGatewayPolicyContext(input, context)),
		);
	}

	#projectTool(upstreamName: string, tool: Tool): McpGatewayProjectedTool {
		const projectedName = this.#nameCodec.encode(upstreamName, tool.name);
		const definition = Object.freeze({
			...tool,
			name: projectedName,
			_meta: projectedMetadata("tool", projectedName),
		}) satisfies Tool;
		return Object.freeze({
			projectedName,
			upstreamName,
			toolName: tool.name,
			tool,
			definition,
		});
	}

	#projectPrompt(upstreamName: string, prompt: Prompt): McpGatewayProjectedPrompt {
		const projectedName = this.#promptNameCodec.encode(upstreamName, prompt.name);
		const definition = Object.freeze({
			...prompt,
			name: projectedName,
			_meta: projectedMetadata("prompt", projectedName),
		}) satisfies Prompt;
		return Object.freeze({
			projectedName,
			upstreamName,
			promptName: prompt.name,
			prompt,
			definition,
		});
	}

	#projectResource(upstreamName: string, resource: Resource): McpGatewayProjectedResource {
		const projectedName = this.#nameCodec.encode(upstreamName, resource.name);
		const projectedUri = this.#resourceUriCodec.encode(upstreamName, resource.uri);
		const definition = Object.freeze({
			...resource,
			name: projectedName,
			uri: projectedUri,
			_meta: projectedMetadata("resource", projectedName),
		}) satisfies Resource;
		return Object.freeze({
			projectedName,
			projectedUri,
			upstreamName,
			resourceName: resource.name,
			resource,
			definition,
		});
	}

	#projectResourceTemplate(
		upstreamName: string,
		resourceTemplate: McpGatewayResourceTemplateDefinition,
	): McpGatewayProjectedResourceTemplate {
		const projectedName = this.#resourceTemplateNameCodec.encode(
			upstreamName,
			resourceTemplate.name,
		);
		const projectedTemplateUri = this.#resourceTemplateUriCodec.encode(
			upstreamName,
			resourceTemplate.uriTemplate,
		);
		const definition = Object.freeze({
			...resourceTemplate,
			name: projectedName,
			uriTemplate: projectedTemplateUri,
			_meta: projectedMetadata("resourceTemplate", projectedName),
		}) satisfies McpGatewayResourceTemplateDefinition;
		return Object.freeze({
			projectedName,
			projectedTemplateUri,
			upstreamName,
			resourceTemplateName: resourceTemplate.name,
			resourceTemplate,
			definition,
		});
	}

	#requireUpstream(upstreamName: string): McpGatewayUpstream {
		const upstream = this.#upstreams.get(upstreamName);
		if (upstream === undefined || this.#fencedUpstreamNames.has(upstreamName)) {
			throw new McpGatewayError(
				"UNKNOWN_UPSTREAM",
				`No MCP gateway upstream named "${upstreamName}" is registered.`,
			);
		}
		return upstream;
	}

	#topologySnapshot(): McpGatewayTopologySnapshot {
		return Object.freeze({
			revision: this.#topologyRevision,
			upstreamNames: Object.freeze([...this.#upstreams.keys()].toSorted()),
		});
	}

	#assertDynamicTopology(): void {
		if (this.#dynamicUpstreams) return;
		throw new McpGatewayError(
			"STATIC_TOPOLOGY",
			"Runtime upstream mutations require dynamicUpstreams: true.",
		);
	}

	#attachTopology(
		upstream: McpGatewayUpstream,
		expectedRevision: number | undefined,
	): Promise<McpGatewayTopologySnapshot> {
		this.#assertDynamicTopology();
		const normalizedUpstream = snapshotUpstreams([upstream]).values().next().value;
		if (normalizedUpstream === undefined) {
			throw new McpGatewayError("INVALID_OPTIONS", "An upstream definition is required.");
		}
		return this.#queueTopologyMutation(expectedRevision, (current) => {
			if (current.has(normalizedUpstream.name)) {
				throw new McpGatewayError(
					"DUPLICATE_UPSTREAM",
					`An MCP gateway upstream named "${normalizedUpstream.name}" is already registered.`,
				);
			}
			const next = new Map(current);
			next.set(normalizedUpstream.name, normalizedUpstream);
			return next;
		});
	}

	#detachTopology(
		upstreamName: string,
		expectedRevision: number | undefined,
	): Promise<McpGatewayTopologySnapshot> {
		this.#assertDynamicTopology();
		const normalizedName = assertUpstreamName(upstreamName);
		return this.#queueTopologyMutation(expectedRevision, (current) => {
			const next = new Map(current);
			if (!next.delete(normalizedName)) {
				throw new McpGatewayError(
					"UNKNOWN_UPSTREAM",
					`No MCP gateway upstream named "${normalizedName}" is registered.`,
				);
			}
			return next;
		});
	}

	#replaceTopology(
		upstreamName: string,
		replacement: McpGatewayUpstream,
		expectedRevision: number | undefined,
	): Promise<McpGatewayTopologySnapshot> {
		this.#assertDynamicTopology();
		const normalizedName = assertUpstreamName(upstreamName);
		const normalizedReplacement = snapshotUpstreams([replacement]).values().next().value;
		if (normalizedReplacement === undefined) {
			throw new McpGatewayError("INVALID_OPTIONS", "A replacement upstream is required.");
		}
		if (normalizedReplacement.name === normalizedName) {
			throw new McpGatewayError(
				"INVALID_OPTIONS",
				"A replacement upstream must use a fresh routing name.",
			);
		}
		return this.#queueTopologyMutation(expectedRevision, (current) => {
			if (!current.has(normalizedName)) {
				throw new McpGatewayError(
					"UNKNOWN_UPSTREAM",
					`No MCP gateway upstream named "${normalizedName}" is registered.`,
				);
			}
			if (current.has(normalizedReplacement.name)) {
				throw new McpGatewayError(
					"DUPLICATE_UPSTREAM",
					`An MCP gateway upstream named "${normalizedReplacement.name}" is already registered.`,
				);
			}
			const next = new Map(current);
			next.delete(normalizedName);
			next.set(normalizedReplacement.name, normalizedReplacement);
			return next;
		});
	}

	#queueTopologyMutation(
		expectedRevision: number | undefined,
		mutate: (
			current: ReadonlyMap<string, McpGatewayUpstream>,
		) => ReadonlyMap<string, McpGatewayUpstream>,
	): Promise<McpGatewayTopologySnapshot> {
		const predecessor = this.#topologyMutationTail;
		const mutation = predecessor
			.catch(() => undefined)
			.then(async () => {
				this.#lifecycle.assertOpen();
				assertTopologyRevision(expectedRevision, this.#topologyRevision);
				const current = this.#upstreams;
				const next = mutate(current);
				const removedNames = [...current.keys()].filter((name) => !next.has(name));
				for (const name of removedNames) this.#fencedUpstreamNames.add(name);

				try {
					// Removed routes reject new invocation admission before the first await.
					// Cache cleanup must settle before the candidate topology is committed.
					await this.#invalidateAllDiscovery();
					this.#lifecycle.assertOpen();
					this.#upstreams = new Map(
						[...next.entries()].toSorted(([left], [right]) => left.localeCompare(right, "en-US")),
					);
					this.#topologyRevision += 1;
					return this.#topologySnapshot();
				} finally {
					for (const name of removedNames) this.#fencedUpstreamNames.delete(name);
				}
			});
		this.#topologyMutationTail = mutation.then(
			() => undefined,
			() => undefined,
		);
		return mutation;
	}

	async #resolveContext(
		context: McpGatewayRequestContext,
	): Promise<McpGatewayResolvedRequestContext> {
		this.#lifecycle.assertOpen();
		const requestSignal = context.signal ?? context.request?.signal ?? new AbortController().signal;
		const signal = AbortSignal.any([requestSignal, this.#lifecycle.signal]);
		signal.throwIfAborted();
		const contextSnapshot = Object.freeze({
			...context,
			signal,
			...(context.principal === undefined
				? {}
				: { principal: toSafeGatewayPrincipal(context.principal) }),
		});
		const authorizationContext = await this.#resolveAuthorizationContext(contextSnapshot);
		this.#lifecycle.assertOpen();
		signal.throwIfAborted();
		if (typeof authorizationContext !== "string" || authorizationContext.length === 0) {
			throw new McpGatewayError(
				"INVALID_OPTIONS",
				"Authorization context resolver must return a non-empty string.",
			);
		}
		return Object.freeze({ ...contextSnapshot, authorizationContext });
	}
}

/** Explicit opt-in policy for already trusted, isolated gateway deployments. */
export function allowAllMcpGatewayPolicy(): McpGatewayPolicy {
	return Object.freeze({
		authorize: allowGatewayOperation,
		authorizePrompt: allowGatewayOperation,
		authorizeResource: allowGatewayOperation,
		authorizeResourceTemplate: allowGatewayOperation,
	});
}

function allowGatewayOperation(): McpAuthorizationAllowDecision {
	return allowMcpOperation({ policy: "gateway.allow-all" });
}

/**
 * Safe default cache identity. It fingerprints every available principal
 * dimension and bearer token without returning the credential itself.
 */
export async function defaultMcpGatewayAuthorizationContext(
	context: McpGatewayRequestContext,
): Promise<string> {
	if (context.principal !== undefined) {
		const bearerFingerprint =
			context.authInfo === undefined ? null : await sha256Hex(context.authInfo.token);
		const identity = JSON.stringify([
			context.principal.clientId,
			context.principal.subject ?? null,
			context.principal.tenantId ?? null,
			[...context.principal.scopes].toSorted(),
			context.principal.resource ?? null,
			bearerFingerprint,
		]);
		return `principal-sha256:${await sha256Hex(identity)}`;
	}
	if (context.authInfo === undefined) return "anonymous";
	return `bearer-sha256:${await sha256Hex(context.authInfo.token)}`;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Buffer.from(digest).toString("hex");
}

function snapshotUpstreams(
	upstreams: readonly McpGatewayUpstream[],
): ReadonlyMap<string, McpGatewayUpstream> {
	if (!Array.isArray(upstreams)) {
		throw new McpGatewayError("INVALID_OPTIONS", "upstreams must be an array.");
	}
	const snapshot = new Map<string, McpGatewayUpstream>();
	for (const upstream of upstreams) {
		if (typeof upstream?.name !== "string" || upstream.name.length === 0) {
			throw new McpGatewayError("INVALID_OPTIONS", "Every upstream must have a non-empty name.");
		}
		if (snapshot.has(upstream.name)) {
			throw new McpGatewayError(
				"DUPLICATE_UPSTREAM",
				`An MCP gateway upstream named "${upstream.name}" is already registered.`,
			);
		}
		if (!isClient(upstream.client) && typeof upstream.client !== "function") {
			throw new McpGatewayError(
				"INVALID_OPTIONS",
				`Upstream "${upstream.name}" must provide an MCP client or client resolver.`,
			);
		}
		snapshot.set(upstream.name, Object.freeze({ ...upstream }));
	}
	return snapshot;
}

function assertUpstreamName(upstreamName: string): string {
	if (typeof upstreamName !== "string" || upstreamName.length === 0) {
		throw new McpGatewayError("INVALID_OPTIONS", "upstreamName must be a non-empty string.");
	}
	return upstreamName;
}

function assertTopologyRevision(expected: number | undefined, actual: number): void {
	if (expected === undefined) return;
	if (!Number.isSafeInteger(expected) || expected < 0) {
		throw new McpGatewayError(
			"INVALID_OPTIONS",
			"expectedRevision must be a non-negative safe integer.",
		);
	}
	if (expected === actual) return;
	throw new McpGatewayError(
		"TOPOLOGY_REVISION_CONFLICT",
		"The MCP gateway topology changed after it was read.",
	);
}

function snapshotMiddleware(
	middleware: readonly McpGatewayMiddleware[],
): readonly McpGatewayMiddleware[] {
	return Object.freeze(
		middleware.map((entry, index) => {
			if (typeof entry !== "function") {
				throw new McpGatewayError(
					"INVALID_OPTIONS",
					`Gateway middleware at index ${String(index)} must be a function.`,
				);
			}
			return entry;
		}),
	);
}

async function resolveClient(
	upstream: McpGatewayUpstream,
	context: McpGatewayResolvedRequestContext,
): Promise<McpGatewayToolClient> {
	const candidate =
		typeof upstream.client === "function" ? await upstream.client(context) : upstream.client;
	if (!isClient(candidate)) {
		throw new McpGatewayError(
			"INVALID_OPTIONS",
			`Client resolver for upstream "${upstream.name}" returned an invalid MCP client.`,
		);
	}
	return candidate;
}

function isClient(value: unknown): value is McpGatewayToolClient {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Partial<McpGatewayToolClient>).listTools === "function" &&
		typeof (value as Partial<McpGatewayToolClient>).callTool === "function"
	);
}

function hasPromptCapability(
	client: McpGatewayToolClient,
): client is McpGatewayToolClient &
	Required<Pick<McpGatewayToolClient, "getPrompt" | "listPrompts">> {
	if (typeof client.listPrompts !== "function" || typeof client.getPrompt !== "function")
		return false;
	const capabilities = client.getServerCapabilities?.();
	return capabilities === undefined || capabilities.prompts !== undefined;
}

function hasResourceCapability(
	client: McpGatewayToolClient,
): client is McpGatewayToolClient &
	Required<Pick<McpGatewayToolClient, "listResources" | "readResource">> {
	if (typeof client.listResources !== "function" || typeof client.readResource !== "function") {
		return false;
	}
	const capabilities = client.getServerCapabilities?.();
	return capabilities === undefined || capabilities.resources !== undefined;
}

function hasResourceTemplateCapability(
	client: McpGatewayToolClient,
): client is McpGatewayToolClient &
	Required<Pick<McpGatewayToolClient, "listResourceTemplates" | "readResource">> {
	if (
		typeof client.listResourceTemplates !== "function" ||
		typeof client.readResource !== "function"
	) {
		return false;
	}
	const capabilities = client.getServerCapabilities?.();
	return capabilities === undefined || capabilities.resources !== undefined;
}

function hasCompletionCapability(
	client: McpGatewayToolClient,
): client is McpGatewayToolClient & Required<Pick<McpGatewayToolClient, "complete">> {
	if (typeof client.complete !== "function") return false;
	const capabilities = client.getServerCapabilities?.();
	return capabilities === undefined || capabilities.completions !== undefined;
}

function validateDiscovery(
	upstreamName: string,
	tools: readonly Tool[],
	prompts: readonly Prompt[],
	resources: readonly Resource[],
	resourceTemplates: readonly McpGatewayResourceTemplateDefinition[],
	limits: DiscoveryStructuralLimits,
	discoveredAt = Date.now(),
): McpGatewayDiscoverySnapshot {
	validateDiscoveryStructure(
		upstreamName,
		[...tools, ...prompts, ...resources, ...resourceTemplates],
		limits,
	);
	validateUnique(upstreamName, "tool", tools, (tool) => tool.name, "DUPLICATE_TOOL");
	validateUnique(upstreamName, "prompt", prompts, (prompt) => prompt.name, "DUPLICATE_PROMPT");
	validateUnique(
		upstreamName,
		"resource URI",
		resources,
		(resource) => resource.uri,
		"DUPLICATE_RESOURCE",
		false,
	);
	for (const resource of resources) {
		if (typeof resource.name !== "string" || resource.name.length === 0) {
			throw invalidDiscovery(upstreamName, "returned a resource without a valid name");
		}
		try {
			if (URL.parse(resource.uri) === null) throw new TypeError();
		} catch {
			throw invalidDiscovery(upstreamName, "returned a resource without an absolute URI");
		}
	}
	validateUnique(
		upstreamName,
		"resource-template name",
		resourceTemplates,
		(resourceTemplate) => resourceTemplate.name,
		"DUPLICATE_RESOURCE_TEMPLATE",
	);
	validateUnique(
		upstreamName,
		"resource-template URI",
		resourceTemplates,
		(resourceTemplate) => resourceTemplate.uriTemplate,
		"DUPLICATE_RESOURCE_TEMPLATE",
		false,
	);
	for (const resourceTemplate of resourceTemplates) {
		try {
			const template = new UriTemplate(resourceTemplate.uriTemplate);
			if (template.variableNames.length === 0) throw new TypeError();
		} catch {
			throw invalidDiscovery(upstreamName, "returned an invalid resource template");
		}
	}
	return freezeMcpGatewayDiscoverySnapshot({
		tools: Object.freeze([...tools]),
		prompts: Object.freeze([...prompts]),
		resources: Object.freeze([...resources]),
		resourceTemplates: Object.freeze([...resourceTemplates]),
		discoveredAt,
	});
}

interface DiscoveryStructuralLimits {
	readonly maxDepth: number;
	readonly maxItemBytes: number;
	readonly maxSnapshotBytes: number;
	readonly maxStringBytes: number;
}

function validateDiscoveryStructure(
	upstreamName: string,
	items: readonly unknown[],
	limits: DiscoveryStructuralLimits,
): void {
	let snapshotBytes = 2;
	for (const item of items) {
		const itemBytes = validateDiscoveryItem(upstreamName, item, limits);
		snapshotBytes += itemBytes + 1;
		if (snapshotBytes > limits.maxSnapshotBytes) {
			throw invalidDiscovery(
				upstreamName,
				`returned a discovery snapshot exceeding ${String(limits.maxSnapshotBytes)} UTF-8 bytes`,
			);
		}
	}
}

function validateDiscoveryItem(
	upstreamName: string,
	item: unknown,
	limits: DiscoveryStructuralLimits,
): number {
	validateDiscoveryValue(upstreamName, item, limits, 0, new WeakSet<object>());
	let serialized: string;
	try {
		serialized = JSON.stringify(item);
	} catch (cause) {
		throw invalidDiscoveryWithCause(
			upstreamName,
			"returned non-serializable discovery data",
			cause,
		);
	}
	const itemBytes = utf8Bytes(serialized);
	if (itemBytes > limits.maxItemBytes) {
		throw invalidDiscovery(
			upstreamName,
			`returned a discovery item exceeding ${String(limits.maxItemBytes)} UTF-8 bytes`,
		);
	}
	return itemBytes;
}

function validateDiscoveryValue(
	upstreamName: string,
	value: unknown,
	limits: DiscoveryStructuralLimits,
	depth: number,
	seen: WeakSet<object>,
): void {
	if (depth > limits.maxDepth) {
		throw invalidDiscovery(
			upstreamName,
			`returned discovery data deeper than ${String(limits.maxDepth)} levels`,
		);
	}
	if (typeof value === "string") {
		if (utf8Bytes(value) > limits.maxStringBytes) {
			throw invalidDiscovery(
				upstreamName,
				`returned a discovery string exceeding ${String(limits.maxStringBytes)} UTF-8 bytes`,
			);
		}
		return;
	}
	if (value === null || value === undefined || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw invalidDiscovery(upstreamName, "returned a non-finite discovery number");
		}
		return;
	}
	if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
		throw invalidDiscovery(upstreamName, "returned non-JSON discovery data");
	}
	if (typeof value !== "object") return;
	if (seen.has(value)) throw invalidDiscovery(upstreamName, "returned cyclic discovery data");
	seen.add(value);
	try {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string" || utf8Bytes(key) > limits.maxStringBytes) {
				throw invalidDiscovery(upstreamName, "returned an invalid or oversized discovery key");
			}
			const descriptor = descriptors[key];
			if (descriptor === undefined || !("value" in descriptor)) {
				throw invalidDiscovery(upstreamName, "returned discovery data with accessor properties");
			}
			if (descriptor.enumerable !== true) continue;
			validateDiscoveryValue(upstreamName, descriptor.value, limits, depth + 1, seen);
		}
	} finally {
		seen.delete(value);
	}
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function validateUnique<Item>(
	upstreamName: string,
	kind: string,
	items: readonly Item[],
	key: (item: Item) => unknown,
	code:
		"DUPLICATE_TOOL" | "DUPLICATE_PROMPT" | "DUPLICATE_RESOURCE" | "DUPLICATE_RESOURCE_TEMPLATE",
	exposeDuplicateValue = true,
): void {
	const values = new Set<string>();
	for (const item of items) {
		const value = key(item);
		if (typeof value !== "string" || value.length === 0) {
			throw invalidDiscovery(upstreamName, `returned a ${kind} without a valid identifier`);
		}
		if (values.has(value)) {
			throw new McpGatewayError(
				code,
				exposeDuplicateValue
					? `Upstream "${upstreamName}" returned duplicate ${kind} "${value}".`
					: `Upstream "${upstreamName}" returned a duplicate ${kind}.`,
			);
		}
		values.add(value);
	}
}

function toolPolicyInput(
	action: "discover" | "invoke",
	projected: McpGatewayProjectedTool,
	arguments_?: Readonly<Record<string, unknown>>,
): McpGatewayPolicyInput {
	return Object.freeze({
		action,
		upstreamName: projected.upstreamName,
		toolName: projected.toolName,
		projectedName: projected.projectedName,
		tool: projected.tool,
		...(arguments_ === undefined ? {} : { arguments: arguments_ }),
	});
}

function promptPolicyInput(
	action: "discover" | "get" | "complete",
	projected: McpGatewayProjectedPrompt,
	arguments_?: Readonly<Record<string, string>>,
	completion?: McpGatewayPromptPolicyInput["completion"],
): McpGatewayPromptPolicyInput {
	return Object.freeze({
		action,
		upstreamName: projected.upstreamName,
		promptName: projected.promptName,
		projectedName: projected.projectedName,
		prompt: projected.prompt,
		...(arguments_ === undefined ? {} : { arguments: arguments_ }),
		...(completion === undefined ? {} : { completion }),
	});
}

function resourcePolicyInput(
	action: "discover" | "read",
	projected: McpGatewayProjectedResource,
): McpGatewayResourcePolicyInput {
	return Object.freeze({
		action,
		upstreamName: projected.upstreamName,
		resourceName: projected.resourceName,
		projectedName: projected.projectedName,
		projectedUri: projected.projectedUri,
		resource: projected.resource,
	});
}

function resourceTemplatePolicyInput(
	action: "discover" | "read" | "complete",
	projected: McpGatewayProjectedResourceTemplate,
	variables?: Variables,
	completion?: McpGatewayResourceTemplatePolicyInput["completion"],
): McpGatewayResourceTemplatePolicyInput {
	return Object.freeze({
		action,
		upstreamName: projected.upstreamName,
		resourceTemplateName: projected.resourceTemplateName,
		projectedName: projected.projectedName,
		projectedTemplateUri: projected.projectedTemplateUri,
		resourceTemplate: projected.resourceTemplate,
		...(variables === undefined ? {} : { variables }),
		...(completion === undefined ? {} : { completion }),
	});
}

function completionPolicyData(
	params: CompleteRequest["params"],
): Readonly<Pick<CompleteRequest["params"], "argument" | "context">> {
	return Object.freeze({
		argument: Object.freeze({ ...params.argument }),
		...(params.context === undefined
			? {}
			: {
					context: Object.freeze({
						...params.context,
						...(params.context.arguments === undefined
							? {}
							: { arguments: Object.freeze({ ...params.context.arguments }) }),
					}),
				}),
	});
}

async function canDiscover(authorize: () => Promise<unknown>): Promise<boolean> {
	try {
		await authorize();
		return true;
	} catch (error) {
		if (error instanceof McpAuthorizationError) return false;
		throw error;
	}
}

function projectedMetadata(
	kind: "tool" | "prompt" | "resource" | "resourceTemplate",
	projectedName: string,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		[GATEWAY_META_KEY]: Object.freeze({ kind, projectedName }),
	});
}

function promptArgumentsJsonSchema(prompt: Prompt): JsonSchemaType {
	const properties: Record<string, JsonSchemaType> = {};
	const required: string[] = [];
	for (const argument of prompt.arguments ?? []) {
		properties[argument.name] = {
			type: "string",
			...(argument.description === undefined ? {} : { description: argument.description }),
		};
		if (argument.required === true) required.push(argument.name);
	}
	return {
		type: "object",
		properties,
		additionalProperties: false,
		...(required.length === 0 ? {} : { required }),
	};
}

function createPromptArgumentsSchema(
	prompt: Prompt,
): StandardSchemaWithJSON<Record<string, string>, Record<string, string>> {
	return fromJsonSchema<Record<string, string>>(promptArgumentsJsonSchema(prompt));
}

function rewritePromptResult(
	result: GetPromptResult,
	upstreamName: string,
	nameCodec: NonNullable<McpGatewayOptions["nameCodec"]>,
	uriCodec: NonNullable<McpGatewayOptions["resourceUriCodec"]>,
	listedResourceUris: ReadonlySet<string>,
): GetPromptResult {
	if (!isGetPromptResult(result)) {
		throw new McpGatewayError(
			"INVALID_PROMPT_RESULT",
			"Upstream returned an invalid prompt result.",
		);
	}
	return {
		...stripOpaqueMetadata(result),
		messages: result.messages.map((message) => ({
			...stripOpaqueMetadata(message),
			content: rewriteContentBlock(
				message.content,
				upstreamName,
				nameCodec,
				uriCodec,
				listedResourceUris,
			),
		})),
	};
}

function rewriteCallToolResult(
	result: CallToolResult,
	upstreamName: string,
	nameCodec: NonNullable<McpGatewayOptions["nameCodec"]>,
	uriCodec: NonNullable<McpGatewayOptions["resourceUriCodec"]>,
	listedResourceUris: ReadonlySet<string>,
): CallToolResult {
	if (!isCallToolResult(result)) {
		throw new McpGatewayError(
			"INVALID_INVOCATION_RESULT",
			"Upstream returned an invalid tool-call result.",
		);
	}
	return {
		...stripOpaqueMetadata(result),
		content: result.content.map((content) =>
			rewriteContentBlock(content, upstreamName, nameCodec, uriCodec, listedResourceUris),
		),
	};
}

function rewriteContentBlock(
	content: ContentBlock,
	upstreamName: string,
	nameCodec: NonNullable<McpGatewayOptions["nameCodec"]>,
	uriCodec: NonNullable<McpGatewayOptions["resourceUriCodec"]>,
	listedResourceUris: ReadonlySet<string>,
): ContentBlock {
	if (content.type === "resource_link") {
		if (!listedResourceUris.has(content.uri)) {
			throw new McpGatewayError(
				"UNLISTED_RESOURCE_LINK",
				"An upstream result referenced a resource that was not authorized through concrete resource discovery.",
			);
		}
		return {
			...stripOpaqueMetadata(content),
			name: nameCodec.encode(upstreamName, content.name),
			uri: uriCodec.encode(upstreamName, content.uri),
		};
	}
	if (content.type === "resource") {
		if (!listedResourceUris.has(content.resource.uri)) {
			throw new McpGatewayError(
				"UNLISTED_RESOURCE_LINK",
				"An upstream result embedded a resource that was not authorized through concrete resource discovery.",
			);
		}
		return {
			...stripOpaqueMetadata(content),
			resource: {
				...stripOpaqueMetadata(content.resource),
				uri: uriCodec.encode(upstreamName, content.resource.uri),
			},
		};
	}
	return stripOpaqueMetadata(content);
}

function rewriteReadResourceResult(
	result: ReadResourceResult,
	rawRequestedUri: string,
	projectedRequestedUri: string,
): ReadResourceResult {
	if (!isReadResourceResult(result)) {
		throw new McpGatewayError(
			"INVALID_RESOURCE_RESULT",
			"Upstream returned an invalid resource-read result.",
		);
	}
	return {
		...stripOpaqueMetadata(result),
		contents: result.contents.map((content) => {
			if (content.uri !== rawRequestedUri) {
				throw new McpGatewayError(
					"UNLISTED_RESOURCE_LINK",
					"A concrete resource read returned content for an unrelated resource URI.",
				);
			}
			return { ...stripOpaqueMetadata(content), uri: projectedRequestedUri };
		}),
	};
}

function rewriteTemplateReadResult(
	result: ReadResourceResult,
	rawExpandedUri: string,
	projectedExpandedUri: string,
): ReadResourceResult {
	if (!isReadResourceResult(result)) {
		throw new McpGatewayError(
			"INVALID_RESOURCE_RESULT",
			"Upstream returned an invalid resource-template read result.",
		);
	}
	return {
		...stripOpaqueMetadata(result),
		contents: result.contents.map((content) => {
			if (content.uri !== rawExpandedUri) {
				throw new McpGatewayError(
					"UNLISTED_RESOURCE_LINK",
					"A resource-template read returned content for an unrelated resource URI.",
				);
			}
			return { ...stripOpaqueMetadata(content), uri: projectedExpandedUri };
		}),
	};
}

function stripOpaqueMetadata<Value extends object>(value: Value): Value {
	const copy = { ...value };
	Reflect.deleteProperty(copy, "_meta");
	return copy;
}

function validateTemplateVariables(templateValue: string, value: Variables): Variables {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new McpGatewayError(
			"INVALID_PROJECTED_TEMPLATE_URI",
			"Resource-template variables must be an object.",
		);
	}
	const expected = new Set(new UriTemplate(templateValue).variableNames);
	const entries = Object.entries(value);
	if (entries.length !== expected.size || entries.some(([name]) => !expected.has(name))) {
		throw new McpGatewayError(
			"INVALID_PROJECTED_TEMPLATE_URI",
			"Resource-template variables must exactly match the projected template.",
		);
	}
	const snapshot: Variables = {};
	for (const [name, variable] of entries) {
		if (typeof variable !== "string" || variable.length === 0) {
			throw new McpGatewayError(
				"INVALID_PROJECTED_TEMPLATE_URI",
				"Resource-template variable values must be non-empty strings; array expansion is not supported by the projected route.",
			);
		}
		snapshot[name] = variable;
	}
	return Object.freeze(snapshot);
}

function decodeProjectedTemplateVariables(
	projectedTemplateUri: string,
	captured: Variables,
	concreteProjectedUri: string,
): Variables {
	const expected = new Set(new UriTemplate(projectedTemplateUri).variableNames);
	const entries = Object.entries(captured);
	if (entries.length !== expected.size || entries.some(([name]) => !expected.has(name))) {
		throw new McpGatewayError(
			"INVALID_PROJECTED_TEMPLATE_URI",
			"The expanded projected URI does not contain exactly the template variables.",
		);
	}
	const decoded: Variables = {};
	for (const [name, value] of entries) {
		if (typeof value !== "string" || value.length === 0) throw invalidProjectedExpansion();
		try {
			const decodedValue = decodeURIComponent(value);
			if (decodedValue.length === 0) throw invalidProjectedExpansion();
			decoded[name] = decodedValue;
		} catch (cause) {
			if (cause instanceof McpGatewayError) throw cause;
			throw invalidProjectedExpansion(cause);
		}
	}
	const snapshot = validateTemplateVariables(projectedTemplateUri, decoded);
	if (new UriTemplate(projectedTemplateUri).expand(snapshot) !== concreteProjectedUri) {
		throw invalidProjectedExpansion();
	}
	return snapshot;
}

function invalidProjectedExpansion(cause?: unknown): McpGatewayError {
	return new McpGatewayError(
		"INVALID_PROJECTED_TEMPLATE_URI",
		"The expanded projected resource-template URI is not canonical.",
		cause === undefined ? undefined : { cause },
	);
}

function validateCompletionRequest(params: CompleteRequest["params"]): void {
	if (
		typeof params !== "object" ||
		params === null ||
		typeof params.argument?.name !== "string" ||
		params.argument.name.length === 0 ||
		typeof params.argument.value !== "string"
	) {
		throw invalidCompletionRequest("Completion arguments must contain a name and string value.");
	}
	if (params.context?.arguments !== undefined) {
		for (const [name, value] of Object.entries(params.context.arguments)) {
			if (name.length === 0 || typeof value !== "string") {
				throw invalidCompletionRequest("Completion context arguments must be strings.");
			}
		}
	}
}

function snapshotToolArguments(
	value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
	if (value === undefined) return undefined;
	const snapshot = snapshotJsonValue(value, "Tool arguments");
	if (!isGatewayJsonObject(snapshot)) {
		throw new McpGatewayError("INVALID_OPTIONS", "Tool arguments must be a JSON object.");
	}
	return snapshot;
}

function snapshotStringArguments(
	value: Readonly<Record<string, string>> | undefined,
	label: string,
): Readonly<Record<string, string>> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new McpGatewayError("INVALID_OPTIONS", `${label} must be an object.`);
	}
	const entries = Object.entries(value);
	if (entries.some(([name, entry]) => name.length === 0 || typeof entry !== "string")) {
		throw new McpGatewayError("INVALID_OPTIONS", `${label} must contain only named strings.`);
	}
	const snapshot = Object.freeze(Object.fromEntries(entries));
	assertBoundedJson(snapshot, label);
	return snapshot;
}

function snapshotCompletionParams(params: CompleteRequest["params"]): CompleteRequest["params"] {
	const argument = Object.freeze({ ...params.argument });
	const contextArguments = snapshotStringArguments(
		params.context?.arguments,
		"Completion context arguments",
	);
	const context =
		params.context === undefined
			? undefined
			: Object.freeze({
					...params.context,
					...(contextArguments === undefined ? {} : { arguments: contextArguments }),
				});
	const ref = Object.freeze({ ...params.ref });
	const snapshot = Object.freeze({
		...params,
		ref,
		argument,
		...(context === undefined ? {} : { context }),
	});
	assertBoundedJson(snapshot, "Completion request");
	return snapshot;
}

type GatewayJsonValue =
	boolean | null | number | string | readonly GatewayJsonValue[] | GatewayJsonObject;

interface GatewayJsonObject {
	readonly [key: string]: GatewayJsonValue;
}

function isGatewayJsonObject(value: GatewayJsonValue): value is GatewayJsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotJsonValue(value: unknown, label: string): GatewayJsonValue {
	const state = { nodes: 0 };
	const snapshot = copyJsonValue(value, label, state, 0, new WeakSet<object>());
	assertBoundedJson(snapshot, label);
	return snapshot;
}

function copyJsonValue(
	value: unknown,
	label: string,
	state: { nodes: number },
	depth: number,
	seen: WeakSet<object>,
): GatewayJsonValue {
	state.nodes += 1;
	if (state.nodes > MAX_OPERATION_INPUT_NODES || depth > MAX_OPERATION_INPUT_DEPTH) {
		throw new McpGatewayError("INVALID_OPTIONS", `${label} exceeds gateway complexity limits.`);
	}
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object") {
		throw new McpGatewayError("INVALID_OPTIONS", `${label} must contain only JSON values.`);
	}
	if (seen.has(value)) {
		throw new McpGatewayError("INVALID_OPTIONS", `${label} must not contain cycles.`);
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return Object.freeze(
				value.map((entry) => copyJsonValue(entry, label, state, depth + 1, seen)),
			);
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (
			Reflect.ownKeys(value).some(
				(key) =>
					typeof key !== "string" ||
					descriptors[key]?.enumerable !== true ||
					!("value" in (descriptors[key] ?? {})),
			)
		) {
			throw new McpGatewayError(
				"INVALID_OPTIONS",
				`${label} must contain only enumerable data properties.`,
			);
		}
		return Object.freeze(
			Object.fromEntries(
				Object.entries(descriptors).map(([key, descriptor]) => [
					key,
					copyJsonValue(descriptor.value, label, state, depth + 1, seen),
				]),
			),
		);
	} finally {
		seen.delete(value);
	}
}

function assertBoundedJson(value: unknown, label: string): void {
	const serialized = JSON.stringify(value);
	if (
		serialized === undefined ||
		new TextEncoder().encode(serialized).byteLength > MAX_OPERATION_INPUT_BYTES
	) {
		throw new McpGatewayError("INVALID_OPTIONS", `${label} exceeds the gateway size limit.`);
	}
}

function validateCompletionResult(value: CompleteResult): CompleteResult {
	if (!isCompleteResult(value)) {
		throw new McpGatewayError(
			"INVALID_COMPLETION_RESULT",
			"Upstream returned an invalid completion result.",
		);
	}
	return {
		...stripOpaqueMetadata(value),
		completion: stripOpaqueMetadata(value.completion),
	};
}

function isCompleteResult(value: unknown): value is CompleteResult {
	if (typeof value !== "object" || value === null || !("completion" in value)) return false;
	const completion = value.completion;
	if (typeof completion !== "object" || completion === null || !("values" in completion)) {
		return false;
	}
	if (
		!Array.isArray(completion.values) ||
		completion.values.length > 100 ||
		completion.values.some((entry) => typeof entry !== "string")
	) {
		return false;
	}
	if (
		"total" in completion &&
		completion.total !== undefined &&
		(typeof completion.total !== "number" ||
			!Number.isSafeInteger(completion.total) ||
			completion.total < 0)
	) {
		return false;
	}
	return (
		!("hasMore" in completion) ||
		completion.hasMore === undefined ||
		typeof completion.hasMore === "boolean"
	);
}

function invalidCompletionRequest(message: string): McpGatewayError {
	return new McpGatewayError("INVALID_COMPLETION_REQUEST", message);
}

function toJsonSchema(value: unknown, upstreamName: string, toolName: string): JsonSchemaType {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalidDiscovery(
			upstreamName,
			`returned a non-object JSON Schema for tool "${toolName}"`,
		);
	}
	return value;
}

function isCallToolResult(value: McpGatewayOperationOutput): value is CallToolResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"content" in value &&
		Array.isArray(value.content)
	);
}

function isGetPromptResult(value: unknown): value is GetPromptResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"messages" in value &&
		Array.isArray(value.messages)
	);
}

function isReadResourceResult(value: unknown): value is ReadResourceResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"contents" in value &&
		Array.isArray(value.contents)
	);
}

function isDiscoverySnapshot(value: unknown): value is McpGatewayDiscoverySnapshot {
	return (
		typeof value === "object" &&
		value !== null &&
		"tools" in value &&
		Array.isArray(value.tools) &&
		(!("prompts" in value) || value.prompts === undefined || Array.isArray(value.prompts)) &&
		(!("resources" in value) || value.resources === undefined || Array.isArray(value.resources)) &&
		(!("resourceTemplates" in value) ||
			value.resourceTemplates === undefined ||
			Array.isArray(value.resourceTemplates)) &&
		"discoveredAt" in value &&
		Number.isFinite(value.discoveredAt)
	);
}

function discoveryFlightKey(key: McpGatewayDiscoveryCacheKey): string {
	return JSON.stringify([key.upstreamName, key.authorizationContext]);
}

function waitForDiscovery(
	pending: Promise<McpGatewayDiscoverySnapshot>,
	requestSignal: AbortSignal,
	sharedSignal: AbortSignal,
): Promise<McpGatewayDiscoverySnapshot> {
	if (requestSignal.aborted) return Promise.reject(requestSignal.reason);
	if (sharedSignal.aborted) return Promise.reject(sharedSignal.reason);
	return new Promise((resolve, reject) => {
		const abortRequest = (): void => reject(requestSignal.reason);
		const abortShared = (): void => reject(sharedSignal.reason);
		const cleanup = (): void => {
			requestSignal.removeEventListener("abort", abortRequest);
			sharedSignal.removeEventListener("abort", abortShared);
		};
		requestSignal.addEventListener("abort", abortRequest, { once: true });
		sharedSignal.addEventListener("abort", abortShared, { once: true });
		void pending.then(resolve, reject).finally(cleanup);
	});
}

function raceDiscoveryWithSignal(
	pending: Promise<McpGatewayDiscoverySnapshot>,
	signal: AbortSignal,
): Promise<McpGatewayDiscoverySnapshot> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = (): void => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function abandonedDiscoveryError(): Error {
	const error = new Error("Shared MCP gateway discovery was cancelled after every waiter left.");
	error.name = "AbortError";
	return error;
}

function positiveIntegerOption(value: number | undefined, name: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new McpGatewayError("INVALID_OPTIONS", `${name} must be a positive safe integer.`);
	}
	return value;
}

function readPageItems<Item>(
	result:
		| { readonly tools: readonly Item[] }
		| { readonly prompts: readonly Item[] }
		| { readonly resources: readonly Item[] }
		| { readonly resourceTemplates: readonly Item[] },
	capability: "tools" | "prompts" | "resources" | "resourceTemplates",
): readonly Item[] | undefined {
	if (capability === "tools" && "tools" in result) return result.tools;
	if (capability === "prompts" && "prompts" in result) return result.prompts;
	if (capability === "resources" && "resources" in result) return result.resources;
	if (capability === "resourceTemplates" && "resourceTemplates" in result) {
		return result.resourceTemplates;
	}
	return undefined;
}

function settledValue<Value>(result: PromiseSettledResult<Value>): Value {
	if (result.status === "fulfilled") return result.value;
	throw result.reason;
}

function contextFromBuild(context: McpServerBuildContext): McpGatewayRequestContext {
	return {
		...(context.authInfo === undefined ? {} : { authInfo: context.authInfo }),
		...(context.principal === undefined ? {} : { principal: context.principal }),
		...(context.requestInfo === undefined ? {} : { request: context.requestInfo }),
		...(context.requestInfo?.signal === undefined ? {} : { signal: context.requestInfo.signal }),
	};
}

function handlerRequestContext(
	context: {
		readonly http?: {
			readonly authInfo?: McpServerBuildContext["authInfo"];
			readonly req?: Request;
		};
		readonly mcpReq: { readonly id: string | number; readonly signal: AbortSignal };
	},
	buildContext: McpServerBuildContext,
): McpGatewayRequestContext {
	return {
		...(context.http?.authInfo === undefined
			? buildContext.authInfo === undefined
				? {}
				: { authInfo: buildContext.authInfo }
			: { authInfo: context.http.authInfo }),
		...(buildContext.principal === undefined ? {} : { principal: buildContext.principal }),
		...(context.http?.req === undefined
			? buildContext.requestInfo === undefined
				? {}
				: { request: buildContext.requestInfo }
			: { request: context.http.req }),
		signal: context.mcpReq.signal,
		requestId: String(context.mcpReq.id),
	};
}

function invalidDiscovery(upstreamName: string, detail: string): McpGatewayError {
	return new McpGatewayError("INVALID_DISCOVERY", `Upstream "${upstreamName}" ${detail}.`);
}

function invalidDiscoveryWithCause(
	upstreamName: string,
	detail: string,
	cause: unknown,
): McpGatewayError {
	return new McpGatewayError("INVALID_DISCOVERY", `Upstream "${upstreamName}" ${detail}.`, {
		cause,
	});
}

function unsupportedCapability(upstreamName: string, capability: string): McpGatewayError {
	return new McpGatewayError(
		"UNSUPPORTED_UPSTREAM_CAPABILITY",
		`Upstream "${upstreamName}" does not implement the structural ${capability} client methods.`,
	);
}

function assertUpstreamCompleteResult<Result extends object>(
	value: Result,
	upstreamName: string,
	method: "prompts/get" | "resources/read" | "tools/call",
): asserts value is Exclude<Result, { readonly resultType: "input_required" }> {
	if (!isInputRequiredResult(value)) return;
	throw new McpGatewayError(
		"UPSTREAM_INPUT_REQUIRED",
		`Upstream "${upstreamName}" returned input_required for ${method}; this gateway does not auto-fulfill or transparently relay multi-round input.`,
	);
}

function assertGatewayCapabilityOwnership(
	capabilities: ServerCapabilities,
	projected: Readonly<{
		tools: boolean;
		prompts: boolean;
		resources: boolean;
		completions: boolean;
	}>,
): void {
	if (projected.tools && capabilities.tools?.listChanged === true) {
		throw capabilityConflict(
			"A gateway projecting tools cannot share a server that already advertises tools.listChanged.",
		);
	}
	if (projected.prompts && capabilities.prompts?.listChanged === true) {
		throw capabilityConflict(
			"A gateway projecting prompts cannot share a server that already advertises prompts.listChanged.",
		);
	}
	if (
		projected.resources &&
		(capabilities.resources?.listChanged === true || capabilities.resources?.subscribe === true)
	) {
		throw capabilityConflict(
			"A gateway projecting resources cannot share a server that already advertises resources.listChanged or resources.subscribe.",
		);
	}
	if (projected.completions && capabilities.completions !== undefined) {
		throw capabilityConflict(
			"The gateway must exclusively own the completions capability on its MCP server.",
		);
	}
}

function assertGatewayHandlerOwnership(
	server: { assertCanSetRequestHandler(method: string): void },
	methods: readonly string[],
): void {
	for (const method of methods) {
		try {
			server.assertCanSetRequestHandler(method);
		} catch (cause) {
			throw capabilityConflict(
				`The gateway must exclusively own ${method} on its MCP server.`,
				cause,
			);
		}
	}
}

function capabilityConflict(message: string, cause?: unknown): McpGatewayError {
	return new McpGatewayError(
		"CAPABILITY_CONFLICT",
		message,
		cause === undefined ? undefined : { cause },
	);
}

function requireInstalledClient(
	clients: ReadonlyMap<string, McpGatewayToolClient>,
	upstreamName: string,
): McpGatewayToolClient {
	const client = clients.get(upstreamName);
	if (client === undefined) {
		throw new McpGatewayError(
			"INVALID_OPTIONS",
			`No resolved MCP client is available for upstream "${upstreamName}".`,
		);
	}
	return client;
}

function assertNever(value: never): never {
	throw new McpGatewayError("INVALID_OPTIONS", `Unhandled gateway variant: ${String(value)}.`);
}
