import { Injectable, type INestApplication, type Provider } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { allowAllMcpGatewayPolicy } from "@nest-mcp/gateway";
import type { McpServer, McpServerRuntime } from "@nest-mcp/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MCP_CATALOG_SCHEMAS_TOOL_NAME,
	MCP_CATALOG_SEARCH_TOOL_NAME,
	McpModule,
	McpModuleError,
	McpRuntimeService,
	Tool,
	allowMcpOperation,
	fromJsonSchema,
} from "../src/index.ts";
import type {
	McpCapabilityVisibilityPolicy,
	McpCatalogExposurePolicy,
	McpCatalogExposureResolverInput,
	McpHandlerAuthorizationPolicy,
	McpNestServerDefinition,
	McpProviderToken,
	McpServerBuildContext,
	McpServerContributor,
} from "../src/index.ts";

const TYPELESS_INPUT_SCHEMA = fromJsonSchema<{ value?: string }>({
	properties: { value: { type: "string" } },
	additionalProperties: false,
});
const TYPELESS_OUTPUT_SCHEMA = fromJsonSchema<{ value: string }>({
	properties: { value: { type: "string" } },
	required: ["value"],
	additionalProperties: false,
});
const STRING_INPUT_SCHEMA = fromJsonSchema<string>({ type: "string" });
const STRING_OUTPUT_SCHEMA = fromJsonSchema<string>({ type: "string" });
const ORIGINAL_ANNOTATIONS = { readOnlyHint: true };
const ORIGINAL_ICONS = [{ src: "https://catalog.test/tool.png", mimeType: "image/png" }];
const ORIGINAL_META = { existing: { retained: true } };
const LONG_MULTIBYTE_QUERY = "é".repeat(256);

@Injectable()
class AdminOnlyVisibility implements McpCapabilityVisibilityPolicy {
	isVisible(context: Readonly<McpServerBuildContext>): boolean {
		return context.principal?.clientId === "admin-client";
	}
}

@Injectable()
class RejectingCatalogVisibility implements McpCapabilityVisibilityPolicy {
	isVisible(): boolean {
		throw new Error("visibility rejected");
	}
}

@Injectable()
class NonBooleanCatalogVisibility {
	isVisible(): string {
		return "visible";
	}
}

@Injectable()
class TimeoutCatalogVisibility implements McpCapabilityVisibilityPolicy {
	isVisible(): Promise<boolean> {
		return new Promise<boolean>(() => undefined);
	}
}

@Injectable()
class CatalogFixtures {
	@Tool({
		name: "public-tool",
		servers: ["eager-catalog", "principal-catalog"],
		title: "Public tool",
		description: "A complete public projection",
		inputSchema: TYPELESS_INPUT_SCHEMA,
		outputSchema: TYPELESS_OUTPUT_SCHEMA,
		annotations: ORIGINAL_ANNOTATIONS,
		icons: ORIGINAL_ICONS,
		_meta: ORIGINAL_META,
		tags: ["public", "stable"],
	})
	publicTool({ value = "public" }: { value?: string }) {
		return {
			content: [{ type: "text" as const, text: value }],
			structuredContent: { value },
		};
	}

	@Tool({
		name: "string-output",
		servers: "eager-catalog",
		outputSchema: STRING_OUTPUT_SCHEMA,
	})
	stringOutput() {
		return { content: [{ type: "text" as const, text: "primitive" }] };
	}

	@Tool({
		name: "secret-tool",
		servers: "principal-catalog",
		visibility: AdminOnlyVisibility,
		tags: ["secret"],
	})
	secretTool() {
		return { content: [{ type: "text" as const, text: "secret" }] };
	}

	@Tool({ name: "search-eager", servers: "search-catalog", _meta: { existing: "eager" } })
	searchEager() {
		return { content: [{ type: "text" as const, text: "eager" }] };
	}

	@Tool({
		name: "search-deferred",
		servers: "search-catalog",
		_meta: { existing: "deferred" },
	})
	searchDeferred() {
		return {
			content: [{ type: "text" as const, text: "deferred" }],
			structuredContent: { retained: true },
		};
	}

	@Tool({ name: "predicate-tool", servers: "predicate-catalog" })
	predicateTool() {
		return { content: [{ type: "text" as const, text: "predicate" }] };
	}

	@Tool({
		name: "metadata-collision",
		servers: "metadata-collision-catalog",
		_meta: { "vendor.example/deferred": "already-owned" },
	})
	metadataCollision() {
		return { content: [{ type: "text" as const, text: "collision" }] };
	}

