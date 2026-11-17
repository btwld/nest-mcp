import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Test } from "@nestjs/testing";
import { fromJsonSchema, McpServerRuntime } from "@nest-mcp/server";
import { createMcpServerTestFetch } from "@nest-mcp/server/testing";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { AppModule } from "../src/app.module.ts";
import { configureApplication } from "../src/bootstrap.ts";
import { ControlPlaneConfigService } from "../src/config/control-plane-config.service.ts";
import { MCP_CONTROL_PLANE_GUARDED_FETCH } from "../src/runtime/runtime.types.ts";

const runtimeStateSchema = z.object({
	phase: z.enum([
		"offline",
		"queued",
		"connecting",
		"online",
		"degraded",
		"draining",
		"failed",
		"quarantined",
	]),
	protocolEra: z.string().optional(),
	errorCode: z.string().optional(),
});
const connectionViewSchema = z.object({
	id: z.string().uuid(),
	displayName: z.string().min(1),
	revision: z.number().int().positive(),
	runtimeGeneration: z.number().int().positive(),
	desiredState: z.enum(["offline", "online"]),
	deletionPending: z.boolean(),
	runtime: runtimeStateSchema,
});
const probeSchema = z.object({
	reachable: z.literal(true),
	protocolEra: z.string().optional(),
	runtime: runtimeStateSchema,
});
const runtimeManagerSchema = z.object({
	maxConnections: z.number().int().positive(),
	connectionCount: z.number().int().nonnegative(),
	onlineKeeperCount: z.number().int().nonnegative(),
});
const catalogSchema = z.object({
	tools: z.array(z.object({ name: z.string() })),
	resources: z.array(z.object({ uri: z.string() })),
	prompts: z.array(z.object({ name: z.string() })),
});
const toolResultSchema = z.object({
	content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
	structuredContent: z.object({ echoed: z.string() }).optional(),
});
const resourceResultSchema = z.object({
	contents: z.array(z.object({ text: z.string().optional() })),
});
const promptResultSchema = z.object({
	messages: z.array(z.object({ content: z.object({ text: z.string().optional() }) })),
});
const problemSchema = z.object({
	code: z.string(),
	details: z.array(z.string()).optional(),
});
const hubSchema = z.object({
	revision: z.number().int().positive(),
	endpoint: z.object({ transport: z.literal("streamable-http"), path: z.literal("/mcp/hub") }),
	members: z.array(
		z.object({
			connectionId: z.string().uuid(),
			connectionRevision: z.number().int().positive(),
			runtimeGeneration: z.number().int().positive(),
			namespace: z.string(),
			runtime: z.object({ phase: z.string() }),
		}),
	),
	counts: z.object({
		tools: z.number().int().nonnegative(),
		resources: z.number().int().nonnegative(),
		resourceTemplates: z.number().int().nonnegative(),
		prompts: z.number().int().nonnegative(),
	}),
});
const hubCatalogSchema = z.object({
	revision: z.number().int().positive(),
	tools: z.array(
		z.object({ namespace: z.string(), sourceName: z.string(), projectedName: z.string() }),
	),
	resources: z.array(
		z.object({
			namespace: z.string(),
			sourceName: z.string(),
			projectedName: z.string(),
			projectedUri: z.string(),
		}),
	),
	prompts: z.array(
		z.object({ namespace: z.string(), sourceName: z.string(), projectedName: z.string() }),
	),
});

