import { AsyncResource } from "node:async_hooks";
import {
	MCP_CLIENT_LEASE_INVALIDATED,
	McpClientLeaseManager,
	type CallToolResult,
	type GetPromptResult,
	type McpClientConnectionSnapshot,
	type McpClientLease,
	type ReadResourceResult,
} from "@nest-mcp/client";
import { METHOD_NOT_FOUND, ProtocolError } from "@modelcontextprotocol/client";

import {
	MCP_RUNTIME_ADMISSION_TIMEOUT,
	MCP_RUNTIME_QUEUE_FULL,
	MCP_RUNTIME_CLEANUP_FAILED,
	MCP_RUNTIME_CONNECTION_LOST,
	MCP_RUNTIME_DISCOVERY_LIMIT_EXCEEDED,
	MCP_RUNTIME_GENERATION_RETIRED,
	McpRuntimeManagerError,
	mapMcpRuntimeManagerError,
	runtimeLeaseModeConflictError,
	runtimeManagerClosedError,
	runtimeManagerErrorCode,
	runtimeNotReadyError,
	runtimeQuarantinedError,
} from "./errors.ts";
import {
	ManagedRuntimeFactory,
	type ActiveMcpRuntime,
	type OwnedMcpRuntime,
} from "./runtime-factory.ts";
import { RuntimeStateStore } from "./runtime-state.ts";
import { OperationAdmission } from "./operation-admission.ts";
import type {
	McpRuntimeAdmissionEvent,
	McpRuntimeCatalogSnapshot,
	McpManagedClientRuntimeOperation,
	McpRuntimeManagerOptions,
	McpRuntimeManagerPort,
	McpRuntimeManagerSnapshot,
	McpRuntimeOperationOptions,
	McpRuntimeProbeSnapshot,
	McpRuntimeStateListener,
	McpRuntimeStateSnapshot,
	McpRuntimeToolCallOptions,
} from "./types.ts";

class ExclusiveRuntimeLeaseIdentity<GenerationKey> {
	constructor(readonly generationKey: GenerationKey) {}
}

type RuntimeLeaseIdentity<GenerationKey> =
	GenerationKey | ExclusiveRuntimeLeaseIdentity<GenerationKey>;

export const MCP_RUNTIME_MANAGER_DEFAULTS = Object.freeze({
	maxConnections: 100,
	maxQueuedOperations: 100,
	maxConcurrentOperationsPerAdmissionKey: 4,
	maxStateEntries: 1_000,
	requestTimeoutMs: 10_000,
	shutdownTimeoutMs: 30_000,
	maxDiscoveryPages: 16,
	maxDiscoveryItems: 1_000,
});

