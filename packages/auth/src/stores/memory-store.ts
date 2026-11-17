import { McpOAuthConfigError } from "../mcp-oauth.errors.ts";
import type {
	McpOAuthStore,
	McpOAuthStoreMaintenance,
	McpOAuthStoreWriteOptions,
} from "./store.types.ts";

export interface McpMemoryOAuthStoreOptions {
	/** Total record bound. Overflow rejects the write; live records are never evicted. */
	readonly maxEntries?: number;
	/**
	 * Per-kind sub-caps keyed by the second `:`-separated key segment (the
	 * record kind in `nest-mcp.oauth.v1:{issuer}:{kind}:{id}` keys), so flooding
	 * one artifact kind cannot exhaust capacity for the others.
	 */
	readonly maxEntriesPerKind?: Readonly<Record<string, number>>;
	/** Interval between expiry sweeps. The timer never keeps the process alive. */
	readonly sweepIntervalMs?: number;
	/** Injectable clock for tests. */
	readonly now?: () => number;
}

/** Raised when a bounded write is rejected; map to OAuth `temporarily_unavailable`. */
export class McpOAuthStoreCapacityError extends Error {
	readonly code = "MCP_OAUTH_STORE_CAPACITY";

	constructor(message: string) {
		super(message);
		this.name = "McpOAuthStoreCapacityError";
	}
}

interface StoredRecord {
	readonly value: string;
	readonly expiresAt: number;
	readonly kind: string;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Bounded in-process store for development and single-node deployments.
 * Overflow rejects the write rather than evicting: silently dropping a live
 * authorization artifact presents as unexplained login failures.
 */
export class McpMemoryOAuthStore implements McpOAuthStore, McpOAuthStoreMaintenance {
	readonly #records = new Map<string, StoredRecord>();
	readonly #kindCounts = new Map<string, number>();
	readonly #maxEntries: number;
	readonly #maxEntriesPerKind: ReadonlyMap<string, number>;
	readonly #now: () => number;
	#sweepTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options?: McpMemoryOAuthStoreOptions) {
		this.#maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
		if (!Number.isInteger(this.#maxEntries) || this.#maxEntries <= 0) {
			throw new McpOAuthConfigError(
				"INVALID_OPTIONS",
				"McpMemoryOAuthStore maxEntries must be a positive integer.",
			);
		}
		const perKind = new Map<string, number>();
		for (const [kind, bound] of Object.entries(options?.maxEntriesPerKind ?? {})) {
			if (!Number.isInteger(bound) || bound <= 0) {
				throw new McpOAuthConfigError(
					"INVALID_OPTIONS",
					`McpMemoryOAuthStore maxEntriesPerKind["${kind}"] must be a positive integer.`,
				);
			}
			perKind.set(kind, bound);
		}
		this.#maxEntriesPerKind = perKind;
		this.#now = options?.now ?? Date.now;
		const sweepIntervalMs = options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
		if (options?.now === undefined) {
			this.#sweepTimer = setInterval(() => void this.sweep(), sweepIntervalMs);
			this.#sweepTimer.unref?.();
		}
	}

	// Methods are async so any synchronous validation/capacity throw surfaces as
	// a rejected promise, matching the async McpOAuthStore contract.

	async get(key: string): Promise<string | undefined> {
		return this.#liveRecord(key)?.value;
	}

	async set(key: string, value: string, options: McpOAuthStoreWriteOptions): Promise<void> {
		this.#write(key, value, options);
	}

	async setIfAbsent(
		key: string,
		value: string,
		options: McpOAuthStoreWriteOptions,
	): Promise<boolean> {
		if (this.#liveRecord(key) !== undefined) return false;
		this.#write(key, value, options);
		return true;
	}

	async take(key: string): Promise<string | undefined> {
		const record = this.#liveRecord(key);
		if (record !== undefined) this.#remove(key, record);
		return record?.value;
	}

	async delete(key: string): Promise<void> {
		const record = this.#records.get(key);
		if (record !== undefined) this.#remove(key, record);
	}

	async sweep(): Promise<void> {
		const now = this.#now();
		for (const [key, record] of this.#records) {
			if (record.expiresAt <= now) this.#remove(key, record);
		}
	}

	/** Stops the background sweep timer; records stay readable until expiry. */
	close(): void {
		if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer);
		this.#sweepTimer = undefined;
	}

	get size(): number {
		return this.#records.size;
	}

	#write(key: string, value: string, options: McpOAuthStoreWriteOptions): void {
		assertTtl(options);
		const kind = kindOf(key);
		const existing = this.#records.get(key);
		if (existing === undefined) {
			if (this.#records.size >= this.#maxEntries) {
				this.#evictExpired();
				if (this.#records.size >= this.#maxEntries) {
					throw new McpOAuthStoreCapacityError("MCP OAuth memory store is at capacity.");
				}
			}
			const kindBound = this.#maxEntriesPerKind.get(kind);
			if (kindBound !== undefined && (this.#kindCounts.get(kind) ?? 0) >= kindBound) {
				this.#evictExpired();
				if ((this.#kindCounts.get(kind) ?? 0) >= kindBound) {
					throw new McpOAuthStoreCapacityError(
						`MCP OAuth memory store is at capacity for "${kind}" records.`,
					);
				}
			}
		} else {
			this.#remove(key, existing);
		}
		this.#records.set(key, {
			value,
			kind,
			expiresAt: this.#now() + options.ttlSeconds * 1_000,
		});
		this.#kindCounts.set(kind, (this.#kindCounts.get(kind) ?? 0) + 1);
	}

	#liveRecord(key: string): StoredRecord | undefined {
		const record = this.#records.get(key);
		if (record === undefined) return undefined;
		if (record.expiresAt <= this.#now()) {
			this.#remove(key, record);
			return undefined;
		}
		return record;
	}

	#remove(key: string, record: StoredRecord): void {
		this.#records.delete(key);
		const count = (this.#kindCounts.get(record.kind) ?? 1) - 1;
		if (count <= 0) this.#kindCounts.delete(record.kind);
		else this.#kindCounts.set(record.kind, count);
	}

	#evictExpired(): void {
		const now = this.#now();
		for (const [key, record] of this.#records) {
			if (record.expiresAt <= now) this.#remove(key, record);
		}
	}
}

function assertTtl(options: McpOAuthStoreWriteOptions): void {
	if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
		throw new McpOAuthConfigError(
			"INVALID_OPTIONS",
			"MCP OAuth store writes require a positive ttlSeconds.",
		);
	}
}

function kindOf(key: string): string {
	const segments = key.split(":");
	return segments.length >= 3 ? (segments[2] ?? "") : "";
}
