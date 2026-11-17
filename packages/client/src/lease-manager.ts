import {
	leaseCapacityExceededError,
	leaseInvalidatedError,
	leaseManagerClosedError,
	leaseReleaseModeConflictError,
} from "./errors.ts";

const DEFAULT_MAX_RESOURCES = 100;
const DEFAULT_IDLE_TTL_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const CREATION_SETTLED = Symbol("creation-settled");
const ENTRY_RETIRED = Symbol("entry-retired");
const CALLER_ABORTED = Symbol("caller-aborted");

/** Determines what happens when the final reference to one resource is released. */
export type McpClientLeaseReleaseMode = "close" | "idle";

export interface McpClientLeaseFactoryContext {
	/** Aborted when this identity generation is invalidated, abandoned, or shut down. */
	readonly signal: AbortSignal;
}

export interface McpClientLeaseManagerOptions<Identity, Resource extends object> {
	/** A stable, non-secret identity is passed only to this caller-owned factory. */
	readonly create: (identity: Identity, context: McpClientLeaseFactoryContext) => Promise<Resource>;
	/** Closes a resource exactly once after its identity generation is retired. */
	readonly close: (resource: Resource) => Promise<void> | void;
	/** Hard bound across pending, ready, and retiring resource generations. */
	readonly maxResources?: number;
	/** Retention window for resources explicitly acquired in `idle` mode. */
	readonly idleTtlMs?: number;
	/** Injectable monotonic-enough wall clock for deterministic expiry tests. */
	readonly now?: () => number;
	/** Called after capacity is released; observer failures cannot affect cleanup. */
	readonly onCapacityAvailable?: () => void;
}

export interface McpClientLeaseAcquireOptions {
	/** Defaults to `close`; use `idle` only for resources safe to reuse. */
	readonly releaseMode?: McpClientLeaseReleaseMode;
	/** Cancels only this acquisition, never another caller sharing the same creation. */
	readonly signal?: AbortSignal;
	/** Wait for this reservation's required cleanup on cancellation; defaults to false. */
	readonly awaitCleanupOnCancel?: boolean;
}

export interface McpClientLease<Resource extends object> extends AsyncDisposable {
	readonly resource: Resource;
	readonly released: boolean;
	/** Releases this reference. Repeated calls return the same settlement. */
	release(): Promise<void>;
}

/** Aggregate diagnostics deliberately omit opaque identity keys and resources. */
export interface McpClientLeaseManagerSnapshot {
	readonly closed: boolean;
	readonly maxResources: number;
	readonly resourceCount: number;
	readonly pendingResourceCount: number;
	readonly activeResourceCount: number;
	readonly idleResourceCount: number;
	readonly closingResourceCount: number;
	readonly failedResourceCount: number;
	readonly referenceCount: number;
}

type LeaseEntryState = "pending" | "ready" | "closing" | "close-failed";

interface LeaseEntry<Identity, Resource extends object> {
	readonly identity: Identity;
	readonly token: symbol;
	readonly releaseMode: McpClientLeaseReleaseMode;
	readonly controller: AbortController;
	state: LeaseEntryState;
	refCount: number;
	resource: Resource | undefined;
	creationFailed: boolean;
	creationFailure: unknown;
	createTask: Promise<void> | undefined;
	retired: boolean;
	retirementReason: unknown;
	drainTask: Promise<void> | undefined;
	resolveDrain: (() => void) | undefined;
	closeTask: Promise<void> | undefined;
	idleSince: number | undefined;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
}

interface AbortWait<Result extends symbol> {
	readonly promise: Promise<Result>;
	detach(): void;
}

/**
 * Bounded, framework-neutral ownership for identity-isolated MCP client resources.
 * Identity keys are compared opaquely with `Map` semantics and are never emitted.
 */
export class McpClientLeaseManager<Identity, Resource extends object> implements AsyncDisposable {
	readonly #entries = new Map<Identity, LeaseEntry<Identity, Resource>>();
	readonly #generations = new Set<LeaseEntry<Identity, Resource>>();
	readonly #create: McpClientLeaseManagerOptions<Identity, Resource>["create"];
	readonly #closeResource: McpClientLeaseManagerOptions<Identity, Resource>["close"];
	readonly #maxResources: number;
	readonly #idleTtlMs: number;
	readonly #now: () => number;
	readonly #onCapacityAvailable: (() => void) | undefined;
	#closed = false;
	#closeTask: Promise<void> | undefined;

