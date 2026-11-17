import { Injectable } from "@nestjs/common";
import {
	composeMcpMiddleware,
	createMcpAuthorizationMiddleware,
	createMcpLifecycleMiddleware,
	createMcpOperation,
	createMcpOperationContext,
} from "@nest-mcp/core";
import type { MaybePromise, McpOperationHandler } from "@nest-mcp/core";
import type {
	McpServer,
	McpServerBuildContext,
	McpServerFeature,
	McpServerPrincipal,
	PromptCallback,
	ReadResourceCallback,
	ReadResourceTemplateCallback,
	RegisteredTool,
	ResourceTemplate,
	ServerContext,
	StandardSchemaWithJSON,
	ToolCallback,
} from "@nest-mcp/server";
import type {
	McpCapabilityDescriptor,
	McpCapabilityMutation,
	McpCapabilityMutationObserver,
	McpCapabilityVisibilityPolicy,
	McpDynamicHandlerRegistration,
} from "../mcp-capability.types.ts";
import { McpModuleError } from "../mcp.errors.ts";
import {
	MCP_CATALOG_SCHEMAS_TOOL_NAME,
	MCP_CATALOG_SEARCH_TOOL_NAME,
} from "../mcp-catalog-exposure.ts";
import type { McpCatalogExposureOptions } from "../mcp-catalog-exposure.ts";
import {
	applyMcpCatalogExposure,
	MCP_CATALOG_TOOL_NAME_LENGTH_LIMIT,
	type McpCatalogMetaToolDefinition,
	type McpCatalogRegisteredTool,
} from "../mcp-catalog.runtime.ts";
import type {
	McpHandlerAuthorizationPolicy,
	McpHandlerInvocationInput,
	McpHandlerInvocationOutput,
	McpHandlerLifecycleObserver,
	McpHandlerMiddleware,
	McpHandlerOperationContext,
} from "../mcp.types.ts";
import {
	McpProviderRegistry,
	isMcpRuntimeProviderToken,
	mcpProviderTokenName,
} from "../mcp-provider.registry.ts";
import type {
	HandlerDefinition,
	PromptOptions,
	ResourceOptions,
	ToolOptions,
} from "../decorators/mcp-handler.decorators.ts";

const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

export type McpDiscoveredHandler = (
	...arguments_: unknown[]
) => MaybePromise<McpHandlerInvocationOutput>;

interface RegisteredHandler {
	readonly id: symbol;
	readonly definition: HandlerDefinition;
	readonly handler: McpDiscoveredHandler;
	readonly source: string;
	readonly visibility: boolean | McpCapabilityVisibilityPolicy | undefined;
}

interface McpHandlerPipelineOptions {
	readonly serverName: string;
	readonly authorization?: McpHandlerAuthorizationPolicy;
	readonly middleware?: readonly McpHandlerMiddleware[];
	readonly lifecycleObserver?: McpHandlerLifecycleObserver;
	readonly visibilityTimeoutMs?: number;
	readonly catalogExposure?: McpCatalogExposureOptions;
}

@Injectable()
export class McpHandlerRegistry {
	#handlers: readonly RegisteredHandler[] = Object.freeze([]);
	#closed = false;
	#serverNames: readonly string[] | undefined;
	#gatewayNames = new Set<string>();
	#catalogRuntimeNames = new Set<string>();
	readonly #mutationObservers = new Set<McpCapabilityMutationObserver>();

	constructor(private readonly providers: McpProviderRegistry) {}

	/** Adds one discovered handler. Prefer the typed capability methods for live registration. */
	register(definition: HandlerDefinition, handler: McpDiscoveredHandler, source: string): void {
		this.#append(definition, handler, source, this.#serverNames !== undefined);
	}