export class McpRuntimeManager<GenerationKey = string>
	implements McpRuntimeManagerPort<GenerationKey>, AsyncDisposable
{
	readonly #leases: McpClientLeaseManager<
		RuntimeLeaseIdentity<GenerationKey>,
		OwnedMcpRuntime<GenerationKey>
	>;
	readonly #keepers = new Map<GenerationKey, McpClientLease<OwnedMcpRuntime<GenerationKey>>>();
	readonly #exclusiveIdentities = new Map<
		GenerationKey,
		Set<ExclusiveRuntimeLeaseIdentity<GenerationKey>>
	>();
	readonly #admission: OperationAdmission<GenerationKey>;
	readonly #onlineTasks = new Map<GenerationKey, Promise<McpRuntimeStateSnapshot>>();
	readonly #offlineTasks = new Map<GenerationKey, Promise<McpRuntimeStateSnapshot>>();
	readonly #postOfflineOnlineTasks = new Map<GenerationKey, Promise<McpRuntimeStateSnapshot>>();
	readonly #states: RuntimeStateStore<GenerationKey>;
	readonly #requestTimeoutMs: number;
	readonly #maxDiscoveryItems: number;
	readonly #now: () => number;
	#closed = false;
	#closeTask: Promise<void> | undefined;

	constructor(options: McpRuntimeManagerOptions<GenerationKey>) {
		if (
			typeof options?.generationResolver !== "object" ||
			options.generationResolver === null ||
			typeof options.generationResolver.resolve !== "function"
		) {
			throw new TypeError("generationResolver.resolve must be a function.");
		}
		const maxConnections = positiveInteger(
			options.maxConnections ?? MCP_RUNTIME_MANAGER_DEFAULTS.maxConnections,
			"maxConnections",
		);
		this.#admission = new OperationAdmission(
			positiveInteger(
				options.maxQueuedOperations ?? MCP_RUNTIME_MANAGER_DEFAULTS.maxQueuedOperations,
				"maxQueuedOperations",
			),
			options.maxConcurrentOperationsPerAdmissionKey === null
				? null
				: positiveInteger(
						options.maxConcurrentOperationsPerAdmissionKey ??
							MCP_RUNTIME_MANAGER_DEFAULTS.maxConcurrentOperationsPerAdmissionKey,
						"maxConcurrentOperationsPerAdmissionKey",
					),
		);
		const maxStateEntries = positiveInteger(
			options.maxStateEntries ??
				Math.max(MCP_RUNTIME_MANAGER_DEFAULTS.maxStateEntries, maxConnections),
			"maxStateEntries",
		);
		if (maxStateEntries < maxConnections) {
			throw new RangeError("maxStateEntries must be greater than or equal to maxConnections.");
		}
		this.#requestTimeoutMs = positiveFinite(
			options.requestTimeoutMs ?? MCP_RUNTIME_MANAGER_DEFAULTS.requestTimeoutMs,
			"requestTimeoutMs",
		);
		const shutdownTimeoutMs = positiveFinite(
			options.shutdownTimeoutMs ?? MCP_RUNTIME_MANAGER_DEFAULTS.shutdownTimeoutMs,
			"shutdownTimeoutMs",
		);
		const maxDiscoveryPages = positiveInteger(
			options.maxDiscoveryPages ?? MCP_RUNTIME_MANAGER_DEFAULTS.maxDiscoveryPages,
			"maxDiscoveryPages",
		);
		this.#maxDiscoveryItems = positiveInteger(
			options.maxDiscoveryItems ?? MCP_RUNTIME_MANAGER_DEFAULTS.maxDiscoveryItems,
			"maxDiscoveryItems",
		);
		if (options.observer !== undefined && typeof options.observer.onEvent !== "function") {
			throw new TypeError("observer.onEvent must be a function.");
		}
		this.#now = safeClock(options.now ?? Date.now);
		this.#states = new RuntimeStateStore({
			now: this.#now,
			maxEntries: maxStateEntries,
			...(options.onListenerError === undefined
				? {}
				: { onListenerError: options.onListenerError }),
		});
		const factory = new ManagedRuntimeFactory({
			generationResolver: options.generationResolver,
			states: this.#states,
			requestTimeoutMs: this.#requestTimeoutMs,
			shutdownTimeoutMs,
			maxDiscoveryPages,
			...(options.clientInfo === undefined ? {} : { clientInfo: options.clientInfo }),
			...(options.observer === undefined ? {} : { observer: options.observer }),
			now: this.#now,
		});
		this.#leases = new McpClientLeaseManager({
			maxResources: maxConnections,
			onCapacityAvailable: () => this.#admission.drain(),
			create: (identity, context) => factory.create(generationKeyOf(identity), context),
			close: (owned) => factory.close(owned),
		});
	}

	async ensureOnline(
		generationKey: GenerationKey,
		signal?: AbortSignal,
	): Promise<McpRuntimeStateSnapshot> {
		this.#assertOpen();
		const offlineTask = this.#offlineTasks.get(generationKey);
		if (offlineTask !== undefined) {
			let queued = this.#postOfflineOnlineTasks.get(generationKey);
			if (queued === undefined) {
				const created = this.#reconnectAfterOfflineBarriers(generationKey);
				queued = created;
				this.#postOfflineOnlineTasks.set(generationKey, created);
				void created.then(
					() => this.#deletePostOfflineOnlineTask(generationKey, created),
					() => this.#deletePostOfflineOnlineTask(generationKey, created),
				);
			}
			return waitForCaller(queued, signal);
		}
		this.#assertSharedLeaseAvailable(generationKey);
		this.#assertNotQuarantined(generationKey);
		return waitForCaller(this.#getOrCreateOnlineTask(generationKey), signal);
	}

	async #reconnectAfterOfflineBarriers(
		generationKey: GenerationKey,
	): Promise<McpRuntimeStateSnapshot> {
		for (;;) {
			const barrier = this.#offlineTasks.get(generationKey);
			if (barrier === undefined) break;
			await barrier;
		}
		this.#assertOpen();
		this.#assertSharedLeaseAvailable(generationKey);
		this.#assertNotQuarantined(generationKey);
		return this.#getOrCreateOnlineTask(generationKey);
	}

	#getOrCreateOnlineTask(generationKey: GenerationKey): Promise<McpRuntimeStateSnapshot> {
		let task = this.#onlineTasks.get(generationKey);
		if (task === undefined) {
			task = Promise.resolve().then(() => this.#reconcileOnline(generationKey));
			this.#onlineTasks.set(generationKey, task);
			void task.then(
				() => {
					if (this.#onlineTasks.get(generationKey) === task) {
						this.#onlineTasks.delete(generationKey);
					}
				},
				() => {
					if (this.#onlineTasks.get(generationKey) === task) {
						this.#onlineTasks.delete(generationKey);
					}
				},
			);
		}
		return task;
	}

	setOffline(generationKey: GenerationKey): Promise<McpRuntimeStateSnapshot> {
		this.#assertOpen();
		this.#admission.rejectGeneration(
			generationKey,
			new McpRuntimeManagerError(
				MCP_RUNTIME_GENERATION_RETIRED,
				"The MCP runtime generation was retired before the operation started.",
			),
		);
		let task = this.#offlineTasks.get(generationKey);
		if (task !== undefined) return task;
		task = Promise.resolve().then(() => this.#performSetOffline(generationKey));
		this.#offlineTasks.set(generationKey, task);
		void task.then(
			() => this.#deleteOfflineTask(generationKey, task),
			() => this.#deleteOfflineTask(generationKey, task),
		);
		return task;
	}

	async #performSetOffline(generationKey: GenerationKey): Promise<McpRuntimeStateSnapshot> {
		if (this.#states.read(generationKey).phase === "quarantined") {
			throw runtimeQuarantinedError();
		}
		this.#states.transition(generationKey, "draining");
		const exclusiveIdentities = [...(this.#exclusiveIdentities.get(generationKey) ?? [])];
		const drains = [
			this.#leases.invalidate(generationKey),
			...exclusiveIdentities.map((identity) => this.#leases.invalidate(identity)),
		];
		const keeper = this.#keepers.get(generationKey);
		this.#keepers.delete(generationKey);
		const onlineTask = this.#onlineTasks.get(generationKey);
		const cleanupTasks = [...drains, ...(keeper === undefined ? [] : [keeper.release()])];
		const [cleanupSettled] = await Promise.all([
			Promise.allSettled(cleanupTasks),
			Promise.allSettled(onlineTask === undefined ? [] : [onlineTask]),
		]);
		const cleanupFailed = cleanupSettled.some(
			(result) => result.status === "rejected" && !isRetirementError(result.reason),
		);
		if (this.#onlineTasks.get(generationKey) === onlineTask) {
			this.#onlineTasks.delete(generationKey);
		}
		if (cleanupFailed) {
			return this.#states.transition(generationKey, "quarantined", MCP_RUNTIME_CLEANUP_FAILED);
		}
		return this.#states.transition(generationKey, "offline");
	}

	#deleteOfflineTask(generationKey: GenerationKey, task: Promise<McpRuntimeStateSnapshot>): void {
		if (this.#offlineTasks.get(generationKey) === task) {
			this.#offlineTasks.delete(generationKey);
		}
	}

	#deletePostOfflineOnlineTask(
		generationKey: GenerationKey,
		task: Promise<McpRuntimeStateSnapshot>,
	): void {
		if (this.#postOfflineOnlineTasks.get(generationKey) === task) {
			this.#postOfflineOnlineTasks.delete(generationKey);
		}
	}

	async retire(generationKey: GenerationKey): Promise<void> {
		const state = await this.setOffline(generationKey);
		if (state.phase === "quarantined") {
			throw runtimeQuarantinedError();
		}
		this.#states.forget(generationKey);
	}

	async probe(
		generationKey: GenerationKey,
		options?: AbortSignal | McpRuntimeOperationOptions,
	): Promise<McpRuntimeProbeSnapshot> {
		const controls = normalizeOperationOptions(options, "probe");
		const observation = await this.#withRuntime(
			generationKey,
			async (owned, operationSignal) => {
				await this.#probeProtocolLiveness(owned, operationSignal);
				const { runtime, serverName } = owned;
				const connected = this.#states.connected(generationKey, runtime.snapshot(serverName));
				return Object.freeze({
					reachable: true as const,
					observedAt: isoTimestamp(this.#now),
					...(connected.protocolVersion === undefined
						? {}
						: { protocolVersion: connected.protocolVersion }),
					...(connected.protocolEra === undefined ? {} : { protocolEra: connected.protocolEra }),
					...(connected.capabilities === undefined ? {} : { capabilities: connected.capabilities }),
				});
			},
			controls,
		);
		return Object.freeze({
			...observation,
			runtime: this.#states.read(generationKey),
		});
	}

	refreshCatalog(
		generationKey: GenerationKey,
		options?: AbortSignal | McpRuntimeOperationOptions,
	): Promise<McpRuntimeCatalogSnapshot> {
		let controls: McpRuntimeOperationOptions;
		try {
			controls = normalizeOperationOptions(options, "refreshCatalog");
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#withRuntime(
			generationKey,
			async (owned, operationSignal) => {
				await this.#probeProtocolLiveness(owned, operationSignal);
				const { runtime, serverName } = owned;
				const capabilities = runtime.snapshot(serverName).serverCapabilities;
				const discoverTools = () =>
					capabilities?.tools === undefined
						? Promise.resolve([])
						: runtime
								.listTools(serverName, undefined, {
									cacheMode: "refresh",
									signal: operationSignal,
								})
								.then((result) => result.tools);
				const discoverResources = () =>
					capabilities?.resources === undefined
						? Promise.resolve([])
						: runtime
								.listResources(serverName, undefined, {
									cacheMode: "refresh",
									signal: operationSignal,
								})
								.then((result) => result.resources);
				const discoverResourceTemplates = () =>
					capabilities?.resources === undefined
						? Promise.resolve([])
						: runtime
								.listResourceTemplates(serverName, undefined, {
									cacheMode: "refresh",
									signal: operationSignal,
								})
								.then((result) => result.resourceTemplates)
								.catch((error: unknown) => {
									if (isMethodNotFoundProtocolError(error)) return [];
									throw error;
								});
				const discoverPrompts = () =>
					capabilities?.prompts === undefined
						? Promise.resolve([])
						: runtime
								.listPrompts(serverName, undefined, {
									cacheMode: "refresh",
									signal: operationSignal,
								})
								.then((result) => result.prompts);
				const finalize = (
					tools: McpRuntimeCatalogSnapshot["tools"],
					resources: McpRuntimeCatalogSnapshot["resources"],
					resourceTemplates: McpRuntimeCatalogSnapshot["resourceTemplates"],
					prompts: McpRuntimeCatalogSnapshot["prompts"],
				): McpRuntimeCatalogSnapshot => {
					const itemCount =
						tools.length + resources.length + resourceTemplates.length + prompts.length;
					if (itemCount > this.#maxDiscoveryItems) {
						throw new McpRuntimeManagerError(
							MCP_RUNTIME_DISCOVERY_LIMIT_EXCEEDED,
							"The upstream MCP catalog exceeds the configured discovery limit.",
						);
					}
					this.#states.connected(generationKey, runtime.snapshot(serverName));
					return Object.freeze({
						discoveredAt: isoTimestamp(this.#now),
						tools: Object.freeze([...tools]),
						resources: Object.freeze([...resources]),
						resourceTemplates: Object.freeze([...resourceTemplates]),
						prompts: Object.freeze([...prompts]),
					});
				};

				if (controls.leaseMode === "exclusive") {
					const tools = await discoverTools();
					const resources = await discoverResources();
					const resourceTemplates = await discoverResourceTemplates();
					const prompts = await discoverPrompts();
					return finalize(tools, resources, resourceTemplates, prompts);
				}
				const [toolsResult, resourcesResult, resourceTemplatesResult, promptsResult] =
					await Promise.allSettled([
						discoverTools(),
						discoverResources(),
						discoverResourceTemplates(),
						discoverPrompts(),
					]);
				const tools = requireDiscoveryResult(toolsResult);
				const resources = requireDiscoveryResult(resourcesResult);
				const resourceTemplates = requireDiscoveryResult(resourceTemplatesResult);
				const prompts = requireDiscoveryResult(promptsResult);
				return finalize(tools, resources, resourceTemplates, prompts);
			},
			controls,
		);
	}

	withClientRuntime<Result>(
		generationKey: GenerationKey,
		operation: McpManagedClientRuntimeOperation<Result>,
		options?: AbortSignal | McpRuntimeOperationOptions,
	): Promise<Result> {
		if (typeof operation !== "function") {
			return Promise.reject(new TypeError("operation must be a function."));
		}
		let controls: McpRuntimeOperationOptions;
		try {
			controls = normalizeOperationOptions(options, "withClientRuntime");
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#withRuntime(
			generationKey,
			(owned, operationSignal) =>
				operation(
					Object.freeze({
						runtime: owned.runtime,
						serverName: owned.serverName,
						signal: operationSignal,
					}),
				),
			controls,
			true,
		);
	}

	callTool(
		generationKey: GenerationKey,
		name: string,
		arguments_: Readonly<Record<string, unknown>>,
		options?: AbortSignal | McpRuntimeToolCallOptions,
	): Promise<CallToolResult> {
		let controls: McpRuntimeToolCallOptions;
		try {
			controls = normalizeToolCallOptions(options);
		} catch (error) {
			return Promise.reject(error);
		}
		const { toolDefinition } = controls;
		return this.#withRuntime(
			generationKey,
			({ runtime, serverName }, operationSignal) =>
				runtime.callTool(
					serverName,
					{ name, arguments: { ...arguments_ } },
					{
						signal: operationSignal,
						...(toolDefinition === undefined ? {} : { toolDefinition }),
					},
				),
			controls,
			true,
		);
	}

	readResource(
		generationKey: GenerationKey,
		uri: string,
		options?: AbortSignal | McpRuntimeOperationOptions,
	): Promise<ReadResourceResult> {
		let controls: McpRuntimeOperationOptions;
		try {
			controls = normalizeOperationOptions(options, "readResource");
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#withRuntime(
			generationKey,
			({ runtime, serverName }, operationSignal) =>
				runtime.readResource(serverName, { uri }, { signal: operationSignal }),
			controls,
			true,
		);
	}

	getPrompt(
		generationKey: GenerationKey,
		name: string,
		arguments_: Readonly<Record<string, string>> | undefined,
		options?: AbortSignal | McpRuntimeOperationOptions,
	): Promise<GetPromptResult> {
		let controls: McpRuntimeOperationOptions;
		try {
			controls = normalizeOperationOptions(options, "getPrompt");
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#withRuntime(
			generationKey,
			({ runtime, serverName }, operationSignal) =>
				runtime.getPrompt(
					serverName,
					{
						name,
						...(arguments_ === undefined ? {} : { arguments: { ...arguments_ } }),
					},
					{ signal: operationSignal },
				),
			controls,
			true,
		);
	}

	state(generationKey: GenerationKey): McpRuntimeStateSnapshot {
		const keeper = this.#keepers.get(generationKey);
		if (keeper === undefined) return this.#states.read(generationKey);
		const owned = keeper.resource;
		if (owned.quarantined) return this.#states.read(generationKey);
		try {
			const snapshot = owned.runtime.snapshot(owned.serverName);
			if (snapshot.state === "connected") {
				return this.#states.connected(generationKey, snapshot);
			}
		} catch {
			// A retained keeper with no readable server snapshot is no longer healthy.
		}
		const current = this.#states.read(generationKey);
		return current.phase === "online"
			? this.#states.transition(generationKey, "degraded", MCP_RUNTIME_CONNECTION_LOST)
			: current;
	}

	snapshot(): McpRuntimeManagerSnapshot {
		const snapshot = this.#leases.snapshot();
		return Object.freeze({
			closed: snapshot.closed,
			maxConnections: snapshot.maxResources,
			maxQueuedOperations: this.#admission.maxOperations,
			queuedOperationCount: this.#admission.size,
			connectionCount: snapshot.resourceCount,
			pendingConnectionCount: snapshot.pendingResourceCount,
			activeConnectionCount: snapshot.activeResourceCount,
			closingConnectionCount: snapshot.closingResourceCount,
			quarantinedConnectionCount: snapshot.failedResourceCount,
			operationReferenceCount: snapshot.referenceCount,
			onlineKeeperCount: this.#keepers.size,
		});
	}

	subscribe(listener: McpRuntimeStateListener): () => void {
		return this.#states.subscribe(listener);
	}

	close(): Promise<void> {
		if (this.#closeTask !== undefined) return this.#closeTask;
		this.#closed = true;
		this.#admission.rejectAll(runtimeManagerClosedError());
		this.#closeTask = this.#performClose();
		return this.#closeTask;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	async #performClose(): Promise<void> {
		const close = this.#leases.close();
		const keepers = [...this.#keepers.values()];
		this.#keepers.clear();
		const settled = await Promise.allSettled([close, ...keepers.map((keeper) => keeper.release())]);
		this.#exclusiveIdentities.clear();
		const failures = settled.flatMap((result) =>
			result.status === "rejected" ? [result.reason as unknown] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(failures, "The MCP runtime manager failed to close.");
		}
	}

	async #reconcileOnline(generationKey: GenerationKey): Promise<McpRuntimeStateSnapshot> {
		const keeper = this.#keepers.get(generationKey);
		if (keeper === undefined) return this.#bringOnline(generationKey);
		const owned = requireActiveRuntime(keeper.resource);
		let snapshot: McpClientConnectionSnapshot;
		try {
			snapshot = owned.runtime.snapshot(owned.serverName);
		} catch (error) {
			const mapped = mapMcpRuntimeManagerError(error);
			this.#states.transition(generationKey, "degraded", runtimeManagerErrorCode(mapped));
			throw mapped;
		}
		if (snapshot.state === "connected") {
			return this.#states.connected(generationKey, snapshot);
		}
		this.#states.transition(generationKey, "connecting");
		try {
			await owned.runtime.connect(owned.serverName, {
				signal: AbortSignal.any([
					owned.generationSignal,
					AbortSignal.timeout(this.#requestTimeoutMs),
				]),
			});
			return this.#states.connected(generationKey, owned.runtime.snapshot(owned.serverName));
		} catch (error) {
			const mapped = mapMcpRuntimeManagerError(error);
			if (this.#states.read(generationKey).phase !== "quarantined") {
				this.#states.transition(generationKey, "degraded", runtimeManagerErrorCode(mapped));
			}
			throw mapped;
		}
	}

	async #bringOnline(generationKey: GenerationKey): Promise<McpRuntimeStateSnapshot> {
		this.#assertNotQuarantined(generationKey);
		this.#states.transition(generationKey, "queued");
		try {
			const lease = await this.#leases.acquire(generationKey, { releaseMode: "close" });
			if (lease.resource.quarantined) {
				await releaseIgnoringFailure(lease);
				throw runtimeQuarantinedError();
			}
			if (this.#closed) {
				await lease.release();
				throw runtimeManagerClosedError();
			}
			this.#keepers.set(generationKey, lease);
			return this.#states.read(generationKey);
		} catch (error) {
			const mapped = mapMcpRuntimeManagerError(error);
			if (this.#states.read(generationKey).phase !== "quarantined") {
				this.#states.transition(generationKey, "failed", runtimeManagerErrorCode(mapped));
			}
			throw mapped;
		}
	}

	async #withRuntime<Result>(
		generationKey: GenerationKey,
		operation: (owned: ActiveMcpRuntime<GenerationKey>, signal: AbortSignal) => Promise<Result>,
		options: McpRuntimeOperationOptions,
		requireOnline = false,
	): Promise<Result> {
		this.#assertOpen();
		if (this.#offlineTasks.has(generationKey)) throw runtimeNotReadyError();
		this.#assertNotQuarantined(generationKey);
		const leaseMode = options.leaseMode ?? "shared";
		if (leaseMode === "shared" && requireOnline) this.#assertOnlineKeeper(generationKey);
		const callerSignal = options.signal;
		const acquisitionSignal = AbortSignal.any([
			AbortSignal.timeout(this.#requestTimeoutMs),
			...(callerSignal === undefined ? [] : [callerSignal]),
		]);
		const identity =
			leaseMode !== "shared" ? this.#createExclusiveIdentity(generationKey) : generationKey;
		let reserved: Promise<McpClientLease<OwnedMcpRuntime<GenerationKey>>> | undefined;
		const startedAt = this.#now();
		const observe = (outcome: McpRuntimeAdmissionEvent["outcome"]): void => {
			try {
				options.onAdmission?.({
					outcome,
					durationMs: Math.max(0, this.#now() - startedAt),
					queuedOperationCount: this.#admission.size,
					activeConnectionCount: this.#leases.size,
				});
			} catch {
				/* Observers cannot change admission or dispatch. */
			}
		};
		let releaseAdmission: (quarantine: boolean) => void;
		try {
			acquisitionSignal.throwIfAborted();
			if (
				leaseMode !== "shared" &&
				(this.#keepers.has(generationKey) || this.#onlineTasks.has(generationKey))
			) {
				throw runtimeLeaseModeConflictError();
			}
			releaseAdmission = await this.#admission.enter(
				generationKey,
				leaseMode,
				options.admissionKey,
				options.exclusiveContention === "queue" || options.concurrentContention === "queue",
				acquisitionSignal,
				options.maxConcurrentOperations,
				AsyncResource.bind(() => {
					acquisitionSignal.throwIfAborted();
					if (!this.#leases.canAcquire(identity)) return false;
					reserved = this.#leases.acquire(identity, {
						releaseMode: "close",
						signal: acquisitionSignal,
						awaitCleanupOnCancel: leaseMode !== "shared",
					});
					void reserved.catch(() => undefined);
					return true;
				}),
			);
		} catch (error) {
			this.#forgetExclusiveIdentity(identity);
			if (
				acquisitionSignal.aborted &&
				acquisitionSignal.reason instanceof DOMException &&
				acquisitionSignal.reason.name === "TimeoutError"
			) {
				observe("timeout");
				throw new McpRuntimeManagerError(
					MCP_RUNTIME_ADMISSION_TIMEOUT,
					"The MCP operation deadline expired while waiting for admission.",
					{ cause: error },
				);
			}
			observe(
				acquisitionSignal.aborted
					? "cancelled"
					: runtimeManagerErrorCode(error) === MCP_RUNTIME_QUEUE_FULL
						? "queue-full"
						: "refused",
			);
			throwIfCallerAborted(callerSignal);
			throw mapMcpRuntimeManagerError(error);
		}
		observe("admitted");
		try {
			if (reserved === undefined) throw new Error("MCP admission did not reserve a transport.");
			return await this.#runOperation(
				generationKey,
				operation,
				reserved,
				acquisitionSignal,
				callerSignal,
			);
		} finally {
			this.#forgetExclusiveIdentity(identity);
			releaseAdmission(this.#states.read(generationKey).phase === "quarantined");
		}
	}

	async #runOperation<Result>(
		generationKey: GenerationKey,
		operation: (owned: ActiveMcpRuntime<GenerationKey>, signal: AbortSignal) => Promise<Result>,
		reservation: Promise<McpClientLease<OwnedMcpRuntime<GenerationKey>>>,
		acquisitionSignal: AbortSignal,
		callerSignal: AbortSignal | undefined,
	): Promise<Result> {
		let lease: McpClientLease<OwnedMcpRuntime<GenerationKey>>;
		try {
			lease = await reservation;
		} catch (error) {
			throwIfCallerAborted(callerSignal);
			throw mapMcpRuntimeManagerError(error);
		}
		let outcome:
			| { readonly success: true; readonly value: Result }
			| { readonly success: false; readonly error: unknown };
		try {
			// The lease may have been granted immediately before cancellation or retirement.
			this.#assertOpen();
			this.#assertNotQuarantined(generationKey);
			const owned = requireActiveRuntime(lease.resource);
			const operationSignal = AbortSignal.any([acquisitionSignal, owned.generationSignal]);
			operationSignal.throwIfAborted();
			if (this.#offlineTasks.has(generationKey))
				throw new McpRuntimeManagerError(
					MCP_RUNTIME_GENERATION_RETIRED,
					"The MCP runtime generation was retired before dispatch.",
				);
			outcome = { success: true, value: await operation(owned, operationSignal) };
		} catch (error) {
			outcome = { success: false, error };
		}
		try {
			await lease.release();
		} catch (error) {
			this.#states.transition(generationKey, "quarantined", MCP_RUNTIME_CLEANUP_FAILED);
			throw runtimeQuarantinedError(error);
		}
		if (!outcome.success) {
			throwIfCallerAborted(callerSignal);
			throw mapMcpRuntimeManagerError(outcome.error);
		}
		return outcome.value;
	}

	async #probeProtocolLiveness(
		owned: ActiveMcpRuntime<GenerationKey>,
		signal: AbortSignal,
	): Promise<void> {
		const { runtime, serverName } = owned;
		const protocolEra = runtime.snapshot(serverName).protocolEra;
		if (protocolEra === "legacy") {
			await runtime.ping(serverName, { signal });
			return;
		}
		if (protocolEra === "modern") {
			await runtime.discover(serverName, { signal });
			return;
		}
		throw new McpRuntimeManagerError(
			"MCP_UPSTREAM_FAILED",
			"The connected MCP server did not report a protocol era.",
		);
	}

	#assertOpen(): void {
		if (this.#closed) throw runtimeManagerClosedError();
	}

	#assertSharedLeaseAvailable(generationKey: GenerationKey): void {
		if (this.#admission.hasIsolatedGeneration(generationKey)) {
			throw runtimeLeaseModeConflictError();
		}
	}

	#createExclusiveIdentity(
		generationKey: GenerationKey,
	): ExclusiveRuntimeLeaseIdentity<GenerationKey> {
		const identity = new ExclusiveRuntimeLeaseIdentity(generationKey);
		let identities = this.#exclusiveIdentities.get(generationKey);
		if (identities === undefined) {
			identities = new Set();
			this.#exclusiveIdentities.set(generationKey, identities);
		}
		identities.add(identity);
		return identity;
	}

	#forgetExclusiveIdentity(identity: RuntimeLeaseIdentity<GenerationKey>): void {
		if (!(identity instanceof ExclusiveRuntimeLeaseIdentity)) return;
		const identities = this.#exclusiveIdentities.get(identity.generationKey);
		if (identities === undefined) return;
		identities.delete(identity);
		if (identities.size === 0) this.#exclusiveIdentities.delete(identity.generationKey);
	}

	#assertNotQuarantined(generationKey: GenerationKey): void {
		if (this.#states.read(generationKey).phase === "quarantined") {
			throw runtimeQuarantinedError();
		}
	}

	#assertOnlineKeeper(generationKey: GenerationKey): void {
		const keeper = this.#keepers.get(generationKey);
		if (keeper === undefined) throw runtimeNotReadyError();
		const owned = requireActiveRuntime(keeper.resource);
		const snapshot = owned.runtime.snapshot(owned.serverName);
		if (snapshot.state !== "connected") {
			this.#states.transition(generationKey, "degraded", MCP_RUNTIME_CONNECTION_LOST);
			throw runtimeNotReadyError();
		}
		this.#states.connected(generationKey, snapshot);
	}
}

