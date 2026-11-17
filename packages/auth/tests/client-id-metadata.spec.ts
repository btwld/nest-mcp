import { describe, expect, it } from "vitest";
import {
	admitClientIdUrl,
	createMcpClientIdMetadataResolver,
	isBlockedDocumentAddress,
	isClientIdMetadataUrl,
	McpClientIdMetadataError,
	validateClientIdMetadataDocument,
} from "../src/cimd/index.ts";
import type { McpFetchedDocument, McpHttpDocumentFetcher } from "../src/cimd/index.ts";

const CLIENT_ID = "https://app.example.com/oauth/client.json";

function documentBody(overrides?: Record<string, unknown>): string {
	return JSON.stringify({
		client_id: CLIENT_ID,
		client_name: "Example App",
		redirect_uris: ["https://app.example.com/callback"],
		...overrides,
	});
}

function stubFetcher(
	respond: (url: URL) => McpFetchedDocument | Promise<McpFetchedDocument>,
): McpHttpDocumentFetcher & { readonly calls: URL[] } {
	const calls: URL[] = [];
	return {
		calls,
		fetchDocument: async (url) => {
			calls.push(url);
			return respond(url);
		},
	};
}

function jsonDocument(body: string, cacheControl?: string): McpFetchedDocument {
	return {
		status: 200,
		contentType: "application/json",
		cacheControl,
		body,
	};
}

describe("client_id URL admission", () => {
	const config = {};

	it.each([
		["http://app.example.com/client.json", "https scheme"],
		["https://app.example.com", "path component"],
		["https://app.example.com/", "path component"],
		["https://app.example.com/a/../client.json", "dot path segments"],
		["https://app.example.com/a/%2e%2e/client.json", "dot path segments"],
		["https://app.example.com/client.json#frag", "fragment"],
		["https://user:pw@app.example.com/client.json", "userinfo"],
		["https://app.example.com/client.json?v=1", "query"],
		[`https://app.example.com/${"x".repeat(600)}`, "length limit"],
		["not a url", "absolute URL"],
	])("rejects %s (%s)", (clientId, fragment) => {
		expect(() => admitClientIdUrl(clientId, config)).toThrowError(new RegExp(fragment));
	});

	it("rejects IP-literal hosts in blocked ranges before any fetch", () => {
		for (const clientId of [
			"https://169.254.169.254/client.json",
			"https://127.0.0.1/client.json",
			"https://10.0.0.8/client.json",
			"https://[::1]/client.json",
			"https://[64:ff9b::7f00:1]/client.json",
		]) {
			expect(() => admitClientIdUrl(clientId, config)).toThrowError(McpClientIdMetadataError);
		}
	});

	it("enforces the host allowlist with exact and suffix entries", () => {
		expect(() => admitClientIdUrl(CLIENT_ID, config, ["app.example.com"])).not.toThrowError();
		expect(() => admitClientIdUrl(CLIENT_ID, config, [".example.com"])).not.toThrowError();
		expect(() => admitClientIdUrl(CLIENT_ID, config, ["other.example.com"])).toThrowError(
			/allowlist/,
		);
		// A bare suffix entry must not match the apex-as-whole-host trick.
		expect(() =>
			admitClientIdUrl("https://example.com/c.json", config, [".example.com"]),
		).toThrowError(/allowlist/);
	});

	it("accepts a query only when explicitly allowed", () => {
		expect(() =>
			admitClientIdUrl("https://app.example.com/c.json?v=1", { allowQueryInClientId: true }),
		).not.toThrowError();
	});

	it("classifies URL-shaped client ids", () => {
		expect(isClientIdMetadataUrl(CLIENT_ID)).toBe(true);
		expect(isClientIdMetadataUrl("https://app.example.com/")).toBe(false);
		expect(isClientIdMetadataUrl("my-registered-client")).toBe(false);
	});
});