	/** Atomically installs a live tool for future per-request server builds. */
	registerTool<const InputSchema extends StandardSchemaWithJSON | undefined = undefined>(
		options: ToolOptions<InputSchema>,
		handler: ToolCallback<InputSchema>,
		source = `dynamic tool "${options.name}"`,
	): McpDynamicHandlerRegistration<ToolCallback<InputSchema>> {
		return this.#registerDynamic({ kind: "tool", options }, eraseHandler(handler), source, (next) =>
			eraseHandler(next),
		);
	}

	/** Atomically installs a live prompt for future per-request server builds. */
	registerPrompt<const ArgsSchema extends StandardSchemaWithJSON | undefined = undefined>(
		options: PromptOptions<ArgsSchema>,
		handler: PromptCallback<ArgsSchema>,
		source = `dynamic prompt "${options.name}"`,
	): McpDynamicHandlerRegistration<PromptCallback<ArgsSchema>> {
		return this.#registerDynamic(
			{ kind: "prompt", options },
			eraseHandler(handler),
			source,
			(next) => eraseHandler(next),
		);
	}

	/** Atomically installs a fixed or templated resource for future server builds. */
	registerResource<const Uri extends string | ResourceTemplate>(
		options: ResourceOptions<Uri>,
		handler: Uri extends string ? ReadResourceCallback : ReadResourceTemplateCallback,
		source = `dynamic resource "${options.name}"`,
	): McpDynamicHandlerRegistration<
		Uri extends string ? ReadResourceCallback : ReadResourceTemplateCallback
	> {
		type Handler = Uri extends string ? ReadResourceCallback : ReadResourceTemplateCallback;
		return this.#registerDynamic(
			{ kind: "resource", options },
			eraseHandler(handler),
			source,
			(next: Handler) => eraseHandler(next),
		);
	}

	list(): readonly McpCapabilityDescriptor[] {
		return this.#handlers.map((entry) =>
			Object.freeze({
				kind: entry.definition.kind,
				name: entry.definition.options.name,
				source: entry.source,
				serverNames: Object.freeze([...this.#effectiveTargets(entry.definition)]),
			}),
		);
	}

	/** Locks target validation to the runtimes declared by the root module. */
	configureRuntimes(
		serverNames: readonly string[],
		gatewayNames: readonly string[] = [],
		catalogRuntimeNames: readonly string[] = [],
	): void {
		if (this.#serverNames !== undefined) {
			throw new McpModuleError("INVALID_OPTIONS", "MCP handler runtimes are already configured.");
		}
		this.#serverNames = normalizeRuntimeNames(serverNames);
		this.#gatewayNames = new Set(normalizeRuntimeNames(gatewayNames));
		this.#catalogRuntimeNames = new Set(normalizeRuntimeNames(catalogRuntimeNames));
		for (const runtimeName of new Set([...this.#gatewayNames, ...this.#catalogRuntimeNames])) {
			if (!this.#serverNames.includes(runtimeName)) {
				throw new McpModuleError(
					"INVALID_OPTIONS",
					`MCP specialized runtime "${runtimeName}" is not a configured server.`,
				);
			}
		}
		for (const entry of this.#handlers) this.#assertKnownTargets(entry.definition, entry.source);
		for (const runtimeName of this.#serverNames) this.assertNoCollisions(runtimeName);
	}

	/** Observes committed live mutations. The returned unsubscriber is idempotent. */
	onMutation(observer: McpCapabilityMutationObserver): () => void {
		this.#assertOpen();
		if (typeof observer !== "function") {
			throw new TypeError("MCP capability mutation observer must be a function.");
		}
		this.#mutationObservers.add(observer);
		return () => {
			this.#mutationObservers.delete(observer);
		};
	}

	/** Seals live mutation APIs and releases handler callbacks during application shutdown. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#handlers = Object.freeze([]);
		this.#mutationObservers.clear();
	}

	assertNoCollisions(runtimeName: string): void {
		const seen = new Map<string, string>();
		for (const entry of this.#handlers) {
			if (!targetsRuntime(entry.definition.options.servers, runtimeName)) continue;
			this.#assertCatalogToolCompatibility(entry.definition, entry.source, runtimeName);
			const key = registrationKey(entry.definition);
			const previous = seen.get(key);
			if (previous !== undefined) {
				throw new McpModuleError(
					"DUPLICATE_HANDLER",
					`Duplicate MCP ${entry.definition.kind} registration "${key}" for server "${runtimeName}" from ${previous} and ${entry.source}.`,
				);
			}
			seen.set(key, entry.source);
		}
	}

	/** Whether discovery found any decorated handler targeting one runtime. */
	hasHandlersFor(runtimeName: string): boolean {
		return this.#handlers.some((entry) =>
			targetsRuntime(entry.definition.options.servers, runtimeName),
		);
	}

	asServerFeature(options: McpHandlerPipelineOptions): McpServerFeature {
		const visibilityTimeoutMs = normalizeVisibilityTimeout(options.visibilityTimeoutMs);
		return async (server, context) => {
			// A build owns one immutable snapshot. Concurrent live mutations affect only later builds.
			const snapshot = this.#handlers.filter((entry) =>
				targetsRuntime(entry.definition.options.servers, context.runtimeName),
			);
			const visible = await selectVisibleHandlers(snapshot, context, visibilityTimeoutMs);
			const catalogRegistrations: McpCatalogRegisteredTool[] = [];
			for (const entry of visible) {
				const registration = registerHandler(server, entry, options, context.principal);
				if (registration !== undefined && entry.definition.kind === "tool") {
					catalogRegistrations.push(
						Object.freeze({
							name: entry.definition.options.name,
							registration,
							tags: entry.definition.options.tags ?? Object.freeze([]),
						}),
					);
				}
			}
			if (options.catalogExposure !== undefined) {
				await applyMcpCatalogExposure(
					server,
					context,
					Object.freeze(catalogRegistrations),
					options.catalogExposure,
					visibilityTimeoutMs,
					(definition) => registerCatalogMetaTool(server, definition, options, context.principal),
				);
			}
		};
	}

	#append(
		definition: HandlerDefinition,
		handler: McpDiscoveredHandler,
		source: string,
		notify: boolean,
	): RegisteredHandler {
		this.#assertOpen();
		const normalizedSource = normalizeSource(source);
		const normalizedDefinition = freezeDefinition(definition);
		this.#assertKnownTargets(normalizedDefinition, normalizedSource);
		const entry = Object.freeze({
			id: Symbol(normalizedSource),
			definition: normalizedDefinition,
			handler,
			source: normalizedSource,
			visibility: this.#resolveVisibility(normalizedDefinition, normalizedSource),
		}) satisfies RegisteredHandler;
		this.#assertNoEntryCollision(entry);
		this.#handlers = Object.freeze([...this.#handlers, entry]);
		if (notify) this.#notify(entry, "registered");
		return entry;
	}

	#registerDynamic<Handler>(
		definition: HandlerDefinition,
		handler: McpDiscoveredHandler,
		source: string,
		eraseReplacement: (handler: Handler) => McpDiscoveredHandler,
	): McpDynamicHandlerRegistration<Handler> {
		this.#assertOpen();
		if (this.#serverNames === undefined) {
			throw new McpModuleError(
				"RUNTIME_NOT_READY",
				"Dynamic MCP capabilities can be registered after application bootstrap configures runtimes.",
			);
		}
		let current = this.#append(definition, handler, source, true);
		let active = true;
		return Object.freeze({
			source: current.source,
			replace: (nextHandler: Handler): boolean => {
				this.#assertOpen();
				if (!active) return false;
				const index = this.#handlers.findIndex((entry) => entry.id === current.id);
				if (index === -1) {
					active = false;
					return false;
				}
				const replacement = Object.freeze({
					...current,
					id: Symbol(current.source),
					handler: eraseReplacement(nextHandler),
				}) satisfies RegisteredHandler;
				this.#handlers = Object.freeze([
					...this.#handlers.slice(0, index),
					replacement,
					...this.#handlers.slice(index + 1),
				]);
				current = replacement;
				this.#notify(replacement, "replaced");
				return true;
			},
			unregister: (): boolean => {
				this.#assertOpen();
				if (!active) return false;
				const next = this.#handlers.filter((entry) => entry.id !== current.id);
				if (next.length === this.#handlers.length) {
					active = false;
					return false;
				}
				this.#handlers = Object.freeze(next);
				active = false;
				this.#notify(current, "unregistered");
				return true;
			},
		});
	}

	#assertOpen(): void {
		if (!this.#closed) return;
		throw new McpModuleError(
			"RUNTIME_CLOSED",
			"MCP capabilities cannot be mutated after the Nest runtime begins shutdown.",
		);
	}

	#resolveVisibility(
		definition: HandlerDefinition,
		source: string,
	): boolean | McpCapabilityVisibilityPolicy | undefined {
		const visibility = definition.options.visibility;
		if (visibility === undefined || typeof visibility === "boolean") return visibility;
		if (!isMcpRuntimeProviderToken(visibility)) {
			throw new McpModuleError(
				"INVALID_VISIBILITY_POLICY",
				`MCP handler ${source} visibility must be a boolean or collaborator provider token.`,
			);
		}
		try {
			const policy = this.providers.get(visibility);
			if (!isCapabilityVisibilityPolicy(policy)) {
				throw new TypeError("resolved provider does not implement isVisible(context)");
			}
			return policy;
		} catch (cause) {
			throw new McpModuleError(
				"INVALID_VISIBILITY_POLICY",
				`MCP handler ${source} visibility policy ${mcpProviderTokenName(visibility)} must be a registered singleton collaborator provider.`,
				{ cause },
			);
		}
	}

	#assertKnownTargets(definition: HandlerDefinition, source: string): void {
		if (this.#serverNames === undefined) return;
		for (const target of explicitTargets(definition.options.servers)) {
			if (!this.#serverNames.includes(target)) {
				throw new McpModuleError(
					"UNKNOWN_SERVER_TARGET",
					`MCP handler ${source} targets unknown server "${target}".`,
				);
			}
		}
	}

	#assertNoEntryCollision(candidate: RegisteredHandler): void {
		if (this.#serverNames === undefined) return;
		const candidateTargets = this.#effectiveTargets(candidate.definition);
		for (const gatewayName of candidateTargets) {
			if (this.#gatewayNames.has(gatewayName)) {
				throw new McpModuleError(
					"INVALID_OPTIONS",
					`MCP gateway server "${gatewayName}" must be dedicated and cannot also host decorated or dynamic tools, prompts, or resources.`,
				);
			}
		}
		for (const runtimeName of candidateTargets) {
			this.#assertCatalogToolCompatibility(candidate.definition, candidate.source, runtimeName);
		}
		const key = registrationKey(candidate.definition);
		for (const entry of this.#handlers) {
			if (registrationKey(entry.definition) !== key) continue;
			const existingTargets = this.#effectiveTargets(entry.definition);
			const collision = candidateTargets.find((target) => existingTargets.includes(target));
			if (collision !== undefined) {
				throw new McpModuleError(
					"DUPLICATE_HANDLER",
					`Duplicate MCP ${candidate.definition.kind} registration "${key}" for server "${collision}" from ${entry.source} and ${candidate.source}.`,
				);
			}
		}
	}

	#effectiveTargets(definition: HandlerDefinition): readonly string[] {
		return definition.options.servers === undefined
			? (this.#serverNames ?? [])
			: explicitTargets(definition.options.servers);
	}

	#notify(entry: RegisteredHandler, type: McpCapabilityMutation["type"]): void {
		const mutation = Object.freeze({
			kind: entry.definition.kind,
			type,
			source: entry.source,
			serverNames: Object.freeze([...this.#effectiveTargets(entry.definition)]),
		}) satisfies McpCapabilityMutation;
		for (const observer of this.#mutationObservers) {
			try {
				const result = observer(mutation);
				void Promise.resolve(result).catch(() => undefined);
			} catch {
				// Observation must not make an already-committed mutation appear to fail.
			}
		}
	}

	#assertCatalogToolCompatibility(
		definition: HandlerDefinition,
		source: string,
		runtimeName: string,
	): void {
		if (definition.kind !== "tool" || !this.#catalogRuntimeNames.has(runtimeName)) return;
		if (definition.options.name.length > MCP_CATALOG_TOOL_NAME_LENGTH_LIMIT) {
			throw new McpModuleError(
				"INVALID_CATALOG_EXPOSURE",
				`MCP tool "${definition.options.name}" from ${source} exceeds the ${String(MCP_CATALOG_TOOL_NAME_LENGTH_LIMIT)} character catalog name limit on server "${runtimeName}".`,
			);
		}
		if (
			definition.options.name !== MCP_CATALOG_SEARCH_TOOL_NAME &&
			definition.options.name !== MCP_CATALOG_SCHEMAS_TOOL_NAME
		) {
			return;
		}
		throw new McpModuleError(
			"DUPLICATE_HANDLER",
			`MCP tool "${definition.options.name}" from ${source} collides with a reserved catalog meta-tool on server "${runtimeName}".`,
		);
	}
}