	constructor(options: McpClientLeaseManagerOptions<Identity, Resource>) {
		const maxResources = options.maxResources ?? DEFAULT_MAX_RESOURCES;
		const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
		if (!Number.isInteger(maxResources) || maxResources <= 0) {
			throw new RangeError("McpClientLeaseManager maxResources must be a positive integer.");
		}
		if (!Number.isFinite(idleTtlMs) || idleTtlMs < 0) {
			throw new RangeError("McpClientLeaseManager idleTtlMs must be a non-negative number.");
		}
		this.#create = options.create;
		this.#closeResource = options.close;
		this.#maxResources = maxResources;
		this.#idleTtlMs = idleTtlMs;
		this.#now = options.now ?? Date.now;
		this.#onCapacityAvailable = options.onCapacityAvailable;
	}

	get closed(): boolean {
		return this.#closed;
	}

	get size(): number {
		return this.#generations.size;
	}

	snapshot(): McpClientLeaseManagerSnapshot {
		let pendingResourceCount = 0;
		let activeResourceCount = 0;
		let idleResourceCount = 0;
		let closingResourceCount = 0;
		let failedResourceCount = 0;
		let referenceCount = 0;

		for (const entry of this.#generations) {
			referenceCount += entry.refCount;
			switch (entry.state) {
				case "pending": {
					pendingResourceCount += 1;
					break;
				}
				case "ready": {
					if (entry.refCount === 0) idleResourceCount += 1;
					else activeResourceCount += 1;
					break;
				}
				case "closing": {
					closingResourceCount += 1;
					break;
				}
				case "close-failed": {
					failedResourceCount += 1;
					break;
				}
			}
		}

		return Object.freeze({
			closed: this.#closed,
			maxResources: this.#maxResources,
			resourceCount: this.#generations.size,
			pendingResourceCount,
			activeResourceCount,
			idleResourceCount,
			closingResourceCount,
			failedResourceCount,
			referenceCount,
		});
	}