const EMPTY_OPERATION_OPTIONS: McpRuntimeOperationOptions = Object.freeze({});
const EMPTY_TOOL_CALL_OPTIONS: McpRuntimeToolCallOptions = EMPTY_OPERATION_OPTIONS;

function normalizeOperationOptions(
	options: AbortSignal | McpRuntimeOperationOptions | undefined,
	operationName: string,
): McpRuntimeOperationOptions {
	if (options === undefined) return EMPTY_OPERATION_OPTIONS;
	if (typeof options !== "object" || options === null) {
		throw new TypeError(
			`${operationName} options must be an AbortSignal or an operation options object.`,
		);
	}
	if (isAbortSignal(options)) return { signal: options };
	let signal: unknown;
	let leaseMode: unknown;
	let exclusiveContention: unknown;
	let admissionKey: unknown;
	let concurrentContention: unknown;
	let maxConcurrentOperations: unknown;
	let onAdmission: unknown;
	try {
		signal = Reflect.get(options, "signal");
		leaseMode = Reflect.get(options, "leaseMode");
		exclusiveContention = Reflect.get(options, "exclusiveContention");
		admissionKey = Reflect.get(options, "admissionKey");
		concurrentContention = Reflect.get(options, "concurrentContention");
		maxConcurrentOperations = Reflect.get(options, "maxConcurrentOperations");
		onAdmission = Reflect.get(options, "onAdmission");
	} catch {
		throw new TypeError(`${operationName} options could not be read.`);
	}
	if (
		signal !== undefined &&
		(typeof signal !== "object" || signal === null || !isAbortSignal(signal))
	) {
		throw new TypeError(`${operationName} options.signal must be an AbortSignal.`);
	}
	if (
		leaseMode !== undefined &&
		leaseMode !== "shared" &&
		leaseMode !== "exclusive" &&
		leaseMode !== "concurrent"
	) {
		throw new TypeError(
			`${operationName} options.leaseMode must be "shared", "exclusive", or "concurrent".`,
		);
	}
	if (
		exclusiveContention !== undefined &&
		exclusiveContention !== "reject" &&
		exclusiveContention !== "queue"
	) {
		throw new TypeError(
			`${operationName} options.exclusiveContention must be "reject" or "queue".`,
		);
	}
	if (
		concurrentContention !== undefined &&
		concurrentContention !== "reject" &&
		concurrentContention !== "queue"
	) {
		throw new TypeError(
			`${operationName} options.concurrentContention must be "reject" or "queue".`,
		);
	}
	if (concurrentContention === "queue" && leaseMode !== "concurrent") {
		throw new TypeError(
			`${operationName} queued concurrent contention requires leaseMode "concurrent".`,
		);
	}
	if (maxConcurrentOperations !== undefined && maxConcurrentOperations !== null) {
		if (typeof maxConcurrentOperations !== "number")
			throw new TypeError("maxConcurrentOperations must be a positive integer or null.");
		positiveInteger(maxConcurrentOperations, "maxConcurrentOperations");
	}
	if (onAdmission !== undefined && !isAdmissionObserver(onAdmission))
		throw new TypeError("onAdmission must be a function.");
	if (exclusiveContention === "queue" && leaseMode !== "exclusive") {
		throw new TypeError(`${operationName} queued contention requires leaseMode "exclusive".`);
	}
	if (
		admissionKey !== undefined &&
		(typeof admissionKey !== "string" || admissionKey.length === 0 || admissionKey.length > 1024)
	) {
		throw new TypeError(`${operationName} options.admissionKey must be a nonempty bounded string.`);
	}
	if (leaseMode === "concurrent" && admissionKey === undefined) {
		throw new TypeError(`${operationName} concurrent execution requires an admissionKey.`);
	}
	if (admissionKey !== undefined && leaseMode !== "concurrent" && leaseMode !== "exclusive") {
		throw new TypeError(`${operationName} admissionKey requires an isolated lease mode.`);
	}
	return {
		...(signal === undefined ? {} : { signal }),
		...(leaseMode === undefined ? {} : { leaseMode }),
		...(exclusiveContention === undefined ? {} : { exclusiveContention }),
		...(admissionKey === undefined ? {} : { admissionKey }),
		...(concurrentContention === undefined ? {} : { concurrentContention }),
		...(maxConcurrentOperations === undefined ? {} : { maxConcurrentOperations }),
		...(onAdmission === undefined ? {} : { onAdmission }),
	};
}