function isCapabilityVisibilityPolicy(value: unknown): value is McpCapabilityVisibilityPolicy {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "isVisible") === "function"
	);
}

async function selectVisibleHandlers(
	handlers: readonly RegisteredHandler[],
	context: McpServerBuildContext,
	timeoutMs: number,
): Promise<readonly RegisteredHandler[]> {
	const policies = new Set<McpCapabilityVisibilityPolicy>();
	for (const entry of handlers) {
		if (typeof entry.visibility === "object") policies.add(entry.visibility);
	}
	const visibilityTask = Promise.all(
		[...policies].map(async (policy) => {
			let visible: unknown;
			try {
				visible = await policy.isVisible(context);
			} catch (cause) {
				throw visibilityError(policy, context.runtimeName, "threw or rejected", cause);
			}
			if (typeof visible !== "boolean") {
				throw visibilityError(
					policy,
					context.runtimeName,
					`returned ${typeof visible} instead of boolean`,
				);
			}
			return [policy, visible] as const;
		}),
	).then((entries) => new Map(entries));
	const byPolicy = await withDeadline(
		visibilityTask,
		timeoutMs,
		context.requestInfo?.signal,
		`MCP visibility evaluation for server "${context.runtimeName}"`,
	);
	return handlers.filter((entry) => {
		if (entry.visibility === false) return false;
		if (entry.visibility === true || entry.visibility === undefined) return true;
		return byPolicy.get(entry.visibility) === true;
	});
}

