import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
	McpServer,
	ResourceTemplate,
	UriTemplate,
	completable,
} from "@modelcontextprotocol/server";
import type {
	CompleteRequest,
	CompleteResult,
	ListResourceTemplatesResult,
	ReadResourceResult,
	Tool,
} from "@modelcontextprotocol/server";
import { allowMcpOperation, denyMcpOperation } from "@nest-mcp/core";
import { McpServerRuntime } from "@nest-mcp/server";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
	GatewayPromptNameCodec,
	GatewayResourceTemplateUriCodec,
	McpGateway,
	allowAllMcpGatewayPolicy,
	defineMcpGatewayTransform,
} from "../src/index.ts";
import type { McpGatewayMiddleware, McpGatewayPolicy, McpGatewayToolClient } from "../src/index.ts";

const NOOP_TOOL = {
	name: "noop",
	inputSchema: { type: "object" },
} satisfies Tool;

describe("gateway resource templates and completion", () => {
	it("projects templates and routes prompt/template completion through official v2 transports", async () => {
		const upstreamServer = new McpServer({ name: "upstream", version: "1.0.0" });
		upstreamServer.registerTool(NOOP_TOOL.name, { inputSchema: z.object({}) }, async () => ({
			content: [],
		}));
		upstreamServer.registerPrompt(
			"review",
			{
				argsSchema: z.object({
					language: completable(z.string(), (value) =>
						["typescript", "terraform", "rust"].filter((entry) => entry.startsWith(value)),
					),
				}),
			},
			async ({ language }) => ({
				messages: [{ role: "user", content: { type: "text", text: language } }],
			}),
		);
		upstreamServer.registerResource(
			"guide",
			new ResourceTemplate("docs://guide/{section}", {
				list: undefined,
				complete: {
					section: (value) =>
						["intro", "install", "security"].filter((entry) => entry.startsWith(value)),
				},
			}),
			{ description: "Guide section", mimeType: "text/plain" },
			async (uri) => ({ contents: [{ uri: uri.href, text: `read:${uri.href}` }] }),
		);

		const upstreamClient = new Client({ name: "gateway-upstream", version: "1.0.0" });
		const [upstreamClientTransport, upstreamServerTransport] = InMemoryTransport.createLinkedPair();
		await upstreamServer.connect(upstreamServerTransport);
		await upstreamClient.connect(upstreamClientTransport);

		const gateway = new McpGateway({
			upstreams: [{ name: "tenant/acme", client: upstreamClient }],
			policy: allowAllMcpGatewayPolicy(),
		});
		const runtime = new McpServerRuntime({
			name: "gateway",
			serverInfo: { name: "gateway", version: "1.0.0" },
			features: [gateway.asServerFeature()],
		});
		const downstreamServer = await runtime.createServer({ era: "modern" });
		const downstreamClient = new Client({ name: "agent", version: "1.0.0" });
		const [downstreamClientTransport, downstreamServerTransport] =
			InMemoryTransport.createLinkedPair();

		try {
			await downstreamServer.connect(downstreamServerTransport);
			await downstreamClient.connect(downstreamClientTransport);
			expect(downstreamClient.getServerCapabilities()?.completions).toEqual({});

			const prompt = (await downstreamClient.listPrompts()).prompts[0]!;
			expect(new GatewayPromptNameCodec().decode(prompt.name)).toEqual({
				upstreamName: "tenant/acme",
				promptName: "review",
			});
			await expect(
				downstreamClient.complete({
					ref: { type: "ref/prompt", name: prompt.name },
					argument: { name: "language", value: "t" },
				}),
			).resolves.toEqual({
				completion: { values: ["typescript", "terraform"], total: 2, hasMore: false },
			});

			const templates = await downstreamClient.listResourceTemplates();
			expect(templates.resourceTemplates).toHaveLength(1);
			const template = templates.resourceTemplates[0]!;
			expect(template.uriTemplate).not.toContain("docs://guide");
			expect(new GatewayResourceTemplateUriCodec().decode(template.uriTemplate)).toEqual({
				upstreamName: "tenant/acme",
				resourceTemplate: "docs://guide/{section}",
			});
			await expect(
				downstreamClient.complete({
					ref: { type: "ref/resource", uri: template.uriTemplate },
					argument: { name: "section", value: "in" },
				}),
			).resolves.toEqual({
				completion: { values: ["intro", "install"], total: 2, hasMore: false },
			});

			const projectedUri = new UriTemplate(template.uriTemplate).expand({ section: "intro" });
			await expect(downstreamClient.readResource({ uri: projectedUri })).resolves.toEqual({
				contents: [{ uri: projectedUri, text: "read:docs://guide/intro" }],
			});

			const specialSection = "space / café %";
			const specialProjectedUri = new UriTemplate(template.uriTemplate).expand({
				section: specialSection,
			});
			const specialRawUri = new UriTemplate("docs://guide/{section}").expand({
				section: specialSection,
			});
			await expect(downstreamClient.readResource({ uri: specialProjectedUri })).resolves.toEqual({
				contents: [{ uri: specialProjectedUri, text: `read:${specialRawUri}` }],
			});
		} finally {
			await downstreamClient.close();
			await downstreamServer.close();
			await runtime.close();
			await upstreamClient.close();
			await upstreamServer.close();
		}
	});

	it("preserves completion total and hasMore through the low-level per-request bridge", async () => {
		const complete = vi.fn(
			(_params: CompleteRequest["params"], options?: { readonly signal?: AbortSignal }) => {
				expect(options?.signal).toBeInstanceOf(AbortSignal);
				return {
					_meta: { secret: "do-not-forward" },
					completion: {
						values: ["typescript"],
						total: 400,
						hasMore: true,
						_meta: { secret: "do-not-forward" },
					},
				} satisfies CompleteResult;
			},
		);
		const gateway = new McpGateway({
			upstreams: [
				{
					name: "primary",
					client: {
						listTools: () => ({ tools: [] }),
						callTool: () => ({ content: [] }),
						listPrompts: () => ({
							prompts: [{ name: "review", arguments: [{ name: "language" }] }],
						}),
						getPrompt: () => ({ messages: [] }),
						complete,
					},
				},
			],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});
		const runtime = new McpServerRuntime({
			name: "gateway",
			serverInfo: { name: "gateway", version: "1.0.0" },
			features: [gateway.asServerFeature()],
		});
		const server = await runtime.createServer({ era: "modern" });
		const client = new Client({ name: "agent", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const [prompt] = (await client.listPrompts()).prompts;
			await expect(
				client.complete({
					ref: { type: "ref/prompt", name: prompt!.name },
					argument: { name: "language", value: "t" },
				}),
			).resolves.toEqual({
				completion: { values: ["typescript"], total: 400, hasMore: true },
			});
			expect(complete).toHaveBeenCalledTimes(1);
		} finally {
			await client.close();
			await server.close();
			await runtime.close();
		}
	});

	it("keeps prompt and template completion parameters frozen after authorization", async () => {
		const terminalValues: string[] = [];
		const authorizedValues: string[] = [];
		const exactValues: string[] = [];
		const complete = vi.fn((params: CompleteRequest["params"]): CompleteResult => {
			terminalValues.push(params.argument.value);
			return { completion: { values: [params.argument.value] } };
		});
		const gateway = new McpGateway({
			upstreams: [
				{
					name: "primary",
					client: {
						listTools: () => ({ tools: [] }),
						callTool: () => ({ content: [] }),
						listPrompts: () => ({
							prompts: [{ name: "review", arguments: [{ name: "language" }] }],
						}),
						getPrompt: () => ({ messages: [] }),
						listResourceTemplates: () => ({
							resourceTemplates: [{ name: "guide", uriTemplate: "docs://guide/{section}" }],
						}),
						readResource: () => ({ contents: [] }),
						complete,
					},
				},
			],
			policy: {
				authorize: () => allowMcpOperation(),
				authorizePrompt(operation) {
					if (operation.input.action === "complete") {
						authorizedValues.push(`prompt:${operation.input.completion?.argument.value}`);
					}
					return allowMcpOperation();
				},
				authorizeResourceTemplate(operation) {
					if (operation.input.action === "complete") {
						authorizedValues.push(`template:${operation.input.completion?.argument.value}`);
					}
					return allowMcpOperation();
				},
			},
			middleware: [
				defineMcpGatewayTransform("gateway.completion", async (operation, next) => {
					exactValues.push(operation.input.params.argument.value);
					expect(Object.isFrozen(operation.input.params)).toBe(true);
					expect(Object.isFrozen(operation.input.params.argument)).toBe(true);
					return next();
				}),
				async (operation, next) => {
					if (operation.input.type === "gateway.completion") {
						expect(Reflect.set(operation.input.params, "argument", {})).toBe(false);
						expect(Reflect.set(operation.input.params.argument, "value", "mutated")).toBe(false);
					}
					return next();
				},
			],
			authorizationContextResolver: () => "principal-a",
		});
		const promptName = new GatewayPromptNameCodec().encode("primary", "review");
		const templateUri = new GatewayResourceTemplateUriCodec().encode(
			"primary",
			"docs://guide/{section}",
		);

		await expect(
			gateway.complete({
				ref: { type: "ref/prompt", name: promptName },
				argument: { name: "language", value: "t" },
			}),
		).resolves.toEqual({ completion: { values: ["t"] } });
		await expect(
			gateway.complete({
				ref: { type: "ref/resource", uri: templateUri },
				argument: { name: "section", value: "in" },
			}),
		).resolves.toEqual({ completion: { values: ["in"] } });

		expect(authorizedValues).toEqual(["prompt:t", "template:in"]);
		expect(exactValues).toEqual(["t", "in"]);
		expect(terminalValues).toEqual(["t", "in"]);
	});

	it("filters discovery and authorizes template read/completion before middleware", async () => {
		let executionsAllowed = true;
		const listResourceTemplates = vi.fn(() => ({
			resourceTemplates: [{ name: "guide", uriTemplate: "docs://guide/{section}" }],
		}));
		const readResource = vi.fn((params: { readonly uri: string }): ReadResourceResult => ({
			contents: [{ uri: params.uri, text: "payload" }],
		}));
		const complete = vi.fn((_params: CompleteRequest["params"]): CompleteResult => ({
			completion: { values: ["intro"] },
		}));
		const client: McpGatewayToolClient = {
			listTools: () => ({ tools: [] }),
			callTool: () => ({ content: [] }),
			listResources: () => ({ resources: [] }),
			listResourceTemplates,
			readResource,
			complete,
		};
		const middleware = vi.fn<McpGatewayMiddleware>(async (_operation, next) => next());
		const policy: McpGatewayPolicy = {
			authorize: () => allowMcpOperation(),
			authorizeResource: () => allowMcpOperation(),
			authorizeResourceTemplate(operation) {
				return operation.input.action !== "discover" && !executionsAllowed
					? denyMcpOperation("Template execution denied.")
					: allowMcpOperation();
			},
		};
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client }],
			policy,
			middleware: [middleware],
			authorizationContextResolver: () => "principal-a",
		});
		const [template] = await gateway.listProjectedResourceTemplates();
		expect(template).toBeDefined();
		executionsAllowed = false;
		middleware.mockClear();

		await expect(
			gateway.readResourceTemplate(template!.projectedTemplateUri, { section: "intro" }),
		).rejects.toMatchObject({ decision: { reason: "Template execution denied." } });
		await expect(
			gateway.complete({
				ref: { type: "ref/resource", uri: template!.projectedTemplateUri },
				argument: { name: "section", value: "in" },
			}),
		).rejects.toMatchObject({ decision: { reason: "Template execution denied." } });
		expect(readResource).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
		expect(
			middleware.mock.calls.every(([operation]) => operation.input.type === "gateway.discovery"),
		).toBe(true);
	});

	it("authorizes hidden references before member validation and rejects unrelated read URIs", async () => {
		let discoveryAllowed = false;
		const client: McpGatewayToolClient = {
			listTools: () => ({ tools: [] }),
			callTool: () => ({ content: [] }),
			listPrompts: () => ({
				prompts: [{ name: "review", arguments: [{ name: "language" }] }],
			}),
			getPrompt: () => ({ messages: [] }),
			listResourceTemplates: () => ({
				resourceTemplates: [{ name: "guide", uriTemplate: "docs://guide/{section}" }],
			}),
			readResource: () => ({ contents: [{ uri: "docs://unrelated", text: "hidden" }] }),
			complete: () => ({ completion: { values: [] } }),
		};
		const gateway = new McpGateway({
			upstreams: [{ name: "primary", client }],
			policy: {
				authorize: () => allowMcpOperation(),
				authorizePrompt(operation) {
					return operation.input.action === "discover" && !discoveryAllowed
						? denyMcpOperation("Prompt hidden.")
						: allowMcpOperation();
				},
				authorizeResourceTemplate(operation) {
					return operation.input.action === "discover" && !discoveryAllowed
						? denyMcpOperation("Template hidden.")
						: allowMcpOperation();
				},
			},
			authorizationContextResolver: () => "principal-a",
		});
		const codec = new GatewayResourceTemplateUriCodec();
		const projectedTemplateUri = codec.encode("primary", "docs://guide/{section}");
		const projectedPromptName = new GatewayPromptNameCodec().encode("primary", "review");

		await expect(
			gateway.readResourceTemplate(projectedTemplateUri, { wrong: "value" }),
		).rejects.toMatchObject({ decision: { reason: "Template hidden." } });
		await expect(
			gateway.complete({
				ref: { type: "ref/resource", uri: projectedTemplateUri },
				argument: { name: "wrong", value: "" },
			}),
		).rejects.toMatchObject({ decision: { reason: "Template hidden." } });
		await expect(
			gateway.complete({
				ref: { type: "ref/prompt", name: projectedPromptName },
				argument: { name: "wrong", value: "" },
			}),
		).rejects.toMatchObject({ decision: { reason: "Prompt hidden." } });

		discoveryAllowed = true;
		await expect(
			gateway.readResourceTemplate(projectedTemplateUri, { section: ["intro", "install"] }),
		).rejects.toMatchObject({ code: "INVALID_PROJECTED_TEMPLATE_URI" });
		await expect(
			gateway.readResourceTemplate(projectedTemplateUri, { section: "intro" }),
		).rejects.toMatchObject({ code: "UNLISTED_RESOURCE_LINK" });
	});

	it("bounds raw template pages and rejects oversized completion results", async () => {
		const listResourceTemplates = vi.fn(
			(params?: { readonly cursor?: string }): ListResourceTemplatesResult => ({
				resourceTemplates: [
					{
						name: params?.cursor === undefined ? "guide" : "guide-two",
						uriTemplate:
							params?.cursor === undefined
								? "docs://guide/{section}"
								: "docs://guide-two/{section}",
					},
				],
				nextCursor: "more",
			}),
		);
		const client: McpGatewayToolClient = {
			listTools: () => ({ tools: [] }),
			callTool: () => ({ content: [] }),
			listResourceTemplates,
			readResource: () => ({ contents: [] }),
			complete: () => ({ completion: { values: Array.from({ length: 101 }, () => "x") } }),
		};
		const pageLimited = new McpGateway({
			upstreams: [{ name: "primary", client }],
			policy: allowAllMcpGatewayPolicy(),
			discoveryMaxPages: 1,
			authorizationContextResolver: () => "principal-a",
		});
		await expect(pageLimited.listProjectedResourceTemplates()).rejects.toMatchObject({
			code: "INVALID_DISCOVERY",
			message: expect.stringContaining("listing resourceTemplates"),
		});

		const completionGateway = new McpGateway({
			upstreams: [
				{
					name: "primary",
					client: {
						...client,
						listResourceTemplates: () => ({
							resourceTemplates: [{ name: "guide", uriTemplate: "docs://guide/{section}" }],
						}),
					},
				},
			],
			policy: allowAllMcpGatewayPolicy(),
			authorizationContextResolver: () => "principal-a",
		});
		const [template] = await completionGateway.listProjectedResourceTemplates();
		await expect(
			completionGateway.complete({
				ref: { type: "ref/resource", uri: template!.projectedTemplateUri },
				argument: { name: "section", value: "" },
			}),
		).rejects.toMatchObject({ code: "INVALID_COMPLETION_RESULT" });
	});
});