	/** Read-only availability for a synchronous acquire reservation. Includes all cleanup. */
	canAcquire(identity: Identity): boolean {
		if (this.#closed) return false;
		const entry = this.#entries.get(identity);
		return (entry !== undefined && !entry.retired) || this.#generations.size < this.#maxResources;
	}

	async acquire(
		identity: Identity,
		options: McpClientLeaseAcquireOptions = {},
	): Promise<McpClientLease<Resource>> {
		const releaseMode = options.releaseMode ?? "close";
		assertReleaseMode(releaseMode);
		if (
			options.awaitCleanupOnCancel !== undefined &&
			typeof options.awaitCleanupOnCancel !== "boolean"
		) {
			throw new TypeError("McpClientLeaseManager awaitCleanupOnCancel must be a boolean.");
		}
		throwIfAborted(options.signal);

		for (;;) {
			this.#assertOpen();
			throwIfAborted(options.signal);

			const existing = this.#entries.get(identity);
			if (existing !== undefined && !existing.retired) {
				if (existing.releaseMode !== releaseMode) throw leaseReleaseModeConflictError();
				this.#reserve(existing);
				return this.#awaitLease(existing, options.signal, options.awaitCleanupOnCancel ?? false);
			}

			if (this.#generations.size < this.#maxResources) {
				const entry = this.#createEntry(identity, releaseMode);
				this.#reserve(entry);
				return this.#awaitLease(entry, options.signal, options.awaitCleanupOnCancel ?? false);
			}

			const idle = this.#oldestIdleEntry();
			if (idle === undefined) throw leaseCapacityExceededError();
			const eviction = this.#retireEntry(idle, resourceEvictedReason());
			await waitForTask(eviction, options.signal);
		}
	}

	/** Retires the current identity generation before waiting for its close. */
	async invalidate(identity: Identity): Promise<boolean> {
		this.#assertOpen();
		const entry = this.#entries.get(identity);
		if (entry === undefined || entry.retired) return false;
		await this.#retireEntry(entry, leaseInvalidatedError());
		return true;
	}

	close(): Promise<void> {
		if (this.#closeTask !== undefined) return this.#closeTask;
		this.#closed = true;

		let resolveClose: (() => void) | undefined;
		let rejectClose: ((error: unknown) => void) | undefined;
		this.#closeTask = new Promise<void>((resolve, reject) => {
			resolveClose = resolve;
			rejectClose = reject;
		});

		const reason = leaseManagerClosedError();
		const closeTasks = [...this.#generations].map((entry) => this.#retireEntry(entry, reason));
		void Promise.allSettled(closeTasks).then((settled) => {
			const failures = settled.flatMap((result) =>
				result.status === "rejected" ? [result.reason as unknown] : [],
			);
			if (failures.length === 0) resolveClose?.();
			else {
				rejectClose?.(
					new AggregateError(failures, "One or more MCP client lease resources failed to close."),
				);
			}
		});

		return this.#closeTask;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	#createEntry(
		identity: Identity,
		releaseMode: McpClientLeaseReleaseMode,
	): LeaseEntry<Identity, Resource> {
		const entry: LeaseEntry<Identity, Resource> = {
			identity,
			token: Symbol("mcp-client-lease-generation"),
			releaseMode,
			controller: new AbortController(),
			state: "pending",
			refCount: 0,
			resource: undefined,
			creationFailed: false,
			creationFailure: undefined,
			createTask: undefined,
			retired: false,
			retirementReason: undefined,
			drainTask: undefined,
			resolveDrain: undefined,
			closeTask: undefined,
			idleSince: undefined,
			idleTimer: undefined,
		};
		this.#entries.set(identity, entry);
		this.#generations.add(entry);

		const context = Object.freeze({ signal: entry.controller.signal });
		entry.createTask = Promise.resolve().then(async () => {
			try {
				const resource = await this.#create(identity, context);
				assertResource(resource);
				entry.resource = resource;
				if (!entry.retired) entry.state = "ready";
			} catch (error) {
				entry.creationFailed = true;
				entry.creationFailure = error;
				if (!entry.retired) this.#failCreation(entry, error);
			}
		});

		return entry;
	}

	#reserve(entry: LeaseEntry<Identity, Resource>): void {
		this.#clearIdle(entry);
		entry.refCount += 1;
	}