function visibilityError(
	policy: McpCapabilityVisibilityPolicy,
	runtimeName: string,
	detail: string,
	cause?: unknown,
): McpModuleError {
	return new McpModuleError(
		"INVALID_VISIBILITY_POLICY",
		`MCP visibility policy ${policy.constructor.name || "<anonymous>"} ${detail} for server "${runtimeName}".`,
		cause === undefined ? undefined : { cause },
	);
}

function withDeadline<T>(
	task: Promise<T>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	label: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => {
			finish(() => reject(signal?.reason ?? new DOMException(`${label} aborted.`, "AbortError")));
		};
		const timer = setTimeout(() => {
			finish(() =>
				reject(
					new McpModuleError(
						"INVALID_VISIBILITY_POLICY",
						`${label} exceeded its ${String(timeoutMs)}ms deadline.`,
					),
				),
			);
		}, timeoutMs);
		task.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
		if (signal?.aborted === true) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function normalizeVisibilityTimeout(value: number | undefined): number {
	const timeout = value ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeout) || timeout <= 0) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			"MCP handlerVisibilityTimeoutMs must be a positive safe integer.",
		);
	}
	return timeout;
}

function normalizeRuntimeNames(names: readonly string[]): readonly string[] {
	const normalized = names.map((name, index) => {
		if (typeof name !== "string" || name.trim().length === 0) {
			throw new McpModuleError(
				"INVALID_OPTIONS",
				`MCP runtime name at index ${String(index)} must be a non-empty string.`,
			);
		}
		return name.trim();
	});
	if (new Set(normalized).size !== normalized.length) {
		throw new McpModuleError("INVALID_OPTIONS", "MCP runtime names must be unique.");
	}
	return Object.freeze(normalized);
}

