import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { NodeIncomingMessageLike, NodeServerResponseLike } from "@modelcontextprotocol/node";
import { fromJsonSchema, type Transport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	McpServerRegistry,
	McpServerRuntime,
	acceptedContent,
	createRequestStateCodec,
	inputRequired,
	resolveMcpServerPrincipal,
} from "../src/index.ts";
import type { CallToolResult, InputRequiredResult, ServerContext } from "../src/index.ts";
import { createMcpServerTestFetch } from "../src/testing/index.ts";

describe("McpServerRuntime", () => {
	let client: Client | undefined;
	let runtime: McpServerRuntime | undefined;

	afterEach(async () => {
		await client?.close();
		await runtime?.close();
	});

	it("rejects malformed JavaScript definitions with a stable runtime error", () => {
		expect(() => Reflect.construct(McpServerRuntime, [null])).toThrowError(
			expect.objectContaining({ code: "INVALID_DEFINITION" }),
		);
		expect(() =>
			Reflect.construct(McpServerRuntime, [
				{ name: "runtime", serverInfo: { name: "wire", version: 1 } },
			]),
		).toThrowError(expect.objectContaining({ code: "INVALID_DEFINITION" }));
	});

	it("serves a feature through the official modern HTTP client", async () => {
		runtime = new McpServerRuntime({
			name: "test",
			serverInfo: { name: "test-server", version: "1.0.0" },
			features: [
				(server) => {
					server.registerTool(
						"echo",
						{
							description: "Echo text",
							inputSchema: fromJsonSchema<{ text: string }>({
								type: "object",
								properties: { text: { type: "string" } },
								required: ["text"],
							}),
						},
						async ({ text }) => ({ content: [{ type: "text", text }] }),
					);
				},
			],
		});
		client = new Client(
			{ name: "test-client", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" } },
		);
		await client.connect(
			new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
				fetch: createMcpServerTestFetch(runtime),
			}),
		);

		const result = await client.callTool({ name: "echo", arguments: { text: "hello" } });

		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		expect(client.getProtocolEra()).toBe("modern");
	});

	it("projects only explicitly selected verified principal claims", async () => {
		const principals: unknown[] = [];
		const resolveClaims = vi.fn((authInfo: { readonly extra?: Record<string, unknown> }) => ({
			subject: String(authInfo.extra?.subject),
			tenantId: String(authInfo.extra?.tenant_id),
		}));
		runtime = new McpServerRuntime({
			name: "principal",
			serverInfo: { name: "principal", version: "1.0.0" },
			principalClaims: resolveClaims,
			middleware: [
				async (operation) => {
					principals.push(operation.context.principal);
					return new Response(null, { status: 204 });
				},
			],
		});
		await runtime.fetch(new Request("https://principal.test/mcp"), {
			authInfo: {
				token: "never-project-me",
				clientId: "artifact-agent",
				scopes: ["artifacts:read"],
				extra: {
					subject: "user-1",
					tenant_id: "tenant-1",
					providerSecret: "never-project-me-either",
				},
			},
		});

		expect(principals).toEqual([
			{
				clientId: "artifact-agent",
				scopes: ["artifacts:read"],
				subject: "user-1",
				tenantId: "tenant-1",
			},
		]);
		expect(JSON.stringify(principals)).not.toContain("never-project-me");
		expect(resolveClaims).toHaveBeenCalledOnce();
	});

	it("projects the mutable AuthInfo resource URL as an immutable canonical string", async () => {
		const resource = new URL("https://api.example.test/artifacts");
		const principal = await resolveMcpServerPrincipal({
			token: "verified",
			clientId: "artifact-agent",
			scopes: [],
			resource,
		});

		resource.pathname = "/changed";

		expect(principal.resource).toBe("https://api.example.test/artifacts");
		expect(typeof principal.resource).toBe("string");
	});

	it("does not dispatch a request when shutdown wins a principal-resolution race", async () => {
		let releaseClaims: (() => void) | undefined;
		const claimsPending = new Promise<void>((resolve) => {
			releaseClaims = resolve;
		});
		const middleware = vi.fn(async () => new Response(null, { status: 204 }));
		runtime = new McpServerRuntime({
			name: "closing-principal",
			serverInfo: { name: "closing-principal", version: "1.0.0" },
			principalClaims: async () => {
				await claimsPending;
				return { subject: "user-1" };
			},
			middleware: [middleware],
		});
		const responsePending = runtime.fetch(new Request("https://closing.test/mcp"), {
			authInfo: {
				token: "verified",
				clientId: "artifact-agent",
				scopes: [],
			},
		});

		const closePending = runtime.close();
		releaseClaims?.();

		await expect(responsePending).rejects.toMatchObject({ code: "RUNTIME_CLOSED" });
		await expect(closePending).resolves.toBeUndefined();
		expect(middleware).not.toHaveBeenCalled();
	});

	it("waits for accepted wrapper middleware and prevents dispatch after close starts", async () => {
		let enterMiddleware: (() => void) | undefined;
		let releaseMiddleware: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			enterMiddleware = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseMiddleware = resolve;
		});
		runtime = new McpServerRuntime({
			name: "quiescent-close",
			serverInfo: { name: "quiescent-close", version: "1.0.0" },
			middleware: [
				async (_operation, next) => {
					enterMiddleware?.();
					await released;
					return next();
				},
			],
		});
		const responsePending = runtime.fetch(new Request("https://closing.test/mcp"));
		await entered;

		const closePending = runtime.close();
		let closeSettled = false;
		void closePending.then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		releaseMiddleware?.();

		await expect(responsePending).rejects.toMatchObject({ code: "RUNTIME_CLOSED" });
		await expect(closePending).resolves.toBeUndefined();
	});

	it("publishes one stable close promise before observer re-entry", async () => {
		let reentrantClose: Promise<void> | undefined;
		runtime = new McpServerRuntime({
			name: "reentrant-close",
			serverInfo: { name: "reentrant-close", version: "1.0.0" },
			observer: (event) => {
				if (event.phase === "close:start") reentrantClose = runtime?.close();
			},
		});

		const close = runtime.close();
		await close;

		expect(reentrantClose).toBe(close);
	});

	it("serves signed multi-round input through the official modern client", async () => {
		const confirmationSchema = fromJsonSchema<{ confirm: boolean }>({
			type: "object",
			properties: { confirm: { type: "boolean" } },
			required: ["confirm"],
		});
		const stateCodec = createRequestStateCodec<{ confirmed: true }>({
			key: new Uint8Array(32).fill(7),
			bind: (context) => context.mcpReq.method,
		});
		const invocations = vi.fn();
		runtime = new McpServerRuntime({
			name: "input-required",
			serverInfo: { name: "input-required", version: "1.0.0" },
			serverOptions: {
				requestState: { verify: (state, context) => stateCodec.verify(state, context) },
			},
			features: [
				(server) => {
					server.registerTool(
						"publish",
						{
							inputSchema: fromJsonSchema<Record<string, never>>({
								type: "object",
								properties: {},
								additionalProperties: false,
							}),
						},
						async (
							_arguments: Record<string, unknown>,
							context: ServerContext,
						): Promise<CallToolResult | InputRequiredResult> => {
							invocations();
							if (context.mcpReq.requestState<{ confirmed: true }>()?.confirmed === true) {
								return { content: [{ type: "text", text: "published" }] };
							}
							const confirmation = acceptedContent(
								context.mcpReq.inputResponses,
								"confirm",
								confirmationSchema,
							);
							if (confirmation?.confirm === true) {
								return inputRequired({
									requestState: await stateCodec.mint({ confirmed: true }, context),
								});
							}
							return inputRequired({
								inputRequests: {
									confirm: inputRequired.elicit({
										message: "Publish?",
										requestedSchema: confirmationSchema,
									}),
								},
							});
						},
					);
				},
			],
		});
		client = new Client(
			{ name: "interactive-host", version: "1.0.0" },
			{
				capabilities: { elicitation: { form: {} } },
				versionNegotiation: { mode: "auto" },
				inputRequired: { maxRounds: 3 },
			},
		);
		client.setRequestHandler("elicitation/create", async () => ({
			action: "accept",
			content: { confirm: true },
		}));
		await client.connect(
			new StreamableHTTPClientTransport(new URL("http://input.test/mcp"), {
				fetch: createMcpServerTestFetch(runtime),
			}),
		);

		const result = await client.callTool({ name: "publish", arguments: {} });

		expect(result.content).toEqual([{ type: "text", text: "published" }]);
		expect(invocations).toHaveBeenCalledTimes(3);
	});

	it("isolates observer failures from server construction", async () => {
		const observer = vi.fn(() => {
			throw new Error("telemetry unavailable");
		});
		runtime = new McpServerRuntime({
			name: "observed",
			serverInfo: { name: "observed", version: "1.0.0" },
			observer,
		});

		await expect(runtime.createServer({ era: "modern" })).resolves.toBeDefined();
		expect(observer).toHaveBeenCalledWith(expect.objectContaining({ phase: "build:success" }));
	});

	it("observes asynchronous error-reporter rejection without changing the reported failure", async () => {
		const reportingFailure = new Error("reporting backend unavailable");
		const onError = vi.fn(async () => {
			throw reportingFailure;
		});
		runtime = new McpServerRuntime({
			name: "async-error-reporter",
			serverInfo: { name: "async-error-reporter", version: "1.0.0" },
			features: [() => Promise.reject(new Error("feature failed"))],
			onError,
		});

		await expect(runtime.createServer({ era: "modern" })).rejects.toThrow("feature failed");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(onError).toHaveBeenCalledOnce();
	});

	it("closes a partially configured SDK server when a later feature fails", async () => {
		const closeServer = vi.fn(async () => undefined);
		const firstFeature = vi.fn((server: import("../src/index.ts").McpServer) => {
			vi.spyOn(server, "close").mockImplementation(closeServer);
		});
		runtime = new McpServerRuntime({
			name: "build-rollback",
			serverInfo: { name: "build-rollback", version: "1.0.0" },
			features: [firstFeature, () => Promise.reject(new Error("feature failed"))],
		});

		await expect(runtime.createServer({ era: "modern" })).rejects.toThrow("feature failed");

		expect(firstFeature).toHaveBeenCalledOnce();
		expect(closeServer).toHaveBeenCalledOnce();
	});

	it("rolls back a server build when shutdown wins during an async feature", async () => {
		let releaseFeature: (() => void) | undefined;
		let enterFeature: (() => void) | undefined;
		const featureEntered = new Promise<void>((resolve) => {
			enterFeature = resolve;
		});
		const featurePending = new Promise<void>((resolve) => {
			releaseFeature = resolve;
		});
		const closeServer = vi.fn(async () => undefined);
		runtime = new McpServerRuntime({
			name: "build-shutdown-race",
			serverInfo: { name: "build-shutdown-race", version: "1.0.0" },
			features: [
				async (server) => {
					vi.spyOn(server, "close").mockImplementation(closeServer);
					enterFeature?.();
					await featurePending;
				},
			],
		});
		const buildPending = runtime.createServer({ era: "modern" });
		await featureEntered;
		const closePending = runtime.close();
		releaseFeature?.();

		await expect(buildPending).rejects.toMatchObject({ code: "RUNTIME_CLOSED" });
		await expect(closePending).resolves.toBeUndefined();
		expect(closeServer).toHaveBeenCalledOnce();
	});

	it("rolls back a server when a build-success observer starts shutdown", async () => {
		const closeServer = vi.fn(async () => undefined);
		let observerClose: Promise<void> | undefined;
		runtime = new McpServerRuntime({
			name: "build-observer-close",
			serverInfo: { name: "build-observer-close", version: "1.0.0" },
			features: [
				(server) => {
					vi.spyOn(server, "close").mockImplementation(closeServer);
				},
			],
			observer: (event) => {
				if (event.phase === "build:success") observerClose = runtime?.close();
			},
		});

		await expect(runtime.createServer({ era: "modern" })).rejects.toMatchObject({
			code: "RUNTIME_CLOSED",
		});
		await expect(observerClose).resolves.toBeUndefined();
		expect(closeServer).toHaveBeenCalledOnce();
	});

	it("preserves request middleware through the Node adapter", async () => {
		const middleware = vi.fn(async () => new Response("blocked", { status: 418 }));
		runtime = new McpServerRuntime({
			name: "node-adapter",
			serverInfo: { name: "node-adapter", version: "1.0.0" },
			middleware: [middleware],
		});
		const handler = runtime.toNodeHandler();
		const server = createHttpServer((request, response) => {
			void handler(toIncomingMessageLike(request), toServerResponseLike(response));
		});

		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new TypeError("Expected the test server to bind a TCP address.");
		}

		try {
			const response = await fetch(`http://127.0.0.1:${String(address.port)}/mcp`);
			expect(response.status).toBe(418);
			expect(await response.text()).toBe("blocked");
			expect(middleware).toHaveBeenCalledOnce();
		} finally {
			server.close();
			await once(server, "close");
		}
	});

	it("owns active stdio handles until runtime shutdown", async () => {
		const closeTransport = vi.fn(async () => undefined);
		const transport: Transport = {
			start: vi.fn(async () => undefined),
			send: vi.fn(async () => undefined),
			close: closeTransport,
		};
		runtime = new McpServerRuntime({
			name: "stdio-owner",
			serverInfo: { name: "stdio-owner", version: "1.0.0" },
		});
		const handle = runtime.serveStdio({ transport });

		await runtime.close();

		expect(closeTransport).toHaveBeenCalledOnce();
		await handle.close();
		expect(closeTransport).toHaveBeenCalledOnce();
		expect(() => runtime?.serveStdio({ transport })).toThrowError(
			expect.objectContaining({ code: "RUNTIME_CLOSED" }),
		);
	});

	it("bounds a non-cooperative stdio close by the runtime shutdown deadline", async () => {
		const closeTransport = vi.fn(() => new Promise<void>(() => undefined));
		const transport: Transport = {
			start: vi.fn(async () => undefined),
			send: vi.fn(async () => undefined),
			close: closeTransport,
		};
		runtime = new McpServerRuntime({
			name: "stdio-shutdown-timeout",
			serverInfo: { name: "stdio-shutdown-timeout", version: "1.0.0" },
			shutdownTimeoutMs: 10,
		});
		runtime.serveStdio({ transport });

		const closingRuntime = runtime;
		runtime = undefined;
		await expect(closingRuntime.close()).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof AggregateError &&
				error.errors.some(
					(candidate) =>
						candidate instanceof Error && candidate.message.includes("timed out after 10ms"),
				),
		);
		expect(closeTransport).toHaveBeenCalledOnce();
	});

	it("keeps client protocol claims out of HTTP lifecycle metadata", async () => {
		const contexts: unknown[] = [];
		runtime = new McpServerRuntime({
			name: "safe-metadata",
			serverInfo: { name: "safe-metadata", version: "1.0.0" },
			middleware: [
				async (operation) => {
					contexts.push(operation.context);
					return new Response(null, { status: 204 });
				},
			],
		});

		await runtime.fetch(
			new Request("https://test.local/mcp", {
				method: "POST",
				headers: {
					"mcp-protocol-version": "2026-07-28",
					"mcp-method": "resources/read",
					"mcp-name": "file:///tenants/private/report.txt",
				},
			}),
		);
		await runtime.fetch(
			new Request("https://test.local/mcp", {
				method: "POST",
				headers: { "mcp-method": "tools/call", "mcp-name": "spoofed" },
			}),
		);

		expect(contexts).toHaveLength(2);
		expect(contexts[0]).toEqual(
			expect.objectContaining({
				operation: expect.objectContaining({
					name: "mcp.http",
					attributes: expect.not.objectContaining({ "mcp.name": expect.anything() }),
				}),
			}),
		);
		expect(contexts[1]).toEqual(
			expect.objectContaining({ operation: expect.objectContaining({ name: "mcp.http" }) }),
		);
	});
});