describe("MCP control-plane API", () => {
	let app: NestFastifyApplication;
	let upstream: McpServerRuntime;
	let baseUrl: string;

	beforeAll(async () => {
		upstream = createUpstream();
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(MCP_CONTROL_PLANE_GUARDED_FETCH)
			.useValue(createMcpServerTestFetch(upstream))
			.overrideProvider(ControlPlaneConfigService)
			.useValue({
				host: "127.0.0.1",
				port: 3400,
				allowedHosts: ["127.0.0.1", "localhost", "::1"],
				oauthAllowedHosts: ["127.0.0.1", "localhost", "::1"],
				allowLoopbackHttp: true,
				maxConnections: 1,
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
		await app.getHttpAdapter().getInstance().ready();
		baseUrl = await app.getUrl();
	});

	afterAll(async () => {
		await app.close();
		await upstream.close();
	});

	it("validates request DTOs through Standard Schema before controller execution", async () => {
		for (const [payload, expectedDetail] of [
			[
				{
					displayName: "Unknown key",
					endpoint: "http://127.0.0.1/mcp",
					unexpected: true,
				},
				"unexpected",
			],
			[{ displayName: "Invalid scheme", endpoint: "ftp://example.com/mcp" }, "endpoint:"],
		] as const) {
			const problem = parse(
				await inject({
					method: "POST",
					url: "/v1/mcp/connections",
					payload,
					expectedStatus: 400,
				}),
				problemSchema,
			);
			expect(problem.code).toBe("REQUEST_INVALID");
			expect(problem.details).toEqual(
				expect.arrayContaining([expect.stringContaining(expectedDetail)]),
			);
		}

		expect(
			parse(
				await inject({
					method: "GET",
					url: "/v1/mcp/hub/catalog?expectedHubRevision=1&expectedHubRevision=2",
					expectedStatus: 400,
				}),
				problemSchema,
			).code,
		).toBe("REQUEST_INVALID");

		expect(
			parse(
				await inject({
					method: "GET",
					url: "/v1/mcp/hub/catalog?unexpected=1",
					expectedStatus: 400,
				}),
				problemSchema,
			).code,
		).toBe("REQUEST_INVALID");

		const tooManyPromptArguments = Object.fromEntries(
			Array.from({ length: 65 }, (_, index) => [`arg-${String(index)}`, "value"]),
		);
		expect(
			parse(
				await inject({
					method: "POST",
					url: "/v1/mcp/connections/00000000-0000-4000-8000-000000000000/prompts/get",
					payload: { name: "summarize", arguments: tooManyPromptArguments },
					expectedStatus: 400,
				}),
				problemSchema,
			).code,
		).toBe("REQUEST_INVALID");
	});

	it("validates lifecycle, capacity, catalog, execution, generation replacement, and CAS", async () => {
		const first = parse(
			await inject({
				method: "POST",
				url: "/v1/mcp/connections",
				payload: {
					displayName: "  First upstream  ",
					endpoint: "http://127.0.0.1/mcp",
					desiredState: "online",
				},
				expectedStatus: 201,
			}),
			connectionViewSchema,
		);
		expect(first).toMatchObject({
			displayName: "First upstream",
			revision: 1,
			runtimeGeneration: 1,
			desiredState: "online",
			runtime: { phase: "online", protocolEra: "modern" },
		});

		const atCapacity = parse(
			await inject({
				method: "POST",
				url: "/v1/mcp/connections",
				payload: {
					displayName: "Second upstream",
					endpoint: "http://127.0.0.1/mcp",
					desiredState: "online",
				},
				expectedStatus: 201,
			}),
			connectionViewSchema,
		);
		expect(atCapacity.runtime).toMatchObject({
			phase: "failed",
			errorCode: "MCP_CAPACITY_EXCEEDED",
		});

		const runtimeAtCapacity = parse(
			await inject({ method: "GET", url: "/v1/mcp/runtime", expectedStatus: 200 }),
			runtimeManagerSchema,
		);
		expect(runtimeAtCapacity).toMatchObject({
			maxConnections: 1,
			connectionCount: 1,
			onlineKeeperCount: 1,
		});

		const firstOffline = parse(
			await inject({
				method: "PUT",
				url: `/v1/mcp/connections/${first.id}/desired-state`,
				payload: { expectedRevision: first.revision, state: "offline" },
				expectedStatus: 200,
			}),
			connectionViewSchema,
		);
		expect(firstOffline.runtime.phase).toBe("offline");
		const offlineProbe = parse(
			await inject({
				method: "POST",
				url: `/v1/mcp/connections/${first.id}/probe`,
				expectedStatus: 200,
			}),
			probeSchema,
		);
		expect(offlineProbe).toMatchObject({
			reachable: true,
			protocolEra: "modern",
			runtime: { phase: "offline" },
		});

		const secondOffline = parse(
			await inject({
				method: "PUT",
				url: `/v1/mcp/connections/${atCapacity.id}/desired-state`,
				payload: { expectedRevision: atCapacity.revision, state: "offline" },
				expectedStatus: 200,
			}),
			connectionViewSchema,
		);
		const secondOnline = parse(
			await inject({
				method: "PUT",
				url: `/v1/mcp/connections/${atCapacity.id}/desired-state`,
				payload: { expectedRevision: secondOffline.revision, state: "online" },
				expectedStatus: 200,
			}),
			connectionViewSchema,
		);
		expect(secondOnline.runtime.phase).toBe("online");

		const catalog = parse(
			await inject({
				method: "POST",
				url: `/v1/mcp/connections/${atCapacity.id}/catalog/refresh`,
				expectedStatus: 200,
			}),
			catalogSchema,
		);
		expect(catalog.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(catalog.resources.map((resource) => resource.uri)).toEqual([
			"docs://control-plane/guide",
		]);
		expect(catalog.prompts.map((prompt) => prompt.name)).toEqual(["summarize"]);
		expect(
			parse(
				await inject({
					method: "POST",
					url: `/v1/mcp/connections/${atCapacity.id}/tools/call`,
					payload: { name: "echo", arguments: { text: 42 } },
					expectedStatus: 422,
				}),
				problemSchema,
			).code,
		).toBe("MCP_TOOL_ARGUMENTS_INVALID");

		const toolResult = parse(
			await inject({
				method: "POST",
				url: `/v1/mcp/connections/${atCapacity.id}/tools/call`,
				payload: { name: "echo", arguments: { text: "hello" } },
				expectedStatus: 200,
			}),
			toolResultSchema,
		);
		expect(toolResult).toEqual({
			content: [{ type: "text", text: "hello" }],
			structuredContent: { echoed: "hello" },
		});

		const resourceResult = parse(
			await inject({
				method: "POST",
				url: `/v1/mcp/connections/${atCapacity.id}/resources/read`,
				payload: { uri: "docs://control-plane/guide" },
				expectedStatus: 200,
			}),
			resourceResultSchema,
		);
		expect(resourceResult.contents[0]?.text).toBe("control-plane guide");

		const invalidPrompt = parse(
			await inject({
				method: "POST",
				url: `/v1/mcp/connections/${atCapacity.id}/prompts/get`,
				payload: { name: "summarize", arguments: { topic: 42 } },
				expectedStatus: 400,
			}),
			problemSchema,
		);
		expect(invalidPrompt.code).toBe("REQUEST_INVALID");
		expect(invalidPrompt.details).toEqual(
			expect.arrayContaining([expect.stringContaining("arguments.topic:")]),
		);

		const promptResult = parse(
			await inject({
				method: "POST",
				url: `/v1/mcp/connections/${atCapacity.id}/prompts/get`,
				payload: { name: "summarize", arguments: { topic: "MCP" } },
				expectedStatus: 200,
			}),
			promptResultSchema,
		);
		expect(promptResult.messages[0]?.content.text).toBe("Summarize MCP");

		expect(
			parse(await inject({ method: "GET", url: "/v1/mcp/hub", expectedStatus: 200 }), hubSchema),
		).toMatchObject({ revision: 1, members: [], counts: { tools: 0, resources: 0, prompts: 0 } });
		const attachedHub = parse(
			await inject({
				method: "PUT",
				url: `/v1/mcp/hub/members/${atCapacity.id}`,
				payload: {
					namespace: "fixture",
					expectedHubRevision: 1,
					expectedConnectionRevision: secondOnline.revision,
					runtimeGeneration: secondOnline.runtimeGeneration,
				},
				expectedStatus: 200,
			}),
			hubSchema,
		);
		expect(attachedHub).toMatchObject({
			revision: 2,
			members: [{ connectionId: atCapacity.id, namespace: "fixture", runtimeGeneration: 1 }],
			counts: { tools: 1, resources: 1, prompts: 1 },
		});
		expect(
			parse(
				await inject({
					method: "GET",
					url: "/v1/mcp/hub/catalog?expectedHubRevision=1",
					expectedStatus: 409,
				}),
				problemSchema,
			).code,
		).toBe("MCP_HUB_REVISION_CONFLICT");
		const hubCatalog = parse(
			await inject({
				method: "GET",
				url: `/v1/mcp/hub/catalog?expectedHubRevision=${String(attachedHub.revision)}`,
				expectedStatus: 200,
			}),
			hubCatalogSchema,
		);
		expect(hubCatalog.tools).toMatchObject([{ namespace: "fixture", sourceName: "echo" }]);
		expect(hubCatalog.resources).toMatchObject([{ namespace: "fixture", sourceName: "guide" }]);
		expect(hubCatalog.prompts).toMatchObject([{ namespace: "fixture", sourceName: "summarize" }]);

		const hubClient = new Client(
			{ name: "control-plane-hub-e2e", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" } },
		);
		await hubClient.connect(new StreamableHTTPClientTransport(new URL("/mcp/hub", baseUrl)));
		const [hubTool] = (await hubClient.listTools()).tools;
		const [hubResource] = (await hubClient.listResources()).resources;
		const [hubPrompt] = (await hubClient.listPrompts()).prompts;
		if (hubTool === undefined || hubResource === undefined || hubPrompt === undefined) {
			throw new Error("Expected the attached hub to expose all fixture capability families.");
		}
		expect(
			await hubClient.callTool({ name: hubTool.name, arguments: { text: "through-hub" } }),
		).toMatchObject({ content: [{ type: "text", text: "through-hub" }] });
		expect(await hubClient.readResource({ uri: hubResource.uri })).toMatchObject({
			contents: [{ text: "control-plane guide" }],
		});
		expect(
			await hubClient.getPrompt({ name: hubPrompt.name, arguments: { topic: "Hub" } }),
		).toMatchObject({
			messages: [{ content: { text: "Summarize Hub" } }],
		});

		const renamed = parse(
			await inject({
				method: "PUT",
				url: `/v1/mcp/connections/${atCapacity.id}`,
				payload: {
					expectedRevision: secondOnline.revision,
					displayName: "Renamed upstream",
				},
				expectedStatus: 200,
			}),
			connectionViewSchema,
		);
		expect(renamed).toMatchObject({
			displayName: "Renamed upstream",
			runtimeGeneration: 1,
			runtime: { phase: "online" },
		});

		const replacement = parse(
			await inject({
				method: "PUT",
				url: `/v1/mcp/connections/${atCapacity.id}`,
				payload: {
					expectedRevision: renamed.revision,
					displayName: "Second upstream",
					endpoint: "http://127.0.0.1/mcp-v2",
				},
				expectedStatus: 200,
			}),
			connectionViewSchema,
		);
		expect(replacement).toMatchObject({ runtimeGeneration: 2, runtime: { phase: "online" } });
		expect(
			parse(await inject({ method: "GET", url: "/v1/mcp/hub", expectedStatus: 200 }), hubSchema),
		).toMatchObject({ revision: 3, members: [], counts: { tools: 0, resources: 0, prompts: 0 } });
		expect((await hubClient.listTools()).tools).toEqual([]);
		await expect(
			hubClient.callTool({ name: hubTool.name, arguments: { text: "stale" } }),
		).rejects.toBeDefined();
		await hubClient.close();

		const stale = await app.inject({
			method: "PUT",
			url: `/v1/mcp/connections/${atCapacity.id}`,
			payload: {
				expectedRevision: secondOnline.revision,
				displayName: "Stale update",
				endpoint: "http://127.0.0.1/stale",
			},
		});
		expect(stale.statusCode).toBe(409);
		expect(parse(stale, problemSchema).code).toBe("MCP_REVISION_CONFLICT");

		await inject({
			method: "DELETE",
			url: `/v1/mcp/connections/${atCapacity.id}?expectedRevision=${String(replacement.revision)}`,
			expectedStatus: 204,
		});
		await inject({
			method: "DELETE",
			url: `/v1/mcp/connections/${first.id}?expectedRevision=${String(firstOffline.revision)}`,
			expectedStatus: 204,
		});
		expect(
			parse(
				await inject({ method: "GET", url: "/v1/mcp/runtime", expectedStatus: 200 }),
				runtimeManagerSchema,
			),
		).toMatchObject({ connectionCount: 0, onlineKeeperCount: 0 });
	});

	async function inject(input: {
		readonly method: "DELETE" | "GET" | "POST" | "PUT";
		readonly url: string;
		readonly payload?: object;
		readonly expectedStatus: number;
	}): Promise<LightMyRequestResponse> {
		const response = await app.inject({
			method: input.method,
			url: input.url,
			...(input.payload === undefined ? {} : { payload: input.payload }),
		});
		expect(response.statusCode, response.body).toBe(input.expectedStatus);
		return response;
	}
});

function createUpstream(): McpServerRuntime {
	return new McpServerRuntime({
		name: "control-plane-fixture",
		serverInfo: { name: "control-plane-fixture", version: "1.0.0" },
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
						outputSchema: fromJsonSchema<{ echoed: string }>({
							type: "object",
							properties: { echoed: { type: "string" } },
							required: ["echoed"],
						}),
					},
					async ({ text }) => ({
						content: [{ type: "text", text }],
						structuredContent: { echoed: text },
					}),
				);
				server.registerResource(
					"guide",
					"docs://control-plane/guide",
					{ title: "Control-plane guide", mimeType: "text/plain" },
					async (uri) => ({
						contents: [{ uri: uri.href, mimeType: "text/plain", text: "control-plane guide" }],
					}),
				);
				server.registerPrompt(
					"summarize",
					{ argsSchema: z.object({ topic: z.string() }) },
					async ({ topic }) => ({
						messages: [{ role: "user", content: { type: "text", text: `Summarize ${topic}` } }],
					}),
				);
			},
		],
	});
}

function parse<Result>(response: LightMyRequestResponse, schema: z.ZodType<Result>): Result {
	return schema.parse(response.json<unknown>());
}
