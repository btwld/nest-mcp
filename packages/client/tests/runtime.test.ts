import {
	type CallToolResult,
	type CallToolRequestOptions,
	type Client,
	type ClientOptions,
	type ConnectOptions,
	type DiscoverResult,
	type Implementation,
	type InputRequiredResult,
	type InputResponses,
	type McpSubscription,
	type StandardSchemaV1,
	type SubscriptionFilter,
	type Transport,
	isInputRequiredResult,
	specTypeSchemas,
} from "@modelcontextprotocol/client";
import {
	McpServer,
	acceptedContent,
	createMcpHandler,
	createRequestStateCodec,
	inputRequired,
	type ServerContext,
} from "@modelcontextprotocol/server";
import {
	McpAuthorizationError,
	McpMiddlewareReentryError,
	allowMcpOperation,
	createMcpAuthorizationMiddleware,
	denyMcpOperation,
	type McpLifecycleEvent,
} from "@nest-mcp/core";
import { describe, expect, it, vi } from "vitest";

import {
	MCP_CLIENT_NOT_CONNECTED,
	MCP_CLIENT_RUNTIME_CLOSED,
	MCP_CLIENT_SERVER_NOT_FOUND,
	MCP_CLIENT_SHUTDOWN_TIMEOUT,
	McpClientRuntime,
	createMcpClientPassthroughMiddleware,
	defineMcpClientTransform,
	type McpClientMrtrRequestOptions,
	type McpClientOperationInput,
	type McpClientServerDefinition,
	type McpSdkClientFactory,
} from "../src/index.ts";

const MODERN_DISCOVERY = {
	supportedVersions: ["2026-07-28"],
	capabilities: { tools: {} },
} as DiscoverResult;

const EMPTY_RESULT_SCHEMA = {
	"~standard": {
		version: 1,
		vendor: "nest-mcp-test",
		types: { input: undefined, output: {} },
		validate: () => ({ value: {} }),
	},
} satisfies StandardSchemaV1<unknown, Record<string, never>>;

const APPROVAL_SCHEMA = {
	"~standard": {
		version: 1,
		vendor: "nest-mcp-test",
		types: { input: undefined, output: { approved: true } },
		validate(value: unknown) {
			if (
				typeof value === "object" &&
				value !== null &&
				"approved" in value &&
				value.approved === true
			) {
				return { value: { approved: true } as const };
			}
			return { issues: [{ message: "approved must be true" }] };
		},
	},
} satisfies StandardSchemaV1<unknown, { readonly approved: true }>;

