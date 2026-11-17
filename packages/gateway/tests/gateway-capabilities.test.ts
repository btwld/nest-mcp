import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { fromJsonSchema, type Prompt, type Resource } from "@modelcontextprotocol/server";
import { allowMcpOperation, denyMcpOperation } from "@nest-mcp/core";
import { McpServerRuntime } from "@nest-mcp/server";
import { describe, expect, it, vi } from "vitest";
import {
	GatewayPromptNameCodec,
	GatewayNameCodec,
	GatewayResourceUriCodec,
	McpGateway,
	allowAllMcpGatewayPolicy,
} from "../src/index.ts";
import type { McpGatewayMiddleware, McpGatewayPolicy } from "../src/index.ts";
import { McpGatewayTestClient } from "../src/testing/index.ts";

const PROMPT = {
	name: "review.code/日本語",
	description: "Review code",
	arguments: [{ name: "language", required: true }],
} satisfies Prompt;

const RESOURCE = {
	name: "tenant note",
	uri: "tenant+opaque://acme/private/customer-42?classification=internal",
	description: "A private note",
	mimeType: "text/plain",
} satisfies Resource;

describe("gateway prompt and resource projection", () => {
	it("serves prompts and concrete resources through an official MCP v2 connection", async () => {
		const upstream = new McpGatewayTestClient(
			[],
			{},
			{
				prompts: [PROMPT],
				resources: [RESOURCE],
				promptHandlers: {
					[PROMPT.name]: (arguments_) => ({
						description: `Review ${arguments_?.language ?? "unknown"}`,
						messages: [
							{
								role: "user",
								content: {
									type: "resource_link",
									name: RESOURCE.name,
									uri: RESOURCE.uri,
								},
							},
						],
					}),
				},
				resourceHandlers: {
					[RESOURCE.uri]: () => ({
						contents: [{ uri: RESOURCE.uri, text: "private payload" }],
					}),
				},
			},
		);
		const gateway = new McpGateway({
			upstreams: [{ name: "tenant/acme", client: upstream }],
			policy: allowAllMcpGatewayPolicy(),
		});
		const runtime = new McpServerRuntime({
			name: "gateway",
			serverInfo: { name: "gateway", version: "1.0.0" },
			features: [gateway.asServerFeature()],
		});
		const server = await runtime.createServer({ era: "modern" });
		const client = new Client({ name: "capability-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const capabilities = client.getServerCapabilities();
			expect(capabilities?.prompts).toEqual({ listChanged: false });
			expect(capabilities?.resources).toEqual({ listChanged: false, subscribe: false });

			const prompts = await client.listPrompts();
			expect(prompts.prompts).toHaveLength(1);
			expect(new GatewayPromptNameCodec().decode(prompts.prompts[0]!.name)).toEqual({
				upstreamName: "tenant/acme",
				promptName: PROMPT.name,
			});

			const resources = await client.listResources();
			expect(resources.resources).toHaveLength(1);
			const projectedUri = resources.resources[0]!.uri;
			expect(projectedUri).not.toContain("customer-42");
			expect(projectedUri).not.toContain("classification=internal");
			expect(new GatewayResourceUriCodec().decode(projectedUri)).toEqual({
				upstreamName: "tenant/acme",
				resourceUri: RESOURCE.uri,
			});

			const prompt = await client.getPrompt({
				name: prompts.prompts[0]!.name,
				arguments: { language: "TypeScript" },
			});
			expect(prompt.description).toBe("Review TypeScript");
			expect(prompt.messages[0]!.content).toMatchObject({
				type: "resource_link",
				uri: projectedUri,
			});

			const read = await client.readResource({ uri: projectedUri });
			expect(read.contents).toEqual([{ uri: projectedUri, text: "private payload" }]);
			expect(upstream.promptCalls).toEqual([
				{ name: PROMPT.name, arguments: { language: "TypeScript" } },
			]);
			expect(upstream.resourceReads).toEqual([RESOURCE.uri]);
		} finally {
			await client.close();
			await server.close();
			await runtime.close();
		}
	});

	it("fails closed for new capabilities when an existing tool-only policy has no hooks", async () => {
		const upstream = new McpGatewayTestClient([], {}, { prompts: [PROMPT], resources: [RESOURCE] });
		const policy: McpGatewayPolicy = { authorize: () => allowMcpOperation() };
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: upstream }],
			policy,
			authorizationContextResolver: () => "principal-a",
		});

		await expect(gateway.listProjectedPrompts()).resolves.toEqual([]);
		await expect(gateway.listProjectedResources()).resolves.toEqual([]);
	});

	it("filters list and re-authorizes get/read before middleware and upstream", async () => {
		let executionsAllowed = true;
		const upstream = new McpGatewayTestClient([], {}, { prompts: [PROMPT], resources: [RESOURCE] });
		const middleware = vi.fn<McpGatewayMiddleware>(async (_operation, next) => next());
		const policy: McpGatewayPolicy = {
			authorize: () => allowMcpOperation(),
			authorizePrompt(operation) {
				return operation.input.action === "get" && !executionsAllowed
					? denyMcpOperation("Prompt get denied.")
					: allowMcpOperation();
			},
			authorizeResource(operation) {
				return operation.input.action === "read" && !executionsAllowed
					? denyMcpOperation("Resource read denied.")
					: allowMcpOperation();
			},
		};
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: upstream }],
			policy,
			middleware: [middleware],
			authorizationContextResolver: () => "principal-a",
		});
		const [prompt] = await gateway.listProjectedPrompts();
		const [resource] = await gateway.listProjectedResources();
		executionsAllowed = false;
		middleware.mockClear();

		await expect(gateway.getPrompt(prompt!.projectedName, {})).rejects.toMatchObject({
			decision: { reason: "Prompt get denied." },
		});
		await expect(gateway.readResource(resource!.projectedUri)).rejects.toMatchObject({
			decision: { reason: "Resource read denied." },
		});
		expect(
			middleware.mock.calls.every(([operation]) => operation.input.type === "gateway.discovery"),
		).toBe(true);
		expect(upstream.promptCalls).toEqual([]);
		expect(upstream.resourceReads).toEqual([]);
	});

	it("rewrites resource links returned by tools", async () => {
		const upstream = new McpGatewayTestClient(
			[
				{
					name: "link",
					inputSchema: { type: "object" },
				},
			],
			{
				link: () => ({
					content: [{ type: "resource_link", name: RESOURCE.name, uri: RESOURCE.uri }],
				}),
			},
			{ resources: [RESOURCE] },
		);
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: upstream }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});
		const [tool] = await gateway.listProjectedTools();
		const result = await gateway.callTool(tool!.projectedName, {});
		const content = result.content[0];
		expect(content?.type).toBe("resource_link");
		if (content?.type !== "resource_link") throw new Error("Expected resource link.");
		expect(new GatewayNameCodec().decode(content.name)).toEqual({
			upstreamName: "primary",
			toolName: RESOURCE.name,
		});
		expect(content.uri).not.toContain("classification=internal");
		expect(new GatewayResourceUriCodec().decode(content.uri).resourceUri).toBe(RESOURCE.uri);
	});

	it("strips opaque metadata from execution results and nested protocol content", async () => {
		const secretMetadata = { token: "upstream-secret", topology: "internal-host" };
		const upstream = new McpGatewayTestClient(
			[{ name: "link", inputSchema: { type: "object" } }],
			{
				link: () => ({
					_meta: secretMetadata,
					content: [
						{
							type: "resource",
							_meta: secretMetadata,
							resource: {
								uri: RESOURCE.uri,
								text: "private payload",
								_meta: secretMetadata,
							},
						},
					],
				}),
			},
			{
				prompts: [PROMPT],
				resources: [RESOURCE],
				promptHandlers: {
					[PROMPT.name]: () => ({
						_meta: secretMetadata,
						messages: [
							{
								role: "user",
								_meta: secretMetadata,
								content: { type: "text", text: "review", _meta: secretMetadata },
							},
						],
					}),
				},
				resourceHandlers: {
					[RESOURCE.uri]: () => ({
						_meta: secretMetadata,
						contents: [{ uri: RESOURCE.uri, text: "private payload", _meta: secretMetadata }],
					}),
				},
			},
		);
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: upstream }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});
		const [tool] = await gateway.listProjectedTools();
		const [prompt] = await gateway.listProjectedPrompts();
		const [resource] = await gateway.listProjectedResources();

		const results = await Promise.all([
			gateway.callTool(tool!.projectedName, {}),
			gateway.getPrompt(prompt!.projectedName, { language: "TypeScript" }),
			gateway.readResource(resource!.projectedUri),
		]);
		expect(JSON.stringify(results)).not.toContain("upstream-secret");
		expect(JSON.stringify(results)).not.toContain("internal-host");
		expect(JSON.stringify(results)).not.toContain('"_meta"');
	});

	it("rejects resource links that were not authorized through concrete discovery", async () => {
		const upstream = new McpGatewayTestClient([{ name: "link", inputSchema: { type: "object" } }], {
			link: () => ({
				content: [{ type: "resource_link", name: RESOURCE.name, uri: RESOURCE.uri }],
			}),
		});
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: upstream }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});
		const [tool] = await gateway.listProjectedTools();
		await expect(gateway.callTool(tool!.projectedName, {})).rejects.toMatchObject({
			code: "UNLISTED_RESOURCE_LINK",
		});
	});

	it("rejects returned links and embedded resources hidden by resource policy", async () => {
		const upstream = new McpGatewayTestClient(
			[
				{ name: "link", inputSchema: { type: "object" } },
				{ name: "embed", inputSchema: { type: "object" } },
			],
			{
				link: () => ({
					content: [{ type: "resource_link", name: RESOURCE.name, uri: RESOURCE.uri }],
				}),
				embed: () => ({
					content: [{ type: "resource", resource: { uri: RESOURCE.uri, text: "hidden" } }],
				}),
			},
			{ resources: [RESOURCE] },
		);
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: upstream }],
			policy: {
				authorize: () => allowMcpOperation(),
				authorizeResource: () => denyMcpOperation("Resource hidden."),
			},
			authorizationContextResolver: () => "principal-a",
		});
		const tools = await gateway.listProjectedTools();

		for (const tool of tools) {
			await expect(gateway.callTool(tool.projectedName, {})).rejects.toMatchObject({
				code: "UNLISTED_RESOURCE_LINK",
			});
		}
	});

	it("rejects unrelated URIs returned by a concrete resource read", async () => {
		const upstream = new McpGatewayTestClient(
			[],
			{},
			{
				resources: [RESOURCE],
				resourceHandlers: {
					[RESOURCE.uri]: () => ({ contents: [{ uri: "test://unrelated", text: "leak" }] }),
				},
			},
		);
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client: upstream }],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});
		const [resource] = await gateway.listProjectedResources();

		await expect(gateway.readResource(resource!.projectedUri)).rejects.toMatchObject({
			code: "UNLISTED_RESOURCE_LINK",
		});
	});

	it("bounds prompt/resource pagination and item counts", async () => {
		const client = new McpGatewayTestClient([], {}, { prompts: [PROMPT], resources: [RESOURCE] });
		client.listPrompts = vi.fn(() => ({ prompts: [PROMPT], nextCursor: "more" }));
		const pageLimited = new McpGateway({
			upstreams: [{ name: "primary", client }],
			policy: allowAllMcpGatewayPolicy(),
			discoveryMaxPages: 1,
			authorizationContextResolver: () => "principal-a",
		});
		await expect(pageLimited.listProjectedPrompts()).rejects.toMatchObject({
			code: "INVALID_DISCOVERY",
			message: expect.stringContaining("page discovery limit while listing prompts"),
		});

		const itemLimited = new McpGateway({
			upstreams: [
				{
					name: "primary",
					client: new McpGatewayTestClient(
						[],
						{},
						{ resources: [RESOURCE, { ...RESOURCE, uri: "test://second" }] },
					),
				},
			],
			policy: allowAllMcpGatewayPolicy(),
			discoveryMaxItemsPerCapability: 1,
			authorizationContextResolver: () => "principal-a",
		});
		await expect(itemLimited.listProjectedResources()).rejects.toMatchObject({
			code: "INVALID_DISCOVERY",
			message: expect.stringContaining("resources discovery-item limit"),
		});
	});

	it.each([false, true])(
		"composes local resources and rejects duplicate tool names: %s",
		async (duplicate) => {
			const gateway = new McpGateway({
				upstreams: [
					{
						name: "primary",
						client: new McpGatewayTestClient([{ name: "query", inputSchema: { type: "object" } }], {
							query: () => ({ content: [] }),
						}),
					},
				],
				policy: allowAllMcpGatewayPolicy(),
			});
			const [remote] = await gateway.listProjectedTools();
			const runtime = new McpServerRuntime({
				name: "mixed",
				serverInfo: { name: "mixed", version: "1" },
				features: [
					gateway.asServerFeature({ toolsOnly: true }),
					(server) => {
						server.registerTool(
							duplicate ? remote!.projectedName : "local",
							{ inputSchema: fromJsonSchema({ type: "object" }) },
							async () => ({ content: [] }),
						);
						server.registerResource("guide", "guide://local", {}, async () => ({
							contents: [{ uri: "guide://local", text: "guide" }],
						}));
					},
				],
			});
			try {
				if (duplicate) {
					await expect(runtime.createServer({ era: "modern" })).rejects.toThrow(
						/already registered/,
					);
					return;
				}
				const server = await runtime.createServer({ era: "modern" });
				const client = new Client({ name: "mixed", version: "1" });
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await server.connect(serverTransport);
				await client.connect(clientTransport);
				try {
					expect((await client.listTools()).tools).toHaveLength(2);
					expect((await client.readResource({ uri: "guide://local" })).contents[0]).toMatchObject({
						text: "guide",
					});
				} finally {
					await client.close();
				}
			} finally {
				await runtime.close();
				await gateway.close();
			}
		},
	);

	it("rejects mixed ownership of notification capabilities for projected namespaces", async () => {
		const gateway = new McpGateway({
			upstreams: [
				{
					name: "primary",
					client: new McpGatewayTestClient([], {}, { prompts: [], resources: [] }),
				},
			],
			policy: allowAllMcpGatewayPolicy(),
		});
		const runtime = new McpServerRuntime({
			name: "mixed",
			serverInfo: { name: "mixed", version: "1.0.0" },
			features: [
				(server) => {
					server.server.registerCapabilities({
						tools: { listChanged: true },
						prompts: { listChanged: true },
						resources: { listChanged: true, subscribe: true },
					});
				},
				gateway.asServerFeature(),
			],
		});
		await expect(runtime.createServer({ era: "modern" })).rejects.toMatchObject({
			code: "CAPABILITY_CONFLICT",
		});
		await runtime.close();
	});
});
