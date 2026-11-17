import { describe, expect, it } from "vitest";
import { McpMemoryOAuthStore, McpOAuthStoreCapacityError } from "../src/stores/index.ts";

const KEY = "nest-mcp.oauth.v1:issuer:code:abc";

describe("McpMemoryOAuthStore", () => {
	it("expires records by TTL against the injected clock", async () => {
		let at = 0;
		const store = new McpMemoryOAuthStore({ now: () => at });
		await store.set(KEY, "value", { ttlSeconds: 10 });
		expect(await store.get(KEY)).toBe("value");
		at = 10_001;
		expect(await store.get(KEY)).toBeUndefined();
	});

	it("takes each record exactly once under contention", async () => {
		const store = new McpMemoryOAuthStore();
		await store.set(KEY, "one-shot", { ttlSeconds: 60 });
		const results = await Promise.all(Array.from({ length: 50 }, async () => store.take(KEY)));
		expect(results.filter((value) => value === "one-shot")).toHaveLength(1);
		expect(results.filter((value) => value === undefined)).toHaveLength(49);
		store.close();
	});

	it("setIfAbsent refuses to overwrite a live record", async () => {
		let at = 0;
		const store = new McpMemoryOAuthStore({ now: () => at });
		expect(await store.setIfAbsent(KEY, "first", { ttlSeconds: 5 })).toBe(true);
		expect(await store.setIfAbsent(KEY, "second", { ttlSeconds: 5 })).toBe(false);
		expect(await store.get(KEY)).toBe("first");
		at = 6_000;
		expect(await store.setIfAbsent(KEY, "third", { ttlSeconds: 5 })).toBe(true);
	});

	it("rejects writes at capacity instead of evicting live records", async () => {
		let at = 0;
		const store = new McpMemoryOAuthStore({ maxEntries: 2, now: () => at });
		await store.set("nest-mcp.oauth.v1:i:grant:1", "a", { ttlSeconds: 60 });
		await store.set("nest-mcp.oauth.v1:i:grant:2", "b", { ttlSeconds: 60 });
		await expect(
			store.set("nest-mcp.oauth.v1:i:grant:3", "c", { ttlSeconds: 60 }),
		).rejects.toBeInstanceOf(McpOAuthStoreCapacityError);
		expect(await store.get("nest-mcp.oauth.v1:i:grant:1")).toBe("a");
		// Expired records free capacity on the next write.
		at = 61_000;
		await store.set("nest-mcp.oauth.v1:i:grant:3", "c", { ttlSeconds: 60 });
		expect(await store.get("nest-mcp.oauth.v1:i:grant:3")).toBe("c");
	});

	it("enforces per-kind sub-caps so one artifact kind cannot starve the rest", async () => {
		const store = new McpMemoryOAuthStore({
			maxEntriesPerKind: { authz: 1 },
			now: () => 0,
		});
		await store.set("nest-mcp.oauth.v1:i:authz:1", "a", { ttlSeconds: 60 });
		await expect(
			store.set("nest-mcp.oauth.v1:i:authz:2", "b", { ttlSeconds: 60 }),
		).rejects.toBeInstanceOf(McpOAuthStoreCapacityError);
		await store.set("nest-mcp.oauth.v1:i:grant:1", "c", { ttlSeconds: 60 });
		expect(await store.get("nest-mcp.oauth.v1:i:grant:1")).toBe("c");
	});

	it("replacing a record never counts against capacity twice", async () => {
		const store = new McpMemoryOAuthStore({ maxEntries: 1, now: () => 0 });
		await store.set(KEY, "a", { ttlSeconds: 60 });
		await store.set(KEY, "b", { ttlSeconds: 60 });
		expect(await store.get(KEY)).toBe("b");
		expect(store.size).toBe(1);
	});

	it("rejects writes without a positive TTL", async () => {
		const store = new McpMemoryOAuthStore({ now: () => 0 });
		await expect(store.set(KEY, "a", { ttlSeconds: 0 })).rejects.toThrowError(
			/positive ttlSeconds/,
		);
	});
});