function toIncomingMessageLike(request: IncomingMessage): NodeIncomingMessageLike {
	return {
		...(request.method === undefined ? {} : { method: request.method }),
		...(request.url === undefined ? {} : { url: request.url }),
		headers: request.headers,
		[Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
	};
}

function toServerResponseLike(response: ServerResponse): NodeServerResponseLike {
	return {
		writeHead: (statusCode, headers) => response.writeHead(statusCode, headers),
		write: (chunk) => response.write(chunk),
		end: (chunk) => response.end(chunk),
		on: (event, listener) =>
			response.on(event, (...arguments_: unknown[]) => listener(...arguments_)),
		destroyed: response.destroyed,
	};
}

describe("McpServerRegistry", () => {
	it("rejects duplicate names", async () => {
		const registry = new McpServerRegistry([
			{ name: "api", serverInfo: { name: "api", version: "1.0.0" } },
		]);
		expect(() =>
			registry.register({ name: "api", serverInfo: { name: "other", version: "1.0.0" } }),
		).toThrow(/already registered/);
		await registry.close();
	});

	it("rejects registration and returns the same promise during reentrant close", async () => {
		const registry = new McpServerRegistry();
		let reentrantClose: Promise<void> | undefined;
		let registrationError: unknown;
		registry.register({
			name: "closing",
			serverInfo: { name: "closing", version: "1.0.0" },
			observer: (event) => {
				if (event.phase !== "close:start") return;
				reentrantClose = registry.close();
				try {
					registry.register({
						name: "late",
						serverInfo: { name: "late", version: "1.0.0" },
					});
				} catch (error) {
					registrationError = error;
				}
			},
		});

		const close = registry.close();
		await close;

		expect(reentrantClose).toBe(close);
		expect(registrationError).toMatchObject({ code: "RUNTIME_CLOSED" });
		expect(registry.list()).toEqual([]);
	});
});