function normalizeSource(source: string): string {
	if (typeof source !== "string" || source.trim().length === 0) {
		throw new McpModuleError("INVALID_HANDLER", "MCP handler source must be a non-empty string.");
	}
	return source.trim();
}

function explicitTargets(targets: string | readonly string[] | undefined): readonly string[] {
	if (targets === undefined) return [];
	return typeof targets === "string" ? [targets] : targets;
}

function targetsRuntime(
	targets: string | readonly string[] | undefined,
	runtimeName: string,
): boolean {
	return (
		targets === undefined ||
		(typeof targets === "string" ? targets === runtimeName : targets.includes(runtimeName))
	);
}

function registrationKey(definition: HandlerDefinition): string {
	if (definition.kind === "resource" && typeof definition.options.uri === "string") {
		return `${definition.kind}:${definition.options.uri}`;
	}
	return `${definition.kind}:${definition.options.name}`;
}

function freezeDefinition(definition: HandlerDefinition): HandlerDefinition {
	if (typeof definition.options.name !== "string" || definition.options.name.trim().length === 0) {
		throw new McpModuleError(
			"INVALID_HANDLER",
			`MCP ${definition.kind} name must be a non-empty string.`,
		);
	}
	const targets = definition.options.servers;
	const frozenTargets = targets === undefined ? {} : { servers: normalizeHandlerTargets(targets) };
	if (definition.kind === "tool") {
		const { tags, annotations, icons, _meta: meta, ...sdkOptions } = definition.options;
		const normalizedTags = normalizeToolTags(tags);
		return Object.freeze({
			kind: "tool",
			options: Object.freeze({
				...sdkOptions,
				...frozenTargets,
				...(annotations === undefined
					? {}
					: {
							annotations: snapshotDefinitionMetadata(
								annotations,
								`MCP tool "${definition.options.name}" annotations`,
							),
						}),
				...(icons === undefined
					? {}
					: {
							icons: snapshotDefinitionMetadata(
								icons,
								`MCP tool "${definition.options.name}" icons`,
							),
						}),
				...(meta === undefined
					? {}
					: {
							_meta: snapshotDefinitionMetadata(
								meta,
								`MCP tool "${definition.options.name}" metadata`,
							),
						}),
				...(normalizedTags === undefined ? {} : { tags: normalizedTags }),
			}),
		});
	}
	if (definition.kind === "prompt") {
		return Object.freeze({
			kind: "prompt",
			options: Object.freeze({ ...definition.options, ...frozenTargets }),
		});
	}
	return Object.freeze({
		kind: "resource",
		options: Object.freeze({ ...definition.options, ...frozenTargets }),
	});
}

