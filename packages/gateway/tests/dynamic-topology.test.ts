import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Prompt, Resource, Tool } from "@modelcontextprotocol/server";
import { McpServerRuntime } from "@nest-mcp/server";
import { describe, expect, it } from "vitest";

import {
	GatewayNameCodec,
	GatewayPromptNameCodec,
	GatewayResourceUriCodec,
	McpGateway,
	allowAllMcpGatewayPolicy,
} from "../src/index.ts";
import { McpGatewayTestClient } from "../src/testing/index.ts";

const SHARED_TOOL = {
	name: "echo",
	inputSchema: { type: "object", properties: { value: { type: "string" } } },
} satisfies Tool;

const SHARED_PROMPT = {
	name: "summarize",
	arguments: [{ name: "topic", required: true }],
} satisfies Prompt;

const SHARED_RESOURCE = {
	name: "guide",
	uri: "docs://shared/guide",
} satisfies Resource;

function upstream(label: string): McpGatewayTestClient {
	return new McpGatewayTestClient(
		[SHARED_TOOL],
		{
			echo: (arguments_) => ({
				content: [{ type: "text", text: `${label}:${String(arguments_?.value)}` }],
			}),
		},
		{
			prompts: [SHARED_PROMPT],
			resources: [SHARED_RESOURCE],
			promptHandlers: {
				summarize: (arguments_) => ({
					messages: [
						{
							role: "user",
							content: { type: "text", text: `${label}:${arguments_?.topic ?? ""}` },
						},
					],
				}),
			},
			resourceHandlers: {
				[SHARED_RESOURCE.uri]: () => ({
					contents: [{ uri: SHARED_RESOURCE.uri, text: `${label}:guide` }],
				}),
			},
		},
	);
}

