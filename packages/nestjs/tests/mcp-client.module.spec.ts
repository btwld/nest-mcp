import { PassThrough } from "node:stream";
import { Injectable, Module, Scope, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CallToolResult, FetchLike, Transport } from "@modelcontextprotocol/client";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import {
	McpClientRuntime,
	defineMcpClientTransform,
	type McpClientTransportDefinition,
	type McpClientTransportFactory,
	type McpClientTransportFactoryContext,
} from "@nest-mcp/client";
import {
	allowAllMcpGatewayPolicy,
	defineMcpGatewayTransform,
	type McpGatewayDiscoverySnapshot,
	type McpGatewayMiddleware,
	type McpGatewayToolClient,
} from "@nest-mcp/gateway";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	McpClientModule,
	McpClientService,
	McpModule,
	McpRuntimeService,
	type McpClientMiddlewareProvider,
	type McpClientModuleOptions,
	type McpGatewayMiddlewareProvider,
	type McpNestClientDefinition,
} from "../src/index.ts";

const ASYNC_CLIENT_NAME = Symbol("ASYNC_CLIENT_NAME");
const MISSING_TRANSPORT_FACTORY = Symbol("MISSING_TRANSPORT_FACTORY");
const HTTP_REQUEST_INIT = Symbol("HTTP_REQUEST_INIT");
const STDERR_STREAM = Symbol("STDERR_STREAM");
const RESPONSE_CACHE_STORE = Symbol("RESPONSE_CACHE_STORE");
const AUTH_PROVIDER = Symbol("AUTH_PROVIDER");

const AUTH_PROVIDER_CASES = [
	{
		label: "bearer auth",
		provider: { token: () => Promise.resolve("test-token") },
	},
	{
		label: "OAuth",
		provider: {
			clientMetadata: {},
			redirectUrl: new URL("https://client.example.test/oauth/callback"),
			clientInformation: () => undefined,
			tokens: () => undefined,
			saveTokens: () => undefined,
			redirectToAuthorization: () => undefined,
			saveCodeVerifier: () => undefined,
			codeVerifier: () => "test-verifier",
		},
	},
] as const;

@Module({
	providers: [{ provide: ASYNC_CLIENT_NAME, useValue: "async-upstream" }],
	exports: [ASYNC_CLIENT_NAME],
})
class AsyncClientConfigurationModule {}

@Injectable()
class McpClientConsumer {
	constructor(
		readonly service: McpClientService,
		readonly runtime: McpClientRuntime,
	) {}
}

@Module({ providers: [McpClientConsumer], exports: [McpClientConsumer] })
class McpClientConsumerModule {}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedClientCollaborator {}

@Injectable()
class RejectingTransportFactory implements McpClientTransportFactory {
	readonly failure = new Error("provider transport factory invoked");
	readonly calls: Array<{
		readonly definition: McpClientTransportDefinition;
		readonly context: McpClientTransportFactoryContext;
	}> = [];

	createTransport(
		definition: McpClientTransportDefinition,
		context: McpClientTransportFactoryContext,
	): Transport {
		this.calls.push({ definition, context });
		throw this.failure;
	}
}