function normalizeToolTags(tags: readonly string[] | undefined): readonly string[] | undefined {
	if (tags === undefined) return undefined;
	if (!Array.isArray(tags) || tags.length > 32) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			"MCP tool tags must be an array containing at most 32 entries.",
		);
	}
	const normalized = tags.map((tag, index) => {
		if (typeof tag !== "string" || tag.trim().length === 0 || tag.trim().length > 64) {
			throw new McpModuleError(
				"INVALID_OPTIONS",
				`MCP tool tag at index ${String(index)} must contain between 1 and 64 characters.`,
			);
		}
		return tag.trim();
	});
	if (new Set(normalized).size !== normalized.length) {
		throw new McpModuleError("INVALID_OPTIONS", "MCP tool tags must not contain duplicates.");
	}
	return Object.freeze(normalized);
}

function snapshotDefinitionMetadata<Value>(value: Value, label: string): Value {
	let snapshot: Value;
	try {
		snapshot = structuredClone(value);
	} catch (cause) {
		throw new McpModuleError("INVALID_OPTIONS", `${label} must be safely detachable.`, {
			cause,
		});
	}
	freezePolicyValue(snapshot);
	return snapshot;
}

function normalizeHandlerTargets(targets: string | readonly string[]): string | readonly string[] {
	const values = typeof targets === "string" ? [targets] : targets;
	if (!Array.isArray(values) || values.length === 0) {
		throw new McpModuleError(
			"INVALID_OPTIONS",
			"MCP handler targets must contain at least one server name.",
		);
	}
	const normalized = values.map((target, index) => {
		if (typeof target !== "string" || target.trim().length === 0) {
			throw new McpModuleError(
				"INVALID_OPTIONS",
				`MCP handler target at index ${String(index)} must be a non-empty string.`,
			);
		}
		return target.trim();
	});
	if (new Set(normalized).size !== normalized.length) {
		throw new McpModuleError("INVALID_OPTIONS", "MCP handler targets must not contain duplicates.");
	}
	return typeof targets === "string" ? normalized[0]! : Object.freeze(normalized);
}