describe("McpClientRuntime", () => {
	it("defaults to auto negotiation, forwards prior discovery, and retains introspection", async () => {
		const fake = createFakeClient({
			protocolEra: "modern",
			discoverResult: MODERN_DISCOVERY,
			protocolVersion: "2026-07-28",
		});
		const created: Array<{ info: Implementation; options: ClientOptions }> = [];
		const configured = vi.fn();
		const transport = createFakeTransport("session-a");
		const transportFactory = {
			createTransport: vi.fn(() => transport),
		};
		const prior = { kind: "modern", discover: MODERN_DISCOVERY } as const;
		const runtime = new McpClientRuntime({
			clientFactory: captureClientFactory(fake.client, created),
			transportFactory,
			servers: [server({ prior, configureClient: configured })],
			now: () => 42,
		});

		const client = await runtime.connect("alpha");

		expect(client).toBe(fake.client);
		expect(created[0]?.options.versionNegotiation).toEqual({ mode: "auto" });
		expect(configured).toHaveBeenCalledWith(fake.client, {
			serverName: "alpha",
			definition: runtime.getDefinition("alpha"),
		});
		expect(fake.connect).toHaveBeenCalledWith(
			transport,
			expect.objectContaining({ prior, signal: expect.any(AbortSignal) }),
		);
		expect(transportFactory.createTransport).toHaveBeenCalledOnce();
		expect(runtime.getClient("alpha")).toBe(fake.client);
		expect(runtime.getPriorDiscovery("alpha")).toEqual(prior);
		expect(runtime.snapshot("alpha")).toMatchObject({
			name: "alpha",
			state: "connected",
			transportKind: "http",
			sessionId: "session-a",
			connectedAt: 42,
			negotiatedProtocolVersion: "2026-07-28",
			protocolEra: "modern",
			discoverResult: MODERN_DISCOVERY,
		});

		await runtime.disconnect("alpha");

		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.snapshot("alpha")).toMatchObject({
			state: "disconnected",
			disconnectedAt: 42,
			protocolEra: "modern",
		});
		expect(() => runtime.requireClient("alpha")).toThrowError(
			expect.objectContaining({ code: MCP_CLIENT_NOT_CONNECTED }),
		);
	});

	it("delegates tool, resource, and prompt APIs through middleware and lifecycle observers", async () => {
		const fake = createFakeClient();
		const methods: string[] = [];
		const events: McpLifecycleEvent[] = [];
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				createMcpClientPassthroughMiddleware(async (operation, next) => {
					methods.push(operation.input.method);
					await next();
				}),
			],
			observer: {
				onEvent(event) {
					events.push(event);
				},
			},
			operationIdFactory: () => "operation-1",
		});
		await runtime.connect("alpha");
		methods.length = 0;
		events.length = 0;

		await expect(runtime.listTools("alpha")).resolves.toEqual({ tools: [] });
		await expect(
			runtime.callTool("alpha", { name: "echo", arguments: { value: "hello" } }),
		).resolves.toMatchObject({ isError: false });
		await expect(runtime.listResources("alpha")).resolves.toEqual({ resources: [] });
		await expect(runtime.listResourceTemplates("alpha")).resolves.toEqual({
			resourceTemplates: [],
		});
		await expect(runtime.readResource("alpha", { uri: "memory://one" })).resolves.toEqual({
			contents: [],
		});
		await expect(runtime.listPrompts("alpha")).resolves.toEqual({ prompts: [] });
		await expect(runtime.getPrompt("alpha", { name: "welcome" })).resolves.toEqual({
			messages: [],
		});

		expect(methods).toEqual([
			"tools/list",
			"tools/call",
			"resources/list",
			"resources/templates/list",
			"resources/read",
			"prompts/list",
			"prompts/get",
		]);
		expect(events.map((event) => event.type)).toEqual([
			"operation.started",
			"operation.succeeded",
			"operation.started",
			"operation.succeeded",
			"operation.started",
			"operation.succeeded",
			"operation.started",
			"operation.succeeded",
			"operation.started",
			"operation.succeeded",
			"operation.started",
			"operation.succeeded",
			"operation.started",
			"operation.succeeded",
		]);
		expect(events[0]?.context).toMatchObject({
			operationId: "operation-1",
			role: "client",
			operation: { name: "tools/list", capability: "tools", target: "alpha" },
		});
	});

	it("transforms one exact client result without dropping structured content or metadata", async () => {
		const structuredContent = { echoed: true };
		const upstreamResult = {
			content: [{ type: "text", text: "upstream" }],
			structuredContent,
			_meta: { upstreamTrace: "trace-1" },
			isError: false,
		} satisfies CallToolResult;
		const fake = createFakeClient({ callToolResult: upstreamResult });
		const controller = new AbortController();
		const requestOptions = { signal: controller.signal };
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				defineMcpClientTransform("tools/call", async (operation, next) => {
					expect(operation.input.serverName).toBe("alpha");
					expect(operation.input.params.name).toBe("echo");
					expect(operation.input.options).not.toBe(requestOptions);
					expect(operation.input.options).toEqual(requestOptions);
					expect(Object.isFrozen(operation.input.options)).toBe(true);
					expect(operation.context.signal).toBe(controller.signal);
					const result = await next();
					expect(result).toBe(upstreamResult);
					return {
						...result,
						content: [...result.content, { type: "text", text: "transformed" }],
						_meta: { ...result["_meta"], transformed: true },
					};
				}),
			],
		});
		await runtime.connect("alpha");

		const result = await runtime.callTool("alpha", { name: "echo" }, requestOptions);

		expect(result.content).toEqual([
			{ type: "text", text: "upstream" },
			{ type: "text", text: "transformed" },
		]);
		expect(result.structuredContent).toBe(structuredContent);
		expect(result["_meta"]).toEqual({ upstreamTrace: "trace-1", transformed: true });
		expect(fake.callTool).toHaveBeenCalledWith({ name: "echo" }, { signal: controller.signal });
		await runtime.close();
	});

	it("snapshots result-affecting request options before exact transform dispatch", async () => {
		const fake = createFakeClient();
		const mutableOptions = {
			allowInputRequired: false,
			headers: { "x-request-id": "original" },
			toolDefinition: {
				name: "echo",
				inputSchema: {
					type: "object",
					properties: { value: { type: "string" } },
				},
				outputSchema: {
					type: "object",
					properties: { echoed: { type: "boolean" } },
				},
			},
		} satisfies CallToolRequestOptions;
		let transformed = false;
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				defineMcpClientTransform("tools/call", async (operation, next) => {
					transformed = true;
					expect(operation.input.options).toEqual({
						allowInputRequired: false,
						headers: { "x-request-id": "original" },
						toolDefinition: {
							name: "echo",
							inputSchema: {
								type: "object",
								properties: { value: { type: "string" } },
							},
							outputSchema: {
								type: "object",
								properties: { echoed: { type: "boolean" } },
							},
						},
					});
					expect(Object.isFrozen(operation.input.options)).toBe(true);
					expect(Object.isFrozen(operation.input.options?.headers)).toBe(true);
					expect(Object.isFrozen(operation.input.options?.toolDefinition)).toBe(true);
					expect(Object.isFrozen(operation.input.options?.toolDefinition?.inputSchema)).toBe(true);
					return next();
				}),
			],
		});
		await runtime.connect("alpha");

		const result = runtime.callTool("alpha", { name: "echo" }, mutableOptions);
		Reflect.set(mutableOptions, "allowInputRequired", true);
		mutableOptions.headers["x-request-id"] = "mutated";
		Reflect.set(mutableOptions.toolDefinition.inputSchema, "type", "string");
		Reflect.set(mutableOptions.toolDefinition.outputSchema, "type", "string");

		await expect(result).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
		expect(transformed).toBe(true);
		expect(fake.callTool).toHaveBeenCalledWith(
			{ name: "echo" },
			{
				allowInputRequired: false,
				headers: { "x-request-id": "original" },
				toolDefinition: {
					name: "echo",
					inputSchema: {
						type: "object",
						properties: { value: { type: "string" } },
					},
					outputSchema: {
						type: "object",
						properties: { echoed: { type: "boolean" } },
					},
				},
			},
		);
		await runtime.close();
	});

	it("snapshots a generic request before asynchronous authorization", async () => {
		let releaseAuthorization: (() => void) | undefined;
		let reportAuthorization: (() => void) | undefined;
		const authorizationGate = new Promise<void>((resolve) => {
			releaseAuthorization = resolve;
		});
		const authorizationEntered = new Promise<void>((resolve) => {
			reportAuthorization = resolve;
		});
		const fake = createFakeClient({ requestResults: [{ tools: [] }] });
		const transformed: string[] = [];
		const authorization = createMcpAuthorizationMiddleware<McpClientOperationInput, unknown>({
			async authorize(operation) {
				if (operation.input.method === "tools/list") {
					reportAuthorization?.();
					await authorizationGate;
				}
				return allowMcpOperation();
			},
		});
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				defineMcpClientTransform("tools/list", async (_operation, next) => {
					transformed.push("tools/list");
					return next();
				}),
				defineMcpClientTransform("tools/call", async (_operation, next) => {
					transformed.push("tools/call");
					return next();
				}),
				authorization,
			],
		});
		await runtime.connect("alpha");
		const mutableRequest = { method: "tools/list" as const, params: {} };

		const result = runtime.request("alpha", mutableRequest);
		await authorizationEntered;
		Reflect.set(mutableRequest, "method", "tools/call");
		Reflect.set(mutableRequest, "params", { name: "mutated" });
		releaseAuthorization?.();

		await expect(result).resolves.toEqual({ tools: [] });
		expect(transformed).toEqual(["tools/list"]);
		expect(fake.request).toHaveBeenCalledWith({ method: "tools/list", params: {} }, undefined);
		await runtime.close();
	});

	it("snapshots tool parameters before authorization and exact transforms", async () => {
		let releaseAuthorization: (() => void) | undefined;
		let reportAuthorization: (() => void) | undefined;
		const authorizationGate = new Promise<void>((resolve) => {
			releaseAuthorization = resolve;
		});
		const authorizationEntered = new Promise<void>((resolve) => {
			reportAuthorization = resolve;
		});
		const fake = createFakeClient();
		const authorization = createMcpAuthorizationMiddleware<McpClientOperationInput, unknown>({
			async authorize(operation) {
				if (operation.input.method === "tools/call") {
					reportAuthorization?.();
					await authorizationGate;
				}
				return allowMcpOperation();
			},
		});
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				defineMcpClientTransform("tools/call", async (operation, next) => {
					expect(operation.input.params).toEqual({
						name: "safe-tool",
						arguments: { tenant: "safe" },
					});
					expect(Object.isFrozen(operation.input.params)).toBe(true);
					expect(Object.isFrozen(operation.input.params.arguments)).toBe(true);
					return next();
				}),
				authorization,
			],
		});
		await runtime.connect("alpha");
		const mutableParams = {
			name: "safe-tool",
			arguments: { tenant: "safe" },
		};

		const result = runtime.callTool("alpha", mutableParams);
		await authorizationEntered;
		mutableParams.name = "mutated-tool";
		mutableParams.arguments.tenant = "mutated";
		releaseAuthorization?.();

		await expect(result).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
		expect(fake.callTool).toHaveBeenCalledWith(
			{ name: "safe-tool", arguments: { tenant: "safe" } },
			undefined,
		);
		await runtime.close();
	});

	it("freezes logging parameters before general and exact middleware", async () => {
		const fake = createFakeClient();
		const setLoggingLevel = vi.spyOn(fake.client, "setLoggingLevel");
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				defineMcpClientTransform("logging/setLevel", async (operation, next) => {
					expect(operation.input.params).toEqual({ level: "info" });
					expect(Object.isFrozen(operation.input.params)).toBe(true);
					return next();
				}),
				async (operation, next) => {
					if (operation.input.method === "logging/setLevel") {
						const params = operation.input.params;
						expect(Object.isFrozen(params)).toBe(true);
						if (typeof params === "object" && params !== null) {
							expect(Reflect.set(params, "level", "error")).toBe(false);
						}
					}
					return next();
				},
			],
		});
		await runtime.connect("alpha");

		await expect(runtime.setLoggingLevel("alpha", "info")).resolves.toEqual({});

		expect(setLoggingLevel).toHaveBeenCalledWith("info", undefined);
		await runtime.close();
	});

	it("runs broad authorization and middleware before exact transforms regardless of list order", async () => {
		const upstreamResult = {
			content: [{ type: "text" as const, text: "upstream" }],
		} satisfies CallToolResult;
		const fake = createFakeClient({ callToolResult: upstreamResult });
		const exactResults: CallToolResult[] = [];
		let exactCalls = 0;
		const exact = defineMcpClientTransform("tools/call", async (_operation, next) => {
			exactCalls += 1;
			const result = await next();
			exactResults.push(result);
			return result;
		});
		const authorization = createMcpAuthorizationMiddleware<McpClientOperationInput, unknown>({
			authorize: (operation) =>
				operation.input.method === "tools/call"
					? denyMcpOperation("Denied by client policy.")
					: allowMcpOperation(),
		});
		let rewrite = false;
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				exact,
				async (operation, next) => {
					const result = await next();
					return rewrite && operation.input.method === "tools/call" ? { tools: [] } : result;
				},
			],
		});
		await runtime.connect("alpha");

		rewrite = true;
		await expect(runtime.callTool("alpha", { name: "echo" })).resolves.toEqual({ tools: [] });
		expect(exactResults).toEqual([upstreamResult]);

		const deniedRuntime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [exact, authorization],
		});
		await deniedRuntime.connect("alpha");
		await expect(deniedRuntime.callTool("alpha", { name: "blocked" })).rejects.toBeInstanceOf(
			McpAuthorizationError,
		);
		expect(exactCalls).toBe(1);
		expect(fake.callTool).toHaveBeenCalledTimes(1);
		await runtime.close();
		await deniedRuntime.close();
	});

	it("excludes custom-schema, input-required, and managed-listen profiles from exact transforms", async () => {
		const fake = createFakeClient();
		const transformed: string[] = [];
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				defineMcpClientTransform("tools/call", async (_operation, next) => {
					transformed.push("tools/call");
					return next();
				}),
				defineMcpClientTransform("prompts/get", async (_operation, next) => {
					transformed.push("prompts/get");
					return next();
				}),
				defineMcpClientTransform("resources/read", async (_operation, next) => {
					transformed.push("resources/read");
					return next();
				}),
				defineMcpClientTransform("subscriptions/listen", async (_operation, next) => {
					transformed.push("subscriptions/listen");
					return next();
				}),
			],
		});
		await runtime.connect("alpha");

		await runtime.requestWithSchema(
			"alpha",
			{ method: "tools/call", params: { name: "custom" } },
			EMPTY_RESULT_SCHEMA,
		);
		await runtime.requestWithInputRequired(
			"alpha",
			{ method: "tools/call", params: { name: "manual" } },
			EMPTY_RESULT_SCHEMA,
		);
		await runtime.callTool("alpha", { name: "manual" }, { allowInputRequired: true });
		await runtime.request(
			"alpha",
			{ method: "tools/call", params: { name: "generic-manual" } },
			{ allowInputRequired: true },
		);
		await runtime.getPrompt("alpha", { name: "manual" }, { allowInputRequired: true });
		await runtime.readResource("alpha", { uri: "memory://manual" }, { allowInputRequired: true });
		await runtime.listen("alpha", { toolsListChanged: true });
		expect(transformed).toEqual([]);

		await runtime.callTool("alpha", { name: "ordinary" });
		await runtime.getPrompt("alpha", { name: "ordinary" });
		expect(transformed).toEqual(["tools/call", "prompts/get"]);
		await runtime.close();
	});

	it("observes transform-side aborts as cancellation and retains next-once enforcement", async () => {
		const fake = createFakeClient();
		const controller = new AbortController();
		const abortReason = new DOMException("cancel transform", "AbortError");
		const events: McpLifecycleEvent[] = [];
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				defineMcpClientTransform("tools/list", async (_operation, next) => {
					const result = await next();
					controller.abort(abortReason);
					return result;
				}),
				defineMcpClientTransform("ping", async (_operation, next) => {
					await next();
					return next();
				}),
			],
			observer: {
				onEvent(event) {
					events.push(event);
				},
			},
		});
		await runtime.connect("alpha");
		events.length = 0;

		await expect(runtime.listTools("alpha", undefined, { signal: controller.signal })).rejects.toBe(
			abortReason,
		);
		expect(events.map((event) => event.type)).toEqual(["operation.started", "operation.cancelled"]);
		await expect(runtime.ping("alpha")).rejects.toBeInstanceOf(McpMiddlewareReentryError);
		await runtime.close();
	});

	it("delegates completion, protocol, notification, logging, and legacy capability APIs", async () => {
		const fake = createFakeClient();
		const operations: Array<{ method: string; kind: string }> = [];
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				async (operation, next) => {
					operations.push({
						method: operation.input.method,
						kind: operation.context.operation.kind,
					});
					return next();
				},
			],
		});
		await runtime.connect("alpha");
		operations.length = 0;

		await expect(runtime.ping("alpha")).resolves.toEqual({});
		await expect(
			runtime.complete("alpha", {
				ref: { type: "ref/prompt", name: "welcome" },
				argument: { name: "tone", value: "f" },
			}),
		).resolves.toEqual({ completion: { values: ["formal"] } });
		await expect(runtime.request("alpha", { method: "ping" })).resolves.toEqual({});
		await expect(
			runtime.requestWithSchema("alpha", { method: "acme/ping" }, EMPTY_RESULT_SCHEMA),
		).resolves.toEqual({});
		await expect(
			runtime.notification("alpha", { method: "notifications/initialized" }),
		).resolves.toBeUndefined();
		await expect(runtime.setLoggingLevel("alpha", "info")).resolves.toEqual({});
		await expect(runtime.subscribeResource("alpha", { uri: "memory://one" })).resolves.toEqual({});
		await expect(runtime.unsubscribeResource("alpha", { uri: "memory://one" })).resolves.toEqual(
			{},
		);
		await expect(runtime.sendRootsListChanged("alpha")).resolves.toBeUndefined();

		expect(operations).toEqual([
			{ method: "ping", kind: "request" },
			{ method: "completion/complete", kind: "request" },
			{ method: "ping", kind: "request" },
			{ method: "acme/ping", kind: "request" },
			{ method: "notifications/initialized", kind: "notification" },
			{ method: "logging/setLevel", kind: "request" },
			{ method: "resources/subscribe", kind: "request" },
			{ method: "resources/unsubscribe", kind: "request" },
			{ method: "notifications/roots/list_changed", kind: "notification" },
		]);
		await runtime.close();
	});

	it("returns an idempotent runtime-owned modern subscription handle", async () => {
		const sdkSubscription = createFakeSubscription({ toolsListChanged: true });
		const fake = createFakeClient({ subscription: sdkSubscription.subscription });
		const methods: string[] = [];
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				async (operation, next) => {
					methods.push(operation.input.method);
					return next();
				},
			],
		});
		await runtime.connect("alpha");
		methods.length = 0;

		const subscription = await runtime.listen("alpha", { toolsListChanged: true });
		expect(subscription).toMatchObject({
			serverName: "alpha",
			honoredFilter: { toolsListChanged: true },
		});
		expect(runtime.activeSubscriptions("alpha")).toEqual([subscription]);

		await subscription.close();
		await subscription.close();

		expect(await subscription.closed).toBe("local");
		expect(sdkSubscription.close).toHaveBeenCalledOnce();
		expect(runtime.activeSubscriptions("alpha")).toEqual([]);
		expect(methods).toEqual(["subscriptions/listen", "notifications/cancelled"]);
		await runtime.close();
	});

	it("gracefully closes active modern subscriptions before disconnecting", async () => {
		const sdkSubscription = createFakeSubscription({
			resourceSubscriptions: ["memory://one"],
		});
		const fake = createFakeClient({ subscription: sdkSubscription.subscription });
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
		});
		await runtime.connect("alpha");
		const subscription = await runtime.listen("alpha", {
			resourceSubscriptions: ["memory://one"],
		});

		await runtime.disconnect("alpha");

		expect(sdkSubscription.close).toHaveBeenCalledOnce();
		expect(await subscription.closed).toBe("local");
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.activeSubscriptions("alpha")).toEqual([]);
	});

	it("observes disconnect subscription cleanup even when middleware short-circuits", async () => {
		const sdkSubscription = createFakeSubscription({ toolsListChanged: true });
		const fake = createFakeClient({ subscription: sdkSubscription.subscription });
		const methods: string[] = [];
		const events: McpLifecycleEvent[] = [];
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				async (operation, next) => {
					methods.push(operation.input.method);
					if (
						operation.input.method === "runtime/disconnect" ||
						operation.input.method === "notifications/cancelled"
					) {
						return undefined;
					}
					return next();
				},
			],
			observer: {
				onEvent(event) {
					events.push(event);
				},
			},
		});
		await runtime.connect("alpha");
		await runtime.listen("alpha", { toolsListChanged: true });
		methods.length = 0;
		events.length = 0;

		await runtime.disconnect("alpha");

		expect(methods).toEqual(["runtime/disconnect", "notifications/cancelled"]);
		expect(
			events
				.filter((event) => event.context.operation.name === "notifications/cancelled")
				.map((event) => event.type),
		).toEqual(["operation.started", "operation.succeeded"]);
		expect(sdkSubscription.close).toHaveBeenCalledOnce();
		expect(fake.close).toHaveBeenCalledOnce();
		expect(sdkSubscription.close.mock.invocationCallOrder[0]).toBeLessThan(
			fake.close.mock.invocationCallOrder[0]!,
		);
	});

	it("aggregates disconnect middleware and required SDK cleanup failures", async () => {
		const middlewareFailure = new Error("disconnect policy failed");
		const cleanupFailure = new Error("client cleanup failed");
		const fake = createFakeClient({ closeError: cleanupFailure });
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				async (operation, next) => {
					if (operation.input.method === "runtime/disconnect") throw middlewareFailure;
					return next();
				},
			],
		});
		await runtime.connect("alpha");

		const disconnect = runtime.disconnect("alpha");
		await expect(disconnect).rejects.toBeInstanceOf(AggregateError);
		await disconnect.catch((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			if (error instanceof AggregateError) {
				expect(error.errors).toEqual([middlewareFailure, cleanupFailure]);
			}
		});
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.snapshot("alpha").state).toBe("failed");
	});

	it("still closes the client and aggregates subscription and client cleanup failures", async () => {
		const subscriptionFailure = new Error("subscription cleanup failed");
		const clientFailure = new Error("client cleanup failed");
		const sdkSubscription = createFakeSubscription(
			{ resourcesListChanged: true },
			subscriptionFailure,
		);
		const fake = createFakeClient({
			subscription: sdkSubscription.subscription,
			closeError: clientFailure,
		});
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
		});
		await runtime.connect("alpha");
		await runtime.listen("alpha", { resourcesListChanged: true });

		const disconnect = runtime.disconnect("alpha");

		await expect(disconnect).rejects.toBeInstanceOf(AggregateError);
		await disconnect.catch((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			if (!(error instanceof AggregateError)) return;
			expect(error.errors).toEqual([subscriptionFailure, clientFailure]);
		});
		expect(sdkSubscription.close).toHaveBeenCalledOnce();
		expect(fake.close).toHaveBeenCalledOnce();
	});

	it("adopts the official list-changed auto-opened subscription", async () => {
		const sdkSubscription = createFakeSubscription({ promptsListChanged: true });
		const fake = createFakeClient({ autoSubscription: sdkSubscription.subscription });
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
		});

		await runtime.connect("alpha");
		const subscription = runtime.getAutoOpenedSubscription("alpha");

		expect(subscription).toMatchObject({
			serverName: "alpha",
			honoredFilter: { promptsListChanged: true },
		});
		expect(runtime.activeSubscriptions("alpha")).toEqual([subscription]);

		await runtime.disconnect("alpha");
		expect(sdkSubscription.close).toHaveBeenCalledOnce();
		expect(runtime.getAutoOpenedSubscription("alpha")).toBeUndefined();
	});

	it("deduplicates concurrent connections and supports many named servers", async () => {
		let releaseConnect: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseConnect = resolve;
		});
		const alpha = createFakeClient({ connectGate: gate });
		const beta = createFakeClient();
		const clients = new Map([
			["alpha", alpha.client],
			["beta", beta.client],
		]);
		const factory: McpSdkClientFactory = {
			createClient(_info, _options, context) {
				const client = clients.get(context.serverName);
				if (client === undefined) throw new Error("missing fake client");
				return client;
			},
		};
		const runtime = new McpClientRuntime({
			clientFactory: factory,
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server(), server({ name: "beta" })],
		});

		const first = runtime.connect("alpha");
		const second = runtime.connect("alpha");
		await vi.waitFor(() => expect(alpha.connect).toHaveBeenCalledOnce());
		releaseConnect?.();
		await Promise.all([first, second]);
		await runtime.connect("beta", { timeout: 250 });

		expect(alpha.connect).toHaveBeenCalledOnce();
		expect(beta.connect).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ timeout: 250, signal: expect.any(AbortSignal) }),
		);
		expect(runtime.names()).toEqual(["alpha", "beta"]);
		expect(runtime.snapshot().map((entry) => entry.state)).toEqual(["connected", "connected"]);

		await runtime.close();
		expect(alpha.close).toHaveBeenCalledOnce();
		expect(beta.close).toHaveBeenCalledOnce();
		await expect(runtime.connect("alpha")).rejects.toMatchObject({
			code: MCP_CLIENT_RUNTIME_CLOSED,
		});
		await expect(runtime.unregister("alpha")).rejects.toMatchObject({
			code: MCP_CLIENT_RUNTIME_CLOSED,
		});
	});

	it("invalidates a connect pipeline paused before its terminal when close wins", async () => {
		let releaseConnect: (() => void) | undefined;
		let reportConnectEntered: (() => void) | undefined;
		const connectGate = new Promise<void>((resolve) => {
			releaseConnect = resolve;
		});
		const connectEntered = new Promise<void>((resolve) => {
			reportConnectEntered = resolve;
		});
		const fake = createFakeClient();
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				async (operation, next) => {
					if (operation.input.method === "runtime/connect") {
						reportConnectEntered?.();
						await connectGate;
					}
					return next();
				},
			],
		});

		const connection = runtime.connect("alpha");
		await connectEntered;
		await runtime.close();
		releaseConnect?.();

		await expect(connection).rejects.toMatchObject({ code: MCP_CLIENT_RUNTIME_CLOSED });
		expect(fake.connect).not.toHaveBeenCalled();
		expect(fake.close).not.toHaveBeenCalled();
		expect(runtime.snapshot("alpha").state).toBe("disconnected");
	});

	it("quiesces terminal-phase connection setup before close resolves", async () => {
		let releaseConfiguration: (() => void) | undefined;
		let reportConfigurationEntered: (() => void) | undefined;
		const configurationGate = new Promise<void>((resolve) => {
			releaseConfiguration = resolve;
		});
		const configurationEntered = new Promise<void>((resolve) => {
			reportConfigurationEntered = resolve;
		});
		const fake = createFakeClient();
		const transportFactory = fixedTransportFactory(createFakeTransport());
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory,
			servers: [
				server({
					async configureClient() {
						reportConfigurationEntered?.();
						await configurationGate;
					},
				}),
			],
		});

		const connection = runtime.connect("alpha");
		await configurationEntered;
		const closing = runtime.close();
		let closeSettled = false;
		void closing.then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		releaseConfiguration?.();

		await expect(connection).rejects.toMatchObject({ code: MCP_CLIENT_RUNTIME_CLOSED });
		await closing;
		expect(transportFactory.createTransport).not.toHaveBeenCalled();
		expect(fake.connect).not.toHaveBeenCalled();
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.snapshot("alpha").state).toBe("disconnected");
	});

	it("closes an unowned transport returned after close invalidates its factory", async () => {
		let releaseFactory: (() => void) | undefined;
		let reportFactoryEntered: (() => void) | undefined;
		const factoryGate = new Promise<void>((resolve) => {
			releaseFactory = resolve;
		});
		const factoryEntered = new Promise<void>((resolve) => {
			reportFactoryEntered = resolve;
		});
		const transportClose = vi.fn(async () => undefined);
		const transport = {
			start: vi.fn(async () => undefined),
			send: vi.fn(async () => undefined),
			close: transportClose,
		} satisfies Transport;
		const transportFactory = {
			createTransport: vi.fn(async () => {
				reportFactoryEntered?.();
				await factoryGate;
				return transport;
			}),
		};
		const fake = createFakeClient();
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory,
			servers: [server()],
		});

		const connection = runtime.connect("alpha");
		await factoryEntered;
		const closing = runtime.close();
		releaseFactory?.();

		await expect(connection).rejects.toMatchObject({ code: MCP_CLIENT_RUNTIME_CLOSED });
		await closing;
		expect(transportClose).toHaveBeenCalledOnce();
		expect(fake.connect).not.toHaveBeenCalled();
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.snapshot("alpha").state).toBe("disconnected");
	});

	it("aborts and bounds close when a transport factory ignores cancellation", async () => {
		let reportFactoryEntered: (() => void) | undefined;
		const factoryEntered = new Promise<void>((resolve) => {
			reportFactoryEntered = resolve;
		});
		const observedSignals: AbortSignal[] = [];
		const fake = createFakeClient();
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: {
				createTransport(_definition, context) {
					observedSignals.push(context.signal);
					reportFactoryEntered?.();
					return new Promise<Transport>(() => undefined);
				},
			},
			servers: [server()],
			shutdownTimeoutMs: 10,
		});

		const connection = runtime.connect("alpha");
		await factoryEntered;
		const closing = runtime.close();

		await expect(connection).rejects.toMatchObject({ code: MCP_CLIENT_SHUTDOWN_TIMEOUT });
		await expect(closing).rejects.toMatchObject({
			code: MCP_CLIENT_SHUTDOWN_TIMEOUT,
			serverName: "alpha",
		});
		expect(observedSignals).toHaveLength(1);
		expect(observedSignals[0]?.aborted).toBe(true);
		expect(fake.connect).not.toHaveBeenCalled();
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.snapshot("alpha")).toMatchObject({
			state: "failed",
			lastError: { message: expect.stringContaining("did not stop within 10ms") },
		});
	});

	it("aborts and bounds unregister when Client.connect ignores cancellation", async () => {
		let reportConnectEntered: (() => void) | undefined;
		const connectEntered = new Promise<void>((resolve) => {
			reportConnectEntered = resolve;
		});
		const fake = createFakeClient({
			connectImplementation: async () => {
				reportConnectEntered?.();
				await new Promise<void>(() => undefined);
			},
		});
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			shutdownTimeoutMs: 10,
		});

		const connection = runtime.connect("alpha");
		await connectEntered;
		const removal = runtime.unregister("alpha");

		await expect(connection).rejects.toMatchObject({ code: MCP_CLIENT_SHUTDOWN_TIMEOUT });
		await expect(removal).rejects.toMatchObject({
			code: MCP_CLIENT_SHUTDOWN_TIMEOUT,
			serverName: "alpha",
		});
		expect(fake.connect.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.has("alpha")).toBe(false);
		expect(runtime.names()).toEqual([]);
	});

	it("bounds client cleanup and preserves failures observed before shutdown timeout", async () => {
		let reportClientCloseEntered: (() => void) | undefined;
		const clientCloseEntered = new Promise<void>((resolve) => {
			reportClientCloseEntered = resolve;
		});
		const subscriptionFailure = new Error("subscription cleanup failed before timeout");
		const sdkSubscription = createFakeSubscription({ toolsListChanged: true }, subscriptionFailure);
		const fake = createFakeClient({
			subscription: sdkSubscription.subscription,
			closeImplementation: async () => {
				reportClientCloseEntered?.();
				await new Promise<void>(() => undefined);
			},
		});
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			shutdownTimeoutMs: 10,
		});
		await runtime.connect("alpha");
		await runtime.listen("alpha", { toolsListChanged: true });

		const closing = runtime.close();
		await clientCloseEntered;

		await expect(closing).rejects.toBeInstanceOf(AggregateError);
		await closing.catch((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			if (!(error instanceof AggregateError)) return;
			expect(error.errors[0]).toBe(subscriptionFailure);
			expect(error.errors[1]).toMatchObject({
				code: MCP_CLIENT_SHUTDOWN_TIMEOUT,
				serverName: "alpha",
			});
		});
		expect(sdkSubscription.close).toHaveBeenCalledOnce();
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.getClient("alpha")).toBeUndefined();
		expect(runtime.snapshot("alpha").state).toBe("failed");
	});

	it("still attempts client close when subscription teardown ignores the deadline", async () => {
		let reportSubscriptionCloseEntered: (() => void) | undefined;
		const subscriptionCloseEntered = new Promise<void>((resolve) => {
			reportSubscriptionCloseEntered = resolve;
		});
		const sdkSubscription = createFakeSubscription({ toolsListChanged: true });
		const close = vi.fn(async () => {
			reportSubscriptionCloseEntered?.();
			await new Promise<void>(() => undefined);
		});
		const hangingSubscription = {
			...sdkSubscription.subscription,
			close,
		} satisfies McpSubscription;
		const fake = createFakeClient({ subscription: hangingSubscription });
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			shutdownTimeoutMs: 10,
		});
		await runtime.connect("alpha");
		await runtime.listen("alpha", { toolsListChanged: true });

		const closing = runtime.close();
		await subscriptionCloseEntered;

		await expect(closing).rejects.toMatchObject({ code: MCP_CLIENT_SHUTDOWN_TIMEOUT });
		expect(close).toHaveBeenCalledOnce();
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.getClient("alpha")).toBeUndefined();
	});

	it("rejects invalid shutdown timeouts before registering servers", () => {
		for (const shutdownTimeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
			expect(() => new McpClientRuntime({ shutdownTimeoutMs })).toThrow(
				"MCP client shutdownTimeoutMs must be a positive finite number.",
			);
		}
	});

	it("rejects a connect pipeline held after its terminal once close disconnects it", async () => {
		let releaseConnect: (() => void) | undefined;
		let reportTerminalCompleted: (() => void) | undefined;
		const connectGate = new Promise<void>((resolve) => {
			releaseConnect = resolve;
		});
		const terminalCompleted = new Promise<void>((resolve) => {
			reportTerminalCompleted = resolve;
		});
		const fake = createFakeClient();
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				async (operation, next) => {
					const result = await next();
					if (operation.input.method === "runtime/connect") {
						reportTerminalCompleted?.();
						await connectGate;
					}
					return result;
				},
			],
		});

		const connection = runtime.connect("alpha");
		await terminalCompleted;
		expect(runtime.snapshot("alpha").state).toBe("connected");
		await runtime.close();
		releaseConnect?.();

		await expect(connection).rejects.toMatchObject({ code: MCP_CLIENT_RUNTIME_CLOSED });
		expect(fake.connect).toHaveBeenCalledOnce();
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.snapshot("alpha").state).toBe("disconnected");
	});

	it("returns one stable close promise when cleanup middleware re-enters close", async () => {
		const fake = createFakeClient();
		let reentrantClose: Promise<void> | undefined;
		let runtime: McpClientRuntime;
		runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				async (operation, next) => {
					if (operation.input.method === "runtime/disconnect") {
						reentrantClose = runtime.close();
					}
					return next();
				},
			],
		});
		await runtime.connect("alpha");

		const firstClose = runtime.close();
		await firstClose;

		expect(reentrantClose).toBe(firstClose);
		expect(runtime.close()).toBe(firstClose);
		expect(fake.close).toHaveBeenCalledOnce();
	});

	it("atomically retires an entry before a paused connect can reach its terminal", async () => {
		let releaseConnect: (() => void) | undefined;
		let reportConnectEntered: (() => void) | undefined;
		const connectGate = new Promise<void>((resolve) => {
			releaseConnect = resolve;
		});
		const connectEntered = new Promise<void>((resolve) => {
			reportConnectEntered = resolve;
		});
		const fake = createFakeClient();
		const transportFactory = fixedTransportFactory(createFakeTransport());
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory,
			servers: [server()],
			middleware: [
				async (operation, next) => {
					if (operation.input.method === "runtime/connect") {
						reportConnectEntered?.();
						await connectGate;
					}
					return next();
				},
			],
		});

		const connection = runtime.connect("alpha");
		await connectEntered;
		await expect(runtime.unregister("alpha")).resolves.toBe(true);
		expect(runtime.has("alpha")).toBe(false);
		expect(runtime.names()).toEqual([]);
		expect(runtime.size).toBe(0);
		releaseConnect?.();

		await expect(connection).rejects.toMatchObject({ code: MCP_CLIENT_SERVER_NOT_FOUND });
		expect(transportFactory.createTransport).not.toHaveBeenCalled();
		expect(fake.connect).not.toHaveBeenCalled();
		expect(fake.close).not.toHaveBeenCalled();
	});

	it("waits for and closes an in-flight connection before completing retirement", async () => {
		let releaseConnect: (() => void) | undefined;
		const connectGate = new Promise<void>((resolve) => {
			releaseConnect = resolve;
		});
		const fake = createFakeClient({ connectGate });
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
		});

		const connection = runtime.connect("alpha");
		await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledOnce());
		const removal = runtime.unregister("alpha");
		await expect(runtime.unregister("alpha")).resolves.toBe(false);
		expect(runtime.has("alpha")).toBe(false);
		expect(fake.close).not.toHaveBeenCalled();
		releaseConnect?.();

		await expect(connection).rejects.toMatchObject({ code: MCP_CLIENT_SERVER_NOT_FOUND });
		await expect(removal).resolves.toBe(true);
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.has("alpha")).toBe(false);
		expect(runtime.names()).toEqual([]);
	});

	it("aggregates unowned transport and client cleanup failures after retirement", async () => {
		let releaseFactory: (() => void) | undefined;
		let reportFactoryEntered: (() => void) | undefined;
		const factoryGate = new Promise<void>((resolve) => {
			releaseFactory = resolve;
		});
		const factoryEntered = new Promise<void>((resolve) => {
			reportFactoryEntered = resolve;
		});
		const transportFailure = new Error("transport cleanup failed");
		const clientFailure = new Error("client cleanup failed");
		const transportClose = vi.fn(async () => {
			throw transportFailure;
		});
		const transport = {
			start: vi.fn(async () => undefined),
			send: vi.fn(async () => undefined),
			close: transportClose,
		} satisfies Transport;
		const fake = createFakeClient({ closeError: clientFailure });
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: {
				async createTransport() {
					reportFactoryEntered?.();
					await factoryGate;
					return transport;
				},
			},
			servers: [server()],
		});

		const connection = runtime.connect("alpha");
		await factoryEntered;
		const removal = runtime.unregister("alpha");
		releaseFactory?.();

		await connection.catch((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			if (error instanceof AggregateError) {
				expect(error.errors).toHaveLength(3);
				expect(error.errors[0]).toMatchObject({ code: MCP_CLIENT_SERVER_NOT_FOUND });
				expect(error.errors.slice(1)).toEqual([transportFailure, clientFailure]);
			}
		});
		await expect(removal).resolves.toBe(true);
		expect(transportClose).toHaveBeenCalledOnce();
		expect(fake.connect).not.toHaveBeenCalled();
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.has("alpha")).toBe(false);
	});

	it("never reroutes a retired entry operation to a same-name replacement", async () => {
		let releaseList: (() => void) | undefined;
		let reportListEntered: (() => void) | undefined;
		const listGate = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		const listEntered = new Promise<void>((resolve) => {
			reportListEntered = resolve;
		});
		const oldClient = createFakeClient();
		const replacementClient = createFakeClient();
		const clientFactory: McpSdkClientFactory = {
			createClient(_info, _options, context) {
				const transport = context.definition.transport;
				return transport.kind === "http" && String(transport.url).includes("replacement")
					? replacementClient.client
					: oldClient.client;
			},
		};
		let pauseFirstList = true;
		const runtime = new McpClientRuntime({
			clientFactory,
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server({ transport: { kind: "http", url: "https://old.example.test/mcp" } })],
			middleware: [
				async (operation, next) => {
					if (operation.input.method === "tools/list" && pauseFirstList) {
						pauseFirstList = false;
						reportListEntered?.();
						await listGate;
					}
					return next();
				},
			],
		});
		await runtime.connect("alpha");
		const oldListing = runtime.listTools("alpha");
		await listEntered;

		await runtime.unregister("alpha");
		runtime.register(
			server({ transport: { kind: "http", url: "https://replacement.example.test/mcp" } }),
		);
		await runtime.connect("alpha");
		releaseList?.();

		await expect(oldListing).rejects.toMatchObject({ code: MCP_CLIENT_SERVER_NOT_FOUND });
		expect(oldClient.listTools).not.toHaveBeenCalled();
		expect(replacementClient.listTools).not.toHaveBeenCalled();
		expect(runtime.getClient("alpha")).toBe(replacementClient.client);
		await runtime.close();
	});

	it("closes a subscription that finishes opening after its entry is retired", async () => {
		let releaseListen: (() => void) | undefined;
		const listenGate = new Promise<void>((resolve) => {
			releaseListen = resolve;
		});
		const sdkSubscription = createFakeSubscription({ toolsListChanged: true });
		const fake = createFakeClient({
			subscription: sdkSubscription.subscription,
			listenGate,
		});
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
		});
		await runtime.connect("alpha");

		const listening = runtime.listen("alpha", { toolsListChanged: true });
		await vi.waitFor(() => expect(fake.listen).toHaveBeenCalledOnce());
		await runtime.unregister("alpha");
		releaseListen?.();

		await expect(listening).rejects.toMatchObject({ code: MCP_CLIENT_SERVER_NOT_FOUND });
		expect(sdkSubscription.close).toHaveBeenCalledOnce();
		expect(fake.close).toHaveBeenCalledOnce();
		expect(runtime.has("alpha")).toBe(false);
	});

	it("rolls back only connections owned by a failed connectAll attempt", async () => {
		const connectFailure = new Error("broken upstream");
		const existing = createFakeClient();
		const healthy = createFakeClient();
		const broken = createFakeClient({ connectError: connectFailure });
		const clients = new Map([
			["existing", existing.client],
			["healthy", healthy.client],
			["broken", broken.client],
		]);
		const rollbackMethods: string[] = [];
		const runtime = new McpClientRuntime({
			clientFactory: clientFactoryByName(clients),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [
				server({ name: "existing" }),
				server({ name: "healthy" }),
				server({ name: "broken" }),
			],
			middleware: [
				async (operation, next) => {
					if (operation.input.method === "runtime/disconnect") {
						rollbackMethods.push(operation.input.serverName);
						return undefined;
					}
					return next();
				},
			],
		});
		await runtime.connect("existing");

		await expect(runtime.connectAll()).rejects.toBe(connectFailure);

		expect(existing.close).not.toHaveBeenCalled();
		expect(healthy.close).toHaveBeenCalledOnce();
		expect(broken.close).toHaveBeenCalledOnce();
		expect(rollbackMethods).toEqual(["healthy"]);
		expect(runtime.snapshot("existing").state).toBe("connected");
		expect(runtime.snapshot("healthy").state).toBe("disconnected");
		expect(runtime.snapshot("broken").state).toBe("failed");
		await runtime.close();
	});

	it("preserves connect and rollback failures in deterministic order", async () => {
		const connectFailure = new Error("connect failed");
		const rollbackFailure = new Error("rollback failed");
		const healthy = createFakeClient({ closeError: rollbackFailure });
		const broken = createFakeClient({ connectError: connectFailure });
		const clients = new Map([
			["healthy", healthy.client],
			["broken", broken.client],
		]);
		const runtime = new McpClientRuntime({
			clientFactory: clientFactoryByName(clients),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server({ name: "healthy" }), server({ name: "broken" })],
		});

		const connection = runtime.connectAll();
		await expect(connection).rejects.toBeInstanceOf(AggregateError);
		await connection.catch((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			if (error instanceof AggregateError) {
				expect(error.errors).toEqual([connectFailure, rollbackFailure]);
			}
		});
		expect(healthy.close).toHaveBeenCalledOnce();
		expect(broken.close).toHaveBeenCalledOnce();
		await runtime.close();
	});

	it("does not roll back a connection already in flight before connectAll", async () => {
		let releaseConnect: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseConnect = resolve;
		});
		const shared = createFakeClient({ connectGate: gate });
		const connectFailure = new Error("parallel connect failed");
		const broken = createFakeClient({ connectError: connectFailure });
		const clients = new Map([
			["shared", shared.client],
			["broken", broken.client],
		]);
		const runtime = new McpClientRuntime({
			clientFactory: clientFactoryByName(clients),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server({ name: "shared" }), server({ name: "broken" })],
		});
		const sharedConnection = runtime.connect("shared");
		await vi.waitFor(() => expect(shared.connect).toHaveBeenCalledOnce());

		const all = runtime.connectAll();
		releaseConnect?.();
		await sharedConnection;
		await expect(all).rejects.toBe(connectFailure);

		expect(shared.close).not.toHaveBeenCalled();
		expect(runtime.snapshot("shared").state).toBe("connected");
		await runtime.close();
		expect(shared.close).toHaveBeenCalledOnce();
	});

	it("does not claim a connection won externally while connectAll middleware is delayed", async () => {
		let releaseConnectAll: (() => void) | undefined;
		let reportConnectAllEntered: (() => void) | undefined;
		const connectAllGate = new Promise<void>((resolve) => {
			releaseConnectAll = resolve;
		});
		const connectAllEntered = new Promise<void>((resolve) => {
			reportConnectAllEntered = resolve;
		});
		let delayFirstAlpha = true;
		const shared = createFakeClient();
		const connectFailure = new Error("parallel connect failed");
		const broken = createFakeClient({ connectError: connectFailure });
		const clients = new Map([
			["shared", shared.client],
			["broken", broken.client],
		]);
		const runtime = new McpClientRuntime({
			clientFactory: clientFactoryByName(clients),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server({ name: "shared" }), server({ name: "broken" })],
			resolvePrincipal(operation) {
				if (operation.serverName !== "shared" || !delayFirstAlpha) return undefined;
				delayFirstAlpha = false;
				reportConnectAllEntered?.();
				return connectAllGate;
			},
		});

		const all = runtime.connectAll();
		await connectAllEntered;
		await runtime.connect("shared");
		releaseConnectAll?.();
		await expect(all).rejects.toBe(connectFailure);

		expect(shared.connect).toHaveBeenCalledOnce();
		expect(shared.close).not.toHaveBeenCalled();
		expect(runtime.snapshot("shared").state).toBe("connected");
		await runtime.close();
		expect(shared.close).toHaveBeenCalledOnce();
	});

	it("preserves an explicit legacy negotiation mode", async () => {
		const fake = createFakeClient();
		const created: Array<{ info: Implementation; options: ClientOptions }> = [];
		const runtime = new McpClientRuntime({
			clientFactory: captureClientFactory(fake.client, created),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [
				server({
					clientOptions: { versionNegotiation: { mode: "legacy" } },
				}),
			],
		});

		await runtime.connect("alpha");
		expect(created[0]?.options.versionNegotiation).toEqual({ mode: "legacy" });
		await runtime.close();
	});

	it("tracks an unexpected close from the underlying official client", async () => {
		const fake = createFakeClient({ protocolEra: "legacy", protocolVersion: "2025-11-25" });
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport("remote-session")),
			servers: [server()],
			now: () => 99,
		});
		await runtime.connect("alpha");

		fake.client.onclose?.();

		expect(runtime.getClient("alpha")).toBeUndefined();
		expect(runtime.snapshot("alpha")).toMatchObject({
			state: "disconnected",
			disconnectedAt: 99,
			protocolEra: "legacy",
			sessionId: "remote-session",
		});
		await runtime.close();
	});

	it("supports typed manual input-required rounds without retaining earlier continuation data", async () => {
		const optionsDoNotClaimToolDefinition: "toolDefinition" extends keyof McpClientMrtrRequestOptions
			? false
			: true = true;
		expect(optionsDoNotClaimToolDefinition).toBe(true);
		const continuation = {
			resultType: "input_required",
			requestState: "opaque-state-byte-for-byte",
			inputRequests: {},
		} satisfies InputRequiredResult;
		const fake = createFakeClient({ requestResults: [continuation, {}] });
		const methods: string[] = [];
		const events: McpLifecycleEvent[] = [];
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			middleware: [
				async (operation, next) => {
					methods.push(operation.input.method);
					return next();
				},
			],
			observer: {
				onEvent(event) {
					events.push(event);
				},
			},
		});
		await runtime.connect("alpha");
		methods.length = 0;
		events.length = 0;
		const controller = new AbortController();
		const originalRequest = {
			method: "tools/call",
			params: {
				name: "approve",
				arguments: { artifactId: "artifact-1" },
				inputResponses: { stale: { action: "decline" } },
				requestState: "stale-state",
			},
		} as const;

		const first = await runtime.requestWithInputRequired(
			"alpha",
			originalRequest,
			EMPTY_RESULT_SCHEMA,
			{ signal: controller.signal, maxTotalTimeout: 5_000 },
		);
		expect(first).toEqual(continuation);
		const inputResponses = {
			serverOwnedUnknownKey: { action: "accept", content: { approved: true } },
		} satisfies InputResponses;
		await expect(
			runtime.resumeInputRequired(
				"alpha",
				originalRequest,
				continuation,
				inputResponses,
				EMPTY_RESULT_SCHEMA,
				{ signal: controller.signal, maxTotalTimeout: 4_000 },
			),
		).resolves.toEqual({});

		expect(originalRequest.params).toMatchObject({
			inputResponses: { stale: { action: "decline" } },
			requestState: "stale-state",
		});
		expect(fake.request).toHaveBeenCalledTimes(2);
		expect(fake.request.mock.calls[0]?.[0]).toEqual(originalRequest);
		expect(fake.request.mock.calls[0]?.[2]).toMatchObject({
			allowInputRequired: true,
			signal: controller.signal,
			maxTotalTimeout: 5_000,
		});
		expect(fake.request.mock.calls[1]?.[0]).toEqual({
			method: "tools/call",
			params: {
				name: "approve",
				arguments: { artifactId: "artifact-1" },
				inputResponses,
				requestState: "opaque-state-byte-for-byte",
			},
		});
		expect(fake.request.mock.calls[1]?.[2]).toMatchObject({
			allowInputRequired: true,
			signal: controller.signal,
			maxTotalTimeout: 4_000,
		});
		expect(methods).toEqual(["tools/call", "tools/call"]);
		expect(events.map((event) => event.type)).toEqual([
			"operation.started",
			"operation.succeeded",
			"operation.started",
			"operation.succeeded",
		]);
		await runtime.close();
	});

	it("types and returns an official callTool continuation when manual mode is explicit", async () => {
		const continuation = {
			resultType: "input_required",
			requestState: "official-call-tool-state",
		} satisfies InputRequiredResult;
		const fake = createFakeClient({ callToolResult: continuation });
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
		});
		await runtime.connect("alpha");

		const result: CallToolResult | InputRequiredResult = await runtime.callTool(
			"alpha",
			{ name: "approve" },
			{ allowInputRequired: true },
		);

		expect(result).toBe(continuation);
		expect(fake.callTool).toHaveBeenCalledWith({ name: "approve" }, { allowInputRequired: true });
		await runtime.close();
	});

	it("resumes requestState-only rounds without synthesizing empty input responses", async () => {
		const continuation = {
			resultType: "input_required",
			requestState: "poll-token",
		} satisfies InputRequiredResult;
		const fake = createFakeClient({ requestResults: [{}] });
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
		});
		await runtime.connect("alpha");

		await runtime.resumeInputRequired(
			"alpha",
			{ method: "resources/read", params: { uri: "memory://artifact" } },
			continuation,
			{},
			EMPTY_RESULT_SCHEMA,
		);

		expect(fake.request.mock.calls[0]?.[0]).toEqual({
			method: "resources/read",
			params: { uri: "memory://artifact", requestState: "poll-token" },
		});
		await runtime.close();
	});

	it("round-trips manual input-required state through official v2 transports", async () => {
		const requestIds: Array<string | number> = [];
		const elicitationHandler = vi.fn(async () => ({
			action: "accept" as const,
			content: { approved: true },
		}));
		const requestStateCodec = createRequestStateCodec<{ readonly flow: "approval" }>({
			key: "nest-mcp-mrtr-test-key-32-bytes-minimum",
			bind: (context) => context.mcpReq.method,
		});
		const handler = createMcpHandler(
			() => {
				const officialServer = new McpServer(
					{ name: "mrtr-server", version: "1.0.0" },
					{
						requestState: {
							verify: (state, context) => requestStateCodec.verify(state, context),
						},
					},
				);
				officialServer.registerTool("approve", {}, async (context: ServerContext) => {
					requestIds.push(context.mcpReq.id);
					const state = context.mcpReq.requestState<{ readonly flow: "approval" }>();
					const approval = acceptedContent(
						context.mcpReq.inputResponses,
						"approval",
						APPROVAL_SCHEMA,
					);
					if (state?.flow === "approval" && approval?.approved === true) {
						return { content: [{ type: "text" as const, text: "approved" }] };
					}
					return inputRequired({
						requestState: await requestStateCodec.mint({ flow: "approval" }, context),
						inputRequests: {
							approval: inputRequired.elicit({
								message: "Approve this operation?",
								requestedSchema: {
									type: "object",
									properties: { approved: { type: "boolean" } },
									required: ["approved"],
								},
							}),
						},
					});
				});
				return officialServer;
			},
			{ legacy: "reject" },
		);
		const runtime = new McpClientRuntime({
			servers: [
				server({
					transport: {
						kind: "http",
						url: "https://mrtr.example.test/mcp",
						fetch: (url, init) => handler.fetch(new Request(url, init)),
					},
					clientOptions: {
						capabilities: { elicitation: { form: {} } },
						versionNegotiation: { mode: { pin: "2026-07-28" } },
					},
					configureClient(client) {
						client.setRequestHandler("elicitation/create", elicitationHandler);
					},
				}),
			],
		});

		try {
			await runtime.connect("alpha");
			const originalRequest = { method: "tools/call", params: { name: "approve" } } as const;
			await expect(
				runtime.requestWithSchema(
					"alpha",
					{
						method: "tools/call",
						params: { name: "approve", requestState: "attacker-preseeded-state" },
					},
					specTypeSchemas.CallToolResult,
				),
			).rejects.toThrow("Invalid or expired requestState");
			expect(requestIds).toHaveLength(0);

			const first = await runtime.requestWithInputRequired(
				"alpha",
				originalRequest,
				specTypeSchemas.CallToolResult,
			);
			expect(first).toMatchObject({ resultType: "input_required" });
			expect(elicitationHandler).not.toHaveBeenCalled();
			if (!isInputRequiredResult(first)) {
				throw new Error("Expected an input-required round.");
			}
			const continuation: InputRequiredResult = first;
			await expect(
				runtime.resumeInputRequired(
					"alpha",
					originalRequest,
					{ ...continuation, requestState: `${continuation.requestState ?? ""}.tampered` },
					{ approval: { action: "accept", content: { approved: true } } },
					specTypeSchemas.CallToolResult,
				),
			).rejects.toThrow("Invalid or expired requestState");
			expect(requestIds).toHaveLength(1);

			const complete = await runtime.resumeInputRequired(
				"alpha",
				originalRequest,
				continuation,
				{ approval: { action: "accept", content: { approved: true } } },
				specTypeSchemas.CallToolResult,
			);
			expect(complete).toMatchObject({
				content: [{ type: "text", text: "approved" }],
			});
			expect(requestIds).toHaveLength(2);
			expect(requestIds[1]).not.toBe(requestIds[0]);
		} finally {
			await runtime.close();
			await handler.close();
		}
	});

	it("forwards cancellation and total-time budgets to each explicit MRTR leg", async () => {
		const failure = new Error("agent cancelled");
		const controller = new AbortController();
		controller.abort(failure);
		const fake = createFakeClient({ requestError: failure });
		const events: McpLifecycleEvent[] = [];
		const runtime = new McpClientRuntime({
			clientFactory: fixedClientFactory(fake.client),
			transportFactory: fixedTransportFactory(createFakeTransport()),
			servers: [server()],
			observer: {
				onEvent(event) {
					events.push(event);
				},
			},
		});
		await runtime.connect("alpha");
		events.length = 0;

		await expect(
			runtime.requestWithInputRequired(
				"alpha",
				{ method: "prompts/get", params: { name: "review" } },
				EMPTY_RESULT_SCHEMA,
				{ signal: controller.signal, maxTotalTimeout: 250 },
			),
		).rejects.toBe(failure);
		expect(fake.request.mock.calls[0]?.[2]).toMatchObject({
			allowInputRequired: true,
			signal: controller.signal,
			maxTotalTimeout: 250,
		});
		expect(events.map((event) => event.type)).toEqual(["operation.started", "operation.cancelled"]);
		await runtime.close();
	});
});

