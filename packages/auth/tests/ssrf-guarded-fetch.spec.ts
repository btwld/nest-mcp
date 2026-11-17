import { createServer } from "node:http";
import type { RequestListener, Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createGuardedHostPolicy,
	createNodeDocumentFetcher,
	createSsrfGuardedFetch,
	isBlockedDocumentAddress,
	isLoopbackAddress,
	McpDocumentFetchError,
	normalizeGuardedHost,
	normalizeGuardedRequest,
} from "../src/cimd/index.ts";
import type {
	McpDocumentLookup,
	McpGuardedHostPolicy,
	McpGuardedTarget,
} from "../src/cimd/index.ts";

describe("createGuardedHostPolicy public CIMD export", () => {
	it("synchronously applies the same host policy used by guarded transports", () => {
		const policy: McpGuardedHostPolicy = createGuardedHostPolicy({
			allowedHosts: ["API.EXAMPLE.COM."],
		});
		const target: McpGuardedTarget = policy.admit(new URL("https://api.example.com:8443/mcp"));

		expect(target).toEqual({ host: "api.example.com", port: 8443, secure: true });
		expect(policy.admitsAddress(target)("2606:4700:4700::1111")).toBe(true);
		expect(policy.admitsAddress(target)("127.0.0.1")).toBe(false);
		expect(() => policy.admit(new URL("https://other.example.com/mcp"))).toThrowError(
			McpDocumentFetchError,
		);
	});
});

describe("normalizeGuardedRequest", () => {
	it("preserves a Headers instance (Content-Type and Basic auth survive)", () => {
		const basic = `Basic ${Buffer.from("client:secret").toString("base64")}`;
		const { headers } = normalizeGuardedRequest("idp.example.com", {
			headers: new Headers({
				"content-type": "application/x-www-form-urlencoded",
				authorization: basic,
				accept: "application/json",
			}),
		});
		expect(headers["authorization"]).toBe(basic);
		expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
		expect(headers["accept"]).toBe("application/json");
		expect(headers["host"]).toBe("idp.example.com");
	});

	it("serializes a URLSearchParams body and sets content-length + type", () => {
		const body = new URLSearchParams({ grant_type: "authorization_code", code: "abc" });
		const result = normalizeGuardedRequest("idp.example.com", { body });
		expect(result.body?.toString("utf8")).toBe("grant_type=authorization_code&code=abc");
		expect(result.headers["content-length"]).toBe(String(result.body?.byteLength));
		expect(result.headers["content-type"]).toBe("application/x-www-form-urlencoded;charset=UTF-8");
	});

	it("accepts string and Uint8Array bodies and rejects unsupported ones", () => {
		expect(normalizeGuardedRequest("h", { body: "raw" }).body?.toString()).toBe("raw");
		expect(normalizeGuardedRequest("h", { body: new Uint8Array([1, 2, 3]) }).body?.byteLength).toBe(
			3,
		);
		// A ReadableStream is a valid BodyInit but the guarded fetch does not stream.
		expect(() => normalizeGuardedRequest("h", { body: new ReadableStream() })).toThrowError();
	});

	it("does not let an incoming header override the pinned Host", () => {
		const { headers } = normalizeGuardedRequest("idp.example.com", {
			headers: { host: "attacker.example" },
		});
		expect(headers["host"]).toBe("idp.example.com");
	});
});

describe("isBlockedDocumentAddress IPv6 hardening", () => {
	it.each([
		"fec0::1", // site-local
		"::ffff:0:7f00:1", // v4-translated ::ffff:0:0:0/96 → 127.0.0.1
		"fe80::1",
		"fc00::1",
		"ff02::1",
		"2001:db8::1",
	])("blocks non-global or embedded-private %s", (address) => {
		expect(isBlockedDocumentAddress(address)).toBe(true);
	});

	it.each(["2606:4700:4700::1111", "2600:1f18::1"])("allows global unicast %s", (address) => {
		expect(isBlockedDocumentAddress(address)).toBe(false);
	});
});

describe("normalizeGuardedHost", () => {
	it.each([
		["Example.COM", "example.com"],
		["example.com.", "example.com"],
		["  EXAMPLE.com.  ", "example.com"],
		["[::1]", "::1"],
		["[::1].", "::1"],
		["[2606:4700::1111]", "2606:4700::1111"],
		["mcp.example.com", "mcp.example.com"],
	])("normalizes %s to %s", (input, expected) => {
		expect(normalizeGuardedHost(input)).toBe(expected);
	});
});

describe("isLoopbackAddress", () => {
	it.each(["127.0.0.1", "127.1.2.3", "127.255.255.254", "::1", "[::1]", " ::1 "])(
		"admits loopback %s",
		(address) => {
			expect(isLoopbackAddress(address)).toBe(true);
		},
	);

	it.each([
		"128.0.0.1",
		"10.0.0.1",
		"0.0.0.0",
		"::",
		"::2",
		// A v4-mapped literal must not smuggle itself through the loopback door.
		"::ffff:127.0.0.1",
		"64:ff9b::7f00:1",
		"localhost",
		"",
	])("refuses non-loopback %s", (address) => {
		expect(isLoopbackAddress(address)).toBe(false);
	});
});

const HOST = "mcp-loopback.test";

