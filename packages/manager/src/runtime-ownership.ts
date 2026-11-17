import { MCP_RUNTIME_MANAGER_CLOSED } from "./errors.ts";
import type { McpRuntimeManagerPort } from "./types.ts";

export const MCP_RUNTIME_OWNERSHIP_DEFAULTS = Object.freeze({
	maxOwners: 1_000,
	maxGenerations: 1_000,
	maxReferences: 10_000,
});

export const MCP_RUNTIME_OWNERSHIP_INVALID_OPTIONS =
	"MCP_RUNTIME_OWNERSHIP_INVALID_OPTIONS" as const;
export const MCP_RUNTIME_OWNERSHIP_CAPACITY_EXCEEDED =
	"MCP_RUNTIME_OWNERSHIP_CAPACITY_EXCEEDED" as const;
export const MCP_RUNTIME_OWNER_RELEASED = "MCP_RUNTIME_OWNER_RELEASED" as const;
export const MCP_RUNTIME_GENERATION_FENCED = "MCP_RUNTIME_GENERATION_FENCED" as const;
export const MCP_RUNTIME_RETIREMENT_FAILED = "MCP_RUNTIME_RETIREMENT_FAILED" as const;

export type McpRuntimeOwnershipErrorCode =
	| typeof MCP_RUNTIME_OWNERSHIP_INVALID_OPTIONS
	| typeof MCP_RUNTIME_OWNERSHIP_CAPACITY_EXCEEDED
	| typeof MCP_RUNTIME_OWNER_RELEASED
	| typeof MCP_RUNTIME_GENERATION_FENCED
	| typeof MCP_RUNTIME_RETIREMENT_FAILED;

/** Stable ownership failure that never retains a generation key or caught manager error. */
export class McpRuntimeOwnershipError extends Error {
	readonly code: McpRuntimeOwnershipErrorCode;

	constructor(code: McpRuntimeOwnershipErrorCode, message: string) {
		super(message);
		this.name = "McpRuntimeOwnershipError";
		this.code = code;
	}
}

/** The only manager operation taken into ownership by this coordinator. */
export type McpRuntimeRetirementPort<GenerationKey> = Pick<
	McpRuntimeManagerPort<GenerationKey>,
	"retire"
>;

export interface McpRuntimeOwnershipOptions<GenerationKey> {
	readonly manager: McpRuntimeRetirementPort<GenerationKey>;
	/** Hard bound over live owner capabilities. */
	readonly maxOwners?: number;
	/** Hard bound over active generations and retained retirement fences. */
	readonly maxGenerations?: number;
	/** Hard bound over distinct owner-to-generation references. */
	readonly maxReferences?: number;
}

export interface McpRuntimeOwner<GenerationKey> extends AsyncDisposable {
	readonly released: boolean;
	/** Retains after any older retirement barrier settles; concurrent duplicates share one task. */
	retain(generationKey: GenerationKey): Promise<void>;
	/** Releases every retained generation. Repeated calls share one settlement. */
	release(): Promise<void>;
}

/** Aggregate diagnostics deliberately omit generation keys and manager failures. */
export interface McpRuntimeOwnershipSnapshot {
	readonly maxOwners: number;
	readonly maxGenerations: number;
	readonly maxReferences: number;
	readonly ownerCount: number;
	readonly generationCount: number;
	readonly referenceCount: number;
	readonly pendingReferenceCount: number;
	readonly retiringGenerationCount: number;
	readonly fencedGenerationCount: number;
}

type GenerationPhase = "active" | "retiring" | "retired" | "retirement-failed";

interface GenerationEntry<GenerationKey> {
	readonly key: GenerationKey;
	readonly token: symbol;
	readonly owners: Set<ManagedMcpRuntimeOwner<GenerationKey>>;
	phase: GenerationPhase;
	/** Owners at or below this sequence can never reacquire after a forced retirement. */
	forceFenceThrough: number | undefined;
	retirementTask: Promise<void> | undefined;
}