	@Tool({ name: "bad-input", servers: "bad-input-catalog", inputSchema: STRING_INPUT_SCHEMA })
	badInput(value: string) {
		return { content: [{ type: "text" as const, text: value }] };
	}
}

@Injectable()
class CollidingCatalogTool {
	@Tool({ name: MCP_CATALOG_SEARCH_TOOL_NAME, servers: "collision-catalog" })
	collision() {
		return { content: [{ type: "text" as const, text: "collision" }] };
	}
}

@Injectable()
class InvalidVisibilityCatalogFixtures {
	@Tool({
		name: "rejecting-visibility",
		servers: "visibility-reject-catalog",
		visibility: RejectingCatalogVisibility,
	})
	rejectingVisibility() {
		return { content: [{ type: "text" as const, text: "never" }] };
	}

	@Tool({
		name: "non-boolean-visibility",
		servers: "visibility-nonboolean-catalog",
		visibility: NonBooleanCatalogVisibility,
	})
	nonBooleanVisibility() {
		return { content: [{ type: "text" as const, text: "never" }] };
	}

	@Tool({
		name: "timeout-visibility",
		servers: "visibility-timeout-catalog",
		visibility: TimeoutCatalogVisibility,
	})
	timeoutVisibility() {
		return { content: [{ type: "text" as const, text: "never" }] };
	}
}