describe("blocked address ranges", () => {
	it.each([
		"0.0.0.0",
		"10.1.2.3",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.0.0.192",
		"192.0.2.10",
		"192.88.99.1",
		"192.168.1.1",
		"198.18.0.1",
		"198.51.100.7",
		"203.0.113.9",
		"224.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"::ffff:127.0.0.1",
		"::ffff:10.0.0.1",
		"64:ff9b::7f00:1",
		"64:ff9b:1::1",
		"100::1",
		"2001:db8::1",
		"2001::1",
		"2002:7f00:1::",
		"fc00::1",
		"fd12:3456::1",
		"fe80::1",
		"ff02::1",
	])("blocks %s", (address) => {
		expect(isBlockedDocumentAddress(address)).toBe(true);
	});

	it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "2600:1f18::1"])(
		"allows public %s",
		(address) => {
			expect(isBlockedDocumentAddress(address)).toBe(false);
		},
	);

	it("refuses non-IP inputs rather than guessing", () => {
		expect(isBlockedDocumentAddress("example.com")).toBe(true);
	});
});

describe("document validation", () => {
	const stamps = { resolvedAt: 0, expiresAt: 60_000 };

	it("accepts a minimal valid document", () => {
		const metadata = validateClientIdMetadataDocument(CLIENT_ID, documentBody(), stamps);
		expect(metadata.clientName).toBe("Example App");
		expect(metadata.tokenEndpointAuthMethod).toBe("none");
		expect(metadata.loopbackOnly).toBe(false);
		expect(Object.isFrozen(metadata)).toBe(true);
		expect(Object.isFrozen(metadata.redirectUris)).toBe(true);
	});

	it.each([
		["not json", "valid JSON"],
		["[]", "JSON object"],
		[documentBody({ client_id: "https://elsewhere.example/c.json" }), "own URL"],
		[documentBody({ client_secret: "hunter2" }), "client secrets"],
		[documentBody({ client_secret_expires_at: 0 }), "client secrets"],
		[documentBody({ token_endpoint_auth_method: "client_secret_basic" }), "auth method"],
		[documentBody({ grant_types: ["implicit"] }), "grant_types"],
		[documentBody({ response_types: ["token"] }), "response_types"],
		[documentBody({ redirect_uris: [] }), "redirect_uris"],
		[
			documentBody({
				redirect_uris: Array.from(
					{ length: 9 },
					(_, index) => `https://a.example/${String(index)}`,
				),
			}),
			"redirect_uris",
		],
		[documentBody({ redirect_uris: ["http://app.example.com/callback"] }), "loopback"],
		[documentBody({ redirect_uris: ["https://app.example.com/cb#frag"] }), "loopback"],
		[documentBody({ client_name: "" }), "client_name"],
		[documentBody({ scope: "x".repeat(600) }), "scope"],
		[documentBody({ token_endpoint_auth_method: "private_key_jwt" }), "jwks_uri"],
		[documentBody({ jwks_uri: "http://app.example.com/jwks" }), "jwks_uri"],
	])("rejects invalid documents (%#: %s)", (body, fragment) => {
		expect(() => validateClientIdMetadataDocument(CLIENT_ID, body, stamps)).toThrowError(
			new RegExp(fragment),
		);
	});

	it("flags loopback-only clients for the consent warning", () => {
		const metadata = validateClientIdMetadataDocument(
			CLIENT_ID,
			documentBody({
				redirect_uris: ["http://127.0.0.1/cb", "http://[::1]:8080/cb", "http://localhost:3000/cb"],
			}),
			stamps,
		);
		expect(metadata.loopbackOnly).toBe(true);
	});
});