describe("McpClientModule", () => {
	let application: INestApplication | undefined;

	afterEach(async () => {
		await application?.close();
		application = undefined;
		vi.restoreAllMocks();
	});

	it("supports synchronous configuration and aliases the service as the client runtime", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [
				McpClientModule.forRoot({
					servers: [
						{
							name: "sync-upstream",
							transport: { kind: "http", url: "https://sync.example.test/mcp" },
						},
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();

		const service = application.get(McpClientService);
		const runtime = application.get(McpClientRuntime);

		expect(runtime).toBe(service);
		expect(service.names()).toEqual(["sync-upstream"]);
		expect(service.getDefinition("sync-upstream")).toMatchObject({
			name: "sync-upstream",
			transport: { kind: "http", url: "https://sync.example.test/mcp" },
		});
	});

	it("supports asynchronous configuration through imported Nest providers", async () => {
		const createOptions = vi.fn((name: string) => ({
			servers: [
				{
					name,
					transport: { kind: "http" as const, url: `https://${name}.example.test/mcp` },
				},
			],
		}));
		const dynamicModule = McpClientModule.forRootAsync({
			imports: [AsyncClientConfigurationModule],
			inject: [ASYNC_CLIENT_NAME],
			useFactory: createOptions,
		});
		expect(dynamicModule.global).toBe(false);

		const testingModule = await Test.createTestingModule({
			imports: [dynamicModule],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();

		expect(application.get(McpClientService).names()).toEqual(["async-upstream"]);
		expect(createOptions).toHaveBeenCalledOnce();
		expect(createOptions).toHaveBeenCalledWith("async-upstream");
	});

	it("is local by default and supports explicit global visibility", async () => {
		expect(McpClientModule.forRoot().global).toBe(false);
		await expect(
			Test.createTestingModule({
				imports: [McpClientModule.forRoot(), McpClientConsumerModule],
			}).compile(),
		).rejects.toThrow(/McpClientService/);

		const testingModule = await Test.createTestingModule({
			imports: [McpClientModule.forRoot({ isGlobal: true }), McpClientConsumerModule],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();

		const consumer = application.get(McpClientConsumer);
		expect(consumer.service).toBe(application.get(McpClientService));
		expect(consumer.runtime).toBe(consumer.service);
	});

	it("resolves a transport factory through an explicit collaborator token", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [
				McpClientModule.forRoot({
					collaborators: { providers: [RejectingTransportFactory] },
					servers: [
						{
							name: "provider-backed",
							transport: { kind: "http", url: "https://provider.example.test/mcp" },
						},
					],
					runtime: { transportFactory: RejectingTransportFactory },
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const service = application.get(McpClientService);
		const transportFactory = application.get(RejectingTransportFactory);

		await expect(service.connect("provider-backed")).rejects.toBe(transportFactory.failure);

		expect(transportFactory.calls).toHaveLength(1);
		expect(transportFactory.calls[0]?.definition).toEqual({
			kind: "http",
			url: "https://provider.example.test/mcp",
		});
		expect(transportFactory.calls[0]?.context).toMatchObject({
			serverName: "provider-backed",
			signal: expect.any(AbortSignal),
		});
	});

	it("preserves provider-backed exact client transforms behind broad middleware", async () => {
		const fetchToken = Symbol("EXACT_CLIENT_FETCH");
		const exactMiddlewareToken = Symbol("EXACT_CLIENT_MIDDLEWARE");
		const broadMiddlewareToken = Symbol("BROAD_CLIENT_MIDDLEWARE");
		const upstreamResult = {
			content: [{ type: "text", text: "upstream" }],
		} satisfies CallToolResult;
		const exactResults: CallToolResult[] = [];
		const exactProvider: McpClientMiddlewareProvider = {
			handle: defineMcpClientTransform("tools/call", async (_operation, next) => {
				const result = await next();
				exactResults.push(result);
				return result;
			}),
		};
		const broadProvider: McpClientMiddlewareProvider = {
			async handle(operation, next) {
				const result = await next();
				return operation.input.method === "tools/call" ? { tools: [] } : result;
			},
		};
		const testingModule = await Test.createTestingModule({
			imports: [
				McpClientModule.forRoot({
					collaborators: {
						providers: [
							{ provide: fetchToken, useValue: { fetch: createEchoServerFetch(upstreamResult) } },
							{ provide: exactMiddlewareToken, useValue: exactProvider },
							{ provide: broadMiddlewareToken, useValue: broadProvider },
						],
					},
					servers: [
						{
							name: "exact-client",
							transport: {
								kind: "http",
								url: "https://exact-client.example.test/mcp",
								fetch: fetchToken,
							},
							clientOptions: {
								versionNegotiation: { mode: { pin: "2026-07-28" } },
							},
						},
					],
					runtime: { middleware: [exactMiddlewareToken, broadMiddlewareToken] },
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const service = application.get(McpClientService);
		await service.connect("exact-client");

		await expect(service.callTool("exact-client", { name: "echo" })).resolves.toEqual({
			tools: [],
		});
		expect(exactResults).toHaveLength(1);
		expect(exactResults[0]).toMatchObject(upstreamResult);
		expect(exactResults[0]).not.toHaveProperty("tools");
	});

	it("preserves provider-backed exact gateway transforms behind broad middleware", async () => {
		const policyToken = Symbol("EXACT_GATEWAY_POLICY");
		const upstreamToken = Symbol("EXACT_GATEWAY_UPSTREAM");
		const exactMiddlewareToken = Symbol("EXACT_GATEWAY_MIDDLEWARE");
		const broadMiddlewareToken = Symbol("BROAD_GATEWAY_MIDDLEWARE");
		const upstreamResult = {
			content: [{ type: "text", text: "upstream" }],
		} satisfies CallToolResult;
		const upstreamClient: McpGatewayToolClient = {
			listTools: () => ({
				tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }],
			}),
			callTool: () => upstreamResult,
		};
		const exactResults: CallToolResult[] = [];
		const exactProvider: McpGatewayMiddlewareProvider = {
			handle: defineMcpGatewayTransform("gateway.invocation", async (_operation, next) => {
				const result = await next();
				exactResults.push(result);
				return result;
			}),
		};
		const mismatchedResult: McpGatewayDiscoverySnapshot = {
			discoveredAt: 0,
			tools: [],
			prompts: [],
			resources: [],
			resourceTemplates: [],
		};
		const broadHandle: McpGatewayMiddleware = async (operation, next) => {
			const result = await next();
			return operation.input.type === "gateway.invocation" ? mismatchedResult : result;
		};
		const broadProvider: McpGatewayMiddlewareProvider = { handle: broadHandle };
		const testingModule = await Test.createTestingModule({
			imports: [
				McpModule.forRoot({
					collaborators: {
						providers: [
							{ provide: policyToken, useValue: allowAllMcpGatewayPolicy() },
							{ provide: upstreamToken, useValue: { resolveClient: () => upstreamClient } },
							{ provide: exactMiddlewareToken, useValue: exactProvider },
							{ provide: broadMiddlewareToken, useValue: broadProvider },
						],
					},
					servers: [
						{
							name: "exact-gateway",
							serverInfo: { name: "exact-gateway", version: "1.0.0" },
							gateway: {
								policy: policyToken,
								upstreams: [{ name: "exact-upstream", clientProvider: upstreamToken }],
								middleware: [exactMiddlewareToken, broadMiddlewareToken],
							},
						},
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const gateway = application.get(McpRuntimeService).gateway("exact-gateway");
		const [tool] = await gateway.listProjectedTools();
		if (tool === undefined) throw new Error("Expected a projected gateway tool.");

		await expect(gateway.callTool(tool.projectedName, {})).rejects.toMatchObject({
			code: "INVALID_INVOCATION_RESULT",
		});
		expect(exactResults).toEqual([upstreamResult]);
	});

	it("strips a raw runtime principal supplied outside the typed API", async () => {
		const fetchToken = Symbol("RAW_PRINCIPAL_FETCH");
		const middlewareToken = Symbol("RAW_PRINCIPAL_MIDDLEWARE");
		const principals: unknown[] = [];
		const middlewareProvider: McpClientMiddlewareProvider = {
			async handle(operation, next) {
				if (operation.input.method === "tools/call") {
					principals.push(operation.context.principal);
				}
				return next();
			},
		};
		const runtime: NonNullable<McpClientModuleOptions["runtime"]> = {
			middleware: [middlewareToken],
		};
		Reflect.set(runtime, "principal", { subject: "raw-principal" });
		const testingModule = await Test.createTestingModule({
			imports: [
				McpClientModule.forRoot({
					collaborators: {
						providers: [
							{ provide: fetchToken, useValue: { fetch: createEchoServerFetch() } },
							{ provide: middlewareToken, useValue: middlewareProvider },
						],
					},
					servers: [clientDefinition("raw-principal", fetchToken)],
					runtime,
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const service = application.get(McpClientService);
		await service.connect("raw-principal");

		await service.callTool("raw-principal", { name: "echo" });

		expect(principals).toEqual([undefined]);
	});

	it("resolves operation principals only through the configured Nest provider", async () => {
		const fetchToken = Symbol("RESOLVED_PRINCIPAL_FETCH");
		const middlewareToken = Symbol("RESOLVED_PRINCIPAL_MIDDLEWARE");
		const resolverToken = Symbol("CLIENT_PRINCIPAL_RESOLVER");
		const resolvedPrincipal = Object.freeze({ subject: "resolved-principal" });
		const principals: unknown[] = [];
		const resolvedMethods: string[] = [];
		const resolvePrincipal = vi.fn((operation: { readonly method: string }) => {
			resolvedMethods.push(operation.method);
			return resolvedPrincipal;
		});
		const middlewareProvider: McpClientMiddlewareProvider = {
			async handle(operation, next) {
				if (operation.input.method === "tools/call") {
					principals.push(operation.context.principal);
				}
				return next();
			},
		};
		const testingModule = await Test.createTestingModule({
			imports: [
				McpClientModule.forRoot({
					collaborators: {
						providers: [
							{ provide: fetchToken, useValue: { fetch: createEchoServerFetch() } },
							{ provide: middlewareToken, useValue: middlewareProvider },
							{ provide: resolverToken, useValue: { resolvePrincipal } },
						],
					},
					servers: [clientDefinition("resolved-principal", fetchToken)],
					runtime: {
						middleware: [middlewareToken],
						principalResolver: resolverToken,
					},
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const service = application.get(McpClientService);
		await service.connect("resolved-principal");

		await service.callTool("resolved-principal", { name: "echo" });

		expect(resolvePrincipal).toHaveBeenCalled();
		expect(resolvedMethods).toContain("tools/call");
		expect(principals).toEqual([resolvedPrincipal]);
	});

	it("resolves HTTP request initialization through a Nest provider", async () => {
		const requestInit = Object.freeze({
			headers: { "x-client-test": "provider-backed" },
		}) satisfies RequestInit;
		const testingModule = await Test.createTestingModule({
			imports: [
				McpClientModule.forRoot({
					collaborators: {
						providers: [{ provide: HTTP_REQUEST_INIT, useValue: requestInit }],
					},
					servers: [
						{
							name: "request-init",
							transport: {
								kind: "http",
								url: "https://request-init.example.test/mcp",
								requestInit: HTTP_REQUEST_INIT,
							},
						},
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();

		const transport = application.get(McpClientService).getDefinition("request-init").transport;
		expect(transport.kind).toBe("http");
		if (transport.kind !== "http") throw new Error("Expected an HTTP transport.");
		expect(transport.requestInit).toBe(requestInit);
	});

	it("resolves a live stdio stderr stream through a Nest provider", async () => {
		const stderr = new PassThrough();
		const testingModule = await Test.createTestingModule({
			imports: [
				McpClientModule.forRoot({
					collaborators: {
						providers: [{ provide: STDERR_STREAM, useValue: stderr }],
					},
					servers: [
						{
							name: "stdio-stream",
							transport: {
								kind: "stdio",
								command: process.execPath,
								stderrStream: STDERR_STREAM,
							},
						},
					],
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();

		const transport = application.get(McpClientService).getDefinition("stdio-stream").transport;
		expect(transport.kind).toBe("stdio");
		if (transport.kind !== "stdio") throw new Error("Expected a stdio transport.");
		expect(transport.stderr).toBe(stderr);
		expect(transport).not.toHaveProperty("stderrStream");
		stderr.destroy();
	});

	it("rejects configuring both passive and provider-backed stdio stderr", async () => {
		const stderr = new PassThrough();
		try {
			await expect(
				Test.createTestingModule({
					imports: [
						McpClientModule.forRoot({
							collaborators: {
								providers: [{ provide: STDERR_STREAM, useValue: stderr }],
							},
							servers: [
								{
									name: "stdio-conflict",
									transport: {
										kind: "stdio",
										command: process.execPath,
										stderr: "pipe",
										stderrStream: STDERR_STREAM,
									},
								},
							],
						}),
					],
				}).compile(),
			).rejects.toThrow(/cannot configure both stderr and stderrStream/);
		} finally {
			stderr.destroy();
		}
	});

	it("rejects a raw live stdio stream supplied outside the typed API", async () => {
		const stderr = new PassThrough();
		const options: McpClientModuleOptions = {
			servers: [
				{
					name: "raw-stdio-stream",
					transport: { kind: "stdio", command: process.execPath },
				},
			],
		};
		const transport = options.servers?.[0]?.transport;
		if (transport === undefined) throw new Error("Expected a configured transport.");
		Reflect.set(transport, "stderr", stderr);

		try {
			await expect(
				Test.createTestingModule({
					imports: [McpClientModule.forRoot(options)],
				}).compile(),
			).rejects.toThrow(/must reference live stderr streams through stderrStream/);
		} finally {
			stderr.destroy();
		}
	});

	it("validates every response-cache store method", async () => {
		const invalidStore = {
			get: () => undefined,
			set: () => 1,
			delete: () => undefined,
			evict: () => undefined,
			clear: false,
		};

		await expect(
			Test.createTestingModule({
				imports: [
					McpClientModule.forRoot({
						collaborators: {
							providers: [{ provide: RESPONSE_CACHE_STORE, useValue: invalidStore }],
						},
						servers: [
							{
								name: "invalid-cache-store",
								transport: {
									kind: "http",
									url: "https://cache.example.test/mcp",
								},
								clientOptions: { responseCacheStore: RESPONSE_CACHE_STORE },
							},
						],
					}),
				],
			}).compile(),
		).rejects.toThrow(/get\(\).*set\(\).*delete\(\).*evict\(\).*clear\(\)/);
	});

	it.each(AUTH_PROVIDER_CASES)(
		"accepts the $label branch of the auth-provider union",
		async ({ label: _label, provider }) => {
			const testingModule = await Test.createTestingModule({
				imports: [
					McpClientModule.forRoot({
						collaborators: {
							providers: [{ provide: AUTH_PROVIDER, useValue: provider }],
						},
						servers: [
							{
								name: "authenticated",
								transport: {
									kind: "http",
									url: "https://auth.example.test/mcp",
									authProvider: AUTH_PROVIDER,
								},
							},
						],
					}),
				],
			}).compile();
			application = testingModule.createNestApplication();
			await application.init();

			const transport = application.get(McpClientService).getDefinition("authenticated").transport;
			expect(transport.kind).toBe("http");
			if (transport.kind !== "http") throw new Error("Expected an HTTP transport.");
			expect(transport.authProvider).toBe(provider);
		},
	);

	it("rejects a collaborator matching neither auth-provider branch", async () => {
		await expect(
			Test.createTestingModule({
				imports: [
					McpClientModule.forRoot({
						collaborators: {
							providers: [{ provide: AUTH_PROVIDER, useValue: { token: "static" } }],
						},
						servers: [
							{
								name: "invalid-auth",
								transport: {
									kind: "http",
									url: "https://invalid-auth.example.test/mcp",
									authProvider: AUTH_PROVIDER,
								},
							},
						],
					}),
				],
			}).compile(),
		).rejects.toThrow(/must implement AuthProvider\.token\(\) or the OAuthClientProvider contract/);
	});

	it("strips raw callbacks and live objects supplied outside the typed API", async () => {
		const abortController = new AbortController();
		const options: McpClientModuleOptions = {
			runtime: {},
			servers: [
				{
					name: "sanitized",
					transport: {
						kind: "http",
						url: "https://sanitized.example.test/mcp",
						options: {},
					},
					clientOptions: {},
					connectOptions: {},
				},
			],
		};
		const runtime = options.runtime;
		const server = options.servers?.[0];
		if (runtime === undefined || server === undefined || server.transport.kind !== "http") {
			throw new Error("Expected configured HTTP client options.");
		}
		Reflect.set(runtime, "servers", [
			{
				name: "raw-runtime-server",
				transport: { kind: "http", url: "https://raw-runtime.example.test/mcp" },
			},
		]);
		Reflect.set(server.clientOptions ?? {}, "listChanged", { tools: () => undefined });
		Reflect.set(server.connectOptions ?? {}, "onprogress", () => undefined);
		Reflect.set(server.connectOptions ?? {}, "signal", abortController.signal);
		Reflect.set(server.transport.options ?? {}, "authProvider", {
			token: () => Promise.resolve("raw"),
		});
		Reflect.set(server.transport.options ?? {}, "fetch", () =>
			Promise.reject(new Error("raw fetch must be stripped")),
		);
		Reflect.set(server.transport.options ?? {}, "requestInit", {
			headers: { "x-raw": "true" },
		});
		const testingModule = await Test.createTestingModule({
			imports: [McpClientModule.forRoot(options)],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();

		const service = application.get(McpClientService);
		const definition = service.getDefinition("sanitized");
		expect(service.names()).toEqual(["sanitized"]);
		expect(definition.clientOptions).not.toHaveProperty("listChanged");
		expect(definition.connectOptions).not.toHaveProperty("onprogress");
		expect(definition.connectOptions).not.toHaveProperty("signal");
		expect(definition.transport.kind).toBe("http");
		if (definition.transport.kind !== "http") {
			throw new Error("Expected an HTTP transport.");
		}
		expect(definition.transport.options).not.toHaveProperty("authProvider");
		expect(definition.transport.options).not.toHaveProperty("fetch");
		expect(definition.transport.options).not.toHaveProperty("requestInit");
	});

	it("rejects a raw HTTP request-init object supplied outside the typed API", async () => {
		const options: McpClientModuleOptions = {
			servers: [
				{
					name: "raw-request-init",
					transport: {
						kind: "http",
						url: "https://raw-request-init.example.test/mcp",
					},
				},
			],
		};
		const transport = options.servers?.[0]?.transport;
		if (transport === undefined) throw new Error("Expected a configured transport.");
		Reflect.set(transport, "requestInit", { headers: { "x-raw": "true" } });

		await expect(
			Test.createTestingModule({
				imports: [McpClientModule.forRoot(options)],
			}).compile(),
		).rejects.toThrow(/<invalid object>.*must be listed in McpClientModule/);
	});

	it("rejects request-scoped collaborators during standalone module bootstrap", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [
				McpClientModule.forRoot({
					collaborators: { providers: [RequestScopedClientCollaborator] },
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();

		await expect(application.init()).rejects.toThrow(
			/default singleton scope with a static dependency tree/,
		);
	});

	it("fails construction when a referenced collaborator is not registered", async () => {
		await expect(
			Test.createTestingModule({
				imports: [
					McpClientModule.forRoot({
						runtime: { transportFactory: MISSING_TRANSPORT_FACTORY },
					}),
				],
			}).compile(),
		).rejects.toThrow(
			/MISSING_TRANSPORT_FACTORY.*must be listed in McpClientModule collaborators\.providers/,
		);
	});

	it("does not connect during application bootstrap by default", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [
				McpClientModule.forRoot({
					collaborators: { providers: [RejectingTransportFactory] },
					servers: [
						{
							name: "deferred",
							transport: { kind: "http", url: "https://deferred.example.test/mcp" },
						},
					],
					runtime: { transportFactory: RejectingTransportFactory },
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		const service = application.get(McpClientService);
		const transportFactory = application.get(RejectingTransportFactory);

		await application.init();

		expect(transportFactory.calls).toHaveLength(0);
		expect(service.snapshot("deferred").state).toBe("disconnected");
	});

	it("closes the runtime when bootstrap.connectAll fails", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [
				McpClientModule.forRoot({
					collaborators: { providers: [RejectingTransportFactory] },
					servers: [
						{
							name: "broken",
							transport: { kind: "http", url: "https://broken.example.test/mcp" },
						},
					],
					runtime: { transportFactory: RejectingTransportFactory },
					bootstrap: { connectAll: true },
				}),
			],
		}).compile();
		application = testingModule.createNestApplication();
		const service = application.get(McpClientService);
		const transportFactory = application.get(RejectingTransportFactory);

		await expect(application.init()).rejects.toBe(transportFactory.failure);

		expect(service.closed).toBe(true);
		expect(service.snapshot("broken").state).not.toBe("connected");
	});

	it("closes its runtime during standalone Nest shutdown", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [McpClientModule.forRoot()],
		}).compile();
		application = testingModule.createNestApplication();
		await application.init();
		const service = application.get(McpClientService);
		const close = vi.spyOn(service, "close");

		await application.close();
		application = undefined;

		expect(close).toHaveBeenCalledOnce();
		expect(service.closed).toBe(true);
		expect(service.shutdownError).toBeUndefined();
	});
});

function createEchoServerFetch(
	result: CallToolResult = { content: [{ type: "text", text: "upstream" }] },
): FetchLike {
	const handler = createMcpHandler(
		() => {
			const server = new McpServer({ name: "nest-client-test", version: "1.0.0" });
			server.registerTool("echo", {}, () => result);
			return server;
		},
		{ legacy: "reject" },
	);
	return (url, init) => handler.fetch(new Request(url, init));
}

function clientDefinition(name: string, fetchToken: symbol): McpNestClientDefinition {
	return {
		name,
		transport: {
			kind: "http",
			url: `https://${name}.example.test/mcp`,
			fetch: fetchToken,
		},
		clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
	};
}
