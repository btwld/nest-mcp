import { METHOD_NOT_FOUND, ProtocolError, type Tool } from "@modelcontextprotocol/client";
import { Test } from "@nestjs/testing";
import { MCP_CLIENT_LEASE_INVALIDATED, McpClientRuntime } from "@nest-mcp/client";
import { runMcpConformancePlan, type McpConformanceCheckReport } from "@nest-mcp/conformance";
import {
	MCP_RUNTIME_GENERATION_RETIRED,
	McpRuntimeManagerError,
	type McpManagedClientRuntime,
	type McpManagedClientRuntimeOperation,
} from "@nest-mcp/manager";
import { describe, expect, it, vi } from "vitest";

import { ControlPlaneConfigService } from "../src/config/control-plane-config.service.ts";
import { ConformanceRunRepository } from "../src/conformance/conformance.repository.ts";
import { ConformanceService } from "../src/conformance/conformance.service.ts";
import {
	createSafeDiscoveryTarget,
	SAFE_DISCOVERY_PLAN,
} from "../src/conformance/safe-discovery.plan.ts";
import { ConnectionRepository } from "../src/connections/connection.repository.ts";
import { VolatileOAuthAuthorityService } from "../src/oauth/volatile-oauth-authority.service.ts";
import { MCP_RUNTIME_SUPERVISOR } from "../src/runtime/runtime.types.ts";

describe("safe discovery conformance", () => {
	it("aggregates exact pages, tolerates absent resource-template support, and redacts catalog data", async () => {
		const requests: { readonly method: string; readonly cursor?: string }[] = [];
		const runtime = fakeManagedRuntime(async (request) => {
			const cursor = readCursor(request);
			requests.push(
				cursor === undefined ? { method: request.method } : { method: request.method, cursor },
			);
			switch (request.method) {
				case "ping":
					return {};
				case "tools/list":
					return cursor === undefined
						? { tools: [validTool("hidden-tool")], nextCursor: "tools-2" }
						: {
								tools: [
									{
										...validTool("hidden-tool"),
										outputSchema: {
											$schema: "http://json-schema.org/draft-07/schema#",
											type: "object",
										},
									},
									{
										name: "oversized-schema",
										inputSchema: { type: "object", privateValue: "x".repeat(262_145) },
									},
								],
							};
				case "resources/list":
					return { resources: [] };
				case "resources/templates/list":
					throw new ProtocolError(METHOD_NOT_FOUND, "private upstream message");
				case "prompts/list":
					return { prompts: [] };
				default:
					throw new TypeError("unexpected request");
			}
		});
		const controller = new AbortController();
		const report = await runMcpConformancePlan(SAFE_DISCOVERY_PLAN, {
			target: createSafeDiscoveryTarget({
				runtime,
				serverName: "private-runtime-name",
				leaseSignal: controller.signal,
				maxPages: 4,
				maxItems: 10,
			}),
			runId: "00000000-0000-4000-8000-000000000001",
			descriptor: {
				target: { kind: "connection", id: "00000000-0000-4000-8000-000000000002" },
				subject: { name: "@nest-mcp/nestjs", version: "test" },
			},
		});

		expect(check(report.checks, "catalog.discovery")).toMatchObject({
			status: "pass",
			code: "CATALOG_DISCOVERED",
			facts: { toolCount: 3, resourceTemplateCount: 0 },
		});
		expect(check(report.checks, "catalog.identities")).toMatchObject({
			status: "fail",
			code: "CATALOG_IDENTITIES_DUPLICATED",
			facts: { duplicateCount: 1 },
		});
		expect(check(report.checks, "tools.schemas")).toMatchObject({
			status: "fail",
			code: "TOOL_SCHEMAS_INVALID",
			facts: { invalidInputSchemas: 1, invalidOutputSchemas: 1 },
		});
		expect(check(report.checks, "catalog.digest")).toMatchObject({
			status: "error",
			code: "CATALOG_DIGEST_ERROR",
		});
		expect(requests.filter(({ method }) => method === "tools/list")).toEqual([
			{ method: "tools/list" },
			{ method: "tools/list", cursor: "tools-2" },
		]);
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("private-runtime-name");
		expect(serialized).not.toContain("private upstream message");
		expect(serialized).not.toContain("hidden-tool");
		expect(serialized).not.toContain("draft-07");
		expect(serialized).not.toContain("privateValue");
	});

	it("stops schema compilation at the aggregate inspection budget", async () => {
		const runtime = fakeManagedRuntime(async (request) => {
			switch (request.method) {
				case "ping":
					return {};
				case "tools/list":
					return {
						tools: Array.from({ length: 257 }, (_, index) => validTool(`tool-${String(index)}`)),
					};
				case "resources/list":
					return { resources: [] };
				case "resources/templates/list":
					return { resourceTemplates: [] };
				case "prompts/list":
					return { prompts: [] };
				default:
					throw new TypeError("unexpected request");
			}
		});
		const report = await runMcpConformancePlan(SAFE_DISCOVERY_PLAN, {
			target: createSafeDiscoveryTarget({
				runtime,
				serverName: "bounded",
				leaseSignal: new AbortController().signal,
				maxPages: 4,
				maxItems: 300,
			}),
			runId: "00000000-0000-4000-8000-000000000003",
			descriptor: {
				target: { kind: "connection", id: "00000000-0000-4000-8000-000000000004" },
				subject: { name: "@nest-mcp/nestjs", version: "test" },
			},
		});

		expect(check(report.checks, "tools.schemas")).toMatchObject({
			status: "error",
			code: "TOOL_SCHEMA_BUDGET_EXCEEDED",
			facts: { inspectedSchemaCount: 257 },
		});
		expect(check(report.checks, "catalog.digest")).toMatchObject({
			status: "pass",
			code: "CATALOG_DIGESTED",
			facts: { catalogDigest: expect.stringMatching(/^sha256:[A-Za-z0-9_-]{43}$/u) },
		});
	});

	it("rejects oversized catalog metadata before sorting or fingerprinting it", async () => {
		const runtime = fakeManagedRuntime(async (request) => {
			switch (request.method) {
				case "ping":
					return {};
				case "tools/list":
					return {
						tools: [{ ...validTool("bounded-tool"), description: "sensitive".repeat(131_073) }],
					};
				case "resources/list":
					return { resources: [] };
				case "resources/templates/list":
					return { resourceTemplates: [] };
				case "prompts/list":
					return { prompts: [] };
				default:
					throw new TypeError("unexpected request");
			}
		});
		const report = await runMcpConformancePlan(SAFE_DISCOVERY_PLAN, {
			target: createSafeDiscoveryTarget({
				runtime,
				serverName: "bounded",
				leaseSignal: new AbortController().signal,
				maxPages: 4,
				maxItems: 10,
			}),
			runId: "00000000-0000-4000-8000-000000000005",
			descriptor: {
				target: { kind: "connection", id: "00000000-0000-4000-8000-000000000006" },
				subject: { name: "@nest-mcp/nestjs", version: "test" },
			},
		});

		expect(check(report.checks, "catalog.discovery")).toMatchObject({
			status: "error",
			code: "CATALOG_DISCOVERY_ERROR",
		});
		expect(check(report.checks, "catalog.digest")).toMatchObject({
			status: "error",
			code: "CATALOG_DIGEST_ERROR",
		});
		expect(JSON.stringify(report)).not.toContain("sensitive");
	});
});