/**
 * Bounded, framework-neutral cooperative ownership for opaque runtime generations.
 *
 * Equal keys use `Map` identity. The final cooperative release retires the manager generation.
 * `forceRetire` immediately revokes every current reference and permanently fences every owner
 * that existed when the force began. No retain can cross an unsettled retirement barrier.
 */
export class McpRuntimeOwnership<GenerationKey> {
	readonly #retireGeneration: (generationKey: GenerationKey) => Promise<void>;
	readonly #maxOwners: number;
	readonly #maxGenerations: number;
	readonly #maxReferences: number;
	readonly #owners = new Set<ManagedMcpRuntimeOwner<GenerationKey>>();
	readonly #generations = new Map<GenerationKey, GenerationEntry<GenerationKey>>();
	#referenceCount = 0;
	#pendingReferenceCount = 0;
	#nextOwnerSequence = 0;

	constructor(options: McpRuntimeOwnershipOptions<GenerationKey>) {
		let manager: McpRuntimeRetirementPort<GenerationKey>;
		let retireGeneration: McpRuntimeRetirementPort<GenerationKey>["retire"];
		let maxOwners: number;
		let maxGenerations: number;
		let maxReferences: number;
		try {
			manager = options.manager;
			if ((typeof manager !== "object" && typeof manager !== "function") || manager === null) {
				throw invalidOptionsError();
			}
			retireGeneration = manager.retire;
			maxOwners = options.maxOwners ?? MCP_RUNTIME_OWNERSHIP_DEFAULTS.maxOwners;
			maxGenerations = options.maxGenerations ?? MCP_RUNTIME_OWNERSHIP_DEFAULTS.maxGenerations;
			maxReferences = options.maxReferences ?? MCP_RUNTIME_OWNERSHIP_DEFAULTS.maxReferences;
		} catch {
			throw invalidOptionsError();
		}
		if (
			typeof retireGeneration !== "function" ||
			!isPositiveSafeInteger(maxOwners) ||
			!isPositiveSafeInteger(maxGenerations) ||
			!isPositiveSafeInteger(maxReferences)
		) {
			throw invalidOptionsError();
		}
		this.#retireGeneration = (generationKey) => retireGeneration.call(manager, generationKey);
		this.#maxOwners = maxOwners;
		this.#maxGenerations = maxGenerations;
		this.#maxReferences = maxReferences;
	}

	createOwner(): McpRuntimeOwner<GenerationKey> {
		if (
			this.#owners.size >= this.#maxOwners ||
			this.#nextOwnerSequence >= Number.MAX_SAFE_INTEGER
		) {
			throw capacityExceededError();
		}
		this.#nextOwnerSequence += 1;
		let owner: ManagedMcpRuntimeOwner<GenerationKey>;
		owner = new ManagedMcpRuntimeOwner(
			this.#nextOwnerSequence,
			(generationKey) => this.#retain(owner, generationKey),
			() => this.#release(owner),
		);
		this.#owners.add(owner);
		return Object.freeze(owner);
	}

