import { describe, expect, it, vi } from "vitest";
import { McpServerRuntime, McpServerRuntimeError } from "../src/index.ts";
import type { McpServerRuntimeEvent } from "../src/index.ts";
import {
	hardenMcpFetch,
	MCP_DEFAULT_MAX_BODY_BYTES,
	resolveMcpHttpSecurity,
} from "../src/security/index.ts";
import type { McpHttpSecurityOptions } from "../src/security/index.ts";

const ROUTE = "http://127.0.0.1/mcp";
const noop = (): void => undefined;

describe("MCP HTTP security posture", () => {
	it("rejects a routable browser origin by default", async () => {
		const dispatched = vi.fn(async () => new Response("ok"));
		const runtime = createRuntime({ dispatched });
		try {
			const response = await runtime.fetch(
				new Request(ROUTE, { headers: { origin: "https://evil.example" } }),
			);
			expect(response.status).toBe(403);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
			expect(dispatched).not.toHaveBeenCalled();
		} finally {
			await runtime.close();
		}
	});

	it("passes requests without an Origin header", async () => {
		const runtime = createRuntime({});
		try {
			const response = await runtime.fetch(new Request(ROUTE));
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("ok");
		} finally {
			await runtime.close();
		}
	});

	it("decorates responses for localhost-class origins with CORS headers", async () => {
		const runtime = createRuntime({});
		try {
			const response = await runtime.fetch(
				new Request(ROUTE, { headers: { origin: "http://localhost:5173" } }),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
			expect(response.headers.get("access-control-expose-headers")).toContain("mcp-session-id");
			expect(response.headers.get("vary")).toContain("Origin");
			expect(response.headers.get("access-control-allow-credentials")).toBeNull();
			expect(await response.text()).toBe("ok");
		} finally {
			await runtime.close();
		}
	});

	it("answers a preflight for an allowed origin without dispatching", async () => {
		const dispatched = vi.fn(async () => new Response("ok"));
		const runtime = createRuntime({ dispatched });
		try {
			const response = await runtime.fetch(
				new Request(ROUTE, {
					method: "OPTIONS",
					headers: {
						origin: "http://localhost:5173",
						"access-control-request-method": "POST",
						"access-control-request-headers": "mcp-method, authorization, x-custom",
					},
				}),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
			expect(response.headers.get("access-control-allow-methods")).toBe(
				"GET, POST, DELETE, OPTIONS",
			);
			// The requested headers are intersected with the allowlist: the
			// unknown x-custom is dropped rather than blindly echoed.
			expect(response.headers.get("access-control-allow-headers")).toBe(
				"mcp-method, authorization",
			);
			expect(response.headers.get("access-control-max-age")).toBe("600");
			expect(dispatched).not.toHaveBeenCalled();
		} finally {
			await runtime.close();
		}
	});

	it("rejects a preflight from a denied origin without CORS headers", async () => {
		const runtime = createRuntime({});
		try {
			const response = await runtime.fetch(
				new Request(ROUTE, {
					method: "OPTIONS",
					headers: {
						origin: "https://evil.example",
						"access-control-request-method": "POST",
					},
				}),
			);
			expect(response.status).toBe(403);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
		} finally {
			await runtime.close();
		}
	});

	it("supports disabling origin validation and reflecting origins over CORS", async () => {
		const runtime = createRuntime({
			httpSecurity: { allowedOriginHostnames: false, cors: true },
		});
		try {
			const response = await runtime.fetch(
				new Request(ROUTE, { headers: { origin: "https://partner.example" } }),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("access-control-allow-origin")).toBe("https://partner.example");
		} finally {
			await runtime.close();
		}
	});

	it("keeps CORS off when origin validation is disabled without an explicit opt-in", async () => {
		const runtime = createRuntime({ httpSecurity: { allowedOriginHostnames: false } });
		try {
			const response = await runtime.fetch(
				new Request(ROUTE, { headers: { origin: "https://partner.example" } }),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
		} finally {
			await runtime.close();
		}
	});

	it("validates the Host header when an allowlist is configured", async () => {
		const runtime = createRuntime({
			httpSecurity: { allowedHostnames: ["api.example.com"], allowedOriginHostnames: false },
		});
		try {
			const rejected = await runtime.fetch(
				new Request("https://evil.example/mcp", { headers: { host: "evil.example" } }),
			);
			expect(rejected.status).toBe(403);
			const allowed = await runtime.fetch(
				new Request("https://api.example.com/mcp", { headers: { host: "api.example.com" } }),
			);
			expect(allowed.status).toBe(200);
		} finally {
			await runtime.close();
		}
	});

	it("treats an empty origin allowlist as deny-all for browser origins", async () => {
		const runtime = createRuntime({ httpSecurity: { allowedOriginHostnames: [] } });
		try {
			const rejected = await runtime.fetch(
				new Request(ROUTE, { headers: { origin: "http://localhost:5173" } }),
			);
			expect(rejected.status).toBe(403);
			const noOrigin = await runtime.fetch(new Request(ROUTE));
			expect(noOrigin.status).toBe(200);
		} finally {
			await runtime.close();
		}
	});

	it("rejects a declared oversize body without dispatching", async () => {
		const dispatched = vi.fn(async () => new Response("ok"));
		const runtime = createRuntime({ dispatched, httpSecurity: { maxBodyBytes: 16 } });
		try {
			const response = await runtime.fetch(
				new Request(ROUTE, { method: "POST", body: "x".repeat(64) }),
			);
			expect(response.status).toBe(413);
			expect(await response.text()).toContain("16-byte limit");
			expect(dispatched).not.toHaveBeenCalled();
		} finally {
			await runtime.close();
		}
	});

	it("rejects an unbounded streaming body once it exceeds the cap", async () => {
		const dispatched = vi.fn(async () => new Response("ok"));
		const runtime = createRuntime({ dispatched, httpSecurity: { maxBodyBytes: 16 } });
		try {
			const chunk = new TextEncoder().encode("0123456789");
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(chunk);
					controller.enqueue(chunk);
					controller.close();
				},
			});
			const response = await runtime.fetch(
				new Request(ROUTE, {
					method: "POST",
					body: stream,
					// @ts-expect-error Node fetch requires duplex for stream bodies.
					duplex: "half",
				}),
			);
			expect(response.status).toBe(413);
			expect(dispatched).not.toHaveBeenCalled();
		} finally {
			await runtime.close();
		}
	});

	it("passes bodies within the cap through to dispatch intact", async () => {
		const runtime = createRuntime({
			middleware: async (operation) => new Response(await operation.input.request.text()),
			httpSecurity: { maxBodyBytes: 64 },
		});
		try {
			const response = await runtime.fetch(
				new Request(ROUTE, { method: "POST", body: '{"hello":"world"}' }),
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('{"hello":"world"}');
		} finally {
			await runtime.close();
		}
	});

	it("streams decorated responses without buffering", async () => {
		let releaseSecondChunk = noop;
		const runtime = createRuntime({
			middleware: async () => {
				const encoder = new TextEncoder();
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode("first"));
						releaseSecondChunk = () => {
							controller.enqueue(encoder.encode("second"));
							controller.close();
						};
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			},
		});
		try {
			const response = await runtime.fetch(
				new Request(ROUTE, { headers: { origin: "http://localhost:5173" } }),
			);
			expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
			if (response.body === null) throw new Error("Expected a streaming response body.");
			const reader = response.body.getReader();
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toBe("first");
			releaseSecondChunk();
			const second = await reader.read();
			expect(new TextDecoder().decode(second.value)).toBe("second");
			expect((await reader.read()).done).toBe(true);
		} finally {
			await runtime.close();
		}
	});

	it("observes pre-dispatch rejections with their status", async () => {
		const events: McpServerRuntimeEvent[] = [];
		const runtime = createRuntime({
			observer: (event) => {
				events.push(event);
			},
			httpSecurity: { maxBodyBytes: 16 },
		});
		try {
			await runtime.fetch(new Request(ROUTE, { headers: { origin: "https://evil.example" } }));
			await runtime.fetch(new Request(ROUTE, { method: "POST", body: "x".repeat(64) }));
			const rejected = events.filter((event) => event.phase === "request:rejected");
			expect(rejected.map((event) => event.status)).toEqual([403, 413]);
		} finally {
			await runtime.close();
		}
	});

	it("lets an outer hardened facade override the inner runtime posture", async () => {
		const runtime = createRuntime({});
		const outer = hardenMcpFetch(
			runtime,
			resolveMcpHttpSecurity({ allowedOriginHostnames: ["partner.example"] }),
		);
		try {
			const allowedByOuter = await outer.fetch(
				new Request(ROUTE, { headers: { origin: "https://partner.example" } }),
			);
			expect(allowedByOuter.status).toBe(200);
			expect(allowedByOuter.headers.get("access-control-allow-origin")).toBe(
				"https://partner.example",
			);
			const deniedByOuter = await outer.fetch(
				new Request(ROUTE, { headers: { origin: "http://localhost:5173" } }),
			);
			expect(deniedByOuter.status).toBe(403);
		} finally {
			await runtime.close();
		}
	});

	it("intersects preflight request headers with the allowlist", async () => {
		const runtime = createRuntime({});
		try {
			const response = await runtime.fetch(
				new Request(ROUTE, {
					method: "OPTIONS",
					headers: {
						origin: "http://localhost:5173",
						"access-control-request-method": "POST",
						"access-control-request-headers": "authorization, x-not-allowed",
					},
				}),
			);
			expect(response.headers.get("access-control-allow-headers")).toBe("authorization");
		} finally {
			await runtime.close();
		}
	});

	it("requires an exact-origin allowlist for credentialed CORS", () => {
		expect(() => resolveMcpHttpSecurity({ cors: { credentials: true } })).toThrowError(
			/allowedOrigins/,
		);
		const policy = resolveMcpHttpSecurity({
			allowedOriginHostnames: ["app.example.com"],
			cors: { credentials: true, allowedOrigins: ["https://app.example.com"] },
		});
		expect(policy.cors?.credentials).toBe(true);
	});

	it("grants credentialed CORS only to an exact origin, never a scheme/port sibling", async () => {
		const runtime = createRuntime({
			httpSecurity: {
				allowedOriginHostnames: ["app.example.com"],
				cors: { credentials: true, allowedOrigins: ["https://app.example.com"] },
			},
		});
		try {
			const exact = await runtime.fetch(
				new Request(ROUTE, { headers: { origin: "https://app.example.com" } }),
			);
			expect(exact.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
			expect(exact.headers.get("access-control-allow-credentials")).toBe("true");
			// Same hostname, different port: passes origin validation but must NOT
			// receive a credentialed grant.
			const sibling = await runtime.fetch(
				new Request(ROUTE, { headers: { origin: "https://app.example.com:8443" } }),
			);
			expect(sibling.status).toBe(200);
			expect(sibling.headers.get("access-control-allow-origin")).toBeNull();
		} finally {
			await runtime.close();
		}
	});

	it("keeps explicit hardened layers intersecting instead of deferring to the mark", async () => {
		const runtime = createRuntime({ httpSecurity: { maxBodyBytes: 1_048_576 } });
		// Outer loose policy admits partner.example; inner strict policy caps at 8 bytes.
		const inner = hardenMcpFetch(runtime, resolveMcpHttpSecurity({ maxBodyBytes: 8 }));
		const outer = hardenMcpFetch(inner, resolveMcpHttpSecurity({ allowedOriginHostnames: false }));
		try {
			const response = await outer.fetch(
				new Request(ROUTE, { method: "POST", body: "x".repeat(64) }),
			);
			// The inner 8-byte cap still fires even though the outer layer marked the request.
			expect(response.status).toBe(413);
		} finally {
			await runtime.close();
		}
	});

	it("rejects malformed posture options at construction", () => {
		const failures: McpHttpSecurityOptions[] = [
			{ maxBodyBytes: 0 },
			{ maxBodyBytes: 1.5 },
			{ allowedOriginHostnames: ["https://app.example.com"] },
			{ allowedOriginHostnames: [" "] },
			{ cors: { maxAgeSeconds: -1 } },
			{ cors: { additionalAllowedHeaders: [""] } },
		];
		for (const httpSecurity of failures) {
			expect(() => resolveMcpHttpSecurity(httpSecurity)).toThrowError(McpServerRuntimeError);
		}
		expect(resolveMcpHttpSecurity().maxBodyBytes).toBe(MCP_DEFAULT_MAX_BODY_BYTES);
	});
});

function createRuntime(options: {
	readonly dispatched?: () => Promise<Response>;
	readonly middleware?: (operation: {
		readonly input: { readonly request: Request };
	}) => Promise<Response>;
	readonly httpSecurity?: McpHttpSecurityOptions;
	readonly observer?: (event: McpServerRuntimeEvent) => void;
}): McpServerRuntime {
	const dispatch =
		options.middleware ?? (async () => (options.dispatched ?? (async () => new Response("ok")))());
	return new McpServerRuntime({
		name: "http-security-test",
		serverInfo: { name: "http-security-test", version: "1.0.0" },
		middleware: [async (operation) => dispatch(operation)],
		...(options.httpSecurity === undefined ? {} : { httpSecurity: options.httpSecurity }),
		...(options.observer === undefined ? {} : { observer: options.observer }),
	});
}