describe("authorization-safe MCP catalog exposure", () => {
	let application: INestApplication | undefined;

	afterEach(async () => {
		await application?.close();
		application = undefined;
		vi.restoreAllMocks();
	});

	it("preserves complete eager tool definitions and gives the resolver detached deep-frozen metadata", async () => {
		let resolverInput: McpCatalogExposureResolverInput | undefined;
		application = await bootstrapMcp(
			completeFixtureServers([
				catalogServer("eager-catalog", (input) => {
					resolverInput = input;
					return { kind: "eager" };
				}),
			]),
			{
				fixtureProviders: [CatalogFixtures],
				collaboratorProviders: [AdminOnlyVisibility],
			},
		);
		const session = await connectFreshBuild(
			application.get(McpRuntimeService).server("eager-catalog"),
		);

		try {
			const listed = await session.client.listTools();
			const publicTool = listed.tools.find(({ name }) => name === "public-tool");
			const primitiveTool = listed.tools.find(({ name }) => name === "string-output");
			expect(publicTool).toMatchObject({
				title: "Public tool",
				description: "A complete public projection",
				inputSchema: { type: "object" },
				outputSchema: { type: "object" },
				annotations: ORIGINAL_ANNOTATIONS,
				icons: ORIGINAL_ICONS,
				_meta: ORIGINAL_META,
			});
			// A legacy SDK connection wraps non-object outputs on the wire per SEP-2106.
			expect(primitiveTool?.outputSchema).toMatchObject({
				type: "object",
				properties: { result: { type: "string" } },
			});
			expect(publicTool).not.toHaveProperty("tags");
			expect(resolverInput).toBeDefined();
			expectDeepFrozen(resolverInput);
			const projected = resolverInput?.tools.find(({ tool }) => tool.name === "public-tool");
			const projectedPrimitive = resolverInput?.tools.find(
				({ tool }) => tool.name === "string-output",
			);
			expect(projected?.tool.annotations).not.toBe(ORIGINAL_ANNOTATIONS);
			expect(projected?.tool.icons).not.toBe(ORIGINAL_ICONS);
			expect(projected?.tool["_meta"]).not.toBe(ORIGINAL_META);
			expect(projected?.tags).toEqual(["public", "stable"]);
			expect(projectedPrimitive?.tool.outputSchema).toMatchObject({ type: "string" });
			expect(JSON.stringify(resolverInput)).not.toContain("token");

			const called = await session.client.callTool({
				name: "public-tool",
				arguments: { value: "complete" },
			});
			expect(called.structuredContent).toEqual({ value: "complete" });
		} finally {
			await session.close();
		}
	});

	it("isolates concurrent principal builds and lazy meta-tools cannot reveal a hidden tool", async () => {
		const authorizationNames: string[] = [];
		const authorize = vi.fn(
			(operation: Parameters<McpHandlerAuthorizationPolicy["authorize"]>[0]) => {
				authorizationNames.push(operation.input.name);
				return allowMcpOperation({ policy: "catalog-test" });
			},
		);
		const resolverInputs: McpCatalogExposureResolverInput[] = [];
		application = await bootstrapMcp(
			completeFixtureServers([
				{
					...catalogServer("principal-catalog", (input) => {
						resolverInputs.push(input);
						return input.principal?.clientId === "admin-client"
							? { kind: "eager" as const }
							: {
									kind: "lazy" as const,
									eager: [{ kind: "tag" as const, tag: "public" }],
								};
					}),
					handlerAuthorization: testValueProviderToken("principal-catalog authorization", {
						authorize,
					} satisfies McpHandlerAuthorizationPolicy),
				},
			]),
			{
				fixtureProviders: [CatalogFixtures],
				collaboratorProviders: [AdminOnlyVisibility],
			},
		);
		const runtime = application.get(McpRuntimeService).server("principal-catalog");
		const [admin, guest] = await Promise.all([
			connectFreshBuild(runtime, principalContext("admin-client", "admin-token")),
			connectFreshBuild(runtime, principalContext("guest-client", "guest-token")),
		]);

		try {
			expect((await admin.client.listTools()).tools.map(({ name }) => name).toSorted()).toEqual([
				"public-tool",
				"secret-tool",
			]);
			const guestList = await guest.client.listTools();
			expect(guestList.tools.map(({ name }) => name)).toEqual([
				"public-tool",
				MCP_CATALOG_SEARCH_TOOL_NAME,
				MCP_CATALOG_SCHEMAS_TOOL_NAME,
			]);
			expect(
				guestList.tools.find(({ name }) => name === MCP_CATALOG_SEARCH_TOOL_NAME)?.outputSchema,
			).toBeDefined();
			expect(
				guestList.tools.find(({ name }) => name === MCP_CATALOG_SCHEMAS_TOOL_NAME)?.outputSchema,
			).toBeDefined();

			const searched = await guest.client.callTool({
				name: MCP_CATALOG_SEARCH_TOOL_NAME,
				arguments: { query: "secret" },
			});
			expect(readStructuredTools(searched)).toEqual([]);
			const unknownSearch = await guest.client.callTool({
				name: MCP_CATALOG_SEARCH_TOOL_NAME,
				arguments: { query: "unknown-tool" },
			});
			expect(readStructuredTools(unknownSearch)).toEqual(readStructuredTools(searched));
			const schemas = await guest.client.callTool({
				name: MCP_CATALOG_SCHEMAS_TOOL_NAME,
				arguments: { names: ["secret-tool", "unknown-tool"] },
			});
			expect(readStructuredTools(schemas)).toEqual([]);
			const publicSchema = await guest.client.callTool({
				name: MCP_CATALOG_SCHEMAS_TOOL_NAME,
				arguments: { names: ["public-tool"] },
			});
			expect(readStructuredTools(publicSchema)).toEqual([
				expect.objectContaining({
					name: "public-tool",
					inputSchema: expect.objectContaining({ type: "object" }),
					outputSchema: expect.objectContaining({ type: "object" }),
					annotations: ORIGINAL_ANNOTATIONS,
					icons: ORIGINAL_ICONS,
					_meta: ORIGINAL_META,
				}),
			]);
			const hiddenSchema = await guest.client.callTool({
				name: MCP_CATALOG_SCHEMAS_TOOL_NAME,
				arguments: { names: ["secret-tool"] },
			});
			const unknownSchema = await guest.client.callTool({
				name: MCP_CATALOG_SCHEMAS_TOOL_NAME,
				arguments: { names: ["unknown-tool"] },
			});
			expect(readStructuredTools(hiddenSchema)).toEqual(readStructuredTools(unknownSchema));
			await expect(guest.client.callTool({ name: "secret-tool", arguments: {} })).rejects.toThrow();

			expect(authorizationNames).toEqual([
				MCP_CATALOG_SEARCH_TOOL_NAME,
				MCP_CATALOG_SEARCH_TOOL_NAME,
				MCP_CATALOG_SCHEMAS_TOOL_NAME,
				MCP_CATALOG_SCHEMAS_TOOL_NAME,
				MCP_CATALOG_SCHEMAS_TOOL_NAME,
				MCP_CATALOG_SCHEMAS_TOOL_NAME,
			]);
			expect(resolverInputs).toHaveLength(2);
			for (const input of resolverInputs) {
				expectDeepFrozen(input.principal);
				expect(Reflect.has(input, "authInfo")).toBe(false);
				expect(JSON.stringify(input)).not.toContain("-token");
			}
		} finally {
			await guest.close();
			await admin.close();
		}
	});

	it("marks only non-selected search tools with explicit metadata and keeps invocation authorization", async () => {
		const authorizationNames: string[] = [];
		const authorize = vi.fn(
			(operation: Parameters<McpHandlerAuthorizationPolicy["authorize"]>[0]) => {
				authorizationNames.push(operation.input.name);
				return allowMcpOperation({ policy: "search-test" });
			},
		);
		application = await bootstrapMcp(
			completeFixtureServers([
				{
					...catalogServer("search-catalog", () => ({
						kind: "search",
						eager: [{ kind: "name", name: "search-eager" }],
						deferredMetadata: { "vendor.example/deferred": { searchable: true } },
					})),
					handlerAuthorization: testValueProviderToken("search-catalog authorization", {
						authorize,
					} satisfies McpHandlerAuthorizationPolicy),
				},
			]),
			{
				fixtureProviders: [CatalogFixtures],
				collaboratorProviders: [AdminOnlyVisibility],
			},
		);
		const session = await connectFreshBuild(
			application.get(McpRuntimeService).server("search-catalog"),
		);

		try {
			const listed = await session.client.listTools();
			const eager = listed.tools.find(({ name }) => name === "search-eager");
			const deferred = listed.tools.find(({ name }) => name === "search-deferred");
			expect(eager?.["_meta"]).toEqual({ existing: "eager" });
			expect(deferred?.["_meta"]).toEqual({
				existing: "deferred",
				"vendor.example/deferred": { searchable: true },
			});
			expect(listed.tools.map(({ name }) => name)).not.toContain(MCP_CATALOG_SEARCH_TOOL_NAME);
			const called = await session.client.callTool({
				name: "search-deferred",
				arguments: {},
			});
			expect(called.structuredContent).toEqual({ retained: true });
			expect(authorize).toHaveBeenCalledOnce();
			expect(authorizationNames).toEqual(["search-deferred"]);
		} finally {
			await session.close();
		}
	});

	it("merges search metadata from the detached pre-resolver build snapshot", async () => {
		let resolveStarted: (() => void) | undefined;
		let resumeResolver: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const resume = new Promise<void>((resolve) => {
			resumeResolver = resolve;
		});
		application = await bootstrapMcp(
			[
				catalogServer("metadata-snapshot-catalog", async () => {
					resolveStarted?.();
					await resume;
					return {
						kind: "search",
						deferredMetadata: { "vendor.example/deferred": true },
					};
				}),
			],
			{ autoDiscover: false },
		);
		const service = application.get(McpRuntimeService);
		const mutableMeta = { existing: { version: "initial" } };
		const mutableAnnotations = { readOnlyHint: true };
		service.capabilities.registerTool(
			{
				name: "snapshot-tool",
				servers: "metadata-snapshot-catalog",
				annotations: mutableAnnotations,
				_meta: mutableMeta,
			},
			async () => ({ content: [{ type: "text" as const, text: "snapshot" }] }),
		);
		const build = service.server("metadata-snapshot-catalog").createServer({ era: "modern" });
		await started;
		mutableMeta.existing.version = "mutated-during-resolver";
		mutableAnnotations.readOnlyHint = false;
		resumeResolver?.();
		const session = await connectBuiltServer(await build);

		try {
			const listed = await session.client.listTools();
			expect(listed.tools[0]?.["_meta"]).toEqual({
				existing: { version: "initial" },
				"vendor.example/deferred": true,
			});
			expect(listed.tools[0]?.annotations).toEqual({ readOnlyHint: true });
		} finally {
			await session.close();
		}
	});

	it("bounds lazy pagination and keeps dynamic tags and registrations build-local", async () => {
		application = await bootstrapMcp(
			[
				catalogServer("dynamic-catalog", () => ({
					kind: "lazy",
					eager: [{ kind: "predicate", predicate: () => true }],
				})),
			],
			{ autoDiscover: false },
		);
		const service = application.get(McpRuntimeService);
		const runtime = service.server("dynamic-catalog");
		const oldBuild = await connectFreshBuild(runtime);
		const changes = vi.spyOn(runtime.notify, "toolsChanged");
		const tagInput = ["bulk"];
		const firstRegistration = service.capabilities.registerTool(
			{
				name: "bulk-00",
				servers: "dynamic-catalog",
				description: LONG_MULTIBYTE_QUERY,
				tags: tagInput,
			},
			async () => ({ content: [{ type: "text" as const, text: "zero" }] }),
		);
		tagInput[0] = "mutated";
		for (let index = 1; index < 55; index += 1) {
			service.capabilities.registerTool(
				{
					name: `bulk-${String(index).padStart(2, "0")}`,
					servers: "dynamic-catalog",
					description: LONG_MULTIBYTE_QUERY,
					tags: ["bulk"],
				},
				async () => ({ content: [{ type: "text" as const, text: String(index) }] }),
			);
		}
		const stored = service.capabilities.list().find(({ name }) => name === "bulk-00");
		expect(stored).toMatchObject({
			kind: "tool",
			name: "bulk-00",
			serverNames: ["dynamic-catalog"],
		});
		expect(stored).not.toHaveProperty("definition");
		expect(() =>
			service.capabilities.registerTool(
				{ name: "invalid-tags", servers: "dynamic-catalog", tags: ["duplicate", "duplicate"] },
				async () => ({ content: [] }),
			),
		).toThrow(/must not contain duplicates/);
		expect(() =>
			service.capabilities.registerTool(
				{ name: "x".repeat(129), servers: "dynamic-catalog" },
				async () => ({ content: [] }),
			),
		).toThrow(/128 character catalog name limit/);
		for (const reserved of [MCP_CATALOG_SEARCH_TOOL_NAME, MCP_CATALOG_SCHEMAS_TOOL_NAME]) {
			expect(() =>
				service.capabilities.registerTool(
					{ name: reserved, servers: "dynamic-catalog" },
					async () => ({ content: [] }),
				),
			).toThrow(/reserved catalog meta-tool/);
		}
		expect(changes).toHaveBeenCalledTimes(55);

		const registeredBuild = await connectFreshBuild(runtime);
		expect(
			firstRegistration.replace(async () => ({
				content: [{ type: "text" as const, text: "replacement" }],
			})),
		).toBe(true);
		expect(changes).toHaveBeenCalledTimes(56);
		const currentBuild = await connectFreshBuild(runtime);
		try {
			const storedTagSearch = await registeredBuild.client.callTool({
				name: MCP_CATALOG_SEARCH_TOOL_NAME,
				arguments: { query: "bulk-00" },
			});
			expect(readStructuredTools(storedTagSearch)).toEqual([
				{ name: "bulk-00", description: LONG_MULTIBYTE_QUERY, tags: ["bulk"] },
			]);
			expect((await oldBuild.client.listTools()).tools.map(({ name }) => name)).toEqual([
				MCP_CATALOG_SEARCH_TOOL_NAME,
				MCP_CATALOG_SCHEMAS_TOOL_NAME,
			]);
			expect(
				(await registeredBuild.client.callTool({ name: "bulk-00", arguments: {} })).content,
			).toEqual([{ type: "text", text: "zero" }]);
			expect(
				(await currentBuild.client.callTool({ name: "bulk-00", arguments: {} })).content,
			).toEqual([{ type: "text", text: "replacement" }]);
			const firstPage = await listRawToolsPage(currentBuild.client);
			expect(firstPage.tools).toHaveLength(50);
			expect(firstPage.tools[0]).not.toHaveProperty("tags");
			expect(firstPage.nextCursor?.length).toBeLessThanOrEqual(512);
			const listCursor = firstPage.nextCursor;
			if (listCursor === undefined) throw new Error("Expected a catalog list cursor.");
			const secondPage = await currentBuild.client.listTools({ cursor: listCursor });
			expect(secondPage.tools).toHaveLength(7);
			expect(secondPage.nextCursor).toBeUndefined();

			const searched = await currentBuild.client.callTool({
				name: MCP_CATALOG_SEARCH_TOOL_NAME,
				arguments: { query: LONG_MULTIBYTE_QUERY, limit: 1 },
			});
			const searchCursor = readNextCursor(searched);
			if (searchCursor === undefined) throw new Error("Expected a catalog search cursor.");
			expect(searchCursor?.length).toBeLessThanOrEqual(512);
			const searchedAgain = await currentBuild.client.callTool({
				name: MCP_CATALOG_SEARCH_TOOL_NAME,
				arguments: { query: LONG_MULTIBYTE_QUERY, limit: 1, cursor: searchCursor },
			});
			expect(readStructuredTools(searchedAgain)).toHaveLength(1);
			const mismatchedCursor = await currentBuild.client.callTool({
				name: MCP_CATALOG_SEARCH_TOOL_NAME,
				arguments: { query: "different", cursor: searchCursor },
			});
			expect(mismatchedCursor.isError).toBe(true);
			const malformedCursor = await currentBuild.client.callTool({
				name: MCP_CATALOG_SEARCH_TOOL_NAME,
				arguments: { query: LONG_MULTIBYTE_QUERY, cursor: "v1.not-base64" },
			});
			expect(malformedCursor.isError).toBe(true);
			const maximumSearch = await currentBuild.client.callTool({
				name: MCP_CATALOG_SEARCH_TOOL_NAME,
				arguments: { query: "", limit: 50 },
			});
			expect(readStructuredTools(maximumSearch)).toHaveLength(50);
			const searchOverflow = await currentBuild.client.callTool({
				name: MCP_CATALOG_SEARCH_TOOL_NAME,
				arguments: { query: "", limit: 51 },
			});
			expect(searchOverflow.isError).toBe(true);
			const queryOverflow = await currentBuild.client.callTool({
				name: MCP_CATALOG_SEARCH_TOOL_NAME,
				arguments: { query: `${LONG_MULTIBYTE_QUERY}x` },
			});
			expect(queryOverflow.isError).toBe(true);

			const maximumSchemas = await currentBuild.client.callTool({
				name: MCP_CATALOG_SCHEMAS_TOOL_NAME,
				arguments: {
					names: Array.from({ length: 20 }, (_, index) => `bulk-${String(index).padStart(2, "0")}`),
				},
			});
			expect(readStructuredTools(maximumSchemas)).toHaveLength(20);

			const schemaOverflow = await currentBuild.client.callTool({
				name: MCP_CATALOG_SCHEMAS_TOOL_NAME,
				arguments: { names: Array.from({ length: 21 }, (_, index) => `bulk-${String(index)}`) },
			});
			expect(schemaOverflow.isError).toBe(true);
			expect(firstRegistration.unregister()).toBe(true);
			expect(changes).toHaveBeenCalledTimes(57);
			expect((await currentBuild.client.listTools()).tools[0]?.name).toBe("bulk-00");
			expect(
				(await currentBuild.client.callTool({ name: "bulk-00", arguments: {} })).content,
			).toEqual([{ type: "text", text: "replacement" }]);
			const futureBuild = await connectFreshBuild(runtime);
			try {
				await expect(futureBuild.client.listTools({ cursor: listCursor })).rejects.toThrow();
				const staleSearch = await futureBuild.client.callTool({
					name: MCP_CATALOG_SEARCH_TOOL_NAME,
					arguments: {
						query: LONG_MULTIBYTE_QUERY,
						limit: 1,
						cursor: searchCursor,
					},
				});
				expect(staleSearch.isError).toBe(true);
				const futureNames = await listAllToolNames(futureBuild.client);
				expect(futureNames).not.toContain("bulk-00");
				expect(futureNames).toHaveLength(56);
			} finally {
				await futureBuild.close();
			}
		} finally {
			await currentBuild.close();
			await registeredBuild.close();
			await oldBuild.close();
		}
	});

	it("rejects unsafe catalog composition and static meta-tool collisions at bootstrap", async () => {
		const customFeature = vi.fn();
		const contributor = testValueProviderToken("custom-feature-catalog contributor", {
			contribute: customFeature,
		} satisfies McpServerContributor);
		const gatewayClient = testValueProviderToken("gateway-catalog client", {
			resolveClient: () => ({
				listTools: () => ({ tools: [] }),
				callTool: () => ({ content: [] }),
			}),
		});
		await expectBootstrapFailure(
			[
				{
					...catalogServer("custom-feature-catalog", () => ({ kind: "eager" })),
					contributors: [contributor],
				},
			],
			[],
			/cannot safely project tools from custom contributors/,
		);
		expect(customFeature).not.toHaveBeenCalled();
		await expectBootstrapFailure(
			[
				{
					...catalogServer("gateway-catalog", () => ({ kind: "eager" })),
					gateway: {
						upstreams: [{ name: "empty", clientProvider: gatewayClient }],
						policy: testValueProviderToken("gateway-catalog policy", allowAllMcpGatewayPolicy()),
					},
				},
			],
			[],
			/cannot be combined with gateway server/,
		);
		await expectBootstrapFailure(
			[catalogServer("collision-catalog", () => ({ kind: "lazy" }))],
			[CollidingCatalogTool],
			/reserved catalog meta-tool/,
		);
	});

	it("never resolves catalog exposure after a failed visibility wave", async () => {
		const resolver = vi.fn(() => ({ kind: "eager" as const }));
		application = await bootstrapMcp(
			[
				catalogServer("visibility-reject-catalog", resolver),
				catalogServer("visibility-nonboolean-catalog", resolver),
				{
					...catalogServer("visibility-timeout-catalog", resolver),
					handlerVisibilityTimeoutMs: 10,
				},
			],
			{
				fixtureProviders: [InvalidVisibilityCatalogFixtures],
				collaboratorProviders: [
					RejectingCatalogVisibility,
					NonBooleanCatalogVisibility,
					TimeoutCatalogVisibility,
				],
			},
		);
		const service = application.get(McpRuntimeService);
		for (const [runtimeName, message] of [
			["visibility-reject-catalog", "threw or rejected"],
			["visibility-nonboolean-catalog", "instead of boolean"],
			["visibility-timeout-catalog", "deadline"],
		] as const) {
			const failure = await captureFailure(
				service.server(runtimeName).createServer({ era: "modern" }),
			);
			expect(failure).toBeInstanceOf(McpModuleError);
			expect(failure).toMatchObject({ code: "INVALID_VISIBILITY_POLICY" });
			expect(String(failure)).toContain(message);
		}
		expect(resolver).not.toHaveBeenCalled();
	});

	it("fails resolver, predicate, and invalid input-schema projection closed", async () => {
		application = await bootstrapMcp(
			completeFixtureServers([
				{
					...catalogServer("timeout-catalog", () => new Promise<never>(() => undefined)),
					handlerVisibilityTimeoutMs: 10,
				},
				catalogServer("predicate-catalog", () => ({
					kind: "lazy",
					eager: [
						{
							kind: "predicate",
							predicate: () => {
								throw new Error("selector unavailable");
							},
						},
					],
				})),
				catalogServer("bad-input-catalog", () => ({ kind: "eager" })),
				catalogServer("metadata-collision-catalog", () => ({
					kind: "search",
					deferredMetadata: { "vendor.example/deferred": true },
				})),
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- corrupt boundary fixture
				catalogServer("invalid-strategy-catalog", () => ({ kind: "undeclared" }) as never),
			]),
			{
				fixtureProviders: [CatalogFixtures],
				collaboratorProviders: [AdminOnlyVisibility],
			},
		);
		const service = application.get(McpRuntimeService);

		await expectCatalogBuildFailure(service.server("timeout-catalog"), "deadline");
		await expectCatalogBuildFailure(
			service.server("predicate-catalog"),
			"predicate selector threw",
		);
		await expectCatalogBuildFailure(
			service.server("bad-input-catalog"),
			"input schema must describe an object",
		);
		await expectCatalogBuildFailure(
			service.server("invalid-strategy-catalog"),
			"undeclared strategy kind",
		);
		await expectCatalogBuildFailure(
			service.server("metadata-collision-catalog"),
			"collides with existing _meta",
		);
	});
});

