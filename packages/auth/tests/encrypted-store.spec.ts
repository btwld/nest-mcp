import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	McpMemoryOAuthStore,
	McpOAuthStoreDecryptError,
	withEncryptedValues,
} from "../src/stores/index.ts";

const KEY_A = { id: "k1", secret: randomBytes(32) };
const KEY_B = { id: "k2", secret: randomBytes(32) };
const RECORD_KEY = "nest-mcp.oauth.v1:issuer:grant:g1";

describe("withEncryptedValues", () => {
	it("round-trips values and stores only ciphertext at rest", async () => {
		const inner = new McpMemoryOAuthStore({ now: () => 0 });
		const store = withEncryptedValues(inner, { keys: [KEY_A] });
		await store.set(RECORD_KEY, "sensitive-value", { ttlSeconds: 60 });
		expect(await store.get(RECORD_KEY)).toBe("sensitive-value");
		const raw = await inner.get(RECORD_KEY);
		expect(raw).toMatch(/^v1\.k1\./);
		expect(raw).not.toContain("sensitive-value");
	});

	it("treats an AAD-mismatched (relocated) record as missing", async () => {
		const inner = new McpMemoryOAuthStore({ now: () => 0 });
		const store = withEncryptedValues(inner, { keys: [KEY_A] });
		await store.set(RECORD_KEY, "value-for-g1", { ttlSeconds: 60 });
		const envelope = await inner.get(RECORD_KEY);
		if (envelope === undefined) throw new Error("Expected a stored envelope.");
		// Move the ciphertext under a different storage key: the AAD binding breaks.
		const otherKey = "nest-mcp.oauth.v1:issuer:grant:g2";
		await inner.set(otherKey, envelope, { ttlSeconds: 60 });
		const onFail = vi.fn();
		const guarded = withEncryptedValues(inner, { keys: [KEY_A], onDecryptFailure: onFail });
		expect(await guarded.get(otherKey)).toBeUndefined();
		expect(onFail).toHaveBeenCalledWith(otherKey);
	});

	it("decrypts under key rotation and never falls back to plaintext for unknown keys", async () => {
		const inner = new McpMemoryOAuthStore({ now: () => 0 });
		// Written under k1.
		await withEncryptedValues(inner, { keys: [KEY_A] }).set(RECORD_KEY, "v", { ttlSeconds: 60 });
		// k2 active, k1 still present for decrypt.
		const rotated = withEncryptedValues(inner, { keys: [KEY_B, KEY_A] });
		expect(await rotated.get(RECORD_KEY)).toBe("v");
		// A ring without k1 cannot read the k1-encrypted record.
		const onFail = vi.fn();
		const onlyB = withEncryptedValues(inner, { keys: [KEY_B], onDecryptFailure: onFail });
		expect(await onlyB.get(RECORD_KEY)).toBeUndefined();
		expect(onFail).toHaveBeenCalled();
	});

	it("preserves take single-use semantics through the decorator", async () => {
		const inner = new McpMemoryOAuthStore({ now: () => 0 });
		const store = withEncryptedValues(inner, { keys: [KEY_A] });
		await store.set(RECORD_KEY, "one-shot", { ttlSeconds: 60 });
		expect(await store.take(RECORD_KEY)).toBe("one-shot");
		expect(await store.take(RECORD_KEY)).toBeUndefined();
	});

	it("rejects a truncated authentication tag", async () => {
		const inner = new McpMemoryOAuthStore({ now: () => 0 });
		await withEncryptedValues(inner, { keys: [KEY_A] }).set(RECORD_KEY, "v", { ttlSeconds: 60 });
		const envelope = (await inner.get(RECORD_KEY)) ?? "";
		const [version, keyId, iv, , ciphertext] = envelope.split(".");
		// Forge a 4-byte tag: must be rejected outright (length pinned to 16).
		const shortTag = Buffer.alloc(4).toString("base64url");
		await inner.set(RECORD_KEY, [version, keyId, iv, shortTag, ciphertext].join("."), {
			ttlSeconds: 60,
		});
		expect(await withEncryptedValues(inner, { keys: [KEY_A] }).get(RECORD_KEY)).toBeUndefined();
	});

	it("fails closed in strict mode when a present record cannot be decrypted", async () => {
		const inner = new McpMemoryOAuthStore({ now: () => 0 });
		await withEncryptedValues(inner, { keys: [KEY_A] }).set(RECORD_KEY, "v", { ttlSeconds: 60 });
		// A ring without k1 cannot decrypt; strict mode raises instead of "missing".
		const strict = withEncryptedValues(inner, { keys: [KEY_B], strict: true });
		await expect(strict.get(RECORD_KEY)).rejects.toBeInstanceOf(McpOAuthStoreDecryptError);
		// Absent keys still read as undefined (not present ⇒ no failure).
		expect(await strict.get("nest-mcp.oauth.v1:i:grant:absent")).toBeUndefined();
	});

	it("rejects short secrets and duplicate/invalid key ids", () => {
		expect(() =>
			withEncryptedValues(new McpMemoryOAuthStore({ now: () => 0 }), { keys: [] }),
		).toThrowError(/at least one/);
		expect(() =>
			withEncryptedValues(new McpMemoryOAuthStore({ now: () => 0 }), {
				keys: [{ id: "x", secret: randomBytes(16) }],
			}),
		).toThrowError(/at least 32 bytes/);
		expect(() =>
			withEncryptedValues(new McpMemoryOAuthStore({ now: () => 0 }), {
				keys: [KEY_A, { id: "k1", secret: randomBytes(32) }],
			}),
		).toThrowError(/Duplicate/);
		expect(() =>
			withEncryptedValues(new McpMemoryOAuthStore({ now: () => 0 }), {
				keys: [{ id: "bad.id", secret: randomBytes(32) }],
			}),
		).toThrowError(/without a dot/);
	});
});
