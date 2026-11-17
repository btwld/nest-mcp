import {
	createMcpHandler,
	McpServer,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { FetchLike } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
	detectMcpClientAuthentication,
	type McpClientAuthenticationDetectionInput,
} from "../src/oauth/index.ts";

const serverUrl = "https://tools.example.test/mcp";
const resourceMetadataUrl = "https://tools.example.test/.well-known/oauth-protected-resource/mcp";
const issuer = "https://login.example.test";
const issuerMetadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
const defaults = {
	serverUrl,
	signal: new AbortController().signal,
	endpointPolicy: () => true,
	timeoutMs: 1_000,
};

describe("passive MCP authentication detection", () => {
	it.each(["json", "sse"] as const)(
		"proves anonymous modern MCP with official %s responses and no feature invocation",
		async (responseMode) => {
			const tool = vi.fn(() => ({ content: [] }));
			const handler = createMcpHandler(
				() => {
					const server = new McpServer({ name: "fixture", version: "1" });
					server.registerTool("never-invoke", {}, tool);
					return server;
				},
				{ legacy: "reject", responseMode },
			);
			const requests: Request[] = [];
			try {
				const result = await detectMcpClientAuthentication({
					...defaults,
					fetch: async (url, init) => {
						const request = new Request(url, init);
						requests.push(request.clone());
						return handler.fetch(request);
					},
				});
				expect(result).toEqual({
					kind: "anonymous",
					protocolVersion: "2026-07-28",
					protocolEra: "modern",
					serverInfo: { name: "fixture", version: "1" },
				});
				expect(Object.isFrozen(result)).toBe(true);
				expect(requests).toHaveLength(1);
				expect(await requests[0]?.json()).toMatchObject({ method: "server/discover" });
				expect(requests[0]?.headers.get("Mcp-Method")).toBe("server/discover");
				expect(requests[0]?.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
				assertCredentialFree(requests[0]);
				expect(tool).not.toHaveBeenCalled();
			} finally {
				await handler.close();
			}
		},
	);

	it.each([true, false])(
		"completes official legacy handshake, cancels GET, and terminates session (JSON=%s)",
		async (enableJsonResponse) => {
			const server = new McpServer({ name: "legacy", version: "1" });
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => "test-session",
				enableJsonResponse,
			});
			await server.connect(transport);
			const requests: Request[] = [];
			try {
				expect(
					await detectMcpClientAuthentication({
						...defaults,
						fetch: async (url, init) => {
							const request = new Request(url, init);
							requests.push(request.clone());
							return transport.handleRequest(request);
						},
					}),
				).toEqual({
					kind: "anonymous",
					protocolVersion: "2025-11-25",
					protocolEra: "legacy",
					serverInfo: { name: "legacy", version: "1" },
				});
				expect(requests.map(({ method }) => method)).toEqual([
					"POST",
					"POST",
					"POST",
					"GET",
					"DELETE",
				]);
				expect(await requests[1]?.json()).toMatchObject({
					method: "initialize",
					params: { protocolVersion: "2025-11-25" },
				});
				expect(requests[1]?.headers.get("MCP-Protocol-Version")).toBeNull();
				expect(await requests[2]?.json()).toMatchObject({ method: "notifications/initialized" });
				expect(requests.at(-1)?.headers.get("mcp-session-id")).toBe("test-session");
				expect(requests.at(-1)?.headers.get("mcp-protocol-version")).toBe("2025-11-25");
				requests.forEach(assertCredentialFree);
			} finally {
				await server.close();
				await transport.close();
			}
		},
	);

	it("does not wait for an SSE stream to end after the valid response, and cancels it", async () => {
		const cancel = vi.fn();
		const result = await detectMcpClientAuthentication({
			...defaults,
			fetch: modernFetch((id) =>
				sseResponse(
					[
						": keep-alive\r\n\r\n",
						`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: modernResult() })}\r\n\r\n`,
					],
					cancel,
				),
			),
		});
		expect(result.kind).toBe("anonymous");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it.each([
		{ stage: "get", status: 405, kind: "anonymous" },
		{ stage: "initialized", status: 401, kind: "oauth-required" },
		{ stage: "get", status: 401, kind: "oauth-required" },
		{ stage: "delete", status: 405, kind: "anonymous" },
		{ stage: "delete", status: 401, kind: "indeterminate" },
		{ stage: "initialized", status: 200, kind: "indeterminate" },
	] as const)(
		"handles legacy $stage HTTP $status and still terminates its own session",
		async ({ stage, status, kind }) => {
			const server = new McpServer({ name: "legacy", version: "1" });
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => "test-session",
			});
			await server.connect(transport);
			const metadataFetch = vi.fn(oauthFetch({}));
			const requests: Request[] = [];
			try {
				const result = await detectMcpClientAuthentication({
					...defaults,
					discoveryFetch: metadataFetch,
					fetch: async (url, init) => {
						const request = new Request(url, init);
						requests.push(request.clone());
						const rpc: unknown =
							request.method === "POST" ? await request.clone().json() : undefined;
						if (
							(stage === "get" && request.method === "GET") ||
							(stage === "delete" && request.method === "DELETE") ||
							(stage === "initialized" &&
								typeof rpc === "object" &&
								rpc !== null &&
								"method" in rpc &&
								rpc.method === "notifications/initialized")
						) {
							return new Response(null, {
								status,
								headers:
									status === 401
										? { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` }
										: {},
							});
						}
						return transport.handleRequest(request);
					},
				});
				expect(result.kind).toBe(kind);
				expect(requests.at(-1)?.method).toBe("DELETE");
				expect(requests.at(-1)?.headers.get("mcp-session-id")).toBe("test-session");
				requests.forEach(assertCredentialFree);
				if (kind === "oauth-required") expect(metadataFetch).toHaveBeenCalledTimes(2);
				else expect(metadataFetch).not.toHaveBeenCalled();
			} finally {
				await server.close();
				await transport.close();
			}
		},
	);

	it("uses separate guarded metadata fetch without widening the endpoint-only fetch", async () => {
		const endpointFetch = vi.fn(async (url: Parameters<FetchLike>[0]) => {
			expect(String(url)).toBe(serverUrl);
			return new Response(null, { status: 401 });
		});
		const metadataFetch = vi.fn(oauthFetch({}));
		expect(
			await detectMcpClientAuthentication({
				...defaults,
				fetch: endpointFetch,
				discoveryFetch: metadataFetch,
			}),
		).toMatchObject({ kind: "oauth-required" });
		expect(endpointFetch).toHaveBeenCalledOnce();
		expect(metadataFetch).toHaveBeenCalledTimes(2);
	});

	it("bounds server display fields and drops all other handshake metadata", async () => {
		const detect = (info: unknown) =>
			detectMcpClientAuthentication({
				...defaults,
				fetch: modernFetch((id) =>
					Response.json({
						jsonrpc: "2.0",
						id,
						result: { ...modernResult(), _meta: { "io.modelcontextprotocol/serverInfo": info } },
					}),
				),
			});
		expect(
			await detect({
				name: "server",
				version: "1",
				title: "Display title",
				websiteUrl: "https://extra.example.test",
			}),
		).toEqual({
			kind: "anonymous",
			protocolVersion: "2026-07-28",
			protocolEra: "modern",
			serverInfo: { name: "server", version: "1", title: "Display title" },
		});
		expect(await detect({ name: "x".repeat(257), version: "1" })).not.toHaveProperty("serverInfo");
	});

	it("does not accept a response belonging to a different MCP request", async () => {
		expect(
			await detectMcpClientAuthentication({
				...defaults,
				timeoutMs: 20,
				fetch: modernFetch(() =>
					Response.json({ jsonrpc: "2.0", id: "not-the-probe", result: modernResult() }),
				),
			}),
		).toMatchObject({ kind: "indeterminate", reason: "timeout" });
	});

	it("rejects oversized challenge headers without reading their response body", async () => {
		const cancel = vi.fn();
		expect(
			await detectMcpClientAuthentication({
				...defaults,
				fetch: async () =>
					new Response(new ReadableStream({ cancel }), {
						status: 401,
						headers: { "www-authenticate": "x".repeat(8_193) },
					}),
			}),
		).toMatchObject({ kind: "indeterminate", reason: "response-too-large" });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it.each([401, 403])(
		"requires validated OAuth metadata after %i Bearer and reuses bootstrap scope precedence",
		async (status) => {
			const endpointPolicy = vi.fn(() => true);
			const cancel = vi.fn();
			const requests: Request[] = [];
			const result = await detectMcpClientAuthentication({
				...defaults,
				endpointPolicy,
				fetch: oauthFetch({ status, cancel, requests }),
			});
			expect(result).toMatchObject({
				kind: "oauth-required",
				discovery: { kind: "ready", scopes: ["tools:read"], resource: { resource: serverUrl } },
			});
			expect(cancel).toHaveBeenCalledOnce();
			expect(requests.map(({ method, url }) => [method, url])).toEqual([
				["POST", serverUrl],
				["GET", resourceMetadataUrl],
				["GET", issuerMetadataUrl],
			]);
			requests.forEach(assertCredentialFree);
			expect(endpointPolicy.mock.calls).toHaveLength(4);
		},
	);

	it("supports bare 401 well-known discovery and preserves issuer selection", async () => {
		const fetch = oauthFetch({
			header: null,
			resource: { authorization_servers: [issuer, "https://other.example.test"] },
		});
		expect(await detectMcpClientAuthentication({ ...defaults, fetch })).toMatchObject({
			kind: "oauth-required",
			discovery: { kind: "authorization-server-selection-required" },
		});
	});

	it("preserves strict-protocol incompatibility without attempting enrollment", async () => {
		expect(
			await detectMcpClientAuthentication({
				...defaults,
				fetch: oauthFetch({ authority: { code_challenge_methods_supported: ["plain"] } }),
			}),
		).toMatchObject({
			kind: "oauth-required",
			discovery: { kind: "strict-protocol-unsupported", issues: ["pkce_s256_unsupported"] },
		});
	});

	it.each([
		[401, "Basic realm=private"],
		[401, "ApiKey"],
		[403, null],
		[401, 'Bearer resource_metadata="http://unsafe.example.test/metadata"'],
		[401, 'Bearer scope="unterminated'],
	] as const)(
		"rejects unsupported challenge %i %s without metadata or anonymous fallback",
		async (status, header) => {
			const fetch = vi.fn(
				async () =>
					new Response(null, {
						status,
						headers: header === null ? {} : { "www-authenticate": header },
					}),
			);
			expect(await detectMcpClientAuthentication({ ...defaults, fetch })).toMatchObject({
				kind: "indeterminate",
				reason: "unsupported-authentication",
				httpStatus: status,
			});
			expect(fetch).toHaveBeenCalledOnce();
		},
	);

	it.each([
		{ resource: { resource: "https://unrelated.example.test/" } },
		{ authority: { issuer: "https://unrelated.example.test" } },
		{ metadataStatus: 404 },
		{ metadataStatus: 500 },
	])("never treats absent or invalid OAuth discovery as anonymous: %j", async (options) => {
		expect(
			await detectMcpClientAuthentication({ ...defaults, fetch: oauthFetch(options) }),
		).toMatchObject({ kind: "indeterminate", reason: "oauth-discovery-failed" });
	});

	it("does not fetch rejected metadata endpoints or expose URLs/provider errors", async () => {
		const requests: Request[] = [];
		const result = await detectMcpClientAuthentication({
			...defaults,
			endpointPolicy: () => false,
			fetch: oauthFetch({ requests }),
		});
		expect(result).toEqual({
			kind: "indeterminate",
			reason: "oauth-discovery-failed",
			httpStatus: 401,
			discoveryErrorCode: "MCP_CLIENT_OAUTH_BOOTSTRAP_ENDPOINT_REJECTED",
		});
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("https:");
	});

	it.each([200, 202, 400, 404, 405, 429, 500, 502])(
		"does not classify non-MCP HTTP %i as anonymous",
		async (status) => {
			const result = await detectMcpClientAuthentication({
				...defaults,
				timeoutMs: 30,
				fetch: async () =>
					new Response("<html>login</html>", { status, headers: { "Content-Type": "text/html" } }),
			});
			expect(result.kind).toBe("indeterminate");
		},
	);

	it.each([
		{},
		{ supportedVersions: ["future"], capabilities: {} },
		{ supportedVersions: ["2026-07-28"], capabilities: "invalid" },
	])("rejects malformed/unsupported MCP discovery %j", async (result) => {
		expect(
			await detectMcpClientAuthentication({
				...defaults,
				fetch: modernFetch((id) => Response.json({ jsonrpc: "2.0", id, result })),
			}),
		).toMatchObject({ kind: "indeterminate" });
	});

	it("bounds total JSON and OAuth metadata bytes", async () => {
		for (const fetch of [
			modernFetch((id) => Response.json({ jsonrpc: "2.0", id, result: modernResult() })),
			oauthFetch({}),
		]) {
			expect(
				await detectMcpClientAuthentication({ ...defaults, maxResponseBytes: 20, fetch }),
			).toMatchObject({ kind: "indeterminate", reason: "response-too-large" });
		}
	});

	it("bounds unterminated SSE framing bytes before a valid message", async () => {
		const cancel = vi.fn();
		expect(
			await detectMcpClientAuthentication({
				...defaults,
				maxResponseBytes: 100,
				fetch: modernFetch(() => sseResponse([":" + "x".repeat(101)], cancel)),
			}),
		).toMatchObject({ kind: "indeterminate", reason: "response-too-large" });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("bounds stalled response reads and calls cancel even if fetch ignores AbortSignal", async () => {
		const cancel = vi.fn();
		expect(
			await detectMcpClientAuthentication({
				...defaults,
				timeoutMs: 20,
				fetch: modernFetch(() => sseResponse([], cancel)),
			}),
		).toMatchObject({ kind: "indeterminate", reason: "timeout" });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("bounds stalled fetch and cancels a late response", async () => {
		let finish: (response: Response) => void = () => {};
		const cancel = vi.fn();
		expect(
			await detectMcpClientAuthentication({
				...defaults,
				timeoutMs: 20,
				fetch: () =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			}),
		).toMatchObject({ kind: "indeterminate", reason: "timeout" });
		finish(sseResponse([], cancel));
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
	});

	it("bounds cleanup when a stream's cancel promise never resolves", async () => {
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const started = Date.now();
		expect(
			await detectMcpClientAuthentication({
				...defaults,
				fetch: modernFetch((id) =>
					sseResponse(
						[`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: modernResult() })}\n\n`],
						cancel,
					),
				),
			}),
		).toMatchObject({ kind: "indeterminate", reason: "cleanup-failed" });
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("preserves host cancellation and never starts an already cancelled operation", async () => {
		const reason = new Error("host cancelled");
		const fetch = vi.fn();
		await expect(
			detectMcpClientAuthentication({ ...defaults, fetch, signal: AbortSignal.abort(reason) }),
		).rejects.toBe(reason);
		expect(fetch).not.toHaveBeenCalled();
		const controller = new AbortController();
		await expect(
			detectMcpClientAuthentication({
				...defaults,
				signal: controller.signal,
				fetch: async () => {
					controller.abort(reason);
					return new Response(null);
				},
			}),
		).rejects.toBe(reason);
	});

	it("contains network failures and forbids redirects", async () => {
		expect(
			await detectMcpClientAuthentication({
				...defaults,
				fetch: async () => {
					throw new Error("provider-private-detail");
				},
			}),
		).toEqual({ kind: "indeterminate", reason: "network-error" });
		const response = new Response(null);
		Object.defineProperty(response, "redirected", { value: true });
		expect(
			await detectMcpClientAuthentication({ ...defaults, fetch: async () => response }),
		).toMatchObject({ kind: "indeterminate", reason: "endpoint-rejected" });
	});

	it.each([
		{ serverUrl: "https://user:password@example.test/mcp" },
		{ serverUrl: "file:///etc/passwd" },
		{ timeoutMs: 0 },
		{ maxResponseBytes: 1_048_577 },
	])("rejects invalid input %j before fetch", async (overrides) => {
		const fetch = vi.fn();
		expect(await detectMcpClientAuthentication({ ...defaults, fetch, ...overrides })).toEqual({
			kind: "indeterminate",
			reason: "invalid-options",
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});

function modernResult() {
	return { supportedVersions: ["2026-07-28"], capabilities: {} };
}

function modernFetch(response: (id: unknown) => Response): FetchLike {
	return async (_url, init) => {
		if (typeof init?.body !== "string") throw new Error("Expected string request body");
		const body: unknown = JSON.parse(init.body);
		if (typeof body !== "object" || body === null || !("id" in body))
			throw new Error("Expected RPC request");
		return response(body.id);
	};
}

function sseResponse(chunks: string[], cancel: () => void | PromiseLike<void>): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
			},
			cancel,
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function assertCredentialFree(request: Request | undefined) {
	expect(request).toBeDefined();
	expect(request?.credentials).toBe("omit");
	expect(request?.redirect).toBe("error");
	expect(request?.cache).toBe("no-store");
	for (const header of ["authorization", "cookie", "proxy-authorization"])
		expect(request?.headers.get(header)).toBeNull();
}

function oauthFetch(options: {
	status?: number;
	header?: string | null;
	cancel?: () => void | PromiseLike<void>;
	requests?: Request[];
	resource?: Record<string, unknown>;
	authority?: Record<string, unknown>;
	metadataStatus?: number;
}): McpClientAuthenticationDetectionInput["fetch"] {
	return async (url, init) => {
		options.requests?.push(new Request(url, init));
		if (String(url) === serverUrl)
			return new Response(
				new ReadableStream(options.cancel === undefined ? {} : { cancel: options.cancel }),
				{
					status: options.status ?? 401,
					headers:
						options.header === null
							? {}
							: {
									"www-authenticate":
										options.header ??
										`Bearer resource_metadata="${resourceMetadataUrl}", scope="tools:read"`,
								},
				},
			);
		if (String(url) === resourceMetadataUrl)
			return Response.json(
				{
					resource: serverUrl,
					authorization_servers: [issuer],
					scopes_supported: ["fallback"],
					...options.resource,
				},
				{ status: options.metadataStatus ?? 200 },
			);
		if (String(url) === issuerMetadataUrl)
			return Response.json({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
				...options.authority,
			});
		return new Response(null, { status: 404 });
	};
}