	async #awaitLease(
		entry: LeaseEntry<Identity, Resource>,
		callerSignal: AbortSignal | undefined,
		awaitCleanupOnCancel: boolean,
	): Promise<McpClientLease<Resource>> {
		const createTask = requireCreateTask(entry);
		const retired = waitForAbort(entry.controller.signal, ENTRY_RETIRED);
		const caller =
			callerSignal === undefined ? undefined : waitForAbort(callerSignal, CALLER_ABORTED);

		try {
			const outcome = await Promise.race([
				createTask.then(() => CREATION_SETTLED),
				retired.promise,
				...(caller === undefined ? [] : [caller.promise]),
			]);

			if (outcome === CALLER_ABORTED) {
				const cleanup = this.#cancelReservation(entry);
				if (awaitCleanupOnCancel) await cleanup;
				else this.#observeBackground(cleanup);
				throw abortReason(callerSignal);
			}
			if (entry.retired || outcome === ENTRY_RETIRED) {
				this.#dropReference(entry);
				if (awaitCleanupOnCancel) await entry.closeTask;
				throw entry.retirementReason;
			}
			if (entry.creationFailed) {
				this.#dropReference(entry);
				throw entry.creationFailure;
			}
			if (entry.state !== "ready" || entry.resource === undefined) {
				const cleanup = this.#cancelReservation(entry);
				if (awaitCleanupOnCancel) await cleanup;
				else this.#observeBackground(cleanup);
				throw new Error("The MCP client lease resource did not become ready.");
			}

			return new ManagedMcpClientLease(entry.resource, () => this.#releaseReference(entry));
		} finally {
			retired.detach();
			caller?.detach();
		}
	}

	#releaseReference(entry: LeaseEntry<Identity, Resource>): Promise<void> {
		this.#dropReference(entry);
		if (entry.refCount !== 0) return Promise.resolve();
		if (entry.retired) return entry.closeTask ?? Promise.resolve();

		if (entry.state === "pending") {
			return this.#retireEntry(entry, acquisitionAbandonedReason());
		}
		if (entry.state !== "ready") return Promise.resolve();
		if (entry.releaseMode === "close") {
			return this.#retireEntry(entry, finalReleaseReason());
		}
		return this.#scheduleIdle(entry);
	}

	#cancelReservation(entry: LeaseEntry<Identity, Resource>): Promise<void> {
		this.#dropReference(entry);
		if (entry.refCount !== 0) return Promise.resolve();
		if (entry.retired) return entry.closeTask ?? Promise.resolve();
		return this.#retireEntry(entry, acquisitionAbandonedReason());
	}

	#dropReference(entry: LeaseEntry<Identity, Resource>): void {
		if (entry.refCount === 0) return;
		entry.refCount -= 1;
		if (entry.refCount === 0) {
			entry.resolveDrain?.();
			entry.resolveDrain = undefined;
		}
	}

	#scheduleIdle(entry: LeaseEntry<Identity, Resource>): Promise<void> {
		entry.idleSince = this.#now();
		if (this.#idleTtlMs === 0) {
			return this.#retireEntry(entry, idleExpiredReason());
		}
		this.#armIdleTimer(entry, entry.idleSince);
		return Promise.resolve();
	}

	#armIdleTimer(entry: LeaseEntry<Identity, Resource>, idleSince: number): void {
		const remaining = Math.max(0, idleSince + this.#idleTtlMs - this.#now());
		const timer = setTimeout(
			() => {
				if (entry.idleTimer !== timer) return;
				entry.idleTimer = undefined;
				if (
					entry.retired ||
					entry.state !== "ready" ||
					entry.refCount !== 0 ||
					entry.idleSince !== idleSince
				) {
					return;
				}
				if (this.#now() < idleSince + this.#idleTtlMs) {
					this.#armIdleTimer(entry, idleSince);
					return;
				}
				this.#observeBackground(this.#retireEntry(entry, idleExpiredReason()));
			},
			Math.min(remaining, MAX_TIMER_DELAY_MS),
		);
		timer.unref?.();
		entry.idleTimer = timer;
	}

	#clearIdle(entry: LeaseEntry<Identity, Resource>): void {
		if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
		entry.idleSince = undefined;
	}

	#oldestIdleEntry(): LeaseEntry<Identity, Resource> | undefined {
		let oldest: LeaseEntry<Identity, Resource> | undefined;
		for (const entry of this.#entries.values()) {
			if (
				entry.retired ||
				entry.state !== "ready" ||
				entry.refCount !== 0 ||
				entry.releaseMode !== "idle" ||
				entry.idleSince === undefined
			) {
				continue;
			}
			if (oldest === undefined || entry.idleSince < (oldest.idleSince ?? Infinity)) {
				oldest = entry;
			}
		}
		return oldest;
	}

	#retireEntry(entry: LeaseEntry<Identity, Resource>, reason: unknown): Promise<void> {
		if (entry.closeTask !== undefined) return entry.closeTask;
		entry.retired = true;
		entry.retirementReason = reason;
		entry.state = "closing";
		this.#clearIdle(entry);
		if (this.#entries.get(entry.identity)?.token === entry.token) {
			this.#entries.delete(entry.identity);
		}
		if (entry.refCount === 0) {
			entry.drainTask = Promise.resolve();
		} else {
			entry.drainTask = new Promise<void>((resolve) => {
				entry.resolveDrain = resolve;
			});
		}

		entry.closeTask = Promise.resolve()
			.then(async () => {
				await Promise.all([requireCreateTask(entry), requireDrainTask(entry)]);
				if (entry.resource !== undefined) {
					await this.#closeResource(entry.resource);
					entry.resource = undefined;
				}
				this.#generations.delete(entry);
				this.#notifyCapacity();
			})
			.catch((error: unknown) => {
				entry.state = "close-failed";
				throw error;
			});
		entry.controller.abort(reason);
		return entry.closeTask;
	}

	#failCreation(entry: LeaseEntry<Identity, Resource>, error: unknown): void {
		entry.retired = true;
		entry.retirementReason = error;
		if (this.#entries.get(entry.identity)?.token === entry.token) {
			this.#entries.delete(entry.identity);
		}
		this.#generations.delete(entry);
		entry.controller.abort(error);
		this.#notifyCapacity();
	}

	#notifyCapacity(): void {
		try {
			this.#onCapacityAvailable?.();
		} catch {
			/* Observers cannot fail resource cleanup. */
		}
	}

	#observeBackground(task: Promise<void>): void {
		void task.catch(() => undefined);
	}

	#assertOpen(): void {
		if (this.#closed) throw leaseManagerClosedError();
	}
}