	/**
	 * Retires a generation regardless of cooperative references.
	 * Repeated calls against the same generation barrier share one settlement.
	 */
	forceRetire(generationKey: GenerationKey): Promise<void> {
		let entry = this.#generations.get(generationKey);
		if (entry !== undefined && entry.phase !== "active") {
			// Every force call is a new linearization point. An owner created after
			// an earlier force but before this call must be fenced by this call even
			// when both callers share the same unsettled retirement barrier.
			entry.forceFenceThrough = Math.max(entry.forceFenceThrough ?? 0, this.#nextOwnerSequence);
			return requireRetirementTask(entry);
		}

		if (entry === undefined) {
			this.#pruneReusableFences();
			if (this.#generations.size >= this.#maxGenerations) {
				return Promise.reject(capacityExceededError());
			}
			entry = this.#createGeneration(generationKey);
		}

		entry.forceFenceThrough = Math.max(entry.forceFenceThrough ?? 0, this.#nextOwnerSequence);
		for (const owner of entry.owners) {
			owner.dropRetainedGeneration(generationKey);
			this.#referenceCount -= 1;
		}
		entry.owners.clear();
		return this.#startRetirement(entry);
	}

	snapshot(): McpRuntimeOwnershipSnapshot {
		let retiringGenerationCount = 0;
		let fencedGenerationCount = 0;
		for (const entry of this.#generations.values()) {
			if (entry.phase === "retiring") retiringGenerationCount += 1;
			if (entry.phase === "retirement-failed" || entry.forceFenceThrough !== undefined) {
				fencedGenerationCount += 1;
			}
		}
		return Object.freeze({
			maxOwners: this.#maxOwners,
			maxGenerations: this.#maxGenerations,
			maxReferences: this.#maxReferences,
			ownerCount: this.#owners.size,
			generationCount: this.#generations.size,
			referenceCount: this.#referenceCount,
			pendingReferenceCount: this.#pendingReferenceCount,
			retiringGenerationCount,
			fencedGenerationCount,
		});
	}

	#retain(
		owner: ManagedMcpRuntimeOwner<GenerationKey>,
		generationKey: GenerationKey,
	): Promise<void> {
		if (owner.released) return Promise.reject(ownerReleasedError());
		if (owner.hasRetainedGeneration(generationKey)) return Promise.resolve();
		if (this.#referenceCount + this.#pendingReferenceCount >= this.#maxReferences) {
			return Promise.reject(capacityExceededError());
		}

		const reservation = { pending: true };
		this.#pendingReferenceCount += 1;
		return this.#performRetain(owner, generationKey, reservation).catch((error: unknown) => {
			if (reservation.pending) {
				reservation.pending = false;
				this.#pendingReferenceCount -= 1;
			}
			throw error;
		});
	}

	async #performRetain(
		owner: ManagedMcpRuntimeOwner<GenerationKey>,
		generationKey: GenerationKey,
		reservation: { pending: boolean },
	): Promise<void> {
		for (;;) {
			if (owner.released) throw ownerReleasedError();
			let entry = this.#generations.get(generationKey);
			if (entry?.phase === "retiring") {
				await waitForRetirementBarrier(requireRetirementTask(entry), owner.releaseSignal);
				continue;
			}
			if (owner.released) throw ownerReleasedError();

			if (entry !== undefined) {
				if (entry.phase === "retirement-failed") throw generationFencedError();
				if (entry.phase === "retired") {
					const forceFenceThrough = entry.forceFenceThrough;
					if (forceFenceThrough === undefined || owner.sequence <= forceFenceThrough) {
						throw generationFencedError();
					}
					entry = this.#replaceRetiredGeneration(entry);
				} else if (
					entry.forceFenceThrough !== undefined &&
					owner.sequence <= entry.forceFenceThrough
				) {
					throw generationFencedError();
				}
			} else {
				this.#pruneReusableFences();
				if (this.#generations.size >= this.#maxGenerations) throw capacityExceededError();
				entry = this.#createGeneration(generationKey);
			}

			if (owner.released) throw ownerReleasedError();
			entry.owners.add(owner);
			owner.addRetainedGeneration(generationKey);
			reservation.pending = false;
			this.#pendingReferenceCount -= 1;
			this.#referenceCount += 1;
			return;
		}
	}

	#release(owner: ManagedMcpRuntimeOwner<GenerationKey>): Promise<void> {
		this.#owners.delete(owner);
		const retirementTasks: Promise<void>[] = [];
		for (const generationKey of owner.takeRetainedGenerations()) {
			const entry = this.#generations.get(generationKey);
			if (entry === undefined || !entry.owners.delete(owner)) continue;
			this.#referenceCount -= 1;
			if (entry.owners.size === 0 && entry.phase === "active") {
				retirementTasks.push(this.#startRetirement(entry));
			}
		}
		this.#pruneReusableFences();
		return settleOwnerRelease(retirementTasks);
	}

	#createGeneration(generationKey: GenerationKey): GenerationEntry<GenerationKey> {
		const entry: GenerationEntry<GenerationKey> = {
			key: generationKey,
			token: Symbol("mcp-runtime-ownership-generation"),
			owners: new Set(),
			phase: "active",
			forceFenceThrough: undefined,
			retirementTask: undefined,
		};
		this.#generations.set(generationKey, entry);
		return entry;
	}

	#replaceRetiredGeneration(
		retired: GenerationEntry<GenerationKey>,
	): GenerationEntry<GenerationKey> {
		const replacement: GenerationEntry<GenerationKey> = {
			key: retired.key,
			token: Symbol("mcp-runtime-ownership-generation"),
			owners: new Set(),
			phase: "active",
			forceFenceThrough: retired.forceFenceThrough,
			retirementTask: undefined,
		};
		this.#generations.set(retired.key, replacement);
		return replacement;
	}

	#startRetirement(entry: GenerationEntry<GenerationKey>): Promise<void> {
		if (entry.retirementTask !== undefined) return entry.retirementTask;
		entry.phase = "retiring";
		const task = Promise.resolve()
			.then(() => this.#retireGeneration(entry.key))
			.then(
				() => this.#settleRetirementSuccess(entry),
				(error: unknown) => {
					if (isManagerClosedError(error)) {
						this.#settleRetirementSuccess(entry);
						return;
					}
					entry.phase = "retirement-failed";
					throw retirementFailedError();
				},
			);
		entry.retirementTask = task;
		return task;
	}

	#settleRetirementSuccess(entry: GenerationEntry<GenerationKey>): void {
		entry.phase = "retired";
		if (this.#generations.get(entry.key)?.token !== entry.token) return;
		if (entry.forceFenceThrough === undefined || !this.#hasFencedOwner(entry.forceFenceThrough)) {
			this.#generations.delete(entry.key);
		}
	}

	#pruneReusableFences(): void {
		for (const [generationKey, entry] of this.#generations) {
			if (
				entry.phase === "retired" &&
				entry.forceFenceThrough !== undefined &&
				!this.#hasFencedOwner(entry.forceFenceThrough)
			) {
				this.#generations.delete(generationKey);
			}
		}
	}

	#hasFencedOwner(fenceThrough: number): boolean {
		for (const owner of this.#owners) {
			if (owner.sequence <= fenceThrough) return true;
		}
		return false;
	}
}