describe("ConformanceService", () => {
	it("pins the full runner lease and accepts a report only for the exact live revision", async () => {
		const connections = new ConnectionRepository();
		const connection = connections.create({
			displayName: "Conformance target",
			endpoint: "https://private.example.test/mcp",
			endpointHost: "private.example.test",
			authenticationKind: "none",
			desiredState: "online",
		});
		const managedRuntime = fakeManagedRuntime(async (request, signal) => {
			signal?.throwIfAborted();
			return emptyResponse(request.method);
		});
		let mutateAfterLease = false;
		let leaseAbort: "none" | "retired" | "timeout" = "none";
		let retireBeforeLease = false;
		const config = {
			requestTimeoutMs: 10_000,
			maxDiscoveryPages: 4,
			maxDiscoveryItems: 10,
		};
		const withClientRuntime = vi.fn(
			async <Result>(
				generationKey: string,
				operation: McpManagedClientRuntimeOperation<Result>,
			): Promise<Result> => {
				expect(generationKey).toBe(connection.generationKey);
				if (retireBeforeLease) {
					throw new McpRuntimeManagerError(
						MCP_RUNTIME_GENERATION_RETIRED,
						"private generation detail",
					);
				}
				const leaseController = new AbortController();
				if (leaseAbort === "retired") {
					leaseController.abort({ code: MCP_CLIENT_LEASE_INVALIDATED });
				}
				if (leaseAbort === "timeout") {
					leaseController.abort(new DOMException("manager deadline", "TimeoutError"));
				}
				const result = await operation({
					runtime: managedRuntime,
					serverName: "must-never-leak",
					signal: leaseController.signal,
				});
				if (mutateAfterLease) {
					connections.setDesiredState(connection.id, connection.revision, "online");
				}
				return result;
			},
		);
		const module = await Test.createTestingModule({
			providers: [
				ConformanceService,
				ConformanceRunRepository,
				{ provide: ConnectionRepository, useValue: connections },
				{
					provide: MCP_RUNTIME_SUPERVISOR,
					useValue: {
						state: () => ({ phase: "online", lastTransitionAt: new Date().toISOString() }),
						withClientRuntime,
					},
				},
				{ provide: VolatileOAuthAuthorityService, useValue: { isAuthorized: () => false } },
				{
					provide: ControlPlaneConfigService,
					useValue: config,
				},
			],
		}).compile();
		const service = module.get(ConformanceService);

		const queued = service.start({
			target: {
				kind: "connection",
				connectionId: connection.id,
				expectedRevision: connection.revision,
				runtimeGeneration: connection.runtimeGeneration,
			},
		});
		expect(queued.status).toBe("queued");
		const completed = await waitForTerminal(service, queued.runId);
		expect(completed).toMatchObject({
			status: "completed",
			report: { completion: "completed", verdict: "pass" },
		});
		expect(completed.report?.descriptor.subject).toMatchObject({
			name: "@nest-mcp/nestjs",
			version: expect.not.stringMatching(/^workspace$/u),
		});
		expect(withClientRuntime).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(completed)).not.toMatch(
			/private\.example\.test|must-never-leak|generationKey|serverName/u,
		);

		expect(() =>
			service.start({
				target: {
					kind: "connection",
					connectionId: connection.id,
					expectedRevision: connection.revision + 1,
					runtimeGeneration: connection.runtimeGeneration,
				},
			}),
		).toThrowError(expect.objectContaining({ code: "MCP_REVISION_CONFLICT" }));

		mutateAfterLease = true;
		const staleRun = service.start({
			target: {
				kind: "connection",
				connectionId: connection.id,
				expectedRevision: connection.revision,
				runtimeGeneration: connection.runtimeGeneration,
			},
		});
		const stale = await waitForTerminal(service, staleRun.runId);
		expect(stale).toMatchObject({
			status: "failed",
			errorCode: "MCP_CONFORMANCE_TARGET_CHANGED",
		});
		expect(stale.report).toBeUndefined();

		mutateAfterLease = false;
		leaseAbort = "retired";
		const current = connections.get(connection.id);
		const retiredRun = service.start({
			target: {
				kind: "connection",
				connectionId: current.id,
				expectedRevision: current.revision,
				runtimeGeneration: current.runtimeGeneration,
			},
		});
		const retired = await waitForTerminal(service, retiredRun.runId);
		expect(retired).toMatchObject({
			status: "failed",
			errorCode: "MCP_CONFORMANCE_TARGET_CHANGED",
		});
		expect(retired.report).toBeUndefined();

		leaseAbort = "none";
		retireBeforeLease = true;
		const acquisitionRaceRun = service.start({
			target: {
				kind: "connection",
				connectionId: current.id,
				expectedRevision: current.revision,
				runtimeGeneration: current.runtimeGeneration,
			},
		});
		const acquisitionRace = await waitForTerminal(service, acquisitionRaceRun.runId);
		expect(acquisitionRace).toMatchObject({
			status: "failed",
			errorCode: "MCP_CONFORMANCE_TARGET_CHANGED",
		});
		expect(JSON.stringify(acquisitionRace)).not.toContain("private generation detail");

		retireBeforeLease = false;
		leaseAbort = "timeout";
		config.requestTimeoutMs = 100;
		const timedOutRun = service.start({
			target: {
				kind: "connection",
				connectionId: current.id,
				expectedRevision: current.revision,
				runtimeGeneration: current.runtimeGeneration,
			},
		});
		const timedOut = await waitForTerminal(service, timedOutRun.runId);
		expect(timedOut).toMatchObject({
			status: "failed",
			errorCode: "MCP_CONFORMANCE_RUN_FAILED",
		});
		expect(timedOut.errorCode).not.toBe("MCP_CONFORMANCE_TARGET_CHANGED");
	});

	it("makes cancellation idempotent and releases the active generation slot", async () => {
		const connections = new ConnectionRepository();
		const connection = connections.create({
			displayName: "Cancelled target",
			endpoint: "https://cancel.example.test/mcp",
			endpointHost: "cancel.example.test",
			authenticationKind: "none",
			desiredState: "online",
		});
		let pingSettled = false;
		const managedRuntime = fakeManagedRuntime(async (request, signal) => {
			if (request.method !== "ping") return emptyResponse(request.method);
			return await new Promise<never>((_resolve, reject) => {
				const onAbort = (): void => {
					pingSettled = true;
					reject(signal?.reason);
				};
				if (signal?.aborted === true) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		});
		const module = await Test.createTestingModule({
			providers: [
				ConformanceService,
				ConformanceRunRepository,
				{ provide: ConnectionRepository, useValue: connections },
				{
					provide: MCP_RUNTIME_SUPERVISOR,
					useValue: {
						state: () => ({ phase: "online", lastTransitionAt: new Date().toISOString() }),
						withClientRuntime: async <Result>(
							_generationKey: string,
							operation: McpManagedClientRuntimeOperation<Result>,
							callerSignal: AbortSignal,
						) =>
							operation({
								runtime: managedRuntime,
								serverName: "cancelled",
								signal: callerSignal,
							}),
					},
				},
				{ provide: VolatileOAuthAuthorityService, useValue: { isAuthorized: () => false } },
				{
					provide: ControlPlaneConfigService,
					useValue: {
						requestTimeoutMs: 10_000,
						maxDiscoveryPages: 4,
						maxDiscoveryItems: 10,
					},
				},
			],
		}).compile();
		const service = module.get(ConformanceService);
		const run = service.start({
			target: {
				kind: "connection",
				connectionId: connection.id,
				expectedRevision: connection.revision,
				runtimeGeneration: connection.runtimeGeneration,
			},
		});
		await waitForStatus(service, run.runId, "running");
		expect(service.cancel(run.runId).status).toBe("cancelling");
		expect(service.cancel(run.runId).status).toBe("cancelling");
		expect((await waitForTerminal(service, run.runId)).status).toBe("cancelled");
		expect(pingSettled).toBe(true);
		expect(service.cancel(run.runId).status).toBe("cancelled");
	});
});

function fakeManagedRuntime(
	request: (
		request: { readonly method: string; readonly params?: unknown },
		signal?: AbortSignal,
	) => Promise<unknown>,
): McpManagedClientRuntime {
	const runtime = new McpClientRuntime();
	Reflect.set(runtime, "snapshot", () => ({
		name: "private",
		state: "connected",
		transportKind: "streamable-http",
		negotiatedProtocolVersion: "2026-07-28",
		protocolEra: "modern",
		serverCapabilities: { tools: {}, resources: {}, prompts: {} },
	}));
	Reflect.set(
		runtime,
		"request",
		async (
			_serverName: string,
			protocolRequest: { readonly method: string },
			options?: { readonly signal?: AbortSignal },
		) => request(protocolRequest, options?.signal),
	);
	return runtime;
}

function validTool(name: string): Tool {
	return { name, inputSchema: { type: "object", additionalProperties: false } };
}

function readCursor(request: { readonly params?: unknown }): string | undefined {
	if (
		typeof request.params !== "object" ||
		request.params === null ||
		!("cursor" in request.params)
	) {
		return undefined;
	}
	const cursor = request.params.cursor;
	return typeof cursor === "string" ? cursor : undefined;
}

function emptyResponse(method: string): unknown {
	switch (method) {
		case "ping":
			return {};
		case "tools/list":
			return { tools: [] };
		case "resources/list":
			return { resources: [] };
		case "resources/templates/list":
			return { resourceTemplates: [] };
		case "prompts/list":
			return { prompts: [] };
		default:
			throw new TypeError("unexpected request");
	}
}

function check(
	checks: readonly McpConformanceCheckReport[],
	id: string,
): McpConformanceCheckReport {
	const result = checks.find((entry) => entry.id === id);
	if (result === undefined) throw new TypeError(`Missing check ${id}.`);
	return result;
}

async function waitForTerminal(service: ConformanceService, runId: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const run = service.get(runId);
		if (["completed", "cancelled", "timed-out", "failed"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Conformance run did not settle.");
}

async function waitForStatus(
	service: ConformanceService,
	runId: string,
	status: "running",
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (service.get(runId).status === status) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error(`Conformance run did not reach ${status}.`);
}