class ManagedMcpClientLease<Resource extends object> implements McpClientLease<Resource> {
	readonly resource: Resource;
	readonly #releaseLease: () => Promise<void>;
	#releaseTask: Promise<void> | undefined;

	constructor(resource: Resource, releaseLease: () => Promise<void>) {
		this.resource = resource;
		this.#releaseLease = releaseLease;
	}

	get released(): boolean {
		return this.#releaseTask !== undefined;
	}

	release(): Promise<void> {
		if (this.#releaseTask === undefined) {
			try {
				this.#releaseTask = this.#releaseLease();
			} catch (error) {
				this.#releaseTask = Promise.reject(error);
			}
		}
		return this.#releaseTask;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.release();
	}
}

function requireCreateTask<Identity, Resource extends object>(
	entry: LeaseEntry<Identity, Resource>,
): Promise<void> {
	if (entry.createTask === undefined) {
		throw new Error("The MCP client lease resource factory did not start.");
	}
	return entry.createTask;
}

function requireDrainTask<Identity, Resource extends object>(
	entry: LeaseEntry<Identity, Resource>,
): Promise<void> {
	if (entry.drainTask === undefined) {
		throw new Error("The MCP client lease resource retirement did not start.");
	}
	return entry.drainTask;
}

function waitForAbort<Result extends symbol>(
	signal: AbortSignal,
	result: Result,
): AbortWait<Result> {
	if (signal.aborted) {
		return { promise: Promise.resolve(result), detach: noop };
	}
	let resolveAbort: ((value: Result) => void) | undefined;
	const promise = new Promise<Result>((resolve) => {
		resolveAbort = resolve;
	});
	const onAbort = (): void => resolveAbort?.(result);
	signal.addEventListener("abort", onAbort, { once: true });
	return {
		promise,
		detach(): void {
			signal.removeEventListener("abort", onAbort);
		},
	};
}

async function waitForTask(task: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	if (signal === undefined) {
		await task;
		return;
	}
	throwIfAborted(signal);
	const aborted = waitForAbort(signal, CALLER_ABORTED);
	try {
		const result = await Promise.race([task.then(() => CREATION_SETTLED), aborted.promise]);
		if (result === CALLER_ABORTED) throw abortReason(signal);
	} finally {
		aborted.detach();
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw abortReason(signal);
}

function abortReason(signal: AbortSignal | undefined): unknown {
	return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function assertReleaseMode(mode: string): asserts mode is McpClientLeaseReleaseMode {
	if (mode !== "close" && mode !== "idle") {
		throw new TypeError('McpClientLeaseManager releaseMode must be "close" or "idle".');
	}
}

function assertResource(resource: object): void {
	if (resource === null || (typeof resource !== "object" && typeof resource !== "function")) {
		throw new TypeError("McpClientLeaseManager create must resolve to a resource object.");
	}
}

function acquisitionAbandonedReason(): DOMException {
	return new DOMException("The MCP client resource creation was abandoned.", "AbortError");
}

function resourceEvictedReason(): DOMException {
	return new DOMException("The idle MCP client resource was evicted.", "AbortError");
}

function idleExpiredReason(): DOMException {
	return new DOMException("The idle MCP client resource expired.", "AbortError");
}

function finalReleaseReason(): DOMException {
	return new DOMException("The MCP client resource's final lease was released.", "AbortError");
}

function noop(): void {}
