import { readdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpDiskOAuthStore } from "../src/stores/index.ts";

describe("McpDiskOAuthStore", () => {
	let dir: string;
	let clock: number;
	let store: McpDiskOAuthStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "nest-mcp-oauth-disk-"));
		clock = 1_000;
		store = new McpDiskOAuthStore({ directory: dir, now: () => clock });
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("round-trips values and expires by TTL", async () => {
		await store.set("nest-mcp.oauth.v1:i:grant:g1", "value", { ttlSeconds: 10 });
		expect(await store.get("nest-mcp.oauth.v1:i:grant:g1")).toBe("value");
		clock += 10_001;
		expect(await store.get("nest-mcp.oauth.v1:i:grant:g1")).toBeUndefined();
	});

	it("takes each record atomically exactly once under contention", async () => {
		await store.set("nest-mcp.oauth.v1:i:code:c1", "one-shot", { ttlSeconds: 60 });
		const results = await Promise.all(
			Array.from({ length: 20 }, async () => store.take("nest-mcp.oauth.v1:i:code:c1")),
		);
		expect(results.filter((value) => value === "one-shot")).toHaveLength(1);
		expect(results.filter((value) => value === undefined)).toHaveLength(19);
	});

	it("setIfAbsent refuses a live record and replaces an expired one", async () => {
		expect(await store.setIfAbsent("k", "first", { ttlSeconds: 5 })).toBe(true);
		expect(await store.setIfAbsent("k", "second", { ttlSeconds: 5 })).toBe(false);
		expect(await store.get("k")).toBe("first");
		clock += 6_000;
		expect(await store.setIfAbsent("k", "third", { ttlSeconds: 5 })).toBe(true);
		expect(await store.get("k")).toBe("third");
	});

	it("maps distinct keys to distinct files (no sanitizer collisions)", async () => {
		await store.set("a/b:c", "x", { ttlSeconds: 60 });
		await store.set("a_b_c", "y", { ttlSeconds: 60 });
		expect(await store.get("a/b:c")).toBe("x");
		expect(await store.get("a_b_c")).toBe("y");
	});

	it("does not escape its directory for traversal-shaped keys", async () => {
		await store.set("../../etc/passwd", "trapped", { ttlSeconds: 60 });
		expect(await store.get("../../etc/passwd")).toBe("trapped");
	});

	it("setIfAbsent yields a single winner under concurrency", async () => {
		const results = await Promise.all(
			Array.from({ length: 25 }, async (_unused, index) =>
				store.setIfAbsent("contended", `writer-${String(index)}`, { ttlSeconds: 60 }),
			),
		);
		expect(results.filter((won) => won)).toHaveLength(1);
		// The surviving value belongs to the single winner.
		const stored = await store.get("contended");
		expect(stored).toMatch(/^writer-\d+$/);
	});

	it("creates owner-only files and directory", async () => {
		await store.set("k", "v", { ttlSeconds: 60 });
		const dirMode = (await stat(dir)).mode & 0o777;
		expect(dirMode & 0o077).toBe(0); // no group/other access
		const files = (await readdir(dir)).filter((name) => name.endsWith(".rec"));
		expect(files.length).toBeGreaterThan(0);
		for (const name of files) {
			const fileMode = (await stat(join(dir, name))).mode & 0o777;
			expect(fileMode & 0o077).toBe(0);
		}
	});

	it("sweeps expired records", async () => {
		await store.set("k1", "a", { ttlSeconds: 5 });
		await store.set("k2", "b", { ttlSeconds: 5_000 });
		clock += 6_000;
		await store.sweep();
		expect(await store.get("k1")).toBeUndefined();
		expect(await store.get("k2")).toBe("b");
	});
});
