import {
	Inject,
	Injectable,
	Module,
	Scope,
	type INestApplication,
	type OnApplicationBootstrap,
	type OnModuleDestroy,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
	Client,
	InMemoryTransport,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	ResourceTemplate,
	UriTemplate,
	completable,
	fromJsonSchema,
} from "@modelcontextprotocol/server";
import { allowMcpOperation } from "@nest-mcp/core";
import {
	GatewayNameCodec,
	GatewayPromptNameCodec,
	GatewayResourceTemplateUriCodec,
	GatewayResourceUriCodec,
	InMemoryMcpGatewayDiscoveryCache,
	allowAllMcpGatewayPolicy,
} from "@nest-mcp/gateway";
import type { McpGatewayClientResolver, McpGatewayPolicy } from "@nest-mcp/gateway";
import { McpServerRegistry, McpServerRuntime } from "@nest-mcp/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	McpClientModule,
	McpModule,
	McpRuntimeService,
	Tool,
	acceptedContent,
	inputRequired,
} from "../src/index.ts";
import type {
	CallToolResult,
	InputRequiredResult,
	McpGatewayAuthorizationContextProvider,
	McpGatewayLifecycleObserverProvider,
	McpGatewayMiddlewareProvider,
	McpGatewayObserverErrorReporter,
	ServerContext,
} from "../src/index.ts";
import { createMcpServerTestFetch } from "../src/testing/index.ts";

const MCP_TEST_CONFIGURATION = Symbol("MCP_TEST_CONFIGURATION");
const ALLOW_ALL_GATEWAY_POLICY = Symbol("ALLOW_ALL_GATEWAY_POLICY");
const ALLOW_ALL_GATEWAY_POLICY_PROVIDER = {
	provide: ALLOW_ALL_GATEWAY_POLICY,
	useValue: allowAllMcpGatewayPolicy(),
};

function providerBackedGatewayUpstream(name: string, resolveClient: McpGatewayClientResolver) {
	const token = Symbol(`${name.toUpperCase()}_GATEWAY_CLIENT`);
	return {
		definition: { name, clientProvider: token },
		provider: { provide: token, useValue: { resolveClient } },
	} as const;
}

@Module({
	providers: [{ provide: MCP_TEST_CONFIGURATION, useValue: "async-server" }],
	exports: [MCP_TEST_CONFIGURATION],
})
class McpTestConfigurationModule {}

@Injectable()
class McpRuntimeConsumer {
	constructor(readonly runtime: McpRuntimeService) {}
}

@Injectable()
class FeatureImportedToolsProvider {
	constructor(@Inject(MCP_TEST_CONFIGURATION) private readonly configuration: string) {}

	@Tool({ name: "feature.imported", servers: "feature-imports" })
	readConfiguration() {
		return { content: [{ type: "text" as const, text: this.configuration }] };
	}
}

@Module({
	imports: [McpTestConfigurationModule],
	providers: [FeatureImportedToolsProvider],
})
class McpFeatureTestModule {}

@Module({ providers: [McpRuntimeConsumer], exports: [McpRuntimeConsumer] })
class McpSiblingConsumerModule {}

@Injectable()
class ToolsProvider {
	@Tool({
		name: "greet",
		servers: "artifact",
		description: "Greet an agent",
		inputSchema: z.object({ name: z.string() }),
	})
	greet({ name }: { name: string }) {
		return { content: [{ type: "text" as const, text: `Hello ${name}` }] };
	}
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedToolsProvider {
	@Tool({ name: "unsafe.request-scoped" })
	call() {
		return { content: [{ type: "text" as const, text: "unsafe" }] };
	}
}

@Injectable()
class StatefulGatewayPolicy implements McpGatewayPolicy {
	readonly calls: string[] = [];

	authorize() {
		return this.#allow("tool");
	}

	authorizePrompt() {
		return this.#allow("prompt");
	}

	authorizeResource() {
		return this.#allow("resource");
	}

	authorizeResourceTemplate() {
		return this.#allow("resource-template");
	}