function eraseHandler(handler: unknown): McpDiscoveredHandler {
	if (typeof handler !== "function") {
		throw new McpModuleError("INVALID_HANDLER", "Dynamic MCP handler must be callable.");
	}
	return (...arguments_: unknown[]) => Reflect.apply(handler, undefined, arguments_);
}

function registerHandler(
	server: McpServer,
	entry: RegisteredHandler,
	options: McpHandlerPipelineOptions,
	principal: McpServerPrincipal | undefined,
): RegisteredTool | undefined {
	const callback = (...arguments_: unknown[]): Promise<McpHandlerInvocationOutput> =>
		invokeHandler(entry, arguments_, options, principal);
	if (entry.definition.kind === "tool") {
		const {
			name,
			servers: _servers,
			visibility: _visibility,
			tags: _tags,
			...config
		} = entry.definition.options;
		const registerTool = server.registerTool.bind(server);
		const registration: unknown = Reflect.apply(registerTool, undefined, [name, config, callback]);
		if (!isRegisteredTool(registration)) {
			throw new McpModuleError(
				"INVALID_HANDLER",
				`MCP tool ${entry.source} did not produce an official registration handle.`,
			);
		}
		return registration;
	}
	if (entry.definition.kind === "prompt") {
		const {
			name,
			servers: _servers,
			visibility: _visibility,
			...config
		} = entry.definition.options;
		const registerPrompt = server.registerPrompt.bind(server);
		Reflect.apply(registerPrompt, undefined, [name, config, callback]);
		return undefined;
	}
	const {
		name,
		uri,
		servers: _servers,
		visibility: _visibility,
		...config
	} = entry.definition.options;
	const registerResource = server.registerResource.bind(server);
	Reflect.apply(registerResource, undefined, [name, uri, config, callback]);
	return undefined;
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
	return (
		typeof value === "object" &&
		value !== null &&
		"enabled" in value &&
		typeof value.enabled === "boolean" &&
		"update" in value &&
		typeof value.update === "function" &&
		"enable" in value &&
		typeof value.enable === "function" &&
		"disable" in value &&
		typeof value.disable === "function"
	);
}

function registerCatalogMetaTool(
	server: McpServer,
	definition: McpCatalogMetaToolDefinition,
	options: McpHandlerPipelineOptions,
	principal: McpServerPrincipal | undefined,
): RegisteredTool {
	const source = `catalog meta-tool "${definition.name}"`;
	const entry = Object.freeze({
		id: Symbol(source),
		definition: freezeDefinition({
			kind: "tool",
			options: {
				name: definition.name,
				title: definition.title,
				description: definition.description,
				inputSchema: definition.inputSchema,
				outputSchema: definition.outputSchema,
			},
		}),
		handler: eraseHandler(definition.handler),
		source,
		visibility: true,
	}) satisfies RegisteredHandler;
	const registration = registerHandler(server, entry, options, principal);
	if (registration === undefined) {
		throw new McpModuleError(
			"INVALID_CATALOG_EXPOSURE",
			`MCP catalog meta-tool "${definition.name}" did not produce a tool registration.`,
		);
	}
	return registration;
}