function catalogServer(
	name: string,
	resolve: McpCatalogExposurePolicy["resolve"],
): McpNestServerDefinition {
	const policy = testValueProviderToken<McpCatalogExposurePolicy>(`${name} catalog policy`, {
		resolve,
	});
	return {
		name,
		serverInfo: { name, version: "1.0.0" },
		catalogExposure: { policy },
	};
}

const FIXTURE_SERVER_NAMES = [
	"eager-catalog",
	"principal-catalog",
	"search-catalog",
	"predicate-catalog",
	"bad-input-catalog",
	"metadata-collision-catalog",
] as const;

function completeFixtureServers(
	configured: readonly McpNestServerDefinition[],
): readonly McpNestServerDefinition[] {
	const names = new Set(configured.map(({ name }) => name));
	return [
		...configured,
		...FIXTURE_SERVER_NAMES.filter((name) => !names.has(name)).map((name) => ({
			name,
			serverInfo: { name, version: "1.0.0" },
		})),
	];
}

interface McpTestBootstrapOptions {
	readonly fixtureProviders?: readonly Provider[];
	readonly collaboratorProviders?: readonly Provider[];
	readonly autoDiscover?: boolean;
}

async function bootstrapMcp(
	servers: readonly McpNestServerDefinition[],
	options: McpTestBootstrapOptions = {},
): Promise<INestApplication> {
	const { fixtureProviders = [], collaboratorProviders = [], autoDiscover = true } = options;
	const testingModule = await Test.createTestingModule({
		imports: [
			McpModule.forRoot({
				servers,
				autoDiscover,
				collaborators: {
					providers: [...TEST_VALUE_PROVIDERS.values(), ...collaboratorProviders],
				},
			}),
		],
		providers: [...fixtureProviders],
	}).compile();
	const nextApplication = testingModule.createNestApplication();
	await nextApplication.init();
	return nextApplication;
}

