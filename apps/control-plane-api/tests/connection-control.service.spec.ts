import { Test } from "@nestjs/testing";
import type { CallToolResult } from "@nest-mcp/client";
import type { McpRuntimeToolCallOptions } from "@nest-mcp/manager";
import type { Tool } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { ControlPlaneError } from "../src/common/control-plane.error.ts";
import { ConnectionControlService } from "../src/connections/connection-control.service.ts";
import { ConnectionLifecycleCoordinator } from "../src/connections/connection-lifecycle.coordinator.ts";
import { ConnectionRepository } from "../src/connections/connection.repository.ts";
import { HubService } from "../src/hub/hub.service.ts";
import { VolatileOAuthAuthorityService } from "../src/oauth/volatile-oauth-authority.service.ts";
import { McpEndpointAdmissionService } from "../src/runtime/mcp-endpoint-admission.service.ts";
import { MCP_RUNTIME_SUPERVISOR, type RuntimeStateView } from "../src/runtime/runtime.types.ts";

describe("ConnectionControlService", () => {
	it("removes retired generations from authority before runtime drain begins", async () => {
		const repository = new ConnectionRepository();
		const detachConnection = vi.fn(async (connectionId: string) => {
			const current = repository.get(connectionId);
			expect(repository.resolveGeneration(current.generationKey)).toBe(current);
		});
		const retire = vi.fn(async (generationKey: string) => {
			expect(() => repository.resolveGeneration(generationKey)).toThrowError(
				expect.objectContaining({ code: "MCP_GENERATION_RETIRED" }),
			);
		});
		const module = await Test.createTestingModule({
			providers: [
				ConnectionControlService,
				ConnectionLifecycleCoordinator,
				{ provide: HubService, useValue: { detachConnection } },
				{ provide: ConnectionRepository, useValue: repository },
				{ provide: McpEndpointAdmissionService, useValue: endpointAdmission() },
				{ provide: VolatileOAuthAuthorityService, useValue: oauthAuthority() },
				{
					provide: MCP_RUNTIME_SUPERVISOR,
					useValue: {
						retire,
						state: () => runtimeState("offline"),
					},
				},
			],
		}).compile();
		const service = module.get(ConnectionControlService);
		const created = await service.create({
			displayName: "Fenced upstream",
			endpoint: "https://mcp.example.test/v1",
			desiredState: "offline",
		});
		const replaced = await service.replace(created.id, created.revision, {
			displayName: created.displayName,
			endpoint: "https://mcp.example.test/v2",
		});

		expect(replaced.runtimeGeneration).toBe(2);
		expect(detachConnection).toHaveBeenCalledTimes(1);
		expect(retire).toHaveBeenCalledTimes(1);
		expect(() =>
			repository.putCatalog({
				connectionId: replaced.id,
				runtimeGeneration: 1,
				discoveredAt: new Date().toISOString(),
				tools: [],
				resources: [],
				resourceTemplates: [],
				prompts: [],
			}),
		).toThrowError(expect.objectContaining({ code: "MCP_GENERATION_RETIRED" }));
		await service.remove(replaced.id, replaced.revision);
		expect(detachConnection).toHaveBeenCalledTimes(2);
		expect(retire).toHaveBeenCalledTimes(2);
	});

	it("retains a fenced tombstone when deletion cleanup is quarantined", async () => {
		const states = new Map<string, RuntimeStateView>();
		const retire = vi.fn(async (generationKey: string) => {
			states.set(generationKey, runtimeState("quarantined"));
			throw new ControlPlaneError("MCP_QUARANTINED", 503, "The runtime generation is quarantined.");
		});
		const module = await Test.createTestingModule({
			providers: [
				ConnectionControlService,
				ConnectionLifecycleCoordinator,
				{ provide: HubService, useValue: hubLifecycle() },
				ConnectionRepository,
				{ provide: McpEndpointAdmissionService, useValue: endpointAdmission() },
				{ provide: VolatileOAuthAuthorityService, useValue: oauthAuthority() },
				{
					provide: MCP_RUNTIME_SUPERVISOR,
					useValue: {
						retire,
						state: (generationKey: string) => states.get(generationKey) ?? runtimeState("offline"),
					},
				},
			],
		}).compile();
		const service = module.get(ConnectionControlService);
		const created = await service.create({
			displayName: "Quarantined upstream",
			endpoint: "https://mcp.example.test/service",
			desiredState: "offline",
		});

		await expect(service.remove(created.id, created.revision)).rejects.toMatchObject({
			code: "MCP_QUARANTINED",
		});
		expect(service.get(created.id)).toMatchObject({
			revision: 2,
			desiredState: "offline",
			deletionPending: true,
			runtime: { phase: "quarantined" },
		});
		await expect(
			service.create({
				displayName: "Quarantined upstream",
				endpoint: "https://mcp.example.test/reuse",
				desiredState: "offline",
			}),
		).rejects.toMatchObject({ code: "MCP_CONNECTION_EXISTS" });
	});

	it("serializes desired-state mutations while an earlier generation is draining", async () => {
		const offlineStarted = deferred();
		const allowOfflineToFinish = deferred();
		const states = new Map<string, RuntimeStateView>();
		const ensureOnline = vi.fn(async (generationKey: string) => {
			const state = runtimeState("online");
			states.set(generationKey, state);
			return state;
		});
		const setOffline = vi.fn(async (generationKey: string) => {
			states.set(generationKey, runtimeState("draining"));
			offlineStarted.resolve();
			await allowOfflineToFinish.promise;
			const state = runtimeState("offline");
			states.set(generationKey, state);
			return state;
		});
		const module = await Test.createTestingModule({
			providers: [
				ConnectionControlService,
				ConnectionLifecycleCoordinator,
				{ provide: HubService, useValue: hubLifecycle() },
				ConnectionRepository,
				{ provide: McpEndpointAdmissionService, useValue: endpointAdmission() },
				{ provide: VolatileOAuthAuthorityService, useValue: oauthAuthority() },
				{
					provide: MCP_RUNTIME_SUPERVISOR,
					useValue: {
						ensureOnline,
						setOffline,
						state: (generationKey: string) => states.get(generationKey) ?? runtimeState("offline"),
					},
				},
			],
		}).compile();
		const service = module.get(ConnectionControlService);
		const connection = await service.create({
			displayName: "Serialized upstream",
			endpoint: "https://mcp.example.test/service",
			desiredState: "online",
		});

		const goingOffline = service.setDesiredState(connection.id, connection.revision, "offline");
		await offlineStarted.promise;
		const draining = service.get(connection.id);
		expect(draining).toMatchObject({ revision: 2, desiredState: "offline" });

		const goingOnline = service.setDesiredState(connection.id, draining.revision, "online");
		await Promise.resolve();
		expect(ensureOnline).toHaveBeenCalledTimes(1);
		expect(service.get(connection.id)).toMatchObject({
			revision: 2,
			desiredState: "offline",
		});

		allowOfflineToFinish.resolve();
		const [offline, online] = await Promise.all([goingOffline, goingOnline]);
		expect(offline).toMatchObject({ revision: 2, desiredState: "offline" });
		expect(online).toMatchObject({
			revision: 3,
			desiredState: "online",
			runtime: { phase: "online" },
		});
		expect(ensureOnline).toHaveBeenCalledTimes(2);
	});

	it("validates arguments and invokes the pinned generation with its catalog definition", async () => {
		const repository = new ConnectionRepository();
		let runtimeCall:
			| {
					readonly generationKey: string;
					readonly name: string;
					readonly arguments: Readonly<Record<string, unknown>>;
					readonly options: McpRuntimeToolCallOptions;
			  }
			| undefined;
		const callTool = vi.fn(
			async (
				generationKey: string,
				name: string,
				arguments_: Readonly<Record<string, unknown>>,
				options?: AbortSignal | McpRuntimeToolCallOptions,
			): Promise<CallToolResult> => {
				if (options === undefined || options instanceof AbortSignal) {
					throw new TypeError("the control plane must pin the catalog definition on every call");
				}
				runtimeCall = Object.freeze({ generationKey, name, arguments: arguments_, options });
				return {
					content: [{ type: "text", text: "accepted" }],
					structuredContent: { accepted: true },
				};
			},
		);
		const module = await Test.createTestingModule({
			providers: [
				ConnectionControlService,
				ConnectionLifecycleCoordinator,
				{ provide: HubService, useValue: hubLifecycle() },
				{ provide: ConnectionRepository, useValue: repository },
				{ provide: McpEndpointAdmissionService, useValue: endpointAdmission() },
				{ provide: VolatileOAuthAuthorityService, useValue: oauthAuthority() },
				{
					provide: MCP_RUNTIME_SUPERVISOR,
					useValue: {
						ensureOnline: async () => runtimeState("online"),
						state: () => runtimeState("online"),
						callTool,
					},
				},
			],
		}).compile();
		const service = module.get(ConnectionControlService);
		const connection = await service.create({
			displayName: "Pinned upstream",
			endpoint: "https://mcp.example.test/service",
			desiredState: "online",
		});
		const discoveredTool = {
			name: "count",
			description: "catalog-v1",
			inputSchema: {
				type: "object",
				properties: { count: { type: "integer", minimum: 1 } },
				required: ["count"],
				additionalProperties: false,
			},
			outputSchema: {
				type: "object",
				properties: { accepted: { type: "boolean" } },
				required: ["accepted"],
				additionalProperties: false,
			},
		} satisfies Tool;
		repository.putCatalog({
			connectionId: connection.id,
			runtimeGeneration: connection.runtimeGeneration,
			discoveredAt: "2026-08-22T00:00:00.000Z",
			tools: [discoveredTool],
			resources: [],
			resourceTemplates: [],
			prompts: [],
		});

		await expect(service.callTool(connection.id, "count", { count: "one" })).rejects.toMatchObject({
			code: "MCP_TOOL_ARGUMENTS_INVALID",
			status: 422,
		});
		await expect(
			service.callTool(connection.id, "count", { count: 2, [Symbol("hostile")]: true }),
		).rejects.toMatchObject({
			code: "MCP_TOOL_ARGUMENTS_INVALID",
			status: 422,
		});
		expect(runtimeCall).toBeUndefined();

		const invocation = service.callTool(connection.id, "count", { count: 2 });
		Reflect.set(discoveredTool, "description", "mutated-after-invocation");
		Reflect.set(discoveredTool.inputSchema.properties.count, "type", "string");
		repository.replace(connection.id, connection.revision, {
			displayName: connection.displayName,
			endpoint: "https://mcp.example.test/replacement",
			endpointHost: "mcp.example.test",
		});

		await expect(invocation).resolves.toMatchObject({
			content: [{ type: "text", text: "accepted" }],
			structuredContent: { accepted: true },
		});
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(runtimeCall).toEqual({
			generationKey: `control-plane-mcp/v1/${connection.id}/${String(connection.runtimeGeneration)}`,
			name: "count",
			arguments: { count: 2 },
			options: {
				toolDefinition: {
					name: "count",
					description: "catalog-v1",
					inputSchema: {
						type: "object",
						properties: { count: { type: "integer", minimum: 1 } },
						required: ["count"],
						additionalProperties: false,
					},
					outputSchema: discoveredTool.outputSchema,
				},
			},
		});
		expect(Object.isFrozen(runtimeCall?.arguments)).toBe(true);
		expect(runtimeCall?.options.toolDefinition).not.toBe(discoveredTool);
	});

	it("rejects missing tools and uncompileable discovered input schemas before execution", async () => {
		const repository = new ConnectionRepository();
		const callTool = vi.fn();
		const module = await Test.createTestingModule({
			providers: [
				ConnectionControlService,
				ConnectionLifecycleCoordinator,
				{ provide: HubService, useValue: hubLifecycle() },
				{ provide: ConnectionRepository, useValue: repository },
				{ provide: McpEndpointAdmissionService, useValue: endpointAdmission() },
				{ provide: VolatileOAuthAuthorityService, useValue: oauthAuthority() },
				{
					provide: MCP_RUNTIME_SUPERVISOR,
					useValue: {
						ensureOnline: async () => runtimeState("online"),
						state: () => runtimeState("online"),
						callTool,
					},
				},
			],
		}).compile();
		const service = module.get(ConnectionControlService);
		const connection = await service.create({
			displayName: "Invalid catalog upstream",
			endpoint: "https://mcp.example.test/service",
			desiredState: "online",
		});

		await expect(service.callTool(connection.id, "missing", {})).rejects.toMatchObject({
			code: "MCP_NOT_READY",
			status: 409,
		});

		repository.putCatalog({
			connectionId: connection.id,
			runtimeGeneration: connection.runtimeGeneration,
			discoveredAt: "2026-08-22T00:00:00.000Z",
			tools: [
				{
					name: "invalid-schema",
					inputSchema: {
						$schema: "http://json-schema.org/draft-07/schema#",
						type: "object",
					},
				} satisfies Tool,
			],
			resources: [],
			resourceTemplates: [],
			prompts: [],
		});

		await expect(service.callTool(connection.id, "missing", {})).rejects.toMatchObject({
			code: "MCP_TOOL_NOT_FOUND",
			status: 404,
		});
		await expect(service.callTool(connection.id, "invalid-schema", {})).rejects.toMatchObject({
			code: "MCP_TOOL_SCHEMA_INVALID",
			status: 502,
		});
		expect(callTool).not.toHaveBeenCalled();
	});
});

function runtimeState(phase: RuntimeStateView["phase"]): RuntimeStateView {
	return Object.freeze({ phase, lastTransitionAt: new Date().toISOString() });
}

function endpointAdmission(): {
	admit(rawEndpoint: string): { readonly url: string; readonly host: string };
} {
	return {
		admit(rawEndpoint: string) {
			const endpoint = new URL(rawEndpoint);
			return Object.freeze({ url: endpoint.href, host: endpoint.host });
		},
	};
}

function hubLifecycle(): { detachConnection(connectionId: string): Promise<void> } {
	return { detachConnection: async () => undefined };
}

function oauthAuthority() {
	return {
		registerConnection: () => undefined,
		isAuthorized: () => false,
		view: () => ({
			kind: "oauth" as const,
			status: "authorization-required" as const,
			scopes: [],
		}),
		resetConnection: () => undefined,
		removeConnection: () => undefined,
	};
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
	let settle: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		settle = resolve;
	});
	return Object.freeze({
		promise,
		resolve(): void {
			settle?.();
		},
	});
}