/** Accepts the positional cancellation form and the richer per-call options object. */
function normalizeToolCallOptions(
	options: AbortSignal | McpRuntimeToolCallOptions | undefined,
): McpRuntimeToolCallOptions {
	if (options === undefined) return EMPTY_TOOL_CALL_OPTIONS;
	if (typeof options !== "object" || options === null) {
		throw new TypeError("callTool options must be an AbortSignal or a tool call options object.");
	}
	if (isAbortSignal(options)) return { signal: options };
	return {
		...normalizeOperationOptions(options, "callTool"),
		...(options.toolDefinition === undefined ? {} : { toolDefinition: options.toolDefinition }),
	};
}

function isAdmissionObserver(value: unknown): value is (event: McpRuntimeAdmissionEvent) => void {
	return typeof value === "function";
}

function isAbortSignal(value: object): value is AbortSignal {
	if (value instanceof AbortSignal) return true;
	try {
		return (
			typeof Reflect.get(value, "aborted") === "boolean" &&
			typeof Reflect.get(value, "addEventListener") === "function"
		);
	} catch {
		return false;
	}
}

function isMethodNotFoundProtocolError(error: unknown): error is ProtocolError {
	return ProtocolError.isInstance(error) && error.code === METHOD_NOT_FOUND;
}

