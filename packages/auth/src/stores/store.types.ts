export type MaybePromise<T> = T | PromiseLike<T>;

export interface McpOAuthStoreWriteOptions {
	/** Mandatory TTL, passed at write so a Redis adapter maps to `SET k v EX ttl`. */
	readonly ttlSeconds: number;
}

/**
 * Storage contract for OAuth artifacts (authorization transactions, codes,
 * grants, refresh handles, consent records, CIMD cache entries).
 *
 * Values are already-serialized (and, when configured, already-encrypted)
 * strings. Every operation maps onto a single Redis primitive so a
 * distributed adapter needs no API change: `get`→GET, `set`→SET EX,
 * `setIfAbsent`→SET NX EX, `take`→GETDEL, `delete`→DEL. There are no
 * scan/list operations by design.
 *
 * `take` is REQUIRED and must be atomic: single-use artifacts (authorization
 * codes, refresh handles) rely on exactly-once redemption. Implementations
 * must never degrade `take` to a get-then-delete.
 */
export interface McpOAuthStore {
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string, options: McpOAuthStoreWriteOptions): Promise<void>;
	/** Returns false when the key already exists. Backs single-use tombstones. */
	setIfAbsent(key: string, value: string, options: McpOAuthStoreWriteOptions): Promise<boolean>;
	/** Atomically read and delete. Returns undefined for missing or expired keys. */
	take(key: string): Promise<string | undefined>;
	delete(key: string): Promise<void>;
}

/** Optional local-store maintenance face; distributed stores expire natively. */
export interface McpOAuthStoreMaintenance {
	sweep(): Promise<void>;
}