describe("resolver caching and throttling", () => {
	it("caches successful documents and coalesces concurrent fetches", async () => {
		let at = 0;
		const fetcher = stubFetcher(() => jsonDocument(documentBody(), "max-age=600"));
		const resolver = createMcpClientIdMetadataResolver({ fetcher, now: () => at });

		const [first, second] = await Promise.all([
			resolver.resolve(CLIENT_ID),
			resolver.resolve(CLIENT_ID),
		]);
		expect(first?.clientName).toBe("Example App");
		expect(second).toBe(first);
		expect(fetcher.calls).toHaveLength(1);

		await resolver.resolve(CLIENT_ID);
		expect(fetcher.calls).toHaveLength(1);

		at = 601_000;
		await resolver.resolve(CLIENT_ID);
		expect(fetcher.calls).toHaveLength(2);
	});

	it("clamps cache lifetimes and honors no-store", async () => {
		let at = 0;
		const fetcher = stubFetcher(() => jsonDocument(documentBody(), "no-store"));
		const resolver = createMcpClientIdMetadataResolver({ fetcher, now: () => at });
		await resolver.resolve(CLIENT_ID);
		await resolver.resolve(CLIENT_ID);
		expect(fetcher.calls).toHaveLength(2);

		const clamped = stubFetcher(() => jsonDocument(documentBody(), "max-age=999999"));
		const clampedResolver = createMcpClientIdMetadataResolver({
			fetcher: clamped,
			now: () => at,
		});
		await clampedResolver.resolve(CLIENT_ID);
		at += 900_001; // above maxCacheTtlMs
		await clampedResolver.resolve(CLIENT_ID);
		expect(clamped.calls).toHaveLength(2);
	});

	it("never caches failures and opens a per-host breaker after repeated ones", async () => {
		let at = 0;
		let failing = true;
		const fetcher = stubFetcher(() =>
			failing
				? { status: 503, contentType: "application/json", cacheControl: undefined, body: "" }
				: jsonDocument(documentBody()),
		);
		const resolver = createMcpClientIdMetadataResolver({ fetcher, now: () => at });

		for (let attempt = 0; attempt < 3; attempt += 1) {
			await expect(resolver.resolve(CLIENT_ID)).rejects.toMatchObject({
				failure: "http-status",
				oauthError: "temporarily_unavailable",
			});
		}
		// Breaker open: no outbound call happens.
		await expect(resolver.resolve(CLIENT_ID)).rejects.toMatchObject({ failure: "throttled" });
		expect(fetcher.calls).toHaveLength(3);

		// After cooldown the next attempt goes out and succeeds; nothing negative was cached.
		at += 30_001;
		failing = false;
		await expect(resolver.resolve(CLIENT_ID)).resolves.toMatchObject({
			clientName: "Example App",
		});
	});

	it("maps redirects, content types, and 4xx statuses to invalid_client", async () => {
		const cases: readonly [McpFetchedDocument, string][] = [
			[
				{ status: 302, contentType: undefined, cacheControl: undefined, body: "" },
				"redirect-not-allowed",
			],
			[{ status: 404, contentType: undefined, cacheControl: undefined, body: "" }, "http-status"],
			[
				{ status: 200, contentType: "text/html", cacheControl: undefined, body: documentBody() },
				"content-type",
			],
		];
		for (const [document, failure] of cases) {
			const resolver = createMcpClientIdMetadataResolver({
				fetcher: stubFetcher(() => document),
				now: () => 0,
			});
			await expect(resolver.resolve(CLIENT_ID)).rejects.toMatchObject({ failure });
		}
	});

	it("bounds the LRU cache", async () => {
		const fetcher = stubFetcher((url) =>
			jsonDocument(
				JSON.stringify({
					client_id: url.href,
					client_name: "App",
					redirect_uris: ["https://app.example.com/cb"],
				}),
				"max-age=600",
			),
		);
		const resolver = createMcpClientIdMetadataResolver({
			fetcher,
			now: () => 0,
			maxCacheEntries: 2,
		});
		await resolver.resolve("https://a.example/c.json");
		await resolver.resolve("https://b.example/c.json");
		await resolver.resolve("https://c.example/c.json");
		// a was evicted: resolving it again refetches.
		await resolver.resolve("https://a.example/c.json");
		expect(fetcher.calls).toHaveLength(4);
		// b/c still... b was evicted when a re-entered; c remains cached.
		await resolver.resolve("https://c.example/c.json");
		expect(fetcher.calls).toHaveLength(4);
	});
});