describe("McpGateway dynamic topology", () => {
	it("attaches, namespaces, routes, and detaches every requested capability", async () => {
		const alpha = upstream("alpha");
		const beta = upstream("beta");
		const gateway = new McpGateway({
			dynamicUpstreams: true,
			upstreams: [],
			policy: allowAllMcpGatewayPolicy(),
		});

		try {
			expect(gateway.topology()).toEqual({ revision: 0, upstreamNames: [] });
			await gateway.attachUpstream({ name: "beta", client: beta }, { expectedRevision: 0 });
			expect(
				await gateway.attachUpstream({ name: "alpha", client: alpha }, { expectedRevision: 1 }),
			).toEqual({ revision: 2, upstreamNames: ["alpha", "beta"] });

			const [tools, prompts, resources] = await Promise.all([
				gateway.listProjectedTools(),
				gateway.listProjectedPrompts(),
				gateway.listProjectedResources(),
			]);
			expect(tools).toHaveLength(2);
			expect(prompts).toHaveLength(2);
			expect(resources).toHaveLength(2);
			expect(new Set(tools.map(({ projectedName }) => projectedName)).size).toBe(2);
			expect(new Set(prompts.map(({ projectedName }) => projectedName)).size).toBe(2);
			expect(new Set(resources.map(({ projectedUri }) => projectedUri)).size).toBe(2);

			const betaTool = new GatewayNameCodec().encode("beta", SHARED_TOOL.name);
			const betaPrompt = new GatewayPromptNameCodec().encode("beta", SHARED_PROMPT.name);
			const betaResource = new GatewayResourceUriCodec().encode("beta", SHARED_RESOURCE.uri);
			await expect(gateway.callTool(betaTool, { value: "ok" })).resolves.toMatchObject({
				content: [{ type: "text", text: "beta:ok" }],
			});
			await expect(gateway.getPrompt(betaPrompt, { topic: "MCP" })).resolves.toMatchObject({
				messages: [{ content: { text: "beta:MCP" } }],
			});
			await expect(gateway.readResource(betaResource)).resolves.toMatchObject({
				contents: [{ text: "beta:guide" }],
			});

			expect(await gateway.detachUpstream("beta", { expectedRevision: 2 })).toEqual({
				revision: 3,
				upstreamNames: ["alpha"],
			});
			expect((await gateway.listProjectedTools()).map(({ upstreamName }) => upstreamName)).toEqual([
				"alpha",
			]);
			await expect(gateway.callTool(betaTool, {})).rejects.toMatchObject({
				code: "UNKNOWN_UPSTREAM",
			});
		} finally {
			await gateway.close();
		}
	});

	it("serializes CAS mutations and refuses dynamic writes on static gateways", async () => {
		const client = upstream("primary");
		const dynamic = new McpGateway({
			dynamicUpstreams: true,
			upstreams: [],
			policy: allowAllMcpGatewayPolicy(),
		});
		const fixed = new McpGateway({
			upstreams: [{ name: "fixed", client }],
			policy: allowAllMcpGatewayPolicy(),
		});

		try {
			const first = dynamic.attachUpstream({ name: "first", client }, { expectedRevision: 0 });
			const stale = dynamic.attachUpstream({ name: "second", client }, { expectedRevision: 0 });
			await expect(first).resolves.toMatchObject({ revision: 1 });
			await expect(stale).rejects.toMatchObject({ code: "TOPOLOGY_REVISION_CONFLICT" });
			expect(dynamic.topology()).toEqual({ revision: 1, upstreamNames: ["first"] });

			await expect(fixed.detachUpstream("fixed")).rejects.toMatchObject({
				code: "STATIC_TOPOLOGY",
			});
			expect(fixed.topology()).toEqual({ revision: 0, upstreamNames: ["fixed"] });
		} finally {
			await Promise.all([dynamic.close(), fixed.close()]);
		}
	});

	it("atomically replaces routing identity so held projected names cannot retarget", async () => {
		const gateway = new McpGateway({
			dynamicUpstreams: true,
			upstreams: [{ name: "old-route", client: upstream("old") }],
			policy: allowAllMcpGatewayPolicy(),
		});
		const heldName = new GatewayNameCodec().encode("old-route", SHARED_TOOL.name);

		try {
			expect(
				await gateway.replaceUpstream(
					"old-route",
					{ name: "new-route", client: upstream("new") },
					{ expectedRevision: 0 },
				),
			).toEqual({ revision: 1, upstreamNames: ["new-route"] });
			await expect(gateway.callTool(heldName, {})).rejects.toMatchObject({
				code: "UNKNOWN_UPSTREAM",
			});
			const newName = new GatewayNameCodec().encode("new-route", SHARED_TOOL.name);
			await expect(gateway.callTool(newName, { value: "safe" })).resolves.toMatchObject({
				content: [{ text: "new:safe" }],
			});
		} finally {
			await gateway.close();
		}
	});

	it("advertises dynamic list invalidation support before the first attachment", async () => {
		const gateway = new McpGateway({
			dynamicUpstreams: true,
			upstreams: [],
			policy: allowAllMcpGatewayPolicy(),
		});
		const runtime = new McpServerRuntime({
			name: "dynamic-gateway",
			serverInfo: { name: "dynamic-gateway", version: "1.0.0" },
			features: [gateway.asServerFeature()],
		});
		const server = await runtime.createServer({ era: "modern" });
		const client = new Client({ name: "dynamic-client", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			expect(client.getServerCapabilities()).toMatchObject({
				tools: { listChanged: true },
				prompts: { listChanged: true },
				resources: { listChanged: true, subscribe: false },
			});
			expect((await client.listTools()).tools).toEqual([]);
			expect((await client.listPrompts()).prompts).toEqual([]);
			expect((await client.listResources()).resources).toEqual([]);
		} finally {
			await Promise.all([client.close(), server.close(), runtime.close(), gateway.close()]);
		}
	});

	it("fences detached routes before asynchronous cache cleanup settles", async () => {
		const clearStarted = deferred();
		const releaseClear = deferred();
		const gateway = new McpGateway({
			dynamicUpstreams: true,
			upstreams: [{ name: "retiring-route", client: upstream("retiring") }],
			policy: allowAllMcpGatewayPolicy(),
			discoveryCache: {
				get: () => undefined,
				set: () => undefined,
				delete: () => false,
				clear: async () => {
					clearStarted.resolve();
					await releaseClear.promise;
				},
			},
		});
		const heldName = new GatewayNameCodec().encode("retiring-route", SHARED_TOOL.name);

		try {
			const detaching = gateway.detachUpstream("retiring-route");
			await clearStarted.promise;
			await expect(gateway.callTool(heldName, {})).rejects.toMatchObject({
				code: "UNKNOWN_UPSTREAM",
			});
			releaseClear.resolve();
			await expect(detaching).resolves.toMatchObject({ revision: 1, upstreamNames: [] });
		} finally {
			releaseClear.resolve();
			await gateway.close();
		}
	});
});

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
	let settle: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		settle = resolve;
	});
	return Object.freeze({
		promise,
		resolve: () => settle?.(),
	});
}
