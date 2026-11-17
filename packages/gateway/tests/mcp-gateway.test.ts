import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Tool } from "@modelcontextprotocol/server";
import {
	McpAuthorizationError,
	McpMiddlewareReentryError,
	allowMcpOperation,
	denyMcpOperation,
} from "@nest-mcp/core";
import { McpServerRuntime } from "@nest-mcp/server";
import type { AuthInfo, CallToolResult } from "@nest-mcp/server";
import { describe, expect, it, vi } from "vitest";
import {
	GatewayNameCodec,
	McpGateway,
	allowAllMcpGatewayPolicy,
	createMcpGatewayPassthroughMiddleware,
	defineMcpGatewayTransform,
} from "../src/index.ts";
import type {
	McpGatewayLifecycleObserver,
	McpGatewayCallToolOptions,
	McpGatewayDiscoveryCache,
	McpGatewayDiscoverySnapshot,
	McpGatewayPolicy,
} from "../src/index.ts";
import { McpGatewayTestClient } from "../src/testing/index.ts";

const TOOL = {
	name: "echo",
	description: "Echo input",
	inputSchema: {
		type: "object",
		properties: { value: { type: "string" } },
	},
} satisfies Tool;

describe("McpGateway", () => {
	it("serves projected tools through an official MCP v2 connection", async () => {
		const upstream = new McpGatewayTestClient([TOOL], {
			echo: (arguments_) => ({
				content: [{ type: "text", text: String(arguments_?.value) }],
			}),
		});
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: upstream }],
			policy: allowAllMcpGatewayPolicy(),
		});
		const runtime = new McpServerRuntime({
			name: "gateway",
			serverInfo: { name: "gateway", version: "1.0.0" },
			features: [gateway.asServerFeature()],
		});
		const server = await runtime.createServer({ era: "modern" });
		const client = new Client({ name: "gateway-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const listed = await client.listTools();
			expect(listed.tools).toHaveLength(1);
			expect(new GatewayNameCodec().decode(listed.tools[0]!.name)).toEqual({
				upstreamName: "primary",
				toolName: "echo",
			});

			const result = await client.callTool({
				name: listed.tools[0]!.name,
				arguments: { value: "through-the-gateway" },
			});
			expect(result.content).toEqual([{ type: "text", text: "through-the-gateway" }]);
		} finally {
			await client.close();
			await server.close();
			await runtime.close();
		}
	});

	it("routes identical tool names to the correct namespace", async () => {
		const first = new McpGatewayTestClient([TOOL], {
			echo: () => ({ content: [{ type: "text", text: "first" }] }),
		});
		const second = new McpGatewayTestClient([TOOL], {
			echo: () => ({ content: [{ type: "text", text: "second" }] }),
		});
		const gateway = new McpGateway({
			upstreams: [
				{ name: "first", client: first },
				{ name: "second", client: second },
			],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});

		const tools = await gateway.listProjectedTools();
		expect(tools).toHaveLength(2);
		expect(new Set(tools.map((tool) => tool.projectedName)).size).toBe(2);

		const secondRoute = tools.find((tool) => tool.upstreamName === "second");
		expect(secondRoute).toBeDefined();
		const result = await gateway.callTool(secondRoute!.projectedName, { value: "hello" });

		expect(result.content).toEqual([{ type: "text", text: "second" }]);
		expect(first.calls).toHaveLength(0);
		expect(second.calls).toEqual([{ name: "echo", arguments: { value: "hello" } }]);
	});

	it("filters discovery and re-authorizes immediately before invocation", async () => {
		let invocationAllowed = true;
		const client = new McpGatewayTestClient([
			TOOL,
			{ ...TOOL, name: "admin", description: "Administrative action" },
		]);
		const policy: McpGatewayPolicy = {
			authorize(operation) {
				if (operation.input.action === "discover" && operation.input.toolName === "admin") {
					return denyMcpOperation("Administrative tools are hidden.", {
						policy: "test-policy",
					});
				}
				if (operation.input.action === "invoke" && !invocationAllowed) {
					return denyMcpOperation("Invocations are currently disabled.", {
						policy: "test-policy",
					});
				}
				return allowMcpOperation({ policy: "test-policy" });
			},
		};
		const codec = new GatewayNameCodec();
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client }],
			policy,
			nameCodec: codec,
			authorizationContextResolver: () => "principal-a",
		});

		const listed = await gateway.listProjectedTools();
		expect(listed.map((tool) => tool.toolName)).toEqual(["echo"]);
		await expect(gateway.callTool(codec.encode("primary", "admin"), {})).rejects.toBeInstanceOf(
			McpAuthorizationError,
		);

		invocationAllowed = false;
		await expect(
			gateway.callTool(listed[0]!.projectedName, { value: "blocked" }),
		).rejects.toMatchObject({
			code: "MCP_AUTHORIZATION_DENIED",
			decision: { reason: "Invocations are currently disabled." },
		});
		expect(client.calls).toHaveLength(0);
	});

	it("authorizes invocation before user middleware can short-circuit", async () => {
		const client = new McpGatewayTestClient([TOOL]);
		let invocationMiddlewareCalled = false;
		const middleware = defineMcpGatewayTransform("gateway.invocation", async () => {
			invocationMiddlewareCalled = true;
			return { content: [{ type: "text", text: "middleware bypass" }] };
		});
		const policy: McpGatewayPolicy = {
			authorize(operation) {
				return operation.input.action === "invoke"
					? denyMcpOperation("Invocation denied.")
					: allowMcpOperation();
			},
		};
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client }],
			policy,
			middleware: [middleware],
			authorizationContextResolver: () => "principal-a",
		});

		const [tool] = await gateway.listProjectedTools();
		await expect(gateway.callTool(tool!.projectedName, {})).rejects.toBeInstanceOf(
			McpAuthorizationError,
		);

		expect(invocationMiddlewareCalled).toBe(false);
		expect(client.calls).toHaveLength(0);
	});

	it("forces manual upstream MRTR and rejects input_required without auto-fulfilling", async () => {
		const callTool = vi.fn(
			(_params: { readonly name: string }, _options?: { readonly allowInputRequired?: true }) => ({
				resultType: "input_required" as const,
				requestState: "opaque-state",
				inputRequests: {},
			}),
		);
		const gateway = new McpGateway({
			upstreams: [
				{
					name: "primary",
					client: { listTools: () => ({ tools: [TOOL] }), callTool },
				},
			],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});
		const [tool] = await gateway.listProjectedTools();

		await expect(gateway.callTool(tool!.projectedName, {})).rejects.toMatchObject({
			code: "UPSTREAM_INPUT_REQUIRED",
		});
		expect(callTool.mock.calls[0]?.[1]).toMatchObject({ allowInputRequired: true });
	});

	it("exposes a token-free principal while retaining auth for client resolution", async () => {
		const authInfo = {
			token: "super-secret-token",
			clientId: "artifact-agent",
			scopes: ["tools:read", "tools:call"],
			expiresAt: 2_000_000_000,
			resource: new URL("https://gateway.example.test/mcp"),
			extra: { tenantId: "secret-tenant-metadata" },
		} satisfies AuthInfo;
		const client = new McpGatewayTestClient([TOOL]);
		const visiblePrincipals: unknown[] = [];
		const resolverAuth: Array<AuthInfo | undefined> = [];
		const policy: McpGatewayPolicy = {
			authorize(operation) {
				visiblePrincipals.push(operation.context.principal);
				return allowMcpOperation();
			},
		};
		const gateway = new McpGateway({
			upstreams: [
				{
					name: "primary",
					client: (context) => {
						resolverAuth.push(context.authInfo);
						return client;
					},
				},
			],
			policy,
			lifecycleObserver: {
				onEvent(event) {
					visiblePrincipals.push(event.context.principal);
				},
			},
			authorizationContextResolver: () => "principal-a",
		});

		const [tool] = await gateway.listProjectedTools({ authInfo });
		await gateway.callTool(tool!.projectedName, {}, { authInfo });

		for (const principal of visiblePrincipals) {
			expect(principal).toEqual({
				clientId: "artifact-agent",
				scopes: ["tools:read", "tools:call"],
				expiresAt: 2_000_000_000,
				resource: "https://gateway.example.test/mcp",
			});
			expect(principal).not.toHaveProperty("token");
			expect(principal).not.toHaveProperty("extra");
		}
		expect(resolverAuth).not.toHaveLength(0);
		expect(resolverAuth.every((auth) => auth === authInfo)).toBe(true);
	});

	it("prefers the pre-resolved subject and tenant principal over basic auth projection", async () => {
		const principals: unknown[] = [];
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: new McpGatewayTestClient([TOOL]) }],
			policy: {
				authorize(operation) {
					principals.push(operation.context.principal);
					return allowMcpOperation();
				},
			},
			authorizationContextResolver: () => "principal-a",
		});
		await gateway.listProjectedTools({
			authInfo: { token: "secret", clientId: "oauth-client", scopes: ["tools:read"] },
			principal: {
				clientId: "oauth-client",
				scopes: ["tools:read"],
				subject: "user-42",
				tenantId: "tenant-acme",
			},
		});

		expect(principals).toEqual([
			{
				clientId: "oauth-client",
				scopes: ["tools:read"],
				subject: "user-42",
				tenantId: "tenant-acme",
			},
		]);
	});

	it("strips arbitrary upstream metadata and exposes only bounded projected routing metadata", async () => {
		const secretTool = {
			...TOOL,
			_meta: {
				token: "do-not-forward",
				vendor: { rawUpstreamUri: "https://internal.example.test/private" },
			},
		} satisfies Tool;
		const gateway = new McpGateway({
			upstreams: [{ name: "sensitive-topology", client: new McpGatewayTestClient([secretTool]) }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});
		const [projected] = await gateway.listProjectedTools();

		expect(projected?.definition["_meta"]).toEqual({
			"nest-mcp/gateway": {
				kind: "tool",
				projectedName: projected?.projectedName,
			},
		});
		expect(JSON.stringify(projected?.definition)).not.toContain("do-not-forward");
		expect(JSON.stringify(projected?.definition)).not.toContain("sensitive-topology");
	});

	it("walks structural-client discovery pages and preserves cursors", async () => {
		const secondTool = { ...TOOL, name: "sum" } satisfies Tool;
		const listTools = vi.fn((params?: { readonly cursor?: string }) =>
			params?.cursor === undefined
				? { tools: [TOOL], nextCursor: "page-2" }
				: { tools: [secondTool] },
		);
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});

		const tools = await gateway.listProjectedTools();

		expect(tools.map((tool) => tool.toolName)).toEqual(["echo", "sum"]);
		expect(listTools.mock.calls.map(([params]) => params)).toEqual([
			undefined,
			{ cursor: "page-2" },
		]);
	});

	it("rejects repeated discovery cursors and page-limit overruns", async () => {
		const repeatedCursor = vi.fn((params?: { readonly cursor?: string }) => ({
			tools: [{ ...TOOL, name: params?.cursor === undefined ? "first" : "second" }],
			nextCursor: "repeat",
		}));
		const looping = new McpGateway({
			upstreams: [{ name: "looping", client: { listTools: repeatedCursor, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});

		await expect(looping.listProjectedTools()).rejects.toMatchObject({
			code: "INVALID_DISCOVERY",
			message: expect.stringContaining("repeated discovery cursor"),
		});
		expect(repeatedCursor).toHaveBeenCalledTimes(2);

		const limited = new McpGateway({
			upstreams: [
				{
					name: "limited",
					client: {
						listTools: vi.fn(() => ({ tools: [TOOL], nextCursor: "more" })),
						callTool: vi.fn(),
					},
				},
			],
			policy: allowAllMcpGatewayPolicy(),
			discoveryMaxPages: 1,
			authorizationContextResolver: () => "principal-a",
		});
		await expect(limited.listProjectedTools()).rejects.toMatchObject({
			code: "INVALID_DISCOVERY",
			message: expect.stringContaining("exceeded the 1 page discovery limit"),
		});
	});

	it("rejects oversized structural discovery cursors before retaining or forwarding them", async () => {
		const listTools = vi.fn(() => ({ tools: [TOOL], nextCursor: "x".repeat(33) }));
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			discoveryMaxStringBytes: 32,
			authorizationContextResolver: () => "principal-a",
		});

		await expect(gateway.listProjectedTools()).rejects.toMatchObject({
			code: "INVALID_DISCOVERY",
			message: expect.stringContaining("discovery cursor exceeding 32 UTF-8 bytes"),
		});
		expect(listTools).toHaveBeenCalledTimes(1);
	});

	it("rejects oversized and excessively deep discovery before caching", async () => {
		const oversized = new McpGateway({
			upstreams: [
				{
					name: "oversized",
					client: {
						listTools: () => ({ tools: [{ ...TOOL, description: "x".repeat(512) }] }),
						callTool: vi.fn(),
					},
				},
			],
			policy: allowAllMcpGatewayPolicy(),
			discoveryMaxItemBytes: 128,
			authorizationContextResolver: () => "principal-a",
		});
		await expect(oversized.listProjectedTools()).rejects.toMatchObject({
			code: "INVALID_DISCOVERY",
			message: expect.stringContaining("discovery item exceeding"),
		});

		const deeplyNested: Record<string, unknown> = {};
		let cursor = deeplyNested;
		for (let index = 0; index < 8; index += 1) {
			const next: Record<string, unknown> = {};
			cursor.next = next;
			cursor = next;
		}
		const deep = new McpGateway({
			upstreams: [
				{
					name: "deep",
					client: {
						listTools: () => ({ tools: [{ ...TOOL, _meta: deeplyNested }] }),
						callTool: vi.fn(),
					},
				},
			],
			policy: allowAllMcpGatewayPolicy(),
			discoveryMaxDepth: 4,
			authorizationContextResolver: () => "principal-a",
		});
		await expect(deep.listProjectedTools()).rejects.toMatchObject({
			code: "INVALID_DISCOVERY",
			message: expect.stringContaining("deeper than 4 levels"),
		});
	});

	it("keeps middleware and lifecycle hooks around upstream work", async () => {
		const client = new McpGatewayTestClient([TOOL]);
		const middlewareEvents: string[] = [];
		const lifecycleEvents: string[] = [];
		const middleware = createMcpGatewayPassthroughMiddleware(async (operation, next) => {
			middlewareEvents.push(`before:${operation.input.type}`);
			await next();
			middlewareEvents.push(`after:${operation.input.type}`);
		});
		const lifecycleObserver: McpGatewayLifecycleObserver = {
			onEvent(event) {
				lifecycleEvents.push(`${event.type}:${event.context.operation.name}`);
			},
		};
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client }],
			policy: allowAllMcpGatewayPolicy(),
			middleware: [middleware],
			lifecycleObserver,
			authorizationContextResolver: () => "principal-a",
		});

		const [tool] = await gateway.listProjectedTools();
		await gateway.callTool(tool!.projectedName, {});

		expect(middlewareEvents).toEqual([
			"before:gateway.discovery",
			"after:gateway.discovery",
			"before:gateway.discovery",
			"after:gateway.discovery",
			"before:gateway.invocation",
			"after:gateway.invocation",
		]);
		expect(lifecycleEvents).toEqual([
			"operation.started:tools/list",
			"operation.succeeded:tools/list",
			"operation.started:tools/list",
			"operation.succeeded:tools/list",
			"operation.started:tools/call",
			"operation.succeeded:tools/call",
		]);
	});

	it("transforms one exact gateway result after authorization without dropping official fields", async () => {
		const structuredContent = { echoed: true };
		const client = new McpGatewayTestClient([TOOL], {
			echo: () => ({
				content: [{ type: "text", text: "upstream" }],
				structuredContent,
				_meta: { untrustedUpstreamTrace: "removed" },
			}),
		});
		const authorizationOrder: string[] = [];
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client }],
			policy: {
				authorize(operation) {
					if (operation.input.action === "invoke") authorizationOrder.push("authorize");
					return allowMcpOperation();
				},
			},
			middleware: [
				defineMcpGatewayTransform("gateway.invocation", async (operation, next) => {
					authorizationOrder.push("transform");
					expect(operation.input.toolName).toBe("echo");
					const result = await next();
					expect(result["_meta"]).toBeUndefined();
					return {
						...result,
						content: [...result.content, { type: "text", text: "transformed" }],
						_meta: { trustedGatewayTrace: "trace-1" },
					};
				}),
			],
			authorizationContextResolver: () => "principal-a",
		});
		const [tool] = await gateway.listProjectedTools();
		authorizationOrder.length = 0;

		const result = await gateway.callTool(tool!.projectedName, {});

		expect(authorizationOrder).toEqual(["authorize", "transform"]);
		expect(result.content).toEqual([
			{ type: "text", text: "upstream" },
			{ type: "text", text: "transformed" },
		]);
		expect(result.structuredContent).toBe(structuredContent);
		expect(result["_meta"]).toEqual({ trustedGatewayTrace: "trace-1" });
	});

	it("keeps exact gateway continuations downstream of broad transforming middleware", async () => {
		const client = new McpGatewayTestClient([TOOL], {
			echo: () => ({ content: [{ type: "text", text: "upstream" }] }),
		});
		const mismatchedResult: McpGatewayDiscoverySnapshot = {
			discoveredAt: 0,
			tools: [],
			prompts: [],
			resources: [],
			resourceTemplates: [],
		};
		let exactNextResult: CallToolResult | undefined;
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client }],
			policy: allowAllMcpGatewayPolicy(),
			middleware: [
				defineMcpGatewayTransform("gateway.invocation", async (_operation, next) => {
					exactNextResult = await next();
					return exactNextResult;
				}),
				async (operation, next) => {
					const result = await next();
					return operation.input.type === "gateway.invocation" ? mismatchedResult : result;
				},
			],
			authorizationContextResolver: () => "principal-a",
		});
		const [tool] = await gateway.listProjectedTools();

		await expect(gateway.callTool(tool!.projectedName, {})).rejects.toMatchObject({
			code: "INVALID_INVOCATION_RESULT",
		});
		expect(exactNextResult).toEqual({ content: [{ type: "text", text: "upstream" }] });
	});

	it("observes transform-side aborts as cancellation and retains next-once enforcement", async () => {
		const client = new McpGatewayTestClient([TOOL]);
		const controller = new AbortController();
		const abortReason = new DOMException("cancel transform", "AbortError");
		const lifecycleEvents: Array<{ type: string; name: string }> = [];
		let mode: "abort" | "reenter" = "abort";
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client }],
			policy: allowAllMcpGatewayPolicy(),
			middleware: [
				defineMcpGatewayTransform("gateway.invocation", async (_operation, next) => {
					const result = await next();
					if (mode === "abort") {
						controller.abort(abortReason);
						return result;
					}
					return next();
				}),
			],
			lifecycleObserver: {
				onEvent(event) {
					lifecycleEvents.push({ type: event.type, name: event.context.operation.name });
				},
			},
			authorizationContextResolver: () => "principal-a",
		});
		const [tool] = await gateway.listProjectedTools();
		lifecycleEvents.length = 0;

		await expect(
			gateway.callTool(tool!.projectedName, {}, { signal: controller.signal }),
		).rejects.toBe(abortReason);
		expect(
			lifecycleEvents.filter((event) => event.name === "tools/call").map((event) => event.type),
		).toEqual(["operation.started", "operation.cancelled"]);

		mode = "reenter";
		await expect(gateway.callTool(tool!.projectedName, {})).rejects.toBeInstanceOf(
			McpMiddlewareReentryError,
		);
	});

	it("uses separate cache entries for separate principals", async () => {
		const listTools = vi
			.fn()
			.mockResolvedValueOnce({ tools: [{ ...TOOL, name: "alice-tool" }] })
			.mockResolvedValueOnce({ tools: [{ ...TOOL, name: "bob-tool" }] });
		const client = {
			listTools,
			callTool: vi.fn(),
		};
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: (context) => context.requestId ?? "anonymous",
		});

		expect((await gateway.listProjectedTools({ requestId: "alice" }))[0]?.toolName).toBe(
			"alice-tool",
		);
		expect((await gateway.listProjectedTools({ requestId: "bob" }))[0]?.toolName).toBe("bob-tool");
		expect((await gateway.listProjectedTools({ requestId: "alice" }))[0]?.toolName).toBe(
			"alice-tool",
		);
		expect(listTools).toHaveBeenCalledTimes(2);
	});

	it("isolates the default cache key for principal-only delegated identities", async () => {
		const listTools = vi
			.fn()
			.mockResolvedValueOnce({ tools: [{ ...TOOL, name: "tenant-a-tool" }] })
			.mockResolvedValueOnce({ tools: [{ ...TOOL, name: "tenant-b-tool" }] });
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
		});
		const base = { clientId: "artifact", scopes: ["tools:read"] } as const;
		const tenantA = { ...base, subject: "user-1", tenantId: "tenant-a" };
		const tenantB = { ...base, subject: "user-1", tenantId: "tenant-b" };

		expect((await gateway.listProjectedTools({ principal: tenantA }))[0]?.toolName).toBe(
			"tenant-a-tool",
		);
		expect((await gateway.listProjectedTools({ principal: tenantB }))[0]?.toolName).toBe(
			"tenant-b-tool",
		);
		expect((await gateway.listProjectedTools({ principal: tenantA }))[0]?.toolName).toBe(
			"tenant-a-tool",
		);
		expect(listTools).toHaveBeenCalledTimes(2);
	});

	it("retains bearer isolation when the same principal accompanies different tokens", async () => {
		const listTools = vi
			.fn()
			.mockResolvedValueOnce({ tools: [{ ...TOOL, name: "token-a-tool" }] })
			.mockResolvedValueOnce({ tools: [{ ...TOOL, name: "token-b-tool" }] });
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
		});
		const principal = {
			clientId: "artifact",
			subject: "user-1",
			tenantId: "tenant-a",
			scopes: ["tools:read"],
		} as const;
		const authBase = {
			clientId: "artifact",
			scopes: ["tools:read"],
			expiresAt: 2_000_000_000,
		};
		const tokenA = { ...authBase, token: "token-a" } satisfies AuthInfo;
		const tokenB = { ...authBase, token: "token-b" } satisfies AuthInfo;

		expect((await gateway.listProjectedTools({ principal, authInfo: tokenA }))[0]?.toolName).toBe(
			"token-a-tool",
		);
		expect((await gateway.listProjectedTools({ principal, authInfo: tokenB }))[0]?.toolName).toBe(
			"token-b-tool",
		);
		expect((await gateway.listProjectedTools({ principal, authInfo: tokenA }))[0]?.toolName).toBe(
			"token-a-tool",
		);
		expect(listTools).toHaveBeenCalledTimes(2);
	});

	it("snapshots a caller-owned principal before resolving cache and upstream identity", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let resolverPrincipal: unknown;
		let upstreamPrincipal: unknown;
		const principal: {
			clientId: string;
			scopes: string[];
			tenantId: string;
			resource: string;
		} = {
			clientId: "artifact",
			scopes: ["tools:read"],
			tenantId: "tenant-a",
			resource: "https://gateway.example.test/mcp",
		};
		const client = new McpGatewayTestClient([TOOL]);
		const gateway = new McpGateway({
			upstreams: [
				{
					name: "primary",
					client: (context) => {
						upstreamPrincipal = context.principal;
						return client;
					},
				},
			],
			policy: allowAllMcpGatewayPolicy(),
			async authorizationContextResolver(context) {
				resolverPrincipal = context.principal;
				await gate;
				return "principal-a";
			},
		});

		const pending = gateway.listProjectedTools({ principal });
		await vi.waitFor(() => expect(resolverPrincipal).toBeDefined());
		principal.scopes.push("admin");
		principal.tenantId = "tenant-b";
		principal.resource = "https://attacker.example.test/mcp";
		release();
		await pending;

		expect(resolverPrincipal).toEqual({
			clientId: "artifact",
			scopes: ["tools:read"],
			tenantId: "tenant-a",
			resource: "https://gateway.example.test/mcp",
		});
		expect(upstreamPrincipal).toBe(resolverPrincipal);
		expect(Object.isFrozen(resolverPrincipal)).toBe(true);
		if (
			typeof resolverPrincipal !== "object" ||
			resolverPrincipal === null ||
			!("scopes" in resolverPrincipal)
		) {
			throw new Error("Expected principal scopes.");
		}
		expect(Object.isFrozen(resolverPrincipal.scopes)).toBe(true);
	});

	it("singleflights discovery per upstream and authorization context", async () => {
		let release!: (value: { readonly tools: readonly Tool[] }) => void;
		const page = new Promise<{ readonly tools: readonly Tool[] }>((resolve) => {
			release = resolve;
		});
		const listTools = vi.fn(() => page);
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});

		const first = gateway.listProjectedTools();
		const second = gateway.listProjectedTools();
		await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(1));
		release({ tools: [TOOL] });

		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(listTools).toHaveBeenCalledTimes(1);
	});

	it("closes idempotently, aborts accepted discovery, and rejects new public work", async () => {
		let discoverySignal: AbortSignal | undefined;
		const listTools = vi.fn(
			(_params?: { readonly cursor?: string }, options?: { readonly signal?: AbortSignal }) =>
				new Promise<{ readonly tools: readonly Tool[] }>((_resolve, reject) => {
					discoverySignal = options?.signal;
					options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
						once: true,
					});
				}),
		);
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			shutdownTimeoutMs: 100,
		});
		const pending = gateway.listProjectedTools();
		await vi.waitFor(() => expect(discoverySignal).toBeDefined());

		const close = gateway.close();

		expect(gateway.close()).toBe(close);
		await expect(pending).rejects.toMatchObject({ code: "GATEWAY_CLOSED" });
		await expect(close).resolves.toBeUndefined();
		expect(discoverySignal?.aborted).toBe(true);
		await expect(gateway.listProjectedTools()).rejects.toMatchObject({
			code: "GATEWAY_CLOSED",
		});
		expect(() => gateway.asServerFeature()).toThrowError(
			expect.objectContaining({ code: "GATEWAY_CLOSED" }),
		);
		await expect(gateway[Symbol.asyncDispose]()).resolves.toBeUndefined();
	});

	it("bounds close when accepted upstream execution ignores its abort signal", async () => {
		let invocationSignal: AbortSignal | undefined;
		let releaseInvocation: ((value: CallToolResult) => void) | undefined;
		const invocation = new Promise<CallToolResult>((resolve) => {
			releaseInvocation = resolve;
		});
		const callTool = vi.fn(
			(_params: { readonly name: string }, options?: McpGatewayCallToolOptions) => {
				invocationSignal = options?.signal;
				return invocation;
			},
		);
		const gateway = new McpGateway({
			upstreams: [
				{
					name: "primary",
					client: { listTools: () => ({ tools: [TOOL] }), callTool },
				},
			],
			policy: allowAllMcpGatewayPolicy(),
			shutdownTimeoutMs: 5,
		});
		const [tool] = await gateway.listProjectedTools();
		const pending = gateway.callTool(tool!.projectedName, {});
		await vi.waitFor(() => expect(callTool).toHaveBeenCalledOnce());

		const close = gateway.close();

		await expect(pending).rejects.toMatchObject({ code: "GATEWAY_CLOSED" });
		await expect(close).rejects.toMatchObject({ code: "GATEWAY_SHUTDOWN_TIMEOUT" });
		expect(invocationSignal?.aborted).toBe(true);
		releaseInvocation?.({ content: [] });
	});

	it("does not clear an application-owned discovery cache during close", async () => {
		const clear = vi.fn();
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: new McpGatewayTestClient([TOOL]) }],
			policy: allowAllMcpGatewayPolicy(),
			discoveryCache: {
				get: () => undefined,
				set: () => undefined,
				delete: () => false,
				clear,
			},
		});

		await gateway.close();

		expect(clear).not.toHaveBeenCalled();
	});

	it("evicts failed discovery singleflights so a retry can recover", async () => {
		let rejectFirst!: (reason: Error) => void;
		const failedPage = new Promise<never>((_resolve, reject) => {
			rejectFirst = reject;
		});
		const listTools = vi
			.fn()
			.mockImplementationOnce(() => failedPage)
			.mockResolvedValueOnce({ tools: [TOOL] });
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});

		const first = gateway.listProjectedTools();
		const second = gateway.listProjectedTools();
		await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(1));
		const failures = Promise.all([
			expect(first).rejects.toThrow("upstream offline"),
			expect(second).rejects.toThrow("upstream offline"),
		]);
		rejectFirst(new Error("upstream offline"));
		await failures;

		await expect(gateway.listProjectedTools()).resolves.toHaveLength(1);
		expect(listTools).toHaveBeenCalledTimes(2);
	});

	it("isolates waiter cancellation from shared discovery", async () => {
		let release!: (value: { readonly tools: readonly Tool[] }) => void;
		const page = new Promise<{ readonly tools: readonly Tool[] }>((resolve) => {
			release = resolve;
		});
		const listTools = vi.fn(() => page);
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});
		const controller = new AbortController();
		const cancelled = gateway.listProjectedTools({ signal: controller.signal });
		const surviving = gateway.listProjectedTools();
		await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(1));
		controller.abort(new Error("caller cancelled"));
		await expect(cancelled).rejects.toThrow("caller cancelled");
		release({ tools: [TOOL] });
		await expect(surviving).resolves.toHaveLength(1);
	});

	it("cancels abandoned discovery and bounds a shared refresh even when upstream ignores abort", async () => {
		let firstSignal: AbortSignal | undefined;
		const never = new Promise<{ readonly tools: readonly Tool[] }>(() => undefined);
		const listTools = vi
			.fn()
			.mockImplementationOnce(
				(_params?: { readonly cursor?: string }, options?: { readonly signal?: AbortSignal }) => {
					firstSignal = options?.signal;
					return never;
				},
			)
			.mockResolvedValueOnce({ tools: [TOOL] });
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			discoveryMaxConcurrentFlights: 1,
			discoveryTimeoutMs: 1_000,
			authorizationContextResolver: (context) => context.requestId ?? "anonymous",
		});
		const controller = new AbortController();
		const abandoned = gateway.listProjectedTools({
			requestId: "principal-a",
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(firstSignal).toBeDefined());
		controller.abort(new Error("caller left"));

		await expect(abandoned).rejects.toThrow("caller left");
		expect(firstSignal?.aborted).toBe(true);
		await expect(gateway.listProjectedTools({ requestId: "principal-b" })).rejects.toMatchObject({
			code: "DISCOVERY_OVERLOADED",
		});
		expect(listTools).toHaveBeenCalledTimes(1);

		let timedSignal: AbortSignal | undefined;
		const timedGateway = new McpGateway({
			upstreams: [
				{
					name: "timed",
					client: {
						listTools: (
							_params?: { readonly cursor?: string },
							options?: { readonly signal?: AbortSignal },
						) => {
							timedSignal = options?.signal;
							return never;
						},
						callTool: vi.fn(),
					},
				},
			],
			policy: allowAllMcpGatewayPolicy(),
			discoveryTimeoutMs: 5,
			authorizationContextResolver: () => "principal-a",
		});
		await expect(timedGateway.listProjectedTools()).rejects.toMatchObject({
			code: "DISCOVERY_TIMEOUT",
		});
		expect(timedSignal?.aborted).toBe(true);
	});

	it("rejects excess concurrent discovery contexts before starting more upstream work", async () => {
		const never = new Promise<{ readonly tools: readonly Tool[] }>(() => undefined);
		const listTools = vi.fn(() => never);
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			discoveryMaxConcurrentFlights: 1,
			discoveryTimeoutMs: 1_000,
			authorizationContextResolver: (context) => context.requestId ?? "anonymous",
		});
		const firstController = new AbortController();
		const first = gateway.listProjectedTools({
			requestId: "principal-a",
			signal: firstController.signal,
		});
		await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(1));

		await expect(gateway.listProjectedTools({ requestId: "principal-b" })).rejects.toMatchObject({
			code: "DISCOVERY_OVERLOADED",
		});
		expect(listTools).toHaveBeenCalledTimes(1);
		firstController.abort(new Error("cleanup"));
		await expect(first).rejects.toThrow("cleanup");
	});

	it("snapshots and freezes tool arguments before policy, middleware, and dispatch", async () => {
		const received: unknown[] = [];
		const callerArguments = { nested: { role: "user" } };
		const gateway = new McpGateway({
			upstreams: [
				{
					name: "primary",
					client: {
						listTools: () => ({ tools: [TOOL] }),
						callTool: (params) => {
							received.push(params.arguments);
							return { content: [] };
						},
					},
				},
			],
			policy: {
				authorize(operation) {
					if (operation.input.action === "invoke") received.push(operation.input.arguments);
					return allowMcpOperation();
				},
			},
			middleware: [
				async (operation, next) => {
					if (operation.input.type === "gateway.invocation") {
						const nested = operation.input.arguments?.nested;
						if (typeof nested === "object" && nested !== null) {
							expect(Reflect.set(nested, "role", "admin")).toBe(false);
						}
					}
					return next();
				},
			],
			authorizationContextResolver: () => "principal-a",
		});
		const [tool] = await gateway.listProjectedTools();
		const invocation = gateway.callTool(tool!.projectedName, callerArguments);
		callerArguments.nested.role = "admin";
		await invocation;

		expect(received).toEqual([{ nested: { role: "user" } }, { nested: { role: "user" } }]);
	});

	it("detaches and freezes transformed discovery before authorization and invocation", async () => {
		const mutableTool: Tool = {
			name: "echo",
			inputSchema: {
				type: "object",
				properties: { value: { type: "string" } },
			},
		};
		const mutableDiscovery: McpGatewayDiscoverySnapshot = {
			tools: [mutableTool],
			prompts: [],
			resources: [],
			resourceTemplates: [],
			discoveredAt: 1,
		};
		let reportAuthorization: (() => void) | undefined;
		let releaseAuthorization: (() => void) | undefined;
		const authorizationEntered = new Promise<void>((resolve) => {
			reportAuthorization = resolve;
		});
		const authorizationGate = new Promise<void>((resolve) => {
			releaseAuthorization = resolve;
		});
		const callTool = vi.fn(
			(_params: unknown, options?: McpGatewayCallToolOptions): CallToolResult => {
				expect(options?.toolDefinition?.inputSchema.type).toBe("object");
				expect(Object.isFrozen(options?.toolDefinition)).toBe(true);
				return { content: [] };
			},
		);
		const gateway = new McpGateway({
			upstreams: [
				{
					name: "primary",
					client: { listTools: () => ({ tools: [] }), callTool },
				},
			],
			policy: {
				async authorize(operation) {
					if (operation.input.action === "invoke") {
						expect(operation.input.tool.inputSchema.type).toBe("object");
						reportAuthorization?.();
						await authorizationGate;
					}
					return allowMcpOperation();
				},
			},
			middleware: [
				defineMcpGatewayTransform("gateway.discovery", async () => mutableDiscovery),
				defineMcpGatewayTransform("gateway.invocation", async (operation, next) => {
					expect(operation.input.tool.inputSchema.type).toBe("object");
					expect(Object.isFrozen(operation.input.tool)).toBe(true);
					expect(Object.isFrozen(operation.input.tool.inputSchema)).toBe(true);
					return next();
				}),
				async (operation, next) => {
					if (operation.input.type === "gateway.invocation") {
						expect(Reflect.set(operation.input.tool.inputSchema, "type", "string")).toBe(false);
					}
					return next();
				},
			],
			authorizationContextResolver: () => "principal-a",
		});
		const projectedName = new GatewayNameCodec().encode("primary", "echo");

		const invocation = gateway.callTool(projectedName, { value: "safe" });
		await authorizationEntered;
		Reflect.set(mutableTool.inputSchema, "type", "string");
		releaseAuthorization?.();

		await expect(invocation).resolves.toEqual({ content: [] });
		expect(callTool).toHaveBeenCalledOnce();
	});

	it("does not let an invalidated inflight refresh repopulate discovery", async () => {
		let release!: (value: { readonly tools: readonly Tool[] }) => void;
		const firstPage = new Promise<{ readonly tools: readonly Tool[] }>((resolve) => {
			release = resolve;
		});
		const listTools = vi
			.fn()
			.mockImplementationOnce(() => firstPage)
			.mockResolvedValueOnce({ tools: [{ ...TOOL, name: "fresh" }] });
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});
		const stale = gateway.listProjectedTools();
		const staleRejection = expect(stale).rejects.toMatchObject({ name: "AbortError" });
		await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(1));
		await gateway.invalidateDiscovery({
			upstreamName: "primary",
			authorizationContext: "principal-a",
		});
		release({ tools: [{ ...TOOL, name: "stale" }] });
		await staleRejection;
		await expect(gateway.listProjectedTools()).resolves.toMatchObject([{ toolName: "fresh" }]);
		expect(listTools).toHaveBeenCalledTimes(2);
	});

	it("serializes a slow stale cache write before a newer generation", async () => {
		let stored: McpGatewayDiscoverySnapshot | undefined;
		let releaseFirstSet!: () => void;
		let markFirstSetStarted!: () => void;
		const firstSetStarted = new Promise<void>((resolve) => {
			markFirstSetStarted = resolve;
		});
		const firstSetRelease = new Promise<void>((resolve) => {
			releaseFirstSet = resolve;
		});
		let setCount = 0;
		const cache: McpGatewayDiscoveryCache = {
			get: () => stored,
			async set(_key, snapshot) {
				setCount += 1;
				if (setCount === 1) {
					markFirstSetStarted();
					await firstSetRelease;
				}
				stored = snapshot;
			},
			delete() {
				const existed = stored !== undefined;
				stored = undefined;
				return existed;
			},
			clear() {
				stored = undefined;
			},
		};
		const listTools = vi
			.fn()
			.mockResolvedValueOnce({ tools: [{ ...TOOL, name: "stale" }] })
			.mockResolvedValueOnce({ tools: [{ ...TOOL, name: "fresh" }] });
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			discoveryCache: cache,
			authorizationContextResolver: () => "principal-a",
		});
		const key = { upstreamName: "primary", authorizationContext: "principal-a" };

		const stale = gateway.listProjectedTools();
		const staleRejection = expect(stale).rejects.toMatchObject({ name: "AbortError" });
		await firstSetStarted;
		const invalidated = gateway.invalidateDiscovery(key);
		const fresh = gateway.listProjectedTools();
		await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(2));
		releaseFirstSet();

		await invalidated;
		await staleRejection;
		await expect(fresh).resolves.toMatchObject([{ toolName: "fresh" }]);
		await expect(gateway.listProjectedTools()).resolves.toMatchObject([{ toolName: "fresh" }]);
		expect(listTools).toHaveBeenCalledTimes(2);
	});

	it("globally clears discovery without allowing an older slow write to repopulate it", async () => {
		let stored: McpGatewayDiscoverySnapshot | undefined;
		let releaseFirstSet!: () => void;
		let markFirstSetStarted!: () => void;
		const firstSetStarted = new Promise<void>((resolve) => {
			markFirstSetStarted = resolve;
		});
		const firstSetRelease = new Promise<void>((resolve) => {
			releaseFirstSet = resolve;
		});
		let setCount = 0;
		const clear = vi.fn(() => {
			stored = undefined;
		});
		const cache: McpGatewayDiscoveryCache = {
			get: () => stored,
			async set(_key, snapshot) {
				setCount += 1;
				if (setCount === 1) {
					markFirstSetStarted();
					await firstSetRelease;
				}
				stored = snapshot;
			},
			delete() {
				const existed = stored !== undefined;
				stored = undefined;
				return existed;
			},
			clear,
		};
		const listTools = vi
			.fn()
			.mockResolvedValueOnce({ tools: [{ ...TOOL, name: "stale" }] })
			.mockResolvedValueOnce({ tools: [{ ...TOOL, name: "fresh" }] });
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: { listTools, callTool: vi.fn() } }],
			policy: allowAllMcpGatewayPolicy(),
			discoveryCache: cache,
			authorizationContextResolver: () => "principal-a",
		});

		const stale = gateway.listProjectedTools();
		const staleRejection = expect(stale).rejects.toMatchObject({ name: "AbortError" });
		await firstSetStarted;
		const invalidated = gateway.invalidateAllDiscovery();
		const fresh = gateway.listProjectedTools();
		expect(clear).not.toHaveBeenCalled();
		releaseFirstSet();

		await invalidated;
		await staleRejection;
		await expect(fresh).resolves.toMatchObject([{ toolName: "fresh" }]);
		await expect(gateway.listProjectedTools()).resolves.toMatchObject([{ toolName: "fresh" }]);
		expect(clear).toHaveBeenCalledOnce();
		expect(listTools).toHaveBeenCalledTimes(2);
	});
});