let answers: readonly { address: string; family: number }[] = [{ address: "127.0.0.1", family: 4 }];
const lookup: McpDocumentLookup = (_hostname, callback) => {
	callback(null, answers);
};

const handler: RequestListener = (request, response) => {
	if (request.url === "/document") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: true }));
		return;
	}
	response.writeHead(200, { "content-type": "text/plain" });
	response.end("guarded");
};

let server: Server;
let port = 0;

beforeAll(async () => {
	server = createServer(handler);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Test server did not expose a TCP address.");
	}
	port = address.port;
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error === undefined) resolve();
			else reject(error);
		});
	});
});

function origin(): string {
	return `http://${HOST}:${String(port)}`;
}

describe("guarded fetch host allowlist", () => {
	it("admits any non-blocked host when unset (today's behavior)", async () => {
		const guarded = createSsrfGuardedFetch({ lookup, allowLoopbackHttp: true });
		await expect((await guarded(`${origin()}/`)).text()).resolves.toBe("guarded");
	});

	it("rejects a host outside an exact allowlist before any I/O", async () => {
		const guarded = createSsrfGuardedFetch({
			lookup,
			allowLoopbackHttp: true,
			allowedHosts: ["other.test"],
		});
		await expect(guarded(`${origin()}/`)).rejects.toMatchObject({
			name: "McpDocumentFetchError",
			reason: "host-not-allowed",
		});
	});

	it("matches allowlist entries after normalization, not by suffix", async () => {
		const guarded = createSsrfGuardedFetch({
			lookup,
			allowLoopbackHttp: true,
			allowedHosts: [` ${HOST.toUpperCase()}. `],
		});
		await expect((await guarded(`${origin()}/`)).text()).resolves.toBe("guarded");

		const suffixOnly = createSsrfGuardedFetch({
			lookup,
			allowLoopbackHttp: true,
			allowedHosts: [".test"],
		});
		await expect(suffixOnly(`${origin()}/`)).rejects.toMatchObject({
			reason: "host-not-allowed",
		});
	});

	it("applies the allowlist to the document fetcher too", async () => {
		const fetcher = createNodeDocumentFetcher({
			lookup,
			allowLoopbackHttp: true,
			allowedHosts: ["other.test"],
		});
		await expect(
			fetcher.fetchDocument(new URL(`${origin()}/document`), {
				maxBytes: 8_192,
				totalTimeoutMs: 2_000,
				accept: "application/json",
			}),
		).rejects.toMatchObject({ reason: "host-not-allowed" });
	});
});

describe("guarded fetch loopback http", () => {
	it("keeps http closed by default", async () => {
		await expect(createSsrfGuardedFetch({ lookup })(`${origin()}/`)).rejects.toMatchObject({
			reason: "insecure-url",
		});
		await expect(
			createNodeDocumentFetcher({ lookup }).fetchDocument(new URL(`${origin()}/document`), {
				maxBytes: 8_192,
				totalTimeoutMs: 2_000,
				accept: "application/json",
			}),
		).rejects.toMatchObject({ reason: "insecure-url" });
	});

	it("fetches a document over loopback http when enabled", async () => {
		const fetcher = createNodeDocumentFetcher({
			lookup,
			allowLoopbackHttp: true,
			allowedHosts: [HOST],
		});
		await expect(
			fetcher.fetchDocument(new URL(`${origin()}/document`), {
				maxBytes: 8_192,
				totalTimeoutMs: 2_000,
				accept: "application/json",
			}),
		).resolves.toMatchObject({ status: 200, body: '{"ok":true}' });
	});

	it("keeps loopback blocked for https even when the switch is on", async () => {
		const guarded = createSsrfGuardedFetch({ lookup, allowLoopbackHttp: true });
		await expect(guarded(`https://127.0.0.1:${String(port)}/`)).rejects.toMatchObject({
			reason: "blocked-address",
		});
		await expect(guarded("https://[::1]/")).rejects.toMatchObject({ reason: "blocked-address" });
	});

	it("requires an http IP literal to be loopback itself", async () => {
		const guarded = createSsrfGuardedFetch({ lookup, allowLoopbackHttp: true });
		await expect(guarded("http://10.0.0.9/")).rejects.toMatchObject({
			reason: "blocked-address",
		});
	});

	it("refuses a mixed answer set: only-loopback means only", async () => {
		const guarded = createSsrfGuardedFetch({
			lookup,
			allowLoopbackHttp: true,
			allowedHosts: [HOST],
		});
		const previous = answers;
		for (const mixed of [
			[
				{ address: "127.0.0.1", family: 4 },
				{ address: "93.184.216.34", family: 4 },
			],
			[{ address: "::ffff:127.0.0.1", family: 6 }],
			[{ address: "93.184.216.34", family: 4 }],
		]) {
			answers = mixed;
			try {
				await expect(guarded(`${origin()}/`)).rejects.toMatchObject({
					reason: "blocked-address",
				});
			} finally {
				answers = previous;
			}
		}
	});

	it("still blocks a private answer for an https host", async () => {
		const guarded = createSsrfGuardedFetch({ lookup, totalTimeoutMs: 2_000 });
		const previous = answers;
		answers = [{ address: "10.0.0.9", family: 4 }];
		try {
			await expect(guarded("https://mcp.example.com/token")).rejects.toMatchObject({
				reason: "blocked-address",
			});
		} finally {
			answers = previous;
		}
	});
});