function server(overrides: Partial<McpClientServerDefinition> = {}): McpClientServerDefinition {
	return {
		name: "alpha",
		transport: { kind: "http", url: "https://mcp.example.test" },
		...overrides,
	};
}

function createFakeTransport(sessionId?: string): Transport {
	return {
		start: vi.fn(async () => undefined),
		send: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
		...(sessionId === undefined ? {} : { sessionId }),
	};
}

function fixedTransportFactory(transport: Transport) {
	return { createTransport: vi.fn(() => transport) };
}

function captureClientFactory(
	client: Client,
	created: Array<{ info: Implementation; options: ClientOptions }>,
): McpSdkClientFactory {
	return {
		createClient(info, options) {
			created.push({ info, options });
			return client;
		},
	};
}

function fixedClientFactory(client: Client): McpSdkClientFactory {
	return { createClient: vi.fn(() => client) };
}

function clientFactoryByName(clients: ReadonlyMap<string, Client>): McpSdkClientFactory {
	return {
		createClient(_info, _options, context) {
			const client = clients.get(context.serverName);
			if (client === undefined) throw new Error(`Missing fake client: ${context.serverName}`);
			return client;
		},
	};
}

function createFakeClient(
	options: {
		readonly connectGate?: Promise<void>;
		readonly connectImplementation?: (
			transport: Transport,
			options?: ConnectOptions,
		) => Promise<void>;
		readonly connectError?: Error;
		readonly protocolEra?: "modern" | "legacy";
		readonly discoverResult?: DiscoverResult;
		readonly protocolVersion?: string;
		readonly subscription?: McpSubscription;
		readonly autoSubscription?: McpSubscription;
		readonly listenGate?: Promise<void>;
		readonly closeImplementation?: () => Promise<void>;
		readonly closeError?: Error;
		readonly callToolResult?: CallToolResult | InputRequiredResult;
		readonly requestError?: Error;
		readonly requestResults?: readonly unknown[];
	} = {},
) {
	const requestResults = [...(options.requestResults ?? [])];
	const connect = vi.fn(async (transport: Transport, connectOptions?: ConnectOptions) => {
		if (options.connectImplementation !== undefined) {
			await options.connectImplementation(transport, connectOptions);
			return;
		}
		await options.connectGate;
		if (options.connectError !== undefined) throw options.connectError;
	});
	const close = vi.fn(async () => {
		if (options.closeImplementation !== undefined) {
			await options.closeImplementation();
			return;
		}
		if (options.closeError !== undefined) throw options.closeError;
	});
	const request = vi.fn(async (..._arguments: unknown[]) => {
		if (options.requestError !== undefined) throw options.requestError;
		return requestResults.shift() ?? {};
	});
	const listTools = vi.fn(async () => ({ tools: [] }));
	const callTool = vi.fn(async () =>
		options.callToolResult === undefined
			? {
					content: [{ type: "text" as const, text: "ok" }],
					isError: false,
				}
			: options.callToolResult,
	);
	const listen = vi.fn(async () => {
		await options.listenGate;
		return options.subscription ?? createFakeSubscription({}).subscription;
	});
	// A focused test double implements only the official Client surface exercised by the runtime.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const client = {
		connect,
		close,
		getNegotiatedProtocolVersion: () => options.protocolVersion,
		getProtocolEra: () => options.protocolEra,
		getServerVersion: () => ({ name: "fake-server", version: "1.0.0" }),
		getServerCapabilities: () => ({ tools: {}, resources: {}, prompts: {} }),
		getInstructions: () => "Use responsibly.",
		getDiscoverResult: () => options.discoverResult,
		autoOpenedSubscription: options.autoSubscription,
		ping: vi.fn(async () => ({})),
		discover: vi.fn(async () => options.discoverResult ?? MODERN_DISCOVERY),
		request,
		notification: vi.fn(async () => undefined),
		complete: vi.fn(async () => ({ completion: { values: ["formal"] } })),
		setLoggingLevel: vi.fn(async () => ({})),
		listTools,
		callTool,
		listResources: vi.fn(async () => ({ resources: [] })),
		listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
		readResource: vi.fn(async () => ({ contents: [] })),
		subscribeResource: vi.fn(async () => ({})),
		unsubscribeResource: vi.fn(async () => ({})),
		listen,
		listPrompts: vi.fn(async () => ({ prompts: [] })),
		getPrompt: vi.fn(async () => ({ messages: [] })),
		sendRootsListChanged: vi.fn(async () => undefined),
	} as unknown as Client;
	return { client, connect, close, request, listTools, callTool, listen };
}

function createFakeSubscription(honoredFilter: SubscriptionFilter, closeError?: Error) {
	let resolveClosed: ((cause: "local" | "graceful" | "remote") => void) | undefined;
	const closed = new Promise<"local" | "graceful" | "remote">((resolve) => {
		resolveClosed = resolve;
	});
	const close = vi.fn(async () => {
		if (closeError !== undefined) throw closeError;
		resolveClosed?.("local");
	});
	const subscription = { honoredFilter, close, closed } satisfies McpSubscription;
	return { subscription, close };
}