interface BuiltServerSession {
	readonly client: Client;
	readonly server: McpServer;
	close(): Promise<void>;
}

async function connectFreshBuild(
	runtime: McpServerRuntime,
	context: Parameters<McpServerRuntime["createServer"]>[0] = { era: "modern" },
): Promise<BuiltServerSession> {
	return connectBuiltServer(await runtime.createServer(context));
}

async function connectBuiltServer(server: McpServer): Promise<BuiltServerSession> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client(
		{ name: "catalog-exposure-test", version: "1.0.0" },
		{ versionNegotiation: { mode: "auto" } },
	);
	await client.connect(clientTransport);
	return {
		client,
		server,
		close: async () => {
			try {
				await client.close();
			} finally {
				await server.close();
			}
		},
	};
}

function principalContext(clientId: string, token: string) {
	return { era: "modern" as const, authInfo: { clientId, token, scopes: ["catalog:read"] } };
}

function readStructuredTools(result: Awaited<ReturnType<Client["callTool"]>>): readonly unknown[] {
	const content = result.structuredContent;
	if (typeof content !== "object" || content === null) {
		throw new Error("Expected structured MCP catalog tools.");
	}
	const tools = Reflect.get(content, "tools");
	if (!Array.isArray(tools)) {
		throw new Error("Expected structured MCP catalog tools.");
	}
	return tools;
}