	#allow(kind: string) {
		this.calls.push(kind);
		return allowMcpOperation({ policy: `stateful-${kind}` });
	}
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedCollaborator {
	readonly scope = "request";
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedCollaboratorDependency {}

@Module({
	providers: [RequestScopedCollaboratorDependency],
	exports: [RequestScopedCollaboratorDependency],
})
class RequestScopedCollaboratorDependencyModule {}

@Injectable()
class NonStaticCollaborator {
	constructor(readonly dependency: RequestScopedCollaboratorDependency) {}
}

const confirmationSchema = fromJsonSchema<{ confirm: boolean }>({
	type: "object",
	properties: { confirm: { type: "boolean" } },
	required: ["confirm"],
});

@Injectable()
class InteractiveToolsProvider {
	@Tool({
		name: "publish",
		servers: "interactive",
		inputSchema: fromJsonSchema<Record<string, never>>({
			type: "object",
			properties: {},
			additionalProperties: false,
		}),
	})
	publish(
		_arguments: Record<string, never>,
		context: ServerContext,
	): CallToolResult | InputRequiredResult {
		const confirmation = acceptedContent(
			context.mcpReq.inputResponses,
			"confirm",
			confirmationSchema,
		);
		if (confirmation?.confirm === true) {
			return { content: [{ type: "text", text: "published" }] };
		}
		return inputRequired({
			inputRequests: {
				confirm: inputRequired.elicit({
					message: "Publish?",
					requestedSchema: confirmationSchema,
				}),
			},
		});
	}
}

describe("McpModule", () => {
	let client: Client | undefined;
	let application: INestApplication | undefined;
	let upstream: McpServerRuntime | undefined;

	afterEach(async () => {
		await client?.close();
		await application?.close();
		await upstream?.close();
	});

	it("supports async injected configuration and local-module extras", async () => {
		@Injectable()
		class AsyncCollaborator {}

		const factory = vi.fn((serverName: string) => ({
			autoDiscover: false,
			servers: [{ name: serverName, serverInfo: { name: serverName, version: "1.0.0" } }],
		}));
		const dynamicModule = McpModule.forRootAsync({
			isGlobal: false,
			collaborators: { providers: [AsyncCollaborator] },
			imports: [McpTestConfigurationModule],
			inject: [MCP_TEST_CONFIGURATION],
			useFactory: factory,
		});
		expect(dynamicModule.global).toBe(false);
		const testingModule = await Test.createTestingModule({ imports: [dynamicModule] }).compile();
		application = testingModule.createNestApplication();
		await application.init();

		const runtime = application.get(McpRuntimeService);
		expect(runtime.server("async-server").name).toBe("async-server");
		expect(application.get(AsyncCollaborator)).toBeInstanceOf(AsyncCollaborator);
		expect(factory).toHaveBeenCalledWith("async-server");
		expect(McpModule.forRoot().global).toBe(false);
	});

	it("is local by default and honors explicit global visibility", async () => {
		await expect(
			Test.createTestingModule({
				imports: [McpModule.forRoot(), McpSiblingConsumerModule],
			}).compile(),
		).rejects.toThrow(/McpRuntimeService/);

		const testingModule = await Test.createTestingModule({
			imports: [McpModule.forRoot({ isGlobal: true }), McpSiblingConsumerModule],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		expect(application.get(McpRuntimeConsumer).runtime).toBe(application.get(McpRuntimeService));
	});

	it("rejects more than one configured root module", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					autoDiscover: false,
					servers: [{ name: "root-a", serverInfo: { name: "root-a", version: "1.0.0" } }],
				}),
				McpModule.forRoot({
					autoDiscover: false,
					servers: [{ name: "root-b", serverInfo: { name: "root-b", version: "1.0.0" } }],
				}),
			],
		}).compile();
		const failedApplication = testingModule.createNestApplication();

		await expect(failedApplication.init()).rejects.toThrow(
			/McpModule\.forRoot\(\).*exactly once per Nest application/,
		);
		await failedApplication.close();
	});

	it("runs collaborator bootstrap before readiness and closes runtimes before collaborator destroy", async () => {
		const events: string[] = [];
		let runtime: McpRuntimeService;

		@Injectable()
		class LifecycleCollaborator implements OnApplicationBootstrap, OnModuleDestroy {
			onApplicationBootstrap(): void {
				events.push(`collaborator.bootstrap:${String(runtime.isReady())}`);
			}

			onModuleDestroy(): void {
				events.push(`collaborator.destroy:${String(runtime.isReady())}`);
			}
		}

		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: { providers: [LifecycleCollaborator] },
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		runtime = application.get(McpRuntimeService);
		await application.init();
		expect(events).toEqual(["collaborator.bootstrap:false"]);
		expect(runtime.isReady()).toBe(true);

		const servers = application.get(McpServerRegistry);
		vi.spyOn(servers, "close").mockImplementation(async () => {
			events.push("runtime.close");
		});

		await application.close();
		application = undefined;

		expect(events).toEqual([
			"collaborator.bootstrap:false",
			"runtime.close",
			"collaborator.destroy:false",
		]);
	});

	it.each([
		{
			label: "request-scoped",
			imports: [],
			providers: [RequestScopedCollaborator],
		},
		{
			label: "singleton with a non-static dependency tree",
			imports: [RequestScopedCollaboratorDependencyModule],
			providers: [NonStaticCollaborator],
		},
	])("rejects $label collaborators during bootstrap", async ({ imports, providers }) => {
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: { imports, providers },
				}),
			],
		}).compile();
		const failedApplication = testingModule.createNestApplication();

		await expect(failedApplication.init()).rejects.toThrow(
			/default singleton scope with a static dependency tree/,
		);
		await failedApplication.close();
	});

	it("discovers providers declared in an ordinary imported feature module", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					servers: [
						{
							name: "feature-imports",
							serverInfo: { name: "feature-imports", version: "1.0.0" },
						},
					],
				}),
				McpFeatureTestModule,
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		client = new Client(
			{ name: "feature-imports-test", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" } },
		);
		await client.connect(
			new StreamableHTTPClientTransport(new URL("http://feature.test/mcp"), {
				fetch: createMcpServerTestFetch(
					application.get(McpRuntimeService).server("feature-imports"),
				),
			}),
		);

		const result = await client.callTool({ name: "feature.imported", arguments: {} });

		expect(result.content).toEqual([{ type: "text", text: "async-server" }]);
	});

	it("does not forward raw lower-runtime feature callbacks supplied through untyped input", async () => {
		const rawFeature = vi.fn();
		const rawDefinition: import("../src/index.ts").McpNestServerDefinition = {
			name: "raw-feature",
			serverInfo: { name: "raw-feature", version: "1.0.0" },
		};
		Reflect.set(rawDefinition, "features", [rawFeature]);
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					autoDiscover: false,
					servers: [rawDefinition],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const server = await application
			.get(McpRuntimeService)
			.server("raw-feature")
			.createServer({ era: "modern" });

		expect(rawFeature).not.toHaveBeenCalled();
		await server.close();
	});

	it("discovers decorated providers and serves them through MCP v2", async () => {
		const principalClaimsToken = Symbol("ARTIFACT_PRINCIPAL_CLAIMS");
		const authorizationToken = Symbol("ARTIFACT_HANDLER_AUTHORIZATION");
		const middlewareToken = Symbol("ARTIFACT_HANDLER_MIDDLEWARE");
		const lifecycleToken = Symbol("ARTIFACT_HANDLER_LIFECYCLE");
		const shadowAuthorize = vi.fn(() => allowMcpOperation({ policy: "unrelated" }));

		@Module({
			providers: [{ provide: authorizationToken, useValue: { authorize: shadowAuthorize } }],
		})
		class UnrelatedAuthorizationModule {}

		const authorize = vi.fn((operation) => {
			expect(operation.context.principal).toMatchObject({
				clientId: "artifact-agent",
				subject: "user-1",
				tenantId: "tenant-1",
			});
			return allowMcpOperation({ policy: "test" });
		});
		const lifecycle = vi.fn();
		const principalClaims = vi.fn(() => ({ subject: "user-1", tenantId: "tenant-1" }));
		const middleware = vi.fn(async (operation, next) => {
			const firstArgument = operation.input.arguments[0];
			expect(Object.isFrozen(firstArgument)).toBe(true);
			expect(Reflect.set(Object(firstArgument), "name", "Mallory")).toBe(false);
			return next();
		});
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: {
						providers: [
							{
								provide: principalClaimsToken,
								useValue: { resolvePrincipalClaims: principalClaims },
							},
							{ provide: authorizationToken, useValue: { authorize } },
							{ provide: middlewareToken, useValue: { handle: middleware } },
							{ provide: lifecycleToken, useValue: { onEvent: lifecycle } },
						],
					},
					servers: [
						{
							name: "artifact",
							serverInfo: { name: "artifact", version: "1.0.0" },
							principalClaims: principalClaimsToken,
							handlerAuthorization: authorizationToken,
							handlerMiddleware: [middlewareToken],
							handlerLifecycleObserver: lifecycleToken,
						},
					],
				}),
				UnrelatedAuthorizationModule,
			],
			providers: [ToolsProvider],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const runtimeService = application.get(McpRuntimeService);
		expect(() => runtimeService.clients).toThrow(/No McpClientModule/);
		expect(runtimeService.listGateways()).toEqual([]);
		expect(() => runtimeService.gateway("artifact")).toThrow(/No MCP gateway/);
		const runtime = runtimeService.server("artifact");
		client = new Client(
			{ name: "test", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" } },
		);
		await client.connect(
			new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
				fetch: createMcpServerTestFetch(runtime, {
					authInfo: {
						token: "not-projected",
						clientId: "artifact-agent",
						scopes: ["artifacts:read"],
					},
				}),
			}),
		);

		const result = await client.callTool({ name: "greet", arguments: { name: "Ada" } });
		const invalidResult = await client.callTool({ name: "greet", arguments: { name: 42 } });

		expect(result.content).toEqual([{ type: "text", text: "Hello Ada" }]);
		expect(invalidResult).toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining("Input validation error") }],
		});
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({
					kind: "tool",
					name: "greet",
					serverName: "artifact",
				}),
				context: expect.objectContaining({
					role: "server",
					operation: expect.objectContaining({ name: "tools/call" }),
				}),
			}),
		);
		expect(lifecycle.mock.calls.map(([event]) => event.type)).toEqual([
			"operation.started",
			"operation.succeeded",
		]);
		expect(middleware).toHaveBeenCalledOnce();
		expect(principalClaims).toHaveBeenCalledOnce();
		expect(shadowAuthorize).not.toHaveBeenCalled();
	});

	it("rejects request-scoped decorated handlers during bootstrap", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					servers: [
						{
							name: "unsafe",
							serverInfo: { name: "unsafe", version: "1.0.0" },
						},
					],
				}),
			],
			providers: [RequestScopedToolsProvider],
		}).compile();
		application = testingModule.createNestApplication();

		await expect(application.init()).rejects.toThrow(/singleton provider/);
	});

	it("runs authorization and lifecycle on every decorated multi-round input leg", async () => {
		const authorizationToken = Symbol("INTERACTIVE_HANDLER_AUTHORIZATION");
		const lifecycleToken = Symbol("INTERACTIVE_HANDLER_LIFECYCLE");
		const authorize = vi.fn(() => allowMcpOperation({ policy: "interactive-test" }));
		const lifecycle = vi.fn();
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: {
						providers: [
							{ provide: authorizationToken, useValue: { authorize } },
							{ provide: lifecycleToken, useValue: { onEvent: lifecycle } },
						],
					},
					servers: [
						{
							name: "interactive",
							serverInfo: { name: "interactive", version: "1.0.0" },
							handlerAuthorization: authorizationToken,
							handlerLifecycleObserver: lifecycleToken,
						},
					],
				}),
			],
			providers: [InteractiveToolsProvider],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		client = new Client(
			{ name: "interactive-host", version: "1.0.0" },
			{
				capabilities: { elicitation: { form: {} } },
				versionNegotiation: { mode: "auto" },
				inputRequired: { maxRounds: 2 },
			},
		);
		client.setRequestHandler("elicitation/create", async () => ({
			action: "accept",
			content: { confirm: true },
		}));
		await client.connect(
			new StreamableHTTPClientTransport(new URL("http://interactive.test/mcp"), {
				fetch: createMcpServerTestFetch(application.get(McpRuntimeService).server("interactive")),
			}),
		);

		const result = await client.callTool({ name: "publish", arguments: {} });

		expect(result.content).toEqual([{ type: "text", text: "published" }]);
		expect(authorize).toHaveBeenCalledTimes(2);
		expect(lifecycle.mock.calls.map(([event]) => event.type)).toEqual([
			"operation.started",
			"operation.succeeded",
			"operation.started",
			"operation.succeeded",
		]);
	});

	it("preserves class gateway policy this binding for optional capability hooks", async () => {
		const gatewayUpstream = providerBackedGatewayUpstream("stateful-upstream", () => ({
			listTools: () => ({ tools: [] }),
			callTool: () => ({ content: [] }),
			listPrompts: () => ({ prompts: [{ name: "status" }] }),
			getPrompt: () => ({ messages: [] }),
			listResources: () => ({
				resources: [{ name: "guide", uri: "docs://guide" }],
			}),
			readResource: () => ({ contents: [] }),
			listResourceTemplates: () => ({
				resourceTemplates: [{ name: "section", uriTemplate: "docs://sections/{id}" }],
			}),
		}));
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: { providers: [StatefulGatewayPolicy, gatewayUpstream.provider] },
					servers: [
						{
							name: "stateful-gateway",
							serverInfo: { name: "stateful-gateway", version: "1.0.0" },
							gateway: {
								policy: StatefulGatewayPolicy,
								upstreams: [gatewayUpstream.definition],
							},
						},
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();

		const gateway = application.get(McpRuntimeService).gateway("stateful-gateway");
		expect(await gateway.listProjectedPrompts()).toHaveLength(1);
		expect(await gateway.listProjectedResources()).toHaveLength(1);
		expect(await gateway.listProjectedResourceTemplates()).toHaveLength(1);
		expect(application.get(StatefulGatewayPolicy).calls).toEqual([
			"prompt",
			"resource",
			"resource-template",
		]);
	});

	it("resolves every gateway runtime seam through Nest collaborator tokens", async () => {
		const nameCodecToken = Symbol("GATEWAY_NAME_CODEC");
		const promptNameCodecToken = Symbol("GATEWAY_PROMPT_NAME_CODEC");
		const resourceUriCodecToken = Symbol("GATEWAY_RESOURCE_URI_CODEC");
		const resourceTemplateUriCodecToken = Symbol("GATEWAY_RESOURCE_TEMPLATE_URI_CODEC");
		const resourceTemplateNameCodecToken = Symbol("GATEWAY_RESOURCE_TEMPLATE_NAME_CODEC");
		const discoveryCacheToken = Symbol("GATEWAY_DISCOVERY_CACHE");
		const authorizationContextToken = Symbol("GATEWAY_AUTHORIZATION_CONTEXT");
		const middlewareToken = Symbol("GATEWAY_MIDDLEWARE");
		const lifecycleObserverToken = Symbol("GATEWAY_LIFECYCLE_OBSERVER");
		const observerErrorReporterToken = Symbol("GATEWAY_OBSERVER_ERROR_REPORTER");
		const discoveryCache = new InMemoryMcpGatewayDiscoveryCache();
		const cacheGet = vi.spyOn(discoveryCache, "get");
		const cacheSet = vi.spyOn(discoveryCache, "set");
		const authorizationContextProvider: McpGatewayAuthorizationContextProvider & {
			value: string;
			calls: number;
		} = {
			value: "tenant:test",
			calls: 0,
			resolveAuthorizationContext() {
				this.calls += 1;
				return this.value;
			},
		};
		const gatewayMiddleware: McpGatewayMiddlewareProvider & { calls: number } = {
			calls: 0,
			async handle(_operation, next) {
				this.calls += 1;
				return next();
			},
		};
		const lifecycleObserver: McpGatewayLifecycleObserverProvider & { events: string[] } = {
			events: [] as string[],
			onEvent(event) {
				this.events.push(event.type);
				throw new Error("gateway telemetry unavailable");
			},
		};
		const observerErrorReporter: McpGatewayObserverErrorReporter & { errors: unknown[] } = {
			errors: [] as unknown[],
			report(error: unknown) {
				this.errors.push(error);
			},
		};
		const gatewayUpstream = providerBackedGatewayUpstream("provider-upstream", () => ({
			listTools: () => ({
				tools: [{ name: "search", inputSchema: { type: "object" } }],
			}),
			callTool: () => ({ content: [] }),
			listPrompts: () => ({ prompts: [{ name: "summarize" }] }),
			getPrompt: () => ({ messages: [] }),
			listResources: () => ({
				resources: [{ name: "guide", uri: "docs://guide" }],
			}),
			readResource: () => ({ contents: [] }),
			listResourceTemplates: () => ({
				resourceTemplates: [{ name: "section", uriTemplate: "docs://sections/{id}" }],
			}),
		}));

		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: {
						providers: [
							ALLOW_ALL_GATEWAY_POLICY_PROVIDER,
							{ provide: nameCodecToken, useValue: new GatewayNameCodec("nesttool") },
							{
								provide: promptNameCodecToken,
								useValue: new GatewayPromptNameCodec("nestprompt"),
							},
							{
								provide: resourceUriCodecToken,
								useValue: new GatewayResourceUriCodec({ scheme: "nest-resource" }),
							},
							{
								provide: resourceTemplateUriCodecToken,
								useValue: new GatewayResourceTemplateUriCodec({ scheme: "nest-template" }),
							},
							{
								provide: resourceTemplateNameCodecToken,
								useValue: new GatewayNameCodec("nesttemplate"),
							},
							{ provide: discoveryCacheToken, useValue: discoveryCache },
							{ provide: authorizationContextToken, useValue: authorizationContextProvider },
							{ provide: middlewareToken, useValue: gatewayMiddleware },
							{ provide: lifecycleObserverToken, useValue: lifecycleObserver },
							{ provide: observerErrorReporterToken, useValue: observerErrorReporter },
							gatewayUpstream.provider,
						],
					},
					servers: [
						{
							name: "provider-gateway",
							serverInfo: { name: "provider-gateway", version: "1.0.0" },
							gateway: {
								policy: ALLOW_ALL_GATEWAY_POLICY,
								nameCodec: nameCodecToken,
								promptNameCodec: promptNameCodecToken,
								resourceUriCodec: resourceUriCodecToken,
								resourceTemplateUriCodec: resourceTemplateUriCodecToken,
								resourceTemplateNameCodec: resourceTemplateNameCodecToken,
								discoveryCache: discoveryCacheToken,
								authorizationContextResolver: authorizationContextToken,
								middleware: [middlewareToken],
								lifecycleObserver: lifecycleObserverToken,
								onObserverError: observerErrorReporterToken,
								upstreams: [gatewayUpstream.definition],
							},
						},
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();

		const gateway = application.get(McpRuntimeService).gateway("provider-gateway");
		const tools = await gateway.listProjectedTools();
		const prompts = await gateway.listProjectedPrompts();
		const resources = await gateway.listProjectedResources();
		const templates = await gateway.listProjectedResourceTemplates();

		expect(tools[0]?.projectedName).toMatch(/^nesttool\./);
		expect(prompts[0]?.projectedName).toMatch(/^nestprompt\./);
		expect(resources[0]?.projectedUri).toMatch(/^nest-resource:\/\/v1\//);
		expect(templates[0]?.projectedName).toMatch(/^nesttemplate\./);
		expect(templates[0]?.projectedTemplateUri).toMatch(/^nest-template:\/\/v1\//);
		expect(cacheGet).toHaveBeenCalled();
		expect(cacheSet).toHaveBeenCalledOnce();
		expect(authorizationContextProvider.calls).toBe(4);
		expect(gatewayMiddleware.calls).toBe(4);
		expect(lifecycleObserver.events).toEqual([
			"operation.started",
			"operation.succeeded",
			"operation.started",
			"operation.succeeded",
			"operation.started",
			"operation.succeeded",
			"operation.started",
			"operation.succeeded",
		]);
		expect(observerErrorReporter.errors).toHaveLength(lifecycleObserver.events.length);
	});

	it("builds an aggregate gateway from Nest-owned named clients", async () => {
		const transportFactory = Symbol("KNOWLEDGE_TRANSPORT_FACTORY");
		const upstreamRuntime = new McpServerRuntime({
			name: "knowledge",
			serverInfo: { name: "knowledge", version: "1.0.0" },
			features: [
				(server) => {
					server.registerTool(
						"search",
						{
							inputSchema: fromJsonSchema<{ query: string }>({
								type: "object",
								properties: { query: { type: "string" } },
								required: ["query"],
							}),
						},
						async ({ query }) => ({ content: [{ type: "text", text: `found:${query}` }] }),
					);
					server.registerResource(
						"guide",
						"docs://knowledge/guide",
						{ title: "Knowledge guide", mimeType: "text/plain" },
						async (uri) => ({
							contents: [{ uri: uri.href, mimeType: "text/plain", text: "gateway guide" }],
						}),
					);
					server.registerPrompt(
						"summarize",
						{
							description: "Summarize a topic",
							argsSchema: z.object({
								topic: completable(z.string(), (value) =>
									["MCP v2", "NestJS", "observability"].filter((entry) =>
										entry.toLowerCase().startsWith(value.toLowerCase()),
									),
								),
							}),
						},
						async ({ topic }) => ({
							messages: [
								{
									role: "user",
									content: { type: "text", text: `Summarize ${topic}` },
								},
							],
						}),
					);
					server.registerResource(
						"section",
						new ResourceTemplate("docs://knowledge/sections/{section}", {
							list: undefined,
							complete: {
								section: (value) =>
									["runtime", "security", "observability"].filter((entry) =>
										entry.startsWith(value),
									),
							},
						}),
						{ title: "Knowledge section", mimeType: "text/plain" },
						async (uri, { section }) => ({
							contents: [
								{
									uri: uri.href,
									mimeType: "text/plain",
									text: `section:${String(section)}`,
								},
							],
						}),
					);
				},
			],
		});
		upstream = upstreamRuntime;
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: { providers: [ALLOW_ALL_GATEWAY_POLICY_PROVIDER] },
					imports: [
						McpClientModule.forRoot({
							collaborators: {
								providers: [
									{
										provide: transportFactory,
										useValue: {
											createTransport: () =>
												new StreamableHTTPClientTransport(new URL("http://knowledge.test/mcp"), {
													fetch: createMcpServerTestFetch(upstreamRuntime),
												}),
										},
									},
								],
							},
							servers: [
								{
									name: "knowledge",
									transport: { kind: "http", url: "http://knowledge.test/mcp" },
								},
							],
							runtime: { transportFactory },
							bootstrap: { connectAll: true },
						}),
					],
					servers: [
						{
							name: "agent-gateway",
							serverInfo: { name: "agent-gateway", version: "1.0.0" },
							gateway: {
								upstreams: [{ clientName: "knowledge", gatewayName: "kb" }],
								policy: ALLOW_ALL_GATEWAY_POLICY,
							},
						},
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const runtimeService = application.get(McpRuntimeService);
		const runtime = runtimeService.server("agent-gateway");
		expect(runtimeService.listGateways()).toEqual([runtimeService.gateway("agent-gateway")]);
		client = new Client(
			{ name: "agent", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" } },
		);
		await client.connect(
			new StreamableHTTPClientTransport(new URL("http://gateway.test/mcp"), {
				fetch: createMcpServerTestFetch(runtime),
			}),
		);

		const tools = await client.listTools();
		expect(tools.tools).toHaveLength(1);
		const result = await client.callTool({
			name: tools.tools[0]!.name,
			arguments: { query: "mcp" },
		});
		expect(result.content).toEqual([{ type: "text", text: "found:mcp" }]);

		const resources = await client.listResources();
		expect(resources.resources).toHaveLength(1);
		expect(resources.resources[0]!.uri).not.toBe("docs://knowledge/guide");
		const resource = await client.readResource({ uri: resources.resources[0]!.uri });
		expect(resource.contents).toEqual([
			{
				uri: resources.resources[0]!.uri,
				mimeType: "text/plain",
				text: "gateway guide",
			},
		]);

		const prompts = await client.listPrompts();
		expect(prompts.prompts).toHaveLength(1);
		expect(prompts.prompts[0]!.name).not.toBe("summarize");
		const prompt = await client.getPrompt({
			name: prompts.prompts[0]!.name,
			arguments: { topic: "MCP v2" },
		});
		expect(prompt.messages).toEqual([
			{
				role: "user",
				content: { type: "text", text: "Summarize MCP v2" },
			},
		]);

		const promptCompletion = await client.complete({
			ref: { type: "ref/prompt", name: prompts.prompts[0]!.name },
			argument: { name: "topic", value: "mcp" },
		});
		expect(promptCompletion.completion.values).toEqual(["MCP v2"]);

		const templates = await client.listResourceTemplates();
		expect(templates.resourceTemplates).toHaveLength(1);
		const template = templates.resourceTemplates[0]!;
		expect(template.uriTemplate).not.toBe("docs://knowledge/sections/{section}");
		const templateCompletion = await client.complete({
			ref: { type: "ref/resource", uri: template.uriTemplate },
			argument: { name: "section", value: "sec" },
		});
		expect(templateCompletion.completion.values).toEqual(["security"]);
		const projectedSectionUri = new UriTemplate(template.uriTemplate).expand({
			section: "runtime",
		});
		const section = await client.readResource({ uri: projectedSectionUri });
		expect(section.contents).toEqual([
			{
				uri: projectedSectionUri,
				mimeType: "text/plain",
				text: "section:runtime",
			},
		]);
	});

	it("passes a verified principal to a context-aware declarative gateway upstream", async () => {
		const principalClaimsToken = Symbol("DELEGATED_PRINCIPAL_CLAIMS");
		const resolvedPrincipals: unknown[] = [];
		const resolvedAuthTokens: unknown[] = [];
		const resolveClient: McpGatewayClientResolver = (context) => {
			resolvedPrincipals.push(context.principal);
			resolvedAuthTokens.push(context.authInfo?.token);
			return {
				listTools: () => ({
					tools: [
						{
							name: "whoami",
							inputSchema: { type: "object", additionalProperties: false },
						},
					],
				}),
				callTool: () => ({ content: [{ type: "text", text: "delegated" }] }),
			};
		};
		const gatewayUpstream = providerBackedGatewayUpstream("delegated", resolveClient);
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: {
						providers: [
							ALLOW_ALL_GATEWAY_POLICY_PROVIDER,
							gatewayUpstream.provider,
							{
								provide: principalClaimsToken,
								useValue: {
									resolvePrincipalClaims: () => ({
										subject: "user-1",
										tenantId: "tenant-1",
									}),
								},
							},
						],
					},
					servers: [
						{
							name: "delegated-gateway",
							serverInfo: { name: "delegated-gateway", version: "1.0.0" },
							principalClaims: principalClaimsToken,
							gateway: {
								upstreams: [gatewayUpstream.definition],
								policy: ALLOW_ALL_GATEWAY_POLICY,
							},
						},
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		client = new Client(
			{ name: "delegated-agent", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" } },
		);
		await client.connect(
			new StreamableHTTPClientTransport(new URL("http://delegated.test/mcp"), {
				fetch: createMcpServerTestFetch(
					application.get(McpRuntimeService).server("delegated-gateway"),
					{
						authInfo: {
							token: "never-forward",
							clientId: "artifact-agent",
							scopes: ["artifacts:read"],
						},
					},
				),
			}),
		);

		await client.listTools();

		expect(resolvedPrincipals[0]).toEqual({
			clientId: "artifact-agent",
			scopes: ["artifacts:read"],
			subject: "user-1",
			tenantId: "tenant-1",
		});
		// Full verified auth data is available only at the explicit resolver seam so
		// applications can exchange it; the projected principal remains token-free.
		expect(resolvedAuthTokens[0]).toBe("never-forward");
		expect(JSON.stringify(resolvedPrincipals)).not.toContain("never-forward");
	});

	it("fails bootstrap when a gateway references an unknown named client", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					imports: [McpClientModule.forRoot()],
					collaborators: { providers: [ALLOW_ALL_GATEWAY_POLICY_PROVIDER] },
					servers: [
						{
							name: "invalid-gateway",
							serverInfo: { name: "invalid-gateway", version: "1.0.0" },
							gateway: {
								upstreams: ["missing"],
								policy: ALLOW_ALL_GATEWAY_POLICY,
							},
						},
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		const runtime = application.get(McpRuntimeService);

		await expect(application.init()).rejects.toThrow(/unknown MCP client "missing"/);
		expect(runtime.clients.closed).toBe(true);
	});

	it("fails bootstrap when a provider-backed gateway upstream is not registered", async () => {
		const missingClientProvider = Symbol("MISSING_GATEWAY_CLIENT_PROVIDER");
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: { providers: [ALLOW_ALL_GATEWAY_POLICY_PROVIDER] },
					servers: [
						{
							name: "provider-gateway",
							serverInfo: { name: "provider-gateway", version: "1.0.0" },
							gateway: {
								upstreams: [{ name: "delegated", clientProvider: missingClientProvider }],
								policy: ALLOW_ALL_GATEWAY_POLICY,
							},
						},
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();

		await expect(application.init()).rejects.toThrow(
			/MISSING_GATEWAY_CLIENT_PROVIDER.*implement resolveClient\(\)/,
		);
	});

	it("composes gateway tools and decorated handlers with independent policies", async () => {
		const callTool = vi.fn(() => ({ content: [{ type: "text" as const, text: "remote" }] }));
		const gatewayUpstream = providerBackedGatewayUpstream("data", () => ({
			getServerCapabilities: () => ({ tools: {}, prompts: {} }),
			listTools: () => ({ tools: [{ name: "query", inputSchema: { type: "object" as const } }] }),
			listPrompts: () => {
				throw new Error("Tools composition must not discover remote prompts");
			},
			callTool,
		}));
		const nativePolicy = {
			authorize: vi.fn((operation: { input: { name: string } }) => {
				expect(operation.input.name).toBe("greet");
				return allowMcpOperation();
			}),
		};
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: {
						providers: [
							ALLOW_ALL_GATEWAY_POLICY_PROVIDER,
							gatewayUpstream.provider,
							{ provide: "native-policy", useValue: nativePolicy },
						],
					},
					servers: [
						{
							name: "artifact",
							serverInfo: { name: "artifact", version: "1" },
							handlerAuthorization: "native-policy",
							gateway: {
								composition: "tools",
								upstreams: [gatewayUpstream.definition],
								policy: ALLOW_ALL_GATEWAY_POLICY,
							},
						},
					],
				}),
			],
			providers: [ToolsProvider],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		client = new Client({ name: "mixed", version: "1" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
				fetch: createMcpServerTestFetch(application.get(McpRuntimeService).server("artifact")),
			}),
		);
		const tools = await client.listTools();
		expect(tools.tools.map((tool) => tool.name)).toContain("greet");
		const remoteName = tools.tools.find((tool) => tool.name !== "greet")!.name;
		expect((await client.callTool({ name: "greet", arguments: { name: "Ada" } })).content).toEqual([
			{ type: "text", text: "Hello Ada" },
		]);
		expect((await client.callTool({ name: remoteName, arguments: {} })).content).toEqual([
			{ type: "text", text: "remote" },
		]);
		expect(
			nativePolicy.authorize.mock.calls.every(([operation]) => operation.input.name === "greet"),
		).toBe(true);
		expect(callTool).toHaveBeenCalledOnce();
	});

	it("rejects decorated handlers on a dedicated gateway server during bootstrap", async () => {
		const gatewayUpstream = providerBackedGatewayUpstream("empty", () => ({
			listTools: () => ({ tools: [] }),
			callTool: () => ({ content: [] }),
		}));
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: {
						providers: [ALLOW_ALL_GATEWAY_POLICY_PROVIDER, gatewayUpstream.provider],
					},
					servers: [
						{
							name: "artifact",
							serverInfo: { name: "artifact", version: "1.0.0" },
							gateway: {
								upstreams: [gatewayUpstream.definition],
								policy: ALLOW_ALL_GATEWAY_POLICY,
							},
						},
					],
				}),
			],
			providers: [ToolsProvider],
		}).compile();
		application = testingModule.createNestApplication();

		await expect(application.init()).rejects.toThrow(/must be dedicated/);
	});

	it("closes inbound servers, then gateways, then their upstream clients", async () => {
		const gatewayUpstream = providerBackedGatewayUpstream("upstream", () => ({
			listTools: () => ({ tools: [] }),
			callTool: () => ({ content: [] }),
		}));
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					imports: [McpClientModule.forRoot()],
					collaborators: {
						providers: [ALLOW_ALL_GATEWAY_POLICY_PROVIDER, gatewayUpstream.provider],
					},
					servers: [
						{
							name: "gateway",
							serverInfo: { name: "gateway", version: "1.0.0" },
							gateway: {
								upstreams: [gatewayUpstream.definition],
								policy: ALLOW_ALL_GATEWAY_POLICY,
							},
						},
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const runtime = application.get(McpRuntimeService);
		const servers = application.get(McpServerRegistry);
		const closed: string[] = [];
		vi.spyOn(servers, "close").mockImplementation(async () => {
			closed.push("servers");
		});
		vi.spyOn(runtime.gateway("gateway"), "close").mockImplementation(async () => {
			closed.push("gateway");
		});
		vi.spyOn(runtime.clients, "close").mockImplementation(async () => {
			closed.push("clients");
		});

		await application.close();
		application = undefined;

		expect(closed).toEqual(["servers", "gateway", "clients"]);
	});

	it("publishes one stable runtime close promise before child cleanup can re-enter", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [McpModule.forRoot({ imports: [McpClientModule.forRoot()] })],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const runtime = application.get(McpRuntimeService);
		const servers = application.get(McpServerRegistry);
		let reentrantClose: Promise<void> | undefined;
		vi.spyOn(servers, "close").mockImplementation(() => {
			reentrantClose = runtime.close();
			return Promise.resolve();
		});
		vi.spyOn(runtime.clients, "close").mockResolvedValue();

		const close = runtime.close();
		await close;

		expect(reentrantClose).toBe(close);
	});

	it("contains cleanup failures so Nest can finish disposing its adapters", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [McpModule.forRoot({ imports: [McpClientModule.forRoot()] })],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const runtime = application.get(McpRuntimeService);
		const servers = application.get(McpServerRegistry);
		const clientClose = vi.spyOn(runtime.clients, "close").mockResolvedValue();
		vi.spyOn(servers, "close").mockRejectedValue(new Error("server close failed"));

		await expect(application.close()).resolves.toBeUndefined();
		application = undefined;

		expect(clientClose).toHaveBeenCalledOnce();
		expect(runtime.shutdownError).toBeInstanceOf(AggregateError);
		expect(runtime.shutdownError?.errors).toEqual([
			expect.objectContaining({ message: "server close failed" }),
		]);
		await expect(runtime.close()).rejects.toBe(runtime.shutdownError);
	});

	it("rolls back a partially connected client set when bootstrap fails", async () => {
		const transportFactory = Symbol("PARTIAL_CONNECT_TRANSPORT_FACTORY");
		const healthyServer = new McpServerRuntime({
			name: "healthy",
			serverInfo: { name: "healthy", version: "1.0.0" },
		});
		upstream = healthyServer;
		const healthyMcpServer = await healthyServer.createServer({ era: "modern" });
		let healthyClientTransport: InMemoryTransport | undefined;
		let healthyServerTransport: InMemoryTransport | undefined;
		let runtime: McpRuntimeService | undefined;
		let healthyWasConnected = false;
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					imports: [
						McpClientModule.forRoot({
							collaborators: {
								providers: [
									{
										provide: transportFactory,
										useValue: {
											createTransport: async (definition: { kind: string; url?: string | URL }) => {
												if (definition.kind !== "http") {
													throw new Error("Expected an HTTP test transport.");
												}
												if (String(definition.url).includes("broken")) {
													await vi.waitFor(() =>
														expect(runtime?.clients.snapshot("healthy").state).toBe("connected"),
													);
													healthyWasConnected = true;
													throw new Error("broken upstream");
												}
												[healthyClientTransport, healthyServerTransport] =
													InMemoryTransport.createLinkedPair();
												await healthyMcpServer.connect(healthyServerTransport);
												return healthyClientTransport;
											},
										},
									},
								],
							},
							servers: [
								{
									name: "healthy",
									transport: { kind: "http", url: "http://healthy.test/mcp" },
								},
								{
									name: "broken",
									transport: { kind: "http", url: "http://broken.test/mcp" },
								},
							],
							runtime: { transportFactory },
							bootstrap: { connectAll: true },
						}),
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		const initializedRuntime = application.get(McpRuntimeService);
		runtime = initializedRuntime;

		await expect(application.init()).rejects.toThrow("broken upstream");

		expect(healthyWasConnected).toBe(true);
		expect(initializedRuntime.clients.closed).toBe(true);
		expect(initializedRuntime.clients.snapshot().every(({ state }) => state !== "connected")).toBe(
			true,
		);
		expect(healthyClientTransport).toBeDefined();
		application = undefined;
		await healthyMcpServer.close();
	});
});
