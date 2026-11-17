import { createServer } from "node:http";
import type { RequestListener, Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	admitMcpHttpEndpoint,
	createStreamingSsrfGuardedFetch,
	MCP_STREAM_IDLE_TIMEOUT_MS,
	MCP_STREAM_MAX_RESPONSE_BYTES,
	MCP_STREAM_MAX_SSE_EVENT_BYTES,
	McpDocumentFetchError,
	openGuardedFetch,
} from "../src/cimd/index.ts";
import type { McpDocumentLookup, McpStreamingFetchLike } from "../src/cimd/index.ts";

const HOST = "mcp-loopback.test";
const LIMITS = { idleTimeoutMs: 500, maxResponseBytes: 1_024, maxSseEventBytes: 64 } as const;

let answers: readonly { address: string; family: number }[] = [{ address: "127.0.0.1", family: 4 }];
let lookupCalls = 0;

const lookup: McpDocumentLookup = (_hostname, callback) => {
	lookupCalls += 1;
	callback(null, answers);
};

const handler: RequestListener = (request, response) => {
	const path = request.url ?? "/";
	if (path === "/echo") {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					method: request.method,
					acceptEncoding: request.headers["accept-encoding"],
					contentType: request.headers["content-type"],
					marker: request.headers["x-mcp-test"],
					body: Buffer.concat(chunks).toString("utf8"),
				}),
			);
		});
		return;
	}
	if (path === "/redirect") {
		response.writeHead(302, { location: "http://127.0.0.1/steal" });
		response.end();
		return;
	}
	if (path === "/declared-too-large") {
		response.writeHead(200, {
			"content-type": "application/json",
			"content-length": String(LIMITS.maxResponseBytes + 1),
		});
		response.end();
		return;
	}
	if (path === "/stream-too-large") {
		response.writeHead(200, { "content-type": "application/json" });
		response.write(Buffer.alloc(LIMITS.maxResponseBytes, 120));
		response.end("x");
		return;
	}
	if (path === "/sse-bounded-events" || path === "/sse-bounded-events-lf") {
		const eol = path.endsWith("-lf") ? "\n\n" : "\r\n\r\n";
		response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
		const event = `data: ${"x".repeat(50)}${eol}`;
		response.end(`${event}${event}`);
		return;
	}
	if (path === "/sse-event-too-large") {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`data: ${"x".repeat(100)}\n\n`);
		return;
	}
	if (path === "/sse-stalls") {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(": open\n\n");
		return;
	}
	if (path === "/no-content") {
		response.writeHead(204);
		response.end();
		return;
	}
	response.writeHead(200, { "content-type": "text/plain" });
	response.end("pinned");
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

function loopbackFetch(overrides?: { readonly idleTimeoutMs?: number }): McpStreamingFetchLike {
	return createStreamingSsrfGuardedFetch({
		lookup,
		allowedHosts: [HOST],
		allowLoopbackHttp: true,
		...LIMITS,
		...overrides,
	});
}

describe("createStreamingSsrfGuardedFetch documented fences", () => {
	it("carries the proven fence values as defaults", () => {
		expect(MCP_STREAM_MAX_RESPONSE_BYTES).toBe(4 * 1_024 * 1_024);
		expect(MCP_STREAM_MAX_SSE_EVENT_BYTES).toBe(1_024 * 1_024);
		expect(MCP_STREAM_IDLE_TIMEOUT_MS).toBe(300_000);
	});

	it("is a full FetchLike, assignable without a cast", () => {
		// Compile-time assertion: this is exactly the SDK's `FetchLike` shape,
		// so it drops into `McpHttpClientTransportDefinition.fetch` directly.
		const asFetchLike: (input: string | URL, init?: RequestInit) => Promise<Response> =
			createStreamingSsrfGuardedFetch();
		expect(typeof asFetchLike).toBe("function");
	});
});

