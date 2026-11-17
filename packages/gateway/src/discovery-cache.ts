import { McpGatewayError } from "./mcp-gateway.errors.ts";
import type {
	McpGatewayDiscoveryCache,
	McpGatewayDiscoveryCacheKey,
	McpGatewayDiscoverySnapshot,
} from "./mcp-gateway.types.ts";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1_024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1_024 * 1_024;

interface CacheEntry {
	readonly snapshot: McpGatewayDiscoverySnapshot;
	readonly expiresAt: number;
	readonly byteSize: number;
}

export interface InMemoryMcpGatewayDiscoveryCacheOptions {
	readonly ttlMs?: number;
	readonly maxEntries?: number;
	/** Approximate UTF-8 JSON payload budget across all authorization contexts. */
	readonly maxTotalBytes?: number;
	readonly now?: () => number;
}

/** Authorization-scoped TTL/LRU discovery cache. It never stores bearer tokens. */
export class InMemoryMcpGatewayDiscoveryCache implements McpGatewayDiscoveryCache {
	readonly #entries = new Map<string, CacheEntry>();
	readonly #ttlMs: number;
	readonly #maxEntries: number;
	readonly #maxTotalBytes: number;
	readonly #now: () => number;
	#totalBytes = 0;

	constructor(options: InMemoryMcpGatewayDiscoveryCacheOptions = {}) {
		this.#ttlMs = positiveFinite(options.ttlMs ?? DEFAULT_TTL_MS, "ttlMs");
		this.#maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
		this.#maxTotalBytes = positiveInteger(
			options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
			"maxTotalBytes",
		);
		this.#now = options.now ?? Date.now;
	}

	get size(): number {
		this.prune();
		return this.#entries.size;
	}

	get byteSize(): number {
		this.prune();
		return this.#totalBytes;
	}

	get(key: McpGatewayDiscoveryCacheKey): McpGatewayDiscoverySnapshot | undefined {
		const serialized = serializeKey(key);
		const entry = this.#entries.get(serialized);
		if (entry === undefined) return undefined;
		if (entry.expiresAt <= this.#readNow()) {
			this.#deleteSerialized(serialized);
			return undefined;
		}

		// Refresh insertion order for bounded LRU eviction without extending TTL.
		this.#entries.delete(serialized);
		this.#entries.set(serialized, entry);
		return entry.snapshot;
	}

	set(key: McpGatewayDiscoveryCacheKey, snapshot: McpGatewayDiscoverySnapshot): void {
		const now = this.#readNow();
		const serialized = serializeKey(key);
		const immutableSnapshot = freezeMcpGatewayDiscoverySnapshot(snapshot);
		const byteSize = snapshotByteSize(immutableSnapshot);
		if (byteSize > this.#maxTotalBytes) {
			throw new McpGatewayError(
				"INVALID_DISCOVERY",
				"Discovery snapshot exceeds the in-memory cache byte budget.",
			);
		}
		this.prune(now);
		this.#deleteSerialized(serialized);
		this.#entries.set(serialized, {
			snapshot: immutableSnapshot,
			expiresAt: now + this.#ttlMs,
			byteSize,
		});
		this.#totalBytes += byteSize;
		while (this.#entries.size > this.#maxEntries || this.#totalBytes > this.#maxTotalBytes) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#deleteSerialized(oldest);
		}
	}

	delete(key: McpGatewayDiscoveryCacheKey): boolean {
		return this.#deleteSerialized(serializeKey(key));
	}

	clear(): void {
		this.#entries.clear();
		this.#totalBytes = 0;
	}

	prune(now = this.#readNow()): number {
		let deleted = 0;
		for (const [key, entry] of this.#entries) {
			if (entry.expiresAt <= now) {
				this.#deleteSerialized(key);
				deleted += 1;
			}
		}
		return deleted;
	}

	#deleteSerialized(key: string): boolean {
		const entry = this.#entries.get(key);
		if (entry === undefined) return false;
		this.#entries.delete(key);
		this.#totalBytes -= entry.byteSize;
		return true;
	}

	#readNow(): number {
		const now = this.#now();
		if (!Number.isFinite(now)) {
			throw new McpGatewayError("INVALID_OPTIONS", "Discovery cache clock must be finite.");
		}
		return now;
	}
}

function snapshotByteSize(snapshot: McpGatewayDiscoverySnapshot): number {
	const serialized = JSON.stringify(snapshot);
	if (serialized === undefined) {
		throw new McpGatewayError("INVALID_DISCOVERY", "Discovery snapshot is not serializable.");
	}
	return Buffer.byteLength(serialized, "utf8");
}

function serializeKey(key: McpGatewayDiscoveryCacheKey): string {
	assertNonEmpty(key.upstreamName, "key.upstreamName");
	assertNonEmpty(key.authorizationContext, "key.authorizationContext");
	return JSON.stringify([key.upstreamName, key.authorizationContext]);
}

export function freezeMcpGatewayDiscoverySnapshot(
	snapshot: McpGatewayDiscoverySnapshot,
): McpGatewayDiscoverySnapshot {
	if (!Number.isFinite(snapshot.discoveredAt)) {
		throw new McpGatewayError("INVALID_DISCOVERY", "Discovery timestamp must be finite.");
	}
	const tools = snapshot.tools.map((tool) => deepFreeze(structuredClone(tool)));
	const prompts = snapshot.prompts?.map((prompt) => deepFreeze(structuredClone(prompt)));
	const resources = snapshot.resources?.map((resource) => deepFreeze(structuredClone(resource)));
	const resourceTemplates = snapshot.resourceTemplates?.map((template) =>
		deepFreeze(structuredClone(template)),
	);
	return Object.freeze({
		tools: Object.freeze(tools),
		...(prompts === undefined ? {} : { prompts: Object.freeze(prompts) }),
		...(resources === undefined ? {} : { resources: Object.freeze(resources) }),
		...(resourceTemplates === undefined
			? {}
			: { resourceTemplates: Object.freeze(resourceTemplates) }),
		discoveredAt: snapshot.discoveredAt,
	});
}

function deepFreeze<Value>(value: Value, seen = new WeakSet<object>()): Value {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value)) deepFreeze(child, seen);
	return Object.freeze(value);
}

function positiveFinite(value: number, field: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new TypeError(`${field} must be a positive finite number.`);
	}
	return value;
}

function positiveInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${field} must be a positive safe integer.`);
	}
	return value;
}

function assertNonEmpty(value: string, field: string): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${field} must be a non-empty string.`);
	}
}