class ManagedMcpRuntimeOwner<GenerationKey> implements McpRuntimeOwner<GenerationKey> {
	readonly #releaseController = new AbortController();
	readonly #retainGeneration: (generationKey: GenerationKey) => Promise<void>;
	readonly #releaseOwner: () => Promise<void>;
	readonly #retainedGenerations = new Set<GenerationKey>();
	readonly #retentionTasks = new Map<GenerationKey, Promise<void>>();
	readonly sequence: number;
	#releaseStarted = false;
	#releaseTask: Promise<void> | undefined;

	constructor(
		sequence: number,
		retainGeneration: (generationKey: GenerationKey) => Promise<void>,
		releaseOwner: () => Promise<void>,
	) {
		this.sequence = sequence;
		this.#retainGeneration = retainGeneration;
		this.#releaseOwner = releaseOwner;
	}

	get released(): boolean {
		return this.#releaseStarted;
	}

	get releaseSignal(): AbortSignal {
		return this.#releaseController.signal;
	}

	retain(generationKey: GenerationKey): Promise<void> {
		if (this.#releaseStarted) return Promise.reject(ownerReleasedError());
		const existing = this.#retentionTasks.get(generationKey);
		if (existing !== undefined) return existing;
		const task = this.#retainGeneration(generationKey);
		this.#retentionTasks.set(generationKey, task);
		void task.catch(() => {
			if (this.#retentionTasks.get(generationKey) === task) {
				this.#retentionTasks.delete(generationKey);
			}
		});
		return task;
	}

	release(): Promise<void> {
		if (this.#releaseTask === undefined) {
			this.#releaseStarted = true;
			this.#releaseController.abort();
			try {
				this.#releaseTask = this.#releaseOwner();
			} catch (error) {
				this.#releaseTask = Promise.reject(error);
			}
		}
		return this.#releaseTask;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.release();
	}

	hasRetainedGeneration(generationKey: GenerationKey): boolean {
		return this.#retainedGenerations.has(generationKey);
	}

	addRetainedGeneration(generationKey: GenerationKey): void {
		this.#retainedGenerations.add(generationKey);
	}

	dropRetainedGeneration(generationKey: GenerationKey): void {
		this.#retainedGenerations.delete(generationKey);
		this.#retentionTasks.delete(generationKey);
	}

	takeRetainedGenerations(): readonly GenerationKey[] {
		const retained = [...this.#retainedGenerations];
		this.#retainedGenerations.clear();
		for (const generationKey of retained) this.#retentionTasks.delete(generationKey);
		return retained;
	}
}

function settleOwnerRelease(tasks: readonly Promise<void>[]): Promise<void> {
	if (tasks.length === 0) return Promise.resolve();
	return Promise.allSettled(tasks).then((settled) => {
		const failures = settled.flatMap((result) =>
			result.status === "rejected" ? [result.reason as unknown] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(failures, "One or more MCP runtime generations failed to retire.");
		}
	});
}

function requireRetirementTask<GenerationKey>(
	entry: GenerationEntry<GenerationKey>,
): Promise<void> {
	if (entry.retirementTask === undefined) {
		throw new Error("The MCP runtime ownership retirement task is missing.");
	}
	return entry.retirementTask;
}

function waitForRetirementBarrier(task: Promise<void>, releaseSignal: AbortSignal): Promise<void> {
	if (releaseSignal.aborted) return Promise.reject(ownerReleasedError());
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (released: boolean): void => {
			if (settled) return;
			settled = true;
			releaseSignal.removeEventListener("abort", onRelease);
			if (released) reject(ownerReleasedError());
			else resolve();
		};
		const onRelease = (): void => finish(true);
		releaseSignal.addEventListener("abort", onRelease, { once: true });
		void task.then(
			() => finish(false),
			() => finish(false),
		);
	});
}

function isPositiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function isManagerClosedError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	try {
		return Reflect.get(error, "code") === MCP_RUNTIME_MANAGER_CLOSED;
	} catch {
		return false;
	}
}

function invalidOptionsError(): McpRuntimeOwnershipError {
	return new McpRuntimeOwnershipError(
		MCP_RUNTIME_OWNERSHIP_INVALID_OPTIONS,
		"The MCP runtime ownership options are invalid.",
	);
}

function capacityExceededError(): McpRuntimeOwnershipError {
	return new McpRuntimeOwnershipError(
		MCP_RUNTIME_OWNERSHIP_CAPACITY_EXCEEDED,
		"The MCP runtime ownership coordinator is at its configured capacity.",
	);
}

function ownerReleasedError(): McpRuntimeOwnershipError {
	return new McpRuntimeOwnershipError(
		MCP_RUNTIME_OWNER_RELEASED,
		"The MCP runtime owner has already been released.",
	);
}

function generationFencedError(): McpRuntimeOwnershipError {
	return new McpRuntimeOwnershipError(
		MCP_RUNTIME_GENERATION_FENCED,
		"The MCP runtime generation is fenced from this owner.",
	);
}

function retirementFailedError(): McpRuntimeOwnershipError {
	return new McpRuntimeOwnershipError(
		MCP_RUNTIME_RETIREMENT_FAILED,
		"The MCP runtime generation failed to retire.",
	);
}