function readNextCursor(result: Awaited<ReturnType<Client["callTool"]>>): string | undefined {
	const content = result.structuredContent;
	if (typeof content !== "object" || content === null) return undefined;
	const cursor = Reflect.get(content, "nextCursor");
	return typeof cursor === "string" ? cursor : undefined;
}

async function listAllToolNames(client: Client): Promise<string[]> {
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listTools(cursor === undefined ? undefined : { cursor });
		names.push(...page.tools.map(({ name }) => name));
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return names;
}

function listRawToolsPage(client: Client, cursor?: string) {
	return client.request({
		method: "tools/list",
		params: cursor === undefined ? {} : { cursor },
	});
}

function expectDeepFrozen(value: unknown): void {
	if (typeof value !== "object" || value === null) return;
	expect(Object.isFrozen(value)).toBe(true);
	for (const entry of Array.isArray(value) ? value : Object.values(value)) expectDeepFrozen(entry);
}

async function expectBootstrapFailure(
	servers: readonly McpNestServerDefinition[],
	fixtureProviders: readonly Provider[],
	message: RegExp,
): Promise<void> {
	const testingModule = await Test.createTestingModule({
		imports: [
			McpModule.forRoot({
				servers,
				collaborators: { providers: [...TEST_VALUE_PROVIDERS.values()] },
			}),
		],
		providers: [...fixtureProviders],
	}).compile();
	const failedApplication = testingModule.createNestApplication();
	try {
		const failure = await captureFailure(failedApplication.init());
		expect(failure).toBeInstanceOf(McpModuleError);
		expect(failure).toMatchObject({ code: expect.any(String) });
		expect(String(failure)).toMatch(message);
	} finally {
		await failedApplication.close();
	}
}

async function expectCatalogBuildFailure(
	runtime: McpServerRuntime,
	message: string,
): Promise<void> {
	const failure = await captureFailure(runtime.createServer({ era: "modern" }));
	expect(failure).toBeInstanceOf(McpModuleError);
	if (!(failure instanceof McpModuleError)) return;
	expect(failure.code).toBe("INVALID_CATALOG_EXPOSURE");
	expect(failure.message).toContain(message);
}

async function captureFailure(task: Promise<unknown>): Promise<unknown> {
	try {
		await task;
		return undefined;
	} catch (error) {
		return error;
	}
}

const TEST_VALUE_PROVIDERS = new Map<symbol, Provider>();

function testValueProviderToken<Value>(description: string, value: Value): McpProviderToken<Value> {
	const token = Symbol(description);
	TEST_VALUE_PROVIDERS.set(token, { provide: token, useValue: value });
	return token;
}
