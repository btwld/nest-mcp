import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { fromJsonSchema, McpServerRuntime } from "@nest-mcp/server";
import { createMcpServerTestFetch } from "@nest-mcp/server/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { AppModule } from "../src/app.module.ts";
import { configureApplication } from "../src/bootstrap.ts";
import { ControlPlaneConfigService } from "../src/config/control-plane-config.service.ts";
import { MCP_CONTROL_PLANE_GUARDED_FETCH } from "../src/runtime/runtime.types.ts";

const connectionSchema = z.object({
	id: z.string().uuid(),
	revision: z.number().int().positive(),
	runtimeGeneration: z.number().int().positive(),
});
const hubSchema = z.object({
	revision: z.number().int().positive(),
	members: z.array(z.object({ connectionId: z.string().uuid(), namespace: z.string() })),
	counts: z.object({ tools: z.number(), resources: z.number(), prompts: z.number() }),
});
const catalogSchema = z.object({
	tools: z.array(
		z.object({ namespace: z.string(), sourceName: z.string(), projectedName: z.string() }),
	),
	resources: z.array(
		z.object({ namespace: z.string(), sourceName: z.string(), projectedUri: z.string() }),
	),
	prompts: z.array(
		z.object({ namespace: z.string(), sourceName: z.string(), projectedName: z.string() }),
	),
});