describe("createStreamingSsrfGuardedFetch admission", () => {
	it("rejects a host outside the allowlist before any I/O", async () => {
		await expect(loopbackFetch()(`http://other.test:${String(port)}/`)).rejects.toMatchObject({
			name: "McpDocumentFetchError",
			reason: "host-not-allowed",
		});
	});

	it("rejects plain http unless loopback http is enabled", async () => {
		const guarded = createStreamingSsrfGuardedFetch({ lookup, allowedHosts: [HOST] });
		await expect(guarded(origin())).rejects.toMatchObject({ reason: "insecure-url" });
	});

	it("keeps https to loopback blocked even in loopback-http mode", async () => {
		const guarded = createStreamingSsrfGuardedFetch({ lookup, allowLoopbackHttp: true });
		await expect(guarded("https://127.0.0.1/mcp")).rejects.toMatchObject({
			reason: "blocked-address",
		});
	});

	it("refuses a loopback-http host whose answers are not all loopback", async () => {
		const previous = answers;
		answers = [
			{ address: "127.0.0.1", family: 4 },
			{ address: "10.0.0.9", family: 4 },
		];
		try {
			await expect(loopbackFetch()(`${origin()}/`)).rejects.toMatchObject({
				reason: "blocked-address",
			});
		} finally {
			answers = previous;
		}
	});
});

describe("createStreamingSsrfGuardedFetch transport", () => {
	it("reaches the pinned server and reports the request URL", async () => {
		const response = await loopbackFetch()(`${origin()}/`);
		expect(response.status).toBe(200);
		expect(response.url).toBe(`${origin()}/`);
		await expect(response.text()).resolves.toBe("pinned");
	});

	it("forwards method, headers, and a string body with identity encoding", async () => {
		const response = await loopbackFetch()(`${origin()}/echo`, {
			method: "post",
			headers: new Headers({ "content-type": "application/json", "x-mcp-test": "preserved" }),
			body: JSON.stringify({ jsonrpc: "2.0", method: "initialize" }),
		});
		await expect(response.json()).resolves.toEqual({
			method: "POST",
			acceptEncoding: "identity",
			contentType: "application/json",
			marker: "preserved",
			body: JSON.stringify({ jsonrpc: "2.0", method: "initialize" }),
		});
	});

	const bodyShapes: readonly (readonly [string, BodyInit])[] = [
		["URLSearchParams", new URLSearchParams({ grant_type: "refresh_token" })],
		["Uint8Array", new Uint8Array([104, 105])],
		["Blob", new Blob(["blobbed"], { type: "text/plain" })],
		[
			"ReadableStream",
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("streamed"));
					controller.close();
				},
			}),
		],
	];

	it.each(bodyShapes)("does not throw on a %s request body", async (_label, body) => {
		const response = await loopbackFetch()(`${origin()}/echo`, { method: "POST", body });
		await expect(response.text()).resolves.toMatch(/"body":"[^"]+"/);
	});

	it("returns a null body for a 204", async () => {
		const response = await loopbackFetch()(`${origin()}/no-content`);
		expect(response.status).toBe(204);
		expect(response.body).toBeNull();
	});

	it("rejects any 3xx rather than following it", async () => {
		await expect(loopbackFetch()(`${origin()}/redirect`)).rejects.toMatchObject({
			name: "McpDocumentFetchError",
			reason: "network",
		});
	});
});

describe("createStreamingSsrfGuardedFetch response fences", () => {
	it("rejects a declared length above the cap before streaming", async () => {
		await expect(loopbackFetch()(`${origin()}/declared-too-large`)).rejects.toMatchObject({
			reason: "too-large",
		});
	});

	it("errors the stream when the running total passes the cap", async () => {
		const response = await loopbackFetch()(`${origin()}/stream-too-large`);
		expect(response.status).toBe(200);
		await expect(response.arrayBuffer()).rejects.toBeInstanceOf(McpDocumentFetchError);
	});

	it.each(["/sse-bounded-events", "/sse-bounded-events-lf"])(
		"applies no total cap to SSE, only a per-event budget (%s)",
		async (path) => {
			const response = await loopbackFetch()(`${origin()}${path}`);
			const body = await response.text();
			// Two events well past `maxResponseBytes` in total, each inside the
			// per-event budget: the counter reset at the blank line.
			expect(body.length).toBeGreaterThan(LIMITS.maxSseEventBytes);
			expect(body.split("data: ")).toHaveLength(3);
		},
	);

	it("errors the stream when one SSE event passes its budget", async () => {
		const response = await loopbackFetch()(`${origin()}/sse-event-too-large`);
		await expect(response.text()).rejects.toMatchObject({ reason: "too-large" });
	});

	it("errors the stream when bytes stop arriving", async () => {
		const response = await loopbackFetch({ idleTimeoutMs: 150 })(`${origin()}/sse-stalls`);
		await expect(response.text()).rejects.toMatchObject({ reason: "timeout" });
	});
});

