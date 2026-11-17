import {
	MCP_RUNTIME_CAPACITY_EXCEEDED,
	MCP_RUNTIME_QUEUE_FULL,
	McpRuntimeManagerError,
	runtimeLeaseModeConflictError,
	runtimeQuarantinedError,
} from "./errors.ts";
import type { McpRuntimeOperationLeaseMode } from "./types.ts";

interface Admission<GenerationKey> {
	readonly generationKey: GenerationKey;
	readonly key: string | undefined;
	readonly mode: McpRuntimeOperationLeaseMode;
	readonly limit: number | null;
}

interface Waiter<GenerationKey> {
	readonly admission: Admission<GenerationKey>;
	reserve(): boolean;
	grant(): void;
	reject(error: unknown): void;
}

/** Atomic process-local admission; transports and their cleanup remain owned by the manager. */
export class OperationAdmission<GenerationKey> {
	readonly #active = new Set<Admission<GenerationKey>>();
	readonly #waiters = new Set<Waiter<GenerationKey>>();
	readonly #quarantined = new Set<Admission<GenerationKey>>();
	readonly #lastGranted = new Map<string | GenerationKey, number>();
	#sequence = 0;
	#draining = false;

	constructor(
		readonly maxOperations: number,
		readonly maxConcurrentOperations: number | null,
	) {}

	get size(): number {
		return this.#waiters.size;
	}

	hasIsolatedGeneration(generationKey: GenerationKey): boolean {
		return [...this.#active].some(
			(active) => active.generationKey === generationKey && active.mode !== "shared",
		);
	}

	async enter(
		generationKey: GenerationKey,
		mode: McpRuntimeOperationLeaseMode,
		key: string | undefined,
		queue: boolean,
		signal: AbortSignal,
		limit: number | null | undefined,
		reserve: () => boolean,
	): Promise<(quarantine: boolean) => void> {
		const admission = {
			generationKey,
			mode,
			key,
			limit: limit === undefined ? this.maxConcurrentOperations : limit,
		};
		signal.throwIfAborted();
		this.#assertNotQuarantined(admission);
		const conflicts = [...this.#active].filter((active) => this.#related(active, admission));
		// Retained/shared runtimes never participate in isolated admission waiting.
		if (conflicts.some((active) => active.mode === "shared" && mode !== "shared")) {
			throw runtimeLeaseModeConflictError();
		}
		if (queue) this.drain();
		if (this.#available(admission) && reserve()) {
			this.#active.add(admission);
			this.#lastGranted.set(key ?? generationKey, this.#sequence++);
		} else if (queue) {
			if (this.#waiters.size >= this.maxOperations)
				throw new McpRuntimeManagerError(
					MCP_RUNTIME_QUEUE_FULL,
					"The MCP operation admission queue is full.",
				);
			await new Promise<void>((resolve, reject) => {
				const remove = (): void => {
					this.#waiters.delete(waiter);
					signal.removeEventListener("abort", abort);
				};
				const waiter: Waiter<GenerationKey> = {
					admission,
					reserve,
					grant: () => {
						remove();
						resolve();
					},
					reject: (error) => {
						remove();
						reject(error);
					},
				};
				const abort = (): void => {
					waiter.reject(signal.reason);
					this.drain();
				};
				this.#waiters.add(waiter);
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
				else this.drain();
			});
		} else {
			throw this.#available(admission) || mode === "concurrent"
				? this.#capacityError()
				: runtimeLeaseModeConflictError();
		}
		let released = false;
		return (quarantine) => {
			if (released) return;
			released = true;
			if (quarantine) this.#quarantined.add(admission);
			this.#active.delete(admission);
			this.drain();
		};
	}

	rejectGeneration(generationKey: GenerationKey, reason: unknown): void {
		for (const waiter of this.#waiters) {
			if (waiter.admission.generationKey === generationKey) waiter.reject(reason);
		}
		this.drain();
	}

	rejectAll(reason: unknown): void {
		for (const waiter of this.#waiters) waiter.reject(reason);
	}

	#related(left: Admission<GenerationKey>, right: Admission<GenerationKey>): boolean {
		return (
			left.generationKey === right.generationKey ||
			(left.key !== undefined && left.key === right.key)
		);
	}

	#available(admission: Admission<GenerationKey>, pending?: Waiter<GenerationKey>): boolean {
		for (const waiter of this.#waiters) {
			if (waiter === pending) break;
			if (this.#related(waiter.admission, admission)) return false;
		}
		let count = 0;
		let ceiling = admission.limit ?? Number.POSITIVE_INFINITY;
		for (const active of this.#active) {
			if (!this.#related(active, admission)) continue;
			if (active.mode === "shared" && admission.mode === "shared") continue;
			if (
				active.mode !== "concurrent" ||
				admission.mode !== "concurrent" ||
				active.key !== admission.key
			)
				return false;
			count += 1;
			ceiling = Math.min(ceiling, active.limit ?? Number.POSITIVE_INFINITY);
		}
		return count < ceiling;
	}

	#assertNotQuarantined(admission: Admission<GenerationKey>): void {
		for (const failed of this.#quarantined) {
			if (this.#related(failed, admission)) throw runtimeQuarantinedError();
		}
	}

	/** Woken only when connector admission or the authoritative transport ledger changes. */
	drain(): void {
		if (this.#draining) return;
		this.#draining = true;
		try {
			while (this.#waiters.size > 0) {
				const keys = [
					...new Set(
						[...this.#waiters].map(({ admission }) => admission.key ?? admission.generationKey),
					),
				];
				const ordered = keys.toSorted(
					(left, right) =>
						(this.#lastGranted.get(left) ?? -1) - (this.#lastGranted.get(right) ?? -1),
				);
				let granted = false;
				for (const key of ordered) {
					const waiter = [...this.#waiters].find(
						({ admission }) => (admission.key ?? admission.generationKey) === key,
					);
					if (waiter === undefined) continue;
					try {
						this.#assertNotQuarantined(waiter.admission);
						if (!this.#available(waiter.admission, waiter) || !waiter.reserve()) continue;
					} catch (error) {
						waiter.reject(error);
						granted = true;
						continue;
					}
					// Reservation charges the transport ledger synchronously, before resuming the caller.
					this.#active.add(waiter.admission);
					this.#lastGranted.set(key, this.#sequence++);
					waiter.grant();
					granted = true;
				}
				if (!granted) break;
			}
		} finally {
			this.#draining = false;
			const retained = new Set(
				[...this.#active, ...[...this.#waiters].map(({ admission }) => admission)].map(
					(admission) => admission.key ?? admission.generationKey,
				),
			);
			for (const key of this.#lastGranted.keys())
				if (!retained.has(key)) this.#lastGranted.delete(key);
		}
	}

	#capacityError(): McpRuntimeManagerError {
		return new McpRuntimeManagerError(
			MCP_RUNTIME_CAPACITY_EXCEEDED,
			"The MCP runtime manager has no compatible operation capacity.",
		);
	}
}