function requireDiscoveryResult<Result>(result: PromiseSettledResult<Result>): Result {
	if (result.status === "fulfilled") return result.value;
	throw result.reason;
}

function generationKeyOf<GenerationKey>(
	identity: RuntimeLeaseIdentity<GenerationKey>,
): GenerationKey {
	return identity instanceof ExclusiveRuntimeLeaseIdentity ? identity.generationKey : identity;
}

function requireActiveRuntime<GenerationKey>(
	owned: OwnedMcpRuntime<GenerationKey>,
): ActiveMcpRuntime<GenerationKey> {
	if (owned.quarantined) throw runtimeQuarantinedError();
	return owned;
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw signal.reason;
}

function isRetirementError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	try {
		const code = Reflect.get(error, "code");
		return code === MCP_CLIENT_LEASE_INVALIDATED || code === MCP_RUNTIME_GENERATION_RETIRED;
	} catch {
		return false;
	}
}

async function releaseIgnoringFailure<Resource extends object>(
	lease: McpClientLease<Resource>,
): Promise<void> {
	try {
		await lease.release();
	} catch {
		// The public disposition remains quarantined; the lease manager retains the failed generation.
	}
}

function waitForCaller<Result>(task: Promise<Result>, signal?: AbortSignal): Promise<Result> {
	if (signal === undefined) return task;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<Result>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void task.then(
			(result) => {
				signal.removeEventListener("abort", onAbort);
				resolve(result);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive integer.`);
	}
	return value;
}

function positiveFinite(value: number, name: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive finite number.`);
	}
	return value;
}

function isoTimestamp(now: () => number): string {
	try {
		const timestamp = now();
		if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
	} catch {
		// Fall through to the system clock if an injected diagnostics clock fails.
	}
	return new Date().toISOString();
}

function safeClock(now: () => number): () => number {
	return () => {
		try {
			const timestamp = now();
			if (Number.isFinite(timestamp)) {
				new Date(timestamp).toISOString();
				return timestamp;
			}
		} catch {
			// Diagnostics clocks are best-effort; lifecycle ownership must remain available.
		}
		return Date.now();
	};
}