describe("admitMcpHttpEndpoint and openGuardedFetch", () => {
	const policy = { lookup, allowedHosts: [HOST], allowLoopbackHttp: true } as const;

	it("admits an endpoint once and pins its answers for the lease", async () => {
		lookupCalls = 0;
		const admitted = await admitMcpHttpEndpoint(`${origin()}/mcp`, policy);
		expect(admitted).toEqual({
			url: `${origin()}/mcp`,
			origin: origin(),
			hostname: HOST,
			secure: false,
		});
		expect(Object.isFrozen(admitted)).toBe(true);
		expect(lookupCalls).toBe(1);

		const lease = openGuardedFetch(admitted, LIMITS);
		try {
			// A rebinding answer after admission never reaches the socket: the
			// lease replays the pinned addresses instead of resolving again.
			const previous = answers;
			answers = [{ address: "10.0.0.9", family: 4 }];
			try {
				await expect((await lease.fetch(`${origin()}/`)).text()).resolves.toBe("pinned");
				expect(lookupCalls).toBe(1);
			} finally {
				answers = previous;
			}
			await expect(lease.fetch(`http://127.0.0.1:${String(port)}/`)).rejects.toMatchObject({
				reason: "host-not-allowed",
			});
			await expect(lease.fetch(`${origin()}/redirect`)).rejects.toMatchObject({
				reason: "network",
			});
			await expect((await lease.fetch(`${origin()}/sse-bounded-events`)).text()).resolves.toContain(
				"data: ",
			);
		} finally {
			await lease.close();
			await lease.close();
		}
		await expect(lease.fetch(`${origin()}/`)).rejects.toMatchObject({ reason: "network" });
	});

	it("rejects an endpoint URL that carries userinfo, a fragment, or a query", async () => {
		for (const endpoint of [
			`http://user:pw@${HOST}:${String(port)}/mcp`,
			`${origin()}/mcp#frag`,
			`${origin()}/mcp?tenant=one`,
		]) {
			await expect(admitMcpHttpEndpoint(endpoint, policy)).rejects.toMatchObject({
				reason: "insecure-url",
			});
		}
		await expect(
			admitMcpHttpEndpoint(`${origin()}/mcp?tenant=one`, { ...policy, allowQuery: true }),
		).resolves.toMatchObject({ url: `${origin()}/mcp?tenant=one` });
	});

	it("preserves the admission query policy for every request in the lease", async () => {
		const queryless = await admitMcpHttpEndpoint(`${origin()}/mcp`, policy);
		const querylessLease = openGuardedFetch(queryless, LIMITS);
		try {
			await expect(querylessLease.fetch(`${origin()}/mcp?tenant=one`)).rejects.toMatchObject({
				reason: "insecure-url",
			});
		} finally {
			await querylessLease.close();
		}

		const queryEnabled = await admitMcpHttpEndpoint(`${origin()}/mcp?tenant=one`, {
			...policy,
			allowQuery: true,
		});
		const queryEnabledLease = openGuardedFetch(queryEnabled, LIMITS);
		try {
			// allowQuery is a lease policy, not a pin to the admission URL's exact query.
			await expect(
				(await queryEnabledLease.fetch(`${origin()}/mcp?tenant=two`)).text(),
			).resolves.toBe("pinned");
		} finally {
			await queryEnabledLease.close();
		}
	});

	it("refuses an unadmitted look-alike record", () => {
		expect(() =>
			openGuardedFetch({ url: origin(), origin: origin(), hostname: HOST, secure: false }),
		).toThrowError(McpDocumentFetchError);
	});

	it.each([
		[{ address: "10.0.0.9", family: 4 }],
		[{ address: "::ffff:127.0.0.1", family: 6 }],
		[{ address: "2002:7f00:1::", family: 6 }],
	])("refuses admission when an answer is not admissible (%o)", async (answer) => {
		const previous = answers;
		answers = [answer];
		try {
			await expect(
				admitMcpHttpEndpoint(`https://${HOST}/mcp`, { lookup, allowedHosts: [HOST] }),
			).rejects.toMatchObject({ reason: "blocked-address" });
		} finally {
			answers = previous;
		}
	});
});