describe("process-local MCP hub", () => {
	let app: NestFastifyApplication;
	let alpha: McpServerRuntime;
	let beta: McpServerRuntime;
	let baseUrl: string;

	beforeAll(async () => {
		alpha = upstream("alpha");
		beta = upstream("beta");
		const alphaFetch = createMcpServerTestFetch(alpha);
		const betaFetch = createMcpServerTestFetch(beta);
		const routeFetch: typeof fetch = (input, init) => {
			const rawUrl = input instanceof Request ? input.url : String(input);
			return new URL(rawUrl).pathname.includes("beta")
				? betaFetch(input, init)
				: alphaFetch(input, init);
		};
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(MCP_CONTROL_PLANE_GUARDED_FETCH)
			.useValue(routeFetch)
			.overrideProvider(ControlPlaneConfigService)
			.useValue({
				host: "127.0.0.1",
				port: 3400,
				allowedHosts: ["127.0.0.1", "localhost", "::1"],
				oauthAllowedHosts: ["127.0.0.1", "localhost", "::1"],
				allowLoopbackHttp: true,
				maxConnections: 2,
				requestTimeoutMs: 10_000,
				shutdownTimeoutMs: 10_000,
				maxDiscoveryPages: 16,
				maxDiscoveryItems: 1_000,
			})
			.compile();
		app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
			logger: false,
		});
		configureApplication(app, { swagger: false });
		await app.listen(0, "127.0.0.1");
		baseUrl = await app.getUrl();
	});

	afterAll(async () => {
		await app.close();
		await Promise.all([alpha.close(), beta.close()]);
	});

	it("namespaces colliding capabilities and detaches one upstream without restart", async () => {
		const alphaConnection = connectionSchema.parse(
			(
				await request("POST", "/v1/mcp/connections", 201, {
					displayName: "Alpha",
					endpoint: "http://127.0.0.1/alpha",
					desiredState: "online",
				})
			).json(),
		);
		const betaConnection = connectionSchema.parse(
			(
				await request("POST", "/v1/mcp/connections", 201, {
					displayName: "Beta",
					endpoint: "http://127.0.0.1/beta",
					desiredState: "online",
				})
			).json(),
		);

		const first = hubSchema.parse(
			(
				await request("PUT", `/v1/mcp/hub/members/${alphaConnection.id}`, 200, {
					namespace: "alpha",
					expectedHubRevision: 1,
					expectedConnectionRevision: alphaConnection.revision,
					runtimeGeneration: alphaConnection.runtimeGeneration,
				})
			).json(),
		);
		expect(
			(
				await request("PUT", `/v1/mcp/hub/members/${betaConnection.id}`, 409, {
					namespace: "alpha",
					expectedHubRevision: first.revision,
					expectedConnectionRevision: betaConnection.revision,
					runtimeGeneration: betaConnection.runtimeGeneration,
				})
			).json(),
		).toMatchObject({ code: "MCP_HUB_NAMESPACE_CONFLICT" });
		expect(
			(
				await request("PUT", `/v1/mcp/hub/members/${betaConnection.id}`, 409, {
					namespace: "beta",
					expectedHubRevision: 1,
					expectedConnectionRevision: betaConnection.revision,
					runtimeGeneration: betaConnection.runtimeGeneration,
				})
			).json(),
		).toMatchObject({ code: "MCP_HUB_REVISION_CONFLICT" });
		const second = hubSchema.parse(
			(
				await request("PUT", `/v1/mcp/hub/members/${betaConnection.id}`, 200, {
					namespace: "beta",
					expectedHubRevision: first.revision,
					expectedConnectionRevision: betaConnection.revision,
					runtimeGeneration: betaConnection.runtimeGeneration,
				})
			).json(),
		);
		expect(second).toMatchObject({
			members: [{ namespace: "alpha" }, { namespace: "beta" }],
			counts: { tools: 2, resources: 2, prompts: 2 },
		});

		const catalog = catalogSchema.parse((await request("GET", "/v1/mcp/hub/catalog", 200)).json());
		expect(new Set(catalog.tools.map((entry) => entry.projectedName)).size).toBe(2);
		expect(new Set(catalog.resources.map((entry) => entry.projectedUri)).size).toBe(2);
		expect(new Set(catalog.prompts.map((entry) => entry.projectedName)).size).toBe(2);

		const client = new Client(
			{ name: "hub-collision-e2e", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" } },
		);
		await client.connect(new StreamableHTTPClientTransport(new URL("/mcp/hub", baseUrl)));
		try {
			for (const namespace of ["alpha", "beta"] as const) {
				const tool = catalog.tools.find((entry) => entry.namespace === namespace);
				const resource = catalog.resources.find((entry) => entry.namespace === namespace);
				const prompt = catalog.prompts.find((entry) => entry.namespace === namespace);
				if (tool === undefined || resource === undefined || prompt === undefined) {
					throw new Error(`Missing ${namespace} projected capability.`);
				}
				expect(await client.callTool({ name: tool.projectedName, arguments: {} })).toMatchObject({
					content: [{ text: `${namespace}:tool` }],
				});
				expect(await client.readResource({ uri: resource.projectedUri })).toMatchObject({
					contents: [{ text: `${namespace}:resource` }],
				});
				expect(await client.getPrompt({ name: prompt.projectedName, arguments: {} })).toMatchObject(
					{
						messages: [{ content: { text: `${namespace}:prompt` } }],
					},
				);
			}

			await request(
				"DELETE",
				`/v1/mcp/hub/members/${alphaConnection.id}?expectedHubRevision=${String(second.revision)}&runtimeGeneration=${String(alphaConnection.runtimeGeneration)}`,
				204,
			);
			expect((await client.listTools()).tools).toHaveLength(1);
			const oldAlphaTool = catalog.tools.find((entry) => entry.namespace === "alpha");
			if (oldAlphaTool === undefined) throw new Error("Missing alpha tool.");
			await expect(client.callTool({ name: oldAlphaTool.projectedName })).rejects.toBeDefined();
			const betaTool = catalog.tools.find((entry) => entry.namespace === "beta");
			if (betaTool === undefined) throw new Error("Missing beta tool.");
			expect(await client.callTool({ name: betaTool.projectedName })).toMatchObject({
				content: [{ text: "beta:tool" }],
			});

			const detached = hubSchema.parse((await request("GET", "/v1/mcp/hub", 200)).json());
			await request("PUT", `/v1/mcp/hub/members/${alphaConnection.id}`, 200, {
				namespace: "alpha",
				expectedHubRevision: detached.revision,
				expectedConnectionRevision: alphaConnection.revision,
				runtimeGeneration: alphaConnection.runtimeGeneration,
			});
			const reattachedCatalog = catalogSchema.parse(
				(await request("GET", "/v1/mcp/hub/catalog", 200)).json(),
			);
			const newAlphaTool = reattachedCatalog.tools.find((entry) => entry.namespace === "alpha");
			if (newAlphaTool === undefined) throw new Error("Missing reattached alpha tool.");
			expect(newAlphaTool.projectedName).not.toBe(oldAlphaTool.projectedName);
			await expect(client.callTool({ name: oldAlphaTool.projectedName })).rejects.toBeDefined();
			expect(await client.callTool({ name: newAlphaTool.projectedName })).toMatchObject({
				content: [{ text: "alpha:tool" }],
			});
		} finally {
			await client.close();
		}
	});

	async function request(
		method: "DELETE" | "GET" | "POST" | "PUT",
		url: string,
		expectedStatus: number,
		payload?: object,
	) {
		const response = await app.inject({
			method,
			url,
			...(payload === undefined ? {} : { payload }),
		});
		expect(response.statusCode, response.body).toBe(expectedStatus);
		return response;
	}
});

function upstream(label: string): McpServerRuntime {
	return new McpServerRuntime({
		name: `${label}-fixture`,
		serverInfo: { name: `${label}-fixture`, version: "1.0.0" },
		features: [
			(server) => {
				server.registerTool(
					"shared",
					{ inputSchema: fromJsonSchema({ type: "object", properties: {} }) },
					async () => ({ content: [{ type: "text", text: `${label}:tool` }] }),
				);
				server.registerResource("shared", "docs://shared/item", {}, async (uri) => ({
					contents: [{ uri: uri.href, text: `${label}:resource` }],
				}));
				server.registerPrompt("shared", {}, async () => ({
					messages: [{ role: "user", content: { type: "text", text: `${label}:prompt` } }],
				}));
			},
		],
	});
}
