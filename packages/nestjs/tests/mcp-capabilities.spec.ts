import { Inject, Injectable, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { allowAllMcpGatewayPolicy } from "@nest-mcp/gateway";
import type { McpServer, McpServerRuntime } from "@nest-mcp/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpModule, McpModuleError, McpRuntimeService, Targets, Tool } from "../src/index.ts";
import type { McpCapabilityVisibilityPolicy, McpNestServerDefinition } from "../src/index.ts";

const NON_BOOLEAN_VISIBILITY_RESULT = Symbol("NON_BOOLEAN_VISIBILITY_RESULT");
const ALLOW_ALL_GATEWAY_POLICY = Symbol("ALLOW_ALL_GATEWAY_POLICY");
const ALLOW_ALL_GATEWAY_POLICY_PROVIDER = {
	provide: ALLOW_ALL_GATEWAY_POLICY,
	useValue: allowAllMcpGatewayPolicy(),
};

@Injectable()
@Targets("alpha")
class ClassTargetedTools {
	@Tool({ name: "class-default" })
	classDefault() {
		return { content: [{ type: "text" as const, text: "alpha" }] };
	}

	@Tool({ name: "method-override", servers: "beta" })
	methodOverride() {
		return { content: [{ type: "text" as const, text: "beta" }] };
	}
}

@Injectable()
@Targets("missing")
class UnknownTargetTools {
	@Tool({ name: "unknown-target" })
	unknownTarget() {
		return { content: [{ type: "text" as const, text: "unreachable" }] };
	}
}

@Injectable()
class SharedVisibilityPolicy implements McpCapabilityVisibilityPolicy {
	readonly runtimeNames: string[] = [];

	isVisible(context: { readonly runtimeName: string }): boolean {
		this.runtimeNames.push(context.runtimeName);
		return true;
	}
}

@Injectable()
@Targets("visible")
class SharedVisibilityTools {
	@Tool({ name: "visible-one", visibility: SharedVisibilityPolicy })
	visibleOne() {
		return { content: [{ type: "text" as const, text: "one" }] };
	}

	@Tool({ name: "visible-two", visibility: SharedVisibilityPolicy })
	visibleTwo() {
		return { content: [{ type: "text" as const, text: "two" }] };
	}
}

@Injectable()
class RejectingVisibilityPolicy implements McpCapabilityVisibilityPolicy {
	isVisible(): never {
		throw new Error("visibility backend unavailable");
	}
}

@Injectable()
class NonBooleanVisibilityPolicy implements McpCapabilityVisibilityPolicy {
	constructor(@Inject(NON_BOOLEAN_VISIBILITY_RESULT) private readonly injectedResult: boolean) {}

	isVisible(): boolean {
		return this.injectedResult;
	}
}

@Injectable()
class HangingVisibilityPolicy implements McpCapabilityVisibilityPolicy {
	isVisible(): Promise<boolean> {
		return new Promise<boolean>(() => undefined);
	}
}

@Injectable()
class InvalidVisibilityTools {
	@Tool({
		name: "rejecting-visibility",
		servers: "visibility-rejects",
		visibility: RejectingVisibilityPolicy,
	})
	rejectingVisibility() {
		return { content: [{ type: "text" as const, text: "unreachable" }] };
	}

	@Tool({
		name: "non-boolean-visibility",
		servers: "visibility-non-boolean",
		visibility: NonBooleanVisibilityPolicy,
	})
	nonBooleanVisibility() {
		return { content: [{ type: "text" as const, text: "unreachable" }] };
	}

	@Tool({
		name: "hanging-visibility",
		servers: "visibility-timeout",
		visibility: HangingVisibilityPolicy,
	})
	hangingVisibility() {
		return { content: [{ type: "text" as const, text: "unreachable" }] };
	}
}

describe("MCP capability registry public API", () => {
	let application: INestApplication | undefined;

	afterEach(async () => {
		await application?.close();
		application = undefined;
		vi.restoreAllMocks();
	});

	it("uses @Targets as a class default while method targets override it", async () => {
		application = await bootstrapMcp(
			[serverDefinition("alpha"), serverDefinition("beta")],
			[ClassTargetedTools],
		);
		const runtime = application.get(McpRuntimeService);
		const alpha = await connectFreshBuild(runtime.server("alpha"));
		const beta = await connectFreshBuild(runtime.server("beta"));

		try {
			expect((await alpha.client.listTools()).tools.map(({ name }) => name)).toEqual([
				"class-default",
			]);
			expect((await beta.client.listTools()).tools.map(({ name }) => name)).toEqual([
				"method-override",
			]);
		} finally {
			await beta.close();
			await alpha.close();
		}
	});

	it("rejects an unknown class-level target during application bootstrap", async () => {
		const testingModule = await Test.createTestingModule({
			imports: [McpModule.forRoot({ servers: [serverDefinition("known")] })],
			providers: [UnknownTargetTools],
		}).compile();
		application = testingModule.createNestApplication();

		const failure = await captureFailure(application.init());

		expect(failure).toBeInstanceOf(McpModuleError);
		if (!(failure instanceof McpModuleError)) return;
		expect(failure.code).toBe("UNKNOWN_SERVER_TARGET");
		expect(failure.message).toContain('targets unknown server "missing"');
	});

	it("evaluates one shared visibility policy once per fresh server build", async () => {
		application = await bootstrapMcp([serverDefinition("visible")], [SharedVisibilityTools], {
			collaborators: [SharedVisibilityPolicy],
		});
		const runtime = application.get(McpRuntimeService);
		const policy = application.get(SharedVisibilityPolicy);

		const first = await connectFreshBuild(runtime.server("visible"));
		try {
			expect((await first.client.listTools()).tools.map(({ name }) => name).toSorted()).toEqual([
				"visible-one",
				"visible-two",
			]);
			expect(policy.runtimeNames).toEqual(["visible"]);
		} finally {
			await first.close();
		}

		const second = await connectFreshBuild(runtime.server("visible"));
		try {
			expect((await second.client.listTools()).tools).toHaveLength(2);
			expect(policy.runtimeNames).toEqual(["visible", "visible"]);
		} finally {
			await second.close();
		}
	});

	it("fails a whole build closed when visibility rejects, returns non-boolean, or times out", async () => {
		application = await bootstrapMcp(
			[
				serverDefinition("visibility-rejects"),
				serverDefinition("visibility-non-boolean"),
				{
					...serverDefinition("visibility-timeout"),
					handlerVisibilityTimeoutMs: 10,
				},
			],
			[InvalidVisibilityTools],
			{
				collaborators: [
					RejectingVisibilityPolicy,
					{ provide: NON_BOOLEAN_VISIBILITY_RESULT, useValue: "visible" },
					NonBooleanVisibilityPolicy,
					HangingVisibilityPolicy,
				],
			},
		);
		const runtime = application.get(McpRuntimeService);

		await expectVisibilityBuildFailure(runtime.server("visibility-rejects"), "threw or rejected");
		await expectVisibilityBuildFailure(
			runtime.server("visibility-non-boolean"),
			"returned string instead of boolean",
		);
		await expectVisibilityBuildFailure(runtime.server("visibility-timeout"), "deadline");
	});

	it("applies dynamic register, replace, and unregister to later builds when discovery is disabled", async () => {
		application = await bootstrapMcp([serverDefinition("dynamic")], [], {
			autoDiscover: false,
		});
		const runtime = application.get(McpRuntimeService);
		const sessions: BuiltServerSession[] = [];

		try {
			const beforeRegistration = await connectFreshBuild(runtime.server("dynamic"));
			sessions.push(beforeRegistration);
			expect(beforeRegistration.client.getServerCapabilities()?.tools).toBeUndefined();

			const registration = runtime.capabilities.registerTool(
				{ name: "live-tool", servers: "dynamic" },
				async () => ({ content: [{ type: "text" as const, text: "version-one" }] }),
				"test live tool",
			);
			expect(runtime.capabilities.list()).toEqual([
				{
					kind: "tool",
					name: "live-tool",
					serverNames: ["dynamic"],
					source: "test live tool",
				},
			]);
			expect(beforeRegistration.client.getServerCapabilities()?.tools).toBeUndefined();

			const afterRegistration = await connectFreshBuild(runtime.server("dynamic"));
			sessions.push(afterRegistration);
			expect((await afterRegistration.client.listTools()).tools.map(({ name }) => name)).toEqual([
				"live-tool",
			]);
			expect(
				(await afterRegistration.client.callTool({ name: "live-tool", arguments: {} })).content,
			).toEqual([{ type: "text", text: "version-one" }]);

			expect(
				registration.replace(async () => ({
					content: [{ type: "text" as const, text: "version-two" }],
				})),
			).toBe(true);
			expect(
				(await afterRegistration.client.callTool({ name: "live-tool", arguments: {} })).content,
			).toEqual([{ type: "text", text: "version-one" }]);

			const afterReplacement = await connectFreshBuild(runtime.server("dynamic"));
			sessions.push(afterReplacement);
			expect(
				(await afterReplacement.client.callTool({ name: "live-tool", arguments: {} })).content,
			).toEqual([{ type: "text", text: "version-two" }]);

			expect(registration.unregister()).toBe(true);
			expect(
				(await afterReplacement.client.callTool({ name: "live-tool", arguments: {} })).content,
			).toEqual([{ type: "text", text: "version-two" }]);

			const afterUnregister = await connectFreshBuild(runtime.server("dynamic"));
			sessions.push(afterUnregister);
			expect(afterUnregister.client.getServerCapabilities()?.tools).toBeUndefined();
			expect(registration.unregister()).toBe(false);
			expect(
				registration.replace(async () => ({
					content: [{ type: "text" as const, text: "unreachable" }],
				})),
			).toBe(false);
		} finally {
			for (const session of sessions.toReversed()) await session.close();
		}
	});

	it("rejects register, replace, and unregister after runtime close", async () => {
		application = await bootstrapMcp([serverDefinition("closed")], [], {
			autoDiscover: false,
		});
		const runtime = application.get(McpRuntimeService);
		const registration = runtime.capabilities.registerTool(
			{ name: "closed-tool", servers: "closed" },
			async () => ({ content: [{ type: "text" as const, text: "closed" }] }),
		);

		await runtime.close();

		const mutations = [
			() =>
				runtime.capabilities.registerTool({ name: "late-tool", servers: "closed" }, async () => ({
					content: [{ type: "text" as const, text: "late" }],
				})),
			() =>
				registration.replace(async () => ({
					content: [{ type: "text" as const, text: "replacement" }],
				})),
			() => registration.unregister(),
		] as const;

		for (const mutate of mutations) {
			const failure = captureThrown(mutate);
			expect(failure).toBeInstanceOf(McpModuleError);
			if (failure instanceof McpModuleError) expect(failure.code).toBe("RUNTIME_CLOSED");
		}
	});

	it("publishes targeted list changes exactly once and publishes nothing for rejected mutations", async () => {
		const gatewayClientToken = Symbol("NOTIFY_GATEWAY_CLIENT");
		application = await bootstrapMcp(
			[
				serverDefinition("notify-alpha"),
				serverDefinition("notify-beta"),
				serverDefinition("notify-other"),
				{
					...serverDefinition("notify-gateway"),
					gateway: {
						upstreams: [
							{
								name: "empty",
								clientProvider: gatewayClientToken,
							},
						],
						policy: ALLOW_ALL_GATEWAY_POLICY,
					},
				},
			],
			[],
			{
				autoDiscover: false,
				collaborators: [
					ALLOW_ALL_GATEWAY_POLICY_PROVIDER,
					{
						provide: gatewayClientToken,
						useValue: {
							resolveClient: () => ({
								listTools: () => ({ tools: [] }),
								callTool: () => ({ content: [] }),
							}),
						},
					},
				],
			},
		);
		const capabilities = application.get(McpRuntimeService).capabilities;
		const runtime = application.get(McpRuntimeService);
		const alphaChanges = spyListChanges(runtime.server("notify-alpha"));
		const betaChanges = spyListChanges(runtime.server("notify-beta"));
		const otherChanges = spyListChanges(runtime.server("notify-other"));
		const gatewayChanges = spyListChanges(runtime.server("notify-gateway"));
		const allChanges = [alphaChanges, betaChanges, otherChanges, gatewayChanges] as const;

		const tool = capabilities.registerTool(
			{ name: "notified-tool", servers: ["notify-alpha", "notify-beta"] },
			async () => ({ content: [{ type: "text" as const, text: "tool-one" }] }),
		);
		expect(alphaChanges.tools).toHaveBeenCalledOnce();
		expect(betaChanges.tools).toHaveBeenCalledOnce();
		expect(tool.replace(async () => ({ content: [{ type: "text", text: "tool-two" }] }))).toBe(
			true,
		);
		expect(alphaChanges.tools).toHaveBeenCalledTimes(2);
		expect(betaChanges.tools).toHaveBeenCalledTimes(2);
		expect(tool.unregister()).toBe(true);
		expect(alphaChanges.tools).toHaveBeenCalledTimes(3);
		expect(betaChanges.tools).toHaveBeenCalledTimes(3);

		const prompt = capabilities.registerPrompt(
			{ name: "notified-prompt", servers: "notify-beta" },
			async () => ({
				messages: [
					{ role: "user" as const, content: { type: "text" as const, text: "prompt-one" } },
				],
			}),
		);
		expect(betaChanges.prompts).toHaveBeenCalledOnce();
		expect(
			prompt.replace(async () => ({
				messages: [
					{ role: "user" as const, content: { type: "text" as const, text: "prompt-two" } },
				],
			})),
		).toBe(true);
		expect(betaChanges.prompts).toHaveBeenCalledTimes(2);
		expect(prompt.unregister()).toBe(true);
		expect(betaChanges.prompts).toHaveBeenCalledTimes(3);

		const resource = capabilities.registerResource(
			{ name: "notified-resource", uri: "docs://notify/resource", servers: "notify-alpha" },
			async (uri) => ({ contents: [{ uri: uri.href, text: "resource-one" }] }),
		);
		expect(alphaChanges.resources).toHaveBeenCalledOnce();
		expect(
			resource.replace(async (uri) => ({
				contents: [{ uri: uri.href, text: "resource-two" }],
			})),
		).toBe(true);
		expect(alphaChanges.resources).toHaveBeenCalledTimes(2);
		expect(resource.unregister()).toBe(true);
		expect(alphaChanges.resources).toHaveBeenCalledTimes(3);

		expect(alphaChanges.prompts).not.toHaveBeenCalled();
		expect(alphaChanges.resources).toHaveBeenCalledTimes(3);
		expect(betaChanges.tools).toHaveBeenCalledTimes(3);
		expect(betaChanges.resources).not.toHaveBeenCalled();
		expectNoListChanges(otherChanges);
		expectNoListChanges(gatewayChanges);

		capabilities.registerTool({ name: "duplicate-tool", servers: "notify-alpha" }, async () => ({
			content: [{ type: "text" as const, text: "first" }],
		}));
		clearListChanges(...allChanges);

		expect(() =>
			capabilities.registerTool({ name: "duplicate-tool", servers: "notify-alpha" }, async () => ({
				content: [{ type: "text" as const, text: "duplicate" }],
			})),
		).toThrow(/Duplicate MCP tool registration/);
		expect(() =>
			capabilities.registerPrompt(
				{ name: "unknown-prompt", servers: "not-configured" },
				async () => ({ messages: [] }),
			),
		).toThrow(/targets unknown server "not-configured"/);
		expect(() =>
			capabilities.registerResource(
				{
					name: "gateway-resource",
					uri: "docs://notify/gateway",
					servers: "notify-gateway",
				},
				async (uri) => ({ contents: [{ uri: uri.href, text: "rejected" }] }),
			),
		).toThrow(/gateway server "notify-gateway" must be dedicated/);
		expect(() =>
			capabilities.registerTool({ name: "empty-targets", servers: [] }, async () => ({
				content: [],
			})),
		).toThrow(/at least one server name/);
		expect(() =>
			capabilities.registerTool(
				{ name: "duplicate-targets", servers: ["notify-alpha", "notify-alpha"] },
				async () => ({ content: [] }),
			),
		).toThrow(/must not contain duplicates/);

		for (const changes of allChanges) expectNoListChanges(changes);
	});
});

function serverDefinition(name: string): McpNestServerDefinition {
	return {
		name,
		serverInfo: { name, version: "1.0.0" },
	};
}

async function bootstrapMcp(
	servers: readonly McpNestServerDefinition[],
	providers: readonly import("@nestjs/common").Provider[],
	options: {
		readonly autoDiscover?: boolean;
		readonly collaborators?: import("@nestjs/common").Provider[];
	} = {},
): Promise<INestApplication> {
	const { autoDiscover = true, collaborators = [] } = options;
	const testingModule = await Test.createTestingModule({
		imports: [
			McpModule.forRoot({
				servers,
				autoDiscover,
				collaborators: { providers: collaborators },
			}),
		],
		providers: [...providers],
	}).compile();
	const application = testingModule.createNestApplication();
	await application.init();
	return application;
}

interface BuiltServerSession {
	readonly client: Client;
	readonly server: McpServer;
	close(): Promise<void>;
}

function spyListChanges(runtime: McpServerRuntime) {
	return {
		tools: vi.spyOn(runtime.notify, "toolsChanged"),
		prompts: vi.spyOn(runtime.notify, "promptsChanged"),
		resources: vi.spyOn(runtime.notify, "resourcesChanged"),
	};
}

type ListChangeSpies = ReturnType<typeof spyListChanges>;

function clearListChanges(...groups: readonly ListChangeSpies[]): void {
	for (const group of groups) {
		group.tools.mockClear();
		group.prompts.mockClear();
		group.resources.mockClear();
	}
}

function expectNoListChanges(group: ListChangeSpies): void {
	expect(group.tools).not.toHaveBeenCalled();
	expect(group.prompts).not.toHaveBeenCalled();
	expect(group.resources).not.toHaveBeenCalled();
}

async function connectFreshBuild(runtime: McpServerRuntime): Promise<BuiltServerSession> {
	const server = await runtime.createServer({ era: "modern" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client(
		{ name: "capability-registry-test", version: "1.0.0" },
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

async function captureFailure(task: Promise<unknown>): Promise<unknown> {
	try {
		await task;
		return undefined;
	} catch (error) {
		return error;
	}
}

function captureThrown(action: () => unknown): unknown {
	try {
		return action();
	} catch (error) {
		return error;
	}
}

async function expectVisibilityBuildFailure(
	runtime: McpServerRuntime,
	messageFragment: string,
): Promise<void> {
	const failure = await captureFailure(runtime.createServer({ era: "modern" }));
	expect(failure).toBeInstanceOf(McpModuleError);
	if (!(failure instanceof McpModuleError)) return;
	expect(failure.code).toBe("INVALID_VISIBILITY_POLICY");
	expect(failure.message).toContain(messageFragment);
}