async function invokeHandler(
	entry: RegisteredHandler,
	callbackArguments: readonly unknown[],
	options: McpHandlerPipelineOptions,
	principal: McpServerPrincipal | undefined,
): Promise<McpHandlerInvocationOutput> {
	const sdkContext = callbackArguments.at(-1);
	if (!isServerContext(sdkContext)) {
		throw new McpModuleError(
			"INVALID_HANDLER",
			`MCP ${entry.definition.kind} handler ${entry.source} received no official server context.`,
		);
	}

	const input = Object.freeze({
		kind: entry.definition.kind,
		name: entry.definition.options.name,
		serverName: options.serverName,
		source: entry.source,
		arguments: snapshotHandlerArguments(callbackArguments.slice(0, -1)),
	}) satisfies McpHandlerInvocationInput;
	const requestId = String(sdkContext.mcpReq.id);
	const context = createMcpOperationContext({
		operationId: crypto.randomUUID(),
		role: "server",
		operation: {
			name: sdkContext.mcpReq.method,
			kind: "request",
			capability: capability(entry.definition.kind),
			target: options.serverName,
			attributes: {
				"mcp.handler.kind": entry.definition.kind,
				"mcp.handler.name": entry.definition.options.name,
				"mcp.transport": sdkContext.http?.req === undefined ? "stdio" : "http",
			},
		},
		signal: sdkContext.mcpReq.signal,
		requestId,
		...(sdkContext.sessionId === undefined ? {} : { sessionId: sdkContext.sessionId }),
		...(principal === undefined ? {} : { principal }),
	}) satisfies McpHandlerOperationContext;
	const operation = createMcpOperation(input, context);
	const terminal: McpOperationHandler<
		McpHandlerInvocationInput,
		McpHandlerInvocationOutput,
		McpHandlerOperationContext
	> = () => entry.handler(...callbackArguments);
	const middleware: McpHandlerMiddleware[] = [];
	if (options.lifecycleObserver !== undefined) {
		middleware.push(createMcpLifecycleMiddleware(options.lifecycleObserver));
	}
	if (options.authorization !== undefined) {
		middleware.push(createMcpAuthorizationMiddleware(options.authorization));
	}
	middleware.push(...(options.middleware ?? []));
	return composeMcpMiddleware(middleware, terminal)(operation);
}

function snapshotHandlerArguments(values: readonly unknown[]): readonly unknown[] {
	return Object.freeze(
		values.map((value) => {
			let clone: unknown;
			try {
				clone = value instanceof URL ? new URL(value.href) : structuredClone(value);
			} catch (cause) {
				throw new McpModuleError(
					"INVALID_HANDLER",
					"Validated MCP handler arguments must be snapshot-safe before authorization.",
					{ cause },
				);
			}
			return freezePolicyValue(clone);
		}),
	);
}

function freezePolicyValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		for (const entry of value) freezePolicyValue(entry);
		return Object.freeze(value);
	}
	if (isPlainRecord(value)) {
		for (const entry of Object.values(value)) freezePolicyValue(entry);
		return Object.freeze(value);
	}
	return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function isServerContext(value: unknown): value is ServerContext {
	if (typeof value !== "object" || value === null || !("mcpReq" in value)) return false;
	const request = value.mcpReq;
	return (
		typeof request === "object" &&
		request !== null &&
		"id" in request &&
		"method" in request &&
		typeof request.method === "string" &&
		"signal" in request &&
		request.signal instanceof AbortSignal
	);
}

function capability(kind: McpHandlerInvocationInput["kind"]): string {
	if (kind === "tool") return "tools";
	if (kind === "resource") return "resources";
	return "prompts";
}
