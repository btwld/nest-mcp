import { AsyncLocalStorage } from "node:async_hooks";
import { ProtocolError, ProtocolErrorCode, type Tool } from "@modelcontextprotocol/client";
import type { McpClientConnectionSnapshot, McpClientRuntimeOptions } from "@nest-mcp/client";
import type { McpLifecycleObserver } from "@nest-mcp/core";
import { afterEach, describe, expect, it, vi } from "vitest";

interface ControlledRuntimeInstance {
	readonly options: McpClientRuntimeOptions;
	readonly ping: ReturnType<typeof vi.fn>;
	readonly discover: ReturnType<typeof vi.fn>;
	readonly listTools: ReturnType<typeof vi.fn>;
	readonly listResources: ReturnType<typeof vi.fn>;
	readonly listResourceTemplates: ReturnType<typeof vi.fn>;
	readonly listPrompts: ReturnType<typeof vi.fn>;
	readonly callTool: ReturnType<typeof vi.fn>;
	connected: boolean;
	protocolEra: "legacy" | "modern";
	connectFailure: unknown;
}

const runtimeHarness = vi.hoisted(() => ({
	instances: [] as ControlledRuntimeInstance[],
	constructorFailure: undefined as unknown,
	callToolHook: undefined as ((signal: AbortSignal | undefined) => Promise<unknown>) | undefined,
	listToolsHook: undefined as (() => Promise<{ readonly tools: readonly [] }>) | undefined,
	listResourcesHook: undefined as (() => Promise<{ readonly resources: readonly [] }>) | undefined,
}));

vi.mock("@nest-mcp/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nest-mcp/client")>();
	class ControlledRuntime {
		readonly options: McpClientRuntimeOptions;
		readonly ping = vi.fn(async () => ({}));
		readonly discover = vi.fn(async () => ({}));
		readonly listTools = vi.fn(async () =>
			runtimeHarness.listToolsHook === undefined ? { tools: [] } : runtimeHarness.listToolsHook(),
		);
		readonly listResources = vi.fn(async () =>
			runtimeHarness.listResourcesHook === undefined
				? { resources: [] }
				: runtimeHarness.listResourcesHook(),
		);
		readonly listResourceTemplates = vi.fn(async () => ({ resourceTemplates: [] }));
		readonly listPrompts = vi.fn(async () => ({ prompts: [] }));
		readonly callTool = vi.fn(
			async (_name: string, _request: unknown, options?: { readonly signal?: AbortSignal }) => {
				if (runtimeHarness.callToolHook !== undefined) {
					return runtimeHarness.callToolHook(options?.signal);
				}
				return { content: [] };
			},
		);
		readonly readResource = vi.fn(async () => ({ contents: [] }));
		readonly getPrompt = vi.fn(async () => ({ messages: [] }));
		connected = false;
		protocolEra: "legacy" | "modern" = "modern";
		connectFailure: unknown;

		constructor(options: McpClientRuntimeOptions = {}) {
			if (runtimeHarness.constructorFailure !== undefined) {
				throw runtimeHarness.constructorFailure;
			}
			this.options = options;
			runtimeHarness.instances.push(this);
		}

		async connect(): Promise<void> {
			if (this.connectFailure !== undefined) throw this.connectFailure;
			this.connected = true;
		}

		snapshot(name: string): McpClientConnectionSnapshot {
			return {
				name,
				state: this.connected ? "connected" : "disconnected",
				transportKind: "http",
				...(this.connected ? { connectedAt: 1 } : {}),
				negotiatedProtocolVersion: "2025-11-25",
				protocolEra: this.protocolEra,
				serverCapabilities: {
					tools: {},
					resources: { subscribe: true },
					prompts: {},
					completions: {},
				},
			};
		}

		async close(): Promise<void> {
			this.connected = false;
		}
	}
	return { ...actual, McpClientRuntime: ControlledRuntime };
});

import {
	MCP_RUNTIME_LEASE_MODE_CONFLICT,
	McpRuntimeManager,
	mcpRuntimeCapabilitiesSnapshotSchema,
	mcpRuntimeProbeSnapshotSchema,
	mcpRuntimeStateSnapshotSchema,
	type McpAdmittedRuntimeGeneration,
	type McpRuntimeGenerationResolver,
	type McpRuntimeOperationOptions,
	type McpRuntimeStateSnapshot,
	type McpRuntimeStateTransitionEvent,
} from "../src/index.ts";

describe("McpRuntimeManager", () => {
	afterEach(() => {
		runtimeHarness.instances.length = 0;
		runtimeHarness.constructorFailure = undefined;
		runtimeHarness.callToolHook = undefined;
		runtimeHarness.listToolsHook = undefined;
		runtimeHarness.listResourcesHook = undefined;
		vi.restoreAllMocks();
	});

	it.each([4, 8])(
		"completes six reads with a %i-slot process budget and no connector ceiling",
		async (maxConnections) => {
			const finish = deferred();
			const manager = new McpRuntimeManager({
				generationResolver: resolverFrom(async () => admitted()),
				maxConnections,
			});
			const operation = vi.fn(async () => {
				await finish.promise;
				return "read";
			});
			const events: unknown[] = [];
			const calls = Array.from({ length: 6 }, () =>
				manager.withClientRuntime("g", operation, {
					leaseMode: "concurrent",
					admissionKey: "connector",
					maxConcurrentOperations: null,
					concurrentContention: "queue",
					onAdmission: (event) => events.push(event),
				}),
			);
			await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(Math.min(6, maxConnections)));
			expect(manager.snapshot().queuedOperationCount).toBe(Math.max(0, 6 - maxConnections));
			finish.resolve();
			await expect(Promise.all(calls)).resolves.toEqual(Array(6).fill("read"));
			expect(operation).toHaveBeenCalledTimes(6);
			expect(events).toHaveLength(6);
			expect(manager.snapshot()).toMatchObject({
				connectionCount: 0,
				queuedOperationCount: 0,
				operationReferenceCount: 0,
			});
			await manager.close();
		},
	);

	it("preserves the waiting caller's async context during transport allocation and dispatch", async () => {
		const context = new AsyncLocalStorage<string>();
		const gate = deferred();
		const factoryContexts: (string | undefined)[] = [];
		const manager = new McpRuntimeManager({
			maxConnections: 1,
			generationResolver: resolverFrom(async () => {
				factoryContexts.push(context.getStore());
				return admitted();
			}),
		});
		const options = {
			leaseMode: "concurrent" as const,
			concurrentContention: "queue" as const,
			admissionKey: "a",
			maxConcurrentOperations: null,
		};
		const first = context.run("first-actor", () =>
			manager.withClientRuntime("a", async () => gate.promise, options),
		);
		const queued = context.run("waiting-actor", () =>
			manager.withClientRuntime("b", async () => context.getStore(), options),
		);
		expect(manager.snapshot().queuedOperationCount).toBe(1);
		gate.resolve();
		await first;
		await expect(queued).resolves.toBe("waiting-actor");
		expect(factoryContexts).toEqual(["first-actor", "waiting-actor"]);
		await manager.close();
	});

	it("rotates connector keys while preserving each key's FIFO order", async () => {
		const finish = deferred();
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
			maxConnections: 1,
		});
		const options = {
			leaseMode: "concurrent" as const,
			concurrentContention: "queue" as const,
			maxConcurrentOperations: null,
		};
		const first = manager.withClientRuntime("a", async () => finish.promise, {
			...options,
			admissionKey: "a",
		});
		const order: string[] = [];
		const calls = ["a1", "a2", "b1", "b2", "c1", "c2"].map((name) =>
			manager.withClientRuntime(
				name,
				async () => {
					order.push(name);
				},
				{ ...options, admissionKey: name.slice(0, 1) },
			),
		);
		finish.resolve();
		await Promise.all([first, ...calls]);
		expect(order).toEqual(["b1", "c1", "a1", "b2", "c2", "a2"]);
		await manager.close();
	});

	it("skips a capped connector and preserves ceilings across callers and generations", async () => {
		const finish = deferred();
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
			maxConnections: 4,
		});
		const options = {
			leaseMode: "concurrent" as const,
			concurrentContention: "queue" as const,
			admissionKey: "capped",
			maxConcurrentOperations: 1,
		};
		const first = manager.withClientRuntime("old", async () => finish.promise, options);
		const operation = vi.fn(async () => "second");
		const second = manager.withClientRuntime("new", operation, {
			...options,
			maxConcurrentOperations: null,
		});
		await manager.probe("unrelated", { ...options, admissionKey: "other" });
		expect(operation).not.toHaveBeenCalled();
		expect(manager.snapshot().queuedOperationCount).toBe(1);
		finish.resolve();
		await Promise.all([first, second]);
		expect(operation).toHaveBeenCalledOnce();
		await manager.close();
	});

	it("removes 100 cancelled waiters without allocating or dispatching and reports overflow", async () => {
		const finish = deferred();
		const resolver = resolverFrom(async () => admitted());
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });
		const options = {
			leaseMode: "concurrent" as const,
			concurrentContention: "queue" as const,
			admissionKey: "a",
			maxConcurrentOperations: null,
		};
		const first = manager.withClientRuntime("a", async () => finish.promise, options);
		const controller = new AbortController();
		const operation = vi.fn(async () => undefined);
		const waiting = Array.from({ length: 100 }, () =>
			manager.withClientRuntime("b", operation, { ...options, signal: controller.signal }),
		);
		const settled = Promise.allSettled(waiting);
		expect(manager.snapshot().queuedOperationCount).toBe(100);
		const observer = vi.fn();
		await expect(
			manager.probe("overflow", { ...options, onAdmission: observer }),
		).rejects.toMatchObject({ code: "MCP_QUEUE_FULL" });
		expect(observer).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "queue-full", queuedOperationCount: 100 }),
		);
		controller.abort();
		expect(manager.snapshot().queuedOperationCount).toBe(0);
		expect(
			(await settled).every(
				(result) => result.status === "rejected" && result.reason === controller.signal.reason,
			),
		).toBe(true);
		finish.resolve();
		await first;
		expect(resolver.resolve).toHaveBeenCalledOnce();
		expect(operation).not.toHaveBeenCalled();
		await manager.close();
	});

	it("expires process waiters within the original deadline and dispatches provider failures once", async () => {
		const finish = deferred();
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
			maxConnections: 1,
		});
		const options = {
			leaseMode: "concurrent" as const,
			concurrentContention: "queue" as const,
			admissionKey: "a",
			maxConcurrentOperations: null,
		};
		const first = manager.withClientRuntime("a", async () => finish.promise, options);
		const operation = vi.fn(async () => {
			throw new Error("provider failure");
		});
		await expect(
			manager.withClientRuntime("b", operation, { ...options, signal: AbortSignal.timeout(20) }),
		).rejects.toMatchObject({ code: "MCP_ADMISSION_TIMEOUT" });
		expect(operation).not.toHaveBeenCalled();
		expect(manager.snapshot().queuedOperationCount).toBe(0);
		finish.resolve();
		await first;
		await expect(manager.withClientRuntime("b", operation, options)).rejects.toMatchObject({
			code: "MCP_UPSTREAM_FAILED",
		});
		expect(operation).toHaveBeenCalledOnce();
		expect(manager.snapshot().connectionCount).toBe(0);
		await manager.close();
	});

	it.each(["retire", "close"] as const)(
		"%s rejects concurrent process waiters before allocation",
		async (action) => {
			const finish = deferred();
			const resolver = resolverFrom(async () => admitted());
			const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });
			const options = {
				leaseMode: "concurrent" as const,
				concurrentContention: "queue" as const,
				admissionKey: "a",
				maxConcurrentOperations: null,
			};
			const first = manager.withClientRuntime("a", async () => finish.promise, options);
			const operation = vi.fn(async () => undefined);
			const waiting = manager.withClientRuntime("b", operation, options);
			const rejected = expect(waiting).rejects.toMatchObject({
				code: action === "retire" ? "MCP_GENERATION_RETIRED" : "MCP_RUNTIME_CLOSED",
			});
			const teardown = action === "retire" ? manager.retire("b") : manager.close();
			await rejected;
			expect(manager.snapshot().queuedOperationCount).toBe(0);
			finish.resolve();
			await Promise.allSettled([first, teardown]);
			expect(operation).not.toHaveBeenCalled();
			expect(resolver.resolve.mock.calls.length).toBeLessThanOrEqual(1);
			await manager.close();
		},
	);

	it("retains process and connector capacity through slow cleanup", async () => {
		const closeGate = deferred();
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async (key) =>
				admitted(async () => {
					if (key === "a") await closeGate.promise;
				}),
			),
			maxConnections: 1,
		});
		const options = {
			leaseMode: "concurrent" as const,
			concurrentContention: "queue" as const,
			admissionKey: "a",
			maxConcurrentOperations: null,
		};
		const first = manager.probe("a", options);
		await vi.waitFor(() => expect(manager.snapshot().closingConnectionCount).toBe(1));
		const operation = vi.fn(async () => undefined);
		const second = manager.withClientRuntime("b", operation, { ...options, admissionKey: "b" });
		expect(manager.snapshot()).toMatchObject({ connectionCount: 1, queuedOperationCount: 1 });
		expect(operation).not.toHaveBeenCalled();
		closeGate.resolve();
		await Promise.all([first, second]);
		expect(operation).toHaveBeenCalledOnce();
		expect(manager.snapshot().connectionCount).toBe(0);
		await manager.close();
	});

	it("admits unrelated eligible work even when blocked connector waiters fill the queue", async () => {
		const finish = deferred();
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
			maxConnections: 2,
			maxQueuedOperations: 1,
		});
		const options = {
			leaseMode: "concurrent" as const,
			concurrentContention: "queue" as const,
			admissionKey: "a",
			maxConcurrentOperations: 1,
		};
		const first = manager.withClientRuntime("a", async () => finish.promise, options);
		const second = manager.probe("a", options);
		expect(manager.snapshot().queuedOperationCount).toBe(1);
		await manager.probe("b", { ...options, admissionKey: "b" });
		finish.resolve();
		await Promise.all([first, second]);
		await manager.close();
	});

	it("rejects concurrent waiters after failed cleanup and keeps the failed transport charged", async () => {
		const finish = deferred();
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () =>
				admitted(async () => {
					throw new Error("close");
				}),
			),
			maxConnections: 1,
		});
		const options = {
			leaseMode: "concurrent" as const,
			concurrentContention: "queue" as const,
			admissionKey: "a",
			maxConcurrentOperations: null,
		};
		const first = manager.withClientRuntime("a", async () => finish.promise, options);
		const failed = expect(first).rejects.toMatchObject({ code: "MCP_QUARANTINED" });
		const operation = vi.fn(async () => undefined);
		const queued = expect(manager.withClientRuntime("b", operation, options)).rejects.toMatchObject(
			{ code: "MCP_QUARANTINED" },
		);
		finish.resolve();
		await Promise.all([failed, queued]);
		expect(operation).not.toHaveBeenCalled();
		expect(manager.snapshot()).toMatchObject({
			connectionCount: 1,
			quarantinedConnectionCount: 1,
			queuedOperationCount: 0,
		});
		await expect(manager.close()).rejects.toThrow();
	});

	it("cleans a just-granted reservation if its observer cancels before dispatch", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		const controller = new AbortController();
		const reason = new DOMException("cancel", "AbortError");
		const operation = vi.fn(async () => undefined);
		await expect(
			manager.withClientRuntime("a", operation, {
				leaseMode: "concurrent",
				concurrentContention: "queue",
				admissionKey: "a",
				maxConcurrentOperations: null,
				signal: controller.signal,
				onAdmission: () => {
					controller.abort(reason);
					throw new Error("observer");
				},
			}),
		).rejects.toBe(reason);
		expect(operation).not.toHaveBeenCalled();
		expect(manager.snapshot()).toMatchObject({ connectionCount: 0, queuedOperationCount: 0 });
		await manager.close();
	});

	it("overlaps four isolated calls, counts other generations, and refuses a fifth immediately", async () => {
		const finish = deferred();
		const closeGate = deferred();
		const resolver = resolverFrom(async () => admitted(async () => closeGate.promise));
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 8 });
		const operation = vi.fn(async () => {
			await finish.promise;
			return "done";
		});
		const options = { leaseMode: "concurrent" as const, admissionKey: "connector" };
		const calls = ["v1", "v1", "v2", "v2"].map((key) =>
			manager.withClientRuntime(key, operation, options),
		);
		await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(4));
		expect(runtimeHarness.instances).toHaveLength(4);
		await expect(manager.withClientRuntime("v3", operation, options)).rejects.toMatchObject({
			code: "MCP_CAPACITY_EXCEEDED",
		});
		expect(manager.snapshot()).toMatchObject({
			connectionCount: 4,
			queuedOperationCount: 0,
			onlineKeeperCount: 0,
		});
		finish.resolve();
		await vi.waitFor(() => expect(manager.snapshot().closingConnectionCount).toBe(4));
		await expect(manager.withClientRuntime("v3", operation, options)).rejects.toMatchObject({
			code: "MCP_CAPACITY_EXCEEDED",
		});
		closeGate.resolve();
		await expect(Promise.all(calls)).resolves.toEqual(["done", "done", "done", "done"]);
		expect(manager.snapshot().connectionCount).toBe(0);
		await manager.withClientRuntime("v3", operation, options);
		await manager.close();
	});

	it("drains concurrent work before a queued exclusive operation across generations", async () => {
		const finish = deferred();
		const exclusiveFinish = deferred();
		const resolver = resolverFrom(async () => admitted());
		const manager = new McpRuntimeManager({ generationResolver: resolver });
		const parallel = { leaseMode: "concurrent" as const, admissionKey: "connector" };
		const first = manager.withClientRuntime("old", async () => finish.promise, parallel);
		await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledOnce());
		const exclusiveOperation = vi.fn(async () => exclusiveFinish.promise);
		const exclusive = manager.withClientRuntime("new", exclusiveOperation, {
			leaseMode: "exclusive",
			exclusiveContention: "queue",
			admissionKey: "connector",
		});
		expect(manager.snapshot().queuedOperationCount).toBe(1);
		await expect(manager.probe("newer", parallel)).rejects.toMatchObject({
			code: "MCP_CAPACITY_EXCEEDED",
		});
		expect(exclusiveOperation).not.toHaveBeenCalled();
		finish.resolve();
		await first;
		await vi.waitFor(() => expect(exclusiveOperation).toHaveBeenCalledOnce());
		await expect(manager.probe("old", parallel)).rejects.toMatchObject({
			code: "MCP_CAPACITY_EXCEEDED",
		});
		exclusiveFinish.resolve();
		await exclusive;
		await manager.probe("old", parallel);
		await manager.close();
	});

	it("cancels a queued exclusive barrier without cancelling independent calls", async () => {
		const finish = deferred();
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		const options = { leaseMode: "concurrent" as const, admissionKey: "connector" };
		const first = manager.withClientRuntime("v1", async () => finish.promise, options);
		const controller = new AbortController();
		const exclusive = manager.probe("v2", {
			leaseMode: "exclusive",
			exclusiveContention: "queue",
			admissionKey: "connector",
			signal: controller.signal,
		});
		controller.abort();
		await expect(exclusive).rejects.toBe(controller.signal.reason);
		await manager.probe("v3", options);
		expect(manager.snapshot().queuedOperationCount).toBe(0);
		finish.resolve();
		await first;
		await manager.close();
	});

	it("keeps connector quarantine after another isolated generation closes successfully", async () => {
		const finish = deferred();
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async (key) =>
				admitted(async () => {
					if (key === "bad") throw new Error("close failed");
				}),
			),
		});
		const options = { leaseMode: "concurrent" as const, admissionKey: "connector" };
		const good = manager.withClientRuntime("good", async () => finish.promise, options);
		await expect(manager.probe("bad", options)).rejects.toMatchObject({ code: "MCP_QUARANTINED" });
		finish.resolve();
		await good;
		await expect(manager.probe("next", options)).rejects.toMatchObject({ code: "MCP_QUARANTINED" });
		await expect(manager.close()).rejects.toThrow();
	});

	it("retiring one generation cancels its concurrent calls without cancelling a sibling generation", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		const siblingFinish = deferred();
		const entered = deferred();
		const options = { leaseMode: "concurrent" as const, admissionKey: "connector" };
		const first = manager.withClientRuntime(
			"retired",
			async ({ signal }) => {
				entered.resolve();
				await new Promise<void>((_, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
				);
			},
			options,
		);
		const failed = expect(first).rejects.toMatchObject({ code: "MCP_GENERATION_RETIRED" });
		const sibling = manager.withClientRuntime(
			"sibling",
			async () => siblingFinish.promise,
			options,
		);
		await entered.promise;
		await manager.retire("retired");
		await failed;
		expect(manager.snapshot().connectionCount).toBe(1);
		siblingFinish.resolve();
		await sibling;
		await manager.close();
	});

	it("enforces the process transport limit independently of connector admission", async () => {
		const finish = deferred();
		const resolver = resolverFrom(async () => admitted());
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });
		const first = manager.withClientRuntime("a", async () => finish.promise, {
			leaseMode: "concurrent",
			admissionKey: "a",
		});
		await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledOnce());
		await expect(
			manager.probe("b", { leaseMode: "concurrent", admissionKey: "b" }),
		).rejects.toMatchObject({ code: "MCP_CAPACITY_EXCEEDED" });
		expect(resolver.resolve).toHaveBeenCalledOnce();
		finish.resolve();
		await first;
		await manager.probe("b", { leaseMode: "concurrent", admissionKey: "b" });
		await manager.close();
	});

	it("requires a bounded admission identity and rejects concurrent queue options before acquisition", async () => {
		const resolver = resolverFrom(async () => admitted());
		const manager = new McpRuntimeManager({ generationResolver: resolver });
		for (const options of [
			{ leaseMode: "concurrent" as const },
			{ leaseMode: "concurrent" as const, admissionKey: "" },
			{ leaseMode: "concurrent" as const, admissionKey: "x".repeat(1025) },
			{
				leaseMode: "concurrent" as const,
				admissionKey: "connector",
				exclusiveContention: "queue" as const,
			},
			{ leaseMode: "shared" as const, admissionKey: "connector" },
		])
			await expect(manager.probe("g", options)).rejects.toBeInstanceOf(TypeError);
		expect(resolver.resolve).not.toHaveBeenCalled();
		await manager.close();
	});

	it("deduplicates creation and shares one shutdown settlement", async () => {
		const allowResolve = deferred();
		const allowClose = deferred();
		const close = vi.fn(async () => allowClose.promise);
		const resolver = resolverFrom(async () => {
			await allowResolve.promise;
			return admitted(close);
		});
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });

		const firstOnline = manager.ensureOnline("generation-one");
		const secondOnline = manager.ensureOnline("generation-one");
		await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledOnce());
		allowResolve.resolve();
		await expect(Promise.all([firstOnline, secondOnline])).resolves.toHaveLength(2);
		expect(runtimeHarness.instances).toHaveLength(1);
		expect(manager.snapshot()).toMatchObject({
			connectionCount: 1,
			onlineKeeperCount: 1,
		});

		const firstClose = manager.close();
		const secondClose = manager.close();
		expect(firstClose).toBe(secondClose);
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
		allowClose.resolve();
		await expect(firstClose).resolves.toBeUndefined();
	});

	it("awaits each negotiated observation before dispatch and retains no online keeper", async () => {
		const allowObservation = deferred();
		const close = vi.fn(async () => undefined);
		const onConnected = vi.fn(async (snapshot: McpRuntimeStateSnapshot, signal: AbortSignal) => {
			expect(Object.isFrozen(snapshot)).toBe(true);
			expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
			expect(signal).toBeInstanceOf(AbortSignal);
			await allowObservation.promise;
		});
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => ({ ...admitted(close), onConnected })),
		});
		const options = { leaseMode: "exclusive" as const };
		const refresh = manager.refreshCatalog("observed", options);
		await vi.waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
		expect(runtimeHarness.instances[0]?.listTools).not.toHaveBeenCalled();
		allowObservation.resolve();
		await refresh;
		await manager.probe("observed", options);
		await manager.callTool("observed", "search", {}, options);
		expect(onConnected).toHaveBeenCalledTimes(3);
		expect(onConnected.mock.calls[0]?.[0]).toMatchObject({
			phase: "online",
			protocolVersion: "2025-11-25",
			protocolEra: "modern",
			connectedAt: new Date(1).toISOString(),
			capabilities: {
				tools: true,
				resources: true,
				prompts: true,
				completion: true,
				subscriptions: true,
			},
		});
		expect(manager.state("observed")).toMatchObject({ phase: "offline" });
		expect(manager.state("observed").protocolVersion).toBeUndefined();
		expect(manager.snapshot()).toMatchObject({ connectionCount: 0, onlineKeeperCount: 0 });
		expect(close).toHaveBeenCalledTimes(3);
		await manager.close();
	});

	it("closes admitted material when the observation callback rejects", async () => {
		const close = vi.fn(async () => undefined);
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => ({
				...admitted(close),
				onConnected: async () => {
					throw new Error("observation failed");
				},
			})),
		});
		await expect(manager.refreshCatalog("failed", { leaseMode: "exclusive" })).rejects.toThrow();
		expect(close).toHaveBeenCalledOnce();
		expect(runtimeHarness.instances[0]?.connected).toBe(false);
		expect(runtimeHarness.instances[0]?.listTools).not.toHaveBeenCalled();
		expect(manager.snapshot().connectionCount).toBe(0);
		await manager.close();
	});

	it("does not report observations when runtime creation fails", async () => {
		const onConnected = vi.fn();
		const close = vi.fn(async () => undefined);
		runtimeHarness.constructorFailure = new Error("connect unavailable");
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => ({ ...admitted(close), onConnected })),
		});
		await expect(manager.probe("failed")).rejects.toThrow();
		expect(onConnected).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
		await manager.close();
	});

	it("retains failed cleanup as quarantined capacity", async () => {
		const cleanupFailure = new Error("controlled cleanup failure");
		const resolver = resolverFrom(async () => admitted(async () => Promise.reject(cleanupFailure)));
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });

		await manager.ensureOnline("generation-one");
		await expect(manager.setOffline("generation-one")).resolves.toMatchObject({
			phase: "quarantined",
			errorCode: "MCP_CLEANUP_FAILED",
		});
		expect(manager.snapshot()).toMatchObject({
			connectionCount: 1,
			quarantinedConnectionCount: 1,
		});
		await expect(manager.ensureOnline("generation-one")).rejects.toMatchObject({
			code: "MCP_QUARANTINED",
		});
		await expect(manager.ensureOnline("generation-two")).rejects.toMatchObject({
			code: "MCP_CAPACITY_EXCEEDED",
		});
		expect(resolver.resolve).toHaveBeenCalledOnce();
		await expect(manager.close()).rejects.toBeInstanceOf(AggregateError);
	});

	it("closes admitted material when runtime construction fails", async () => {
		const constructionFailure = new Error("controlled constructor failure");
		const close = vi.fn(async () => undefined);
		runtimeHarness.constructorFailure = constructionFailure;
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted(close)),
		});

		await expect(manager.ensureOnline("generation-one")).rejects.toMatchObject({
			code: "MCP_UPSTREAM_FAILED",
		});
		expect(close).toHaveBeenCalledOnce();
		expect(manager.snapshot().connectionCount).toBe(0);
		await manager.close();
	});

	it("bounds a hung admitted cleanup and quarantines its capacity", async () => {
		const neverCloses = vi.fn(() => new Promise<void>(() => undefined));
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted(neverCloses)),
			maxConnections: 1,
			shutdownTimeoutMs: 5,
		});
		await manager.ensureOnline("generation-one");

		await expect(manager.setOffline("generation-one")).resolves.toMatchObject({
			phase: "quarantined",
			errorCode: "MCP_CLEANUP_FAILED",
		});
		expect(manager.snapshot()).toMatchObject({
			connectionCount: 1,
			quarantinedConnectionCount: 1,
		});
		await expect(manager.close()).rejects.toBeInstanceOf(AggregateError);
	});

	it("does not quarantine a successfully drained in-flight connection failure", async () => {
		const allowResolutionFailure = deferred();
		const resolverFailure = new Error("controlled resolution failure");
		const resolver = resolverFrom(async () => {
			await allowResolutionFailure.promise;
			throw resolverFailure;
		});
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });
		const online = manager.ensureOnline("generation-one");
		const onlineSettlement = online.catch((error: unknown) => error);
		await vi.waitFor(() => expect(resolver.resolve).toHaveBeenCalledOnce());

		const offline = manager.setOffline("generation-one");
		allowResolutionFailure.resolve();
		await expect(offline).resolves.toMatchObject({ phase: "offline" });
		expect(await onlineSettlement).toBeDefined();
		expect(manager.snapshot()).toMatchObject({
			connectionCount: 0,
			quarantinedConnectionCount: 0,
		});
		await manager.close();
	});

	it("shares concurrent offline work and queues reconnect until drain settles", async () => {
		const allowFirstClose = deferred();
		const firstClose = vi.fn(async () => allowFirstClose.promise);
		let resolutionCount = 0;
		const resolver = resolverFrom(async () => {
			resolutionCount += 1;
			return admitted(resolutionCount === 1 ? firstClose : async () => undefined);
		});
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });
		await manager.ensureOnline("generation-one");

		const firstOffline = manager.setOffline("generation-one");
		const secondOffline = manager.setOffline("generation-one");
		expect(secondOffline).toBe(firstOffline);
		await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce());
		const reconnect = manager.ensureOnline("generation-one");
		await Promise.resolve();
		expect(resolver.resolve).toHaveBeenCalledOnce();
		expect(runtimeHarness.instances).toHaveLength(1);

		allowFirstClose.resolve();
		await expect(Promise.all([firstOffline, secondOffline])).resolves.toEqual([
			expect.objectContaining({ phase: "offline" }),
			expect.objectContaining({ phase: "offline" }),
		]);
		await expect(reconnect).resolves.toMatchObject({ phase: "online" });
		expect(resolver.resolve).toHaveBeenCalledTimes(2);
		expect(runtimeHarness.instances).toHaveLength(2);
		expect(manager.snapshot().onlineKeeperCount).toBe(1);
		await manager.close();
	});

	it("rejects transient acquisitions while the same generation is draining", async () => {
		const allowClose = deferred();
		const close = vi.fn(async () => allowClose.promise);
		const resolver = resolverFrom(async () => admitted(close));
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });
		await manager.ensureOnline("generation-one");
		const offline = manager.setOffline("generation-one");
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

		await expect(manager.probe("generation-one")).rejects.toMatchObject({
			code: "MCP_NOT_READY",
		});
		expect(resolver.resolve).toHaveBeenCalledOnce();
		expect(runtimeHarness.instances).toHaveLength(1);
		allowClose.resolve();
		await expect(offline).resolves.toMatchObject({ phase: "offline" });
		await manager.close();
	});

	it("rechecks a new offline barrier before a queued reconnect starts", async () => {
		const allowFirstClose = deferred();
		let secondOfflineCompleted = false;
		let secondResolutionObservedOffline = false;
		let resolutionCount = 0;
		const resolver = resolverFrom(async () => {
			resolutionCount += 1;
			if (resolutionCount === 2) {
				secondResolutionObservedOffline = secondOfflineCompleted;
			}
			return admitted(resolutionCount === 1 ? async () => allowFirstClose.promise : undefined);
		});
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });
		await manager.ensureOnline("generation-one");
		const firstOffline = manager.setOffline("generation-one");
		let secondOffline: Promise<unknown> | undefined;
		void firstOffline.then(() => {
			secondOffline = manager.setOffline("generation-one").then((state) => {
				secondOfflineCompleted = true;
				return state;
			});
		});
		const reconnect = manager.ensureOnline("generation-one");

		allowFirstClose.resolve();
		await firstOffline;
		await vi.waitFor(() => expect(secondOffline).toBeDefined());
		await secondOffline;
		await expect(reconnect).resolves.toMatchObject({ phase: "online" });
		expect(secondResolutionObservedOffline).toBe(true);
		expect(manager.state("generation-one").phase).toBe("online");
		expect(manager.snapshot().onlineKeeperCount).toBe(1);
		await manager.close();
	});

	it("publishes transitions only after lifecycle barriers are registered", async () => {
		const resolver = resolverFrom(async () => admitted());
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });
		let reentrantOnline: Promise<unknown> | undefined;
		let reentrantOffline: Promise<unknown> | undefined;
		manager.subscribe((event) => {
			if (event.phase === "queued") {
				reentrantOnline = manager.ensureOnline("generation-one");
			}
			if (event.phase === "draining") {
				reentrantOffline = manager.setOffline("generation-one");
			}
		});

		await manager.ensureOnline("generation-one");
		await expect(reentrantOnline).resolves.toMatchObject({ phase: "online" });
		expect(resolver.resolve).toHaveBeenCalledOnce();
		const offline = manager.setOffline("generation-one");
		await vi.waitFor(() => expect(reentrantOffline).toBe(offline));
		await expect(offline).resolves.toMatchObject({ phase: "offline" });
		await manager.close();
	});

	it("aborts in-flight work when its generation starts draining", async () => {
		const operationStarted = deferred();
		runtimeHarness.callToolHook = async (signal) => {
			if (signal === undefined) throw new Error("The operation signal is required.");
			operationStarted.resolve();
			await rejectWhenAborted(signal);
		};
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		await manager.ensureOnline("generation-one");
		const operation = manager.callTool("generation-one", "controlled", {});
		await operationStarted.promise;

		const offline = manager.setOffline("generation-one");
		await expect(operation).rejects.toMatchObject({ code: "MCP_GENERATION_RETIRED" });
		await expect(offline).resolves.toMatchObject({ phase: "offline" });
		await manager.close();
	});

	it("closes an exclusive operation runtime before settlement and never pools its generation", async () => {
		const operationStarted = deferred();
		const allowOperation = deferred();
		const allowClose = deferred();
		const close = vi.fn(async () => allowClose.promise);
		runtimeHarness.callToolHook = async () => {
			operationStarted.resolve();
			await allowOperation.promise;
			return { content: [] };
		};
		const resolver = resolverFrom(async () => admitted(close));
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 2 });

		let settled = false;
		const operation = manager
			.callTool("credential-binding", "controlled", {}, { leaseMode: "exclusive" })
			.finally(() => {
				settled = true;
			});
		await operationStarted.promise;
		expect(manager.snapshot()).toMatchObject({
			connectionCount: 1,
			onlineKeeperCount: 0,
		});

		await expect(
			manager.callTool("credential-binding", "second", {}, { leaseMode: "exclusive" }),
		).rejects.toMatchObject({ code: MCP_RUNTIME_LEASE_MODE_CONFLICT });
		expect(resolver.resolve).toHaveBeenCalledOnce();

		allowOperation.resolve();
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
		expect(settled).toBe(false);
		allowClose.resolve();
		await expect(operation).resolves.toMatchObject({ content: [] });
		expect(manager.snapshot()).toMatchObject({
			connectionCount: 0,
			onlineKeeperCount: 0,
		});
		expect(manager.state("credential-binding").phase).toBe("offline");

		runtimeHarness.callToolHook = undefined;
		await expect(
			manager.callTool("credential-binding", "fresh", {}, { leaseMode: "exclusive" }),
		).resolves.toMatchObject({ content: [] });
		expect(resolver.resolve).toHaveBeenCalledTimes(2);
		expect(runtimeHarness.instances).toHaveLength(2);
		await manager.close();
	});

	it("queues exclusive calls FIFO and opens each fresh runtime only after prior cleanup", async () => {
		const started = deferred();
		const allowOperation = deferred();
		const allowClose = deferred();
		const close = vi.fn(async () => allowClose.promise);
		let calls = 0;
		runtimeHarness.callToolHook = async () => {
			calls += 1;
			if (calls === 1) {
				started.resolve();
				await allowOperation.promise;
			}
			return { content: [{ type: "text", text: String(calls) }] };
		};
		const resolver = resolverFrom(async () => admitted(close));
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });
		const first = manager.callTool("same", "first", {}, { leaseMode: "exclusive" });
		await started.promise;
		const second = manager.callTool(
			"same",
			"second",
			{},
			{
				leaseMode: "exclusive",
				exclusiveContention: "queue",
			},
		);
		const third = manager.callTool(
			"same",
			"third",
			{},
			{
				leaseMode: "exclusive",
				exclusiveContention: "queue",
			},
		);
		expect(manager.snapshot()).toMatchObject({ queuedOperationCount: 2, connectionCount: 1 });
		allowOperation.resolve();
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
		expect(resolver.resolve).toHaveBeenCalledOnce();
		expect(calls).toBe(1);
		allowClose.resolve();
		await expect(first).resolves.toMatchObject({ content: [{ text: "1" }] });
		await expect(second).resolves.toMatchObject({ content: [{ text: "2" }] });
		await expect(third).resolves.toMatchObject({ content: [{ text: "3" }] });
		expect(runtimeHarness.instances).toHaveLength(3);
		expect(resolver.resolve).toHaveBeenCalledTimes(3);
		expect(close).toHaveBeenCalledTimes(3);
		expect(manager.snapshot()).toMatchObject({ queuedOperationCount: 0, connectionCount: 0 });
		await manager.close();
	});

	it.each([false, true])(
		"drains cancelled acquisition before the next caller (cleanup fails: %s)",
		async (cleanupFails) => {
			const started = deferred();
			const allowAdmission = deferred();
			const allowClose = deferred();
			const close = vi.fn(async () => {
				await allowClose.promise;
				if (cleanupFails) throw new Error("uncertain abandoned material cleanup");
			});
			let admissions = 0;
			const resolver = resolverFrom(async () => {
				admissions += 1;
				if (admissions === 1) {
					started.resolve();
					await allowAdmission.promise;
				}
				return admitted(close);
			});
			const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });
			const controller = new AbortController();
			const reason = new Error("cancel active acquisition");
			let firstSettled = false;
			const first = manager
				.callTool(
					"same",
					"cancelled",
					{},
					{
						leaseMode: "exclusive",
						signal: controller.signal,
					},
				)
				.finally(() => {
					firstSettled = true;
				});
			const rejected = expect(first).rejects.toBe(reason);
			await started.promise;
			const second = manager.callTool(
				"same",
				"next",
				{},
				{
					leaseMode: "exclusive",
					exclusiveContention: "queue",
				},
			);
			const secondSettlement = cleanupFails
				? expect(second).rejects.toMatchObject({ code: "MCP_QUARANTINED" })
				: expect(second).resolves.toMatchObject({ content: [] });
			controller.abort(reason);
			allowAdmission.resolve();
			await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
			expect(firstSettled).toBe(false);
			expect(resolver.resolve).toHaveBeenCalledOnce();
			expect(manager.snapshot()).toMatchObject({ queuedOperationCount: 1, connectionCount: 1 });
			allowClose.resolve();
			await rejected;
			await secondSettlement;
			expect(resolver.resolve).toHaveBeenCalledTimes(cleanupFails ? 1 : 2);
			expect(runtimeHarness.instances[0]?.callTool).not.toHaveBeenCalled();
			expect(manager.snapshot()).toMatchObject({
				queuedOperationCount: 0,
				connectionCount: cleanupFails ? 1 : 0,
			});
			if (cleanupFails) await expect(manager.close()).rejects.toThrow();
			else await manager.close();
		},
	);

	it("cancels only the waiting caller and never dispatches its request", async () => {
		const started = deferred();
		const allowOperation = deferred();
		runtimeHarness.callToolHook = async () => {
			started.resolve();
			await allowOperation.promise;
			return { content: [] };
		};
		const resolver = resolverFrom(async () => admitted());
		const manager = new McpRuntimeManager({ generationResolver: resolver });
		const first = manager.callTool("same", "first", {}, { leaseMode: "exclusive" });
		await started.promise;
		const caller = new AbortController();
		const reason = new Error("cancel queued caller");
		const second = manager.callTool(
			"same",
			"cancelled",
			{},
			{
				leaseMode: "exclusive",
				exclusiveContention: "queue",
				signal: caller.signal,
			},
		);
		const cancelled = expect(second).rejects.toBe(reason);
		const third = manager.callTool(
			"same",
			"third",
			{},
			{
				leaseMode: "exclusive",
				exclusiveContention: "queue",
			},
		);
		caller.abort(reason);
		await cancelled;
		expect(manager.snapshot().queuedOperationCount).toBe(1);
		allowOperation.resolve();
		await Promise.all([first, third]);
		expect(resolver.resolve).toHaveBeenCalledTimes(2);
		expect(manager.snapshot().queuedOperationCount).toBe(0);
		await manager.close();
	});

	it("includes queue wait in the request timeout without a late dispatch", async () => {
		const started = deferred();
		const allowOperation = deferred();
		runtimeHarness.callToolHook = async () => {
			started.resolve();
			await allowOperation.promise;
			return { content: [] };
		};
		const resolver = resolverFrom(async () => admitted());
		const manager = new McpRuntimeManager({ generationResolver: resolver, requestTimeoutMs: 30 });
		const first = manager.callTool("same", "first", {}, { leaseMode: "exclusive" });
		await started.promise;
		await expect(
			manager.callTool(
				"same",
				"timed-out",
				{},
				{
					leaseMode: "exclusive",
					exclusiveContention: "queue",
				},
			),
		).rejects.toMatchObject({ code: "MCP_ADMISSION_TIMEOUT", cause: { name: "TimeoutError" } });
		expect(manager.snapshot().queuedOperationCount).toBe(0);
		allowOperation.resolve();
		await first;
		expect(resolver.resolve).toHaveBeenCalledOnce();
		await manager.close();
	});

	it.each(["setOffline", "retire", "close"] as const)(
		"%s rejects queued work before admission and fences the active operation",
		async (action) => {
			const started = deferred();
			runtimeHarness.callToolHook = async (signal) => {
				if (signal === undefined) throw new Error("signal required");
				started.resolve();
				await rejectWhenAborted(signal);
			};
			const resolver = resolverFrom(async () => admitted());
			const manager = new McpRuntimeManager({ generationResolver: resolver });
			const first = manager.callTool("same", "first", {}, { leaseMode: "exclusive" });
			await started.promise;
			const firstRejected = expect(first).rejects.toMatchObject({
				code: action === "close" ? "MCP_RUNTIME_CLOSED" : "MCP_GENERATION_RETIRED",
			});
			const second = manager.callTool(
				"same",
				"queued",
				{},
				{
					leaseMode: "exclusive",
					exclusiveContention: "queue",
				},
			);
			const secondRejected = expect(second).rejects.toMatchObject({
				code: action === "close" ? "MCP_RUNTIME_CLOSED" : "MCP_GENERATION_RETIRED",
			});
			await (action === "close" ? manager.close() : manager[action]("same"));
			await Promise.all([firstRejected, secondRejected]);
			expect(resolver.resolve).toHaveBeenCalledOnce();
			expect(manager.snapshot()).toMatchObject({ queuedOperationCount: 0, connectionCount: 0 });
			await manager.close();
		},
	);

	it("rejects queued work when cleanup quarantines its generation", async () => {
		const started = deferred();
		const allowOperation = deferred();
		runtimeHarness.callToolHook = async () => {
			started.resolve();
			await allowOperation.promise;
			return { content: [] };
		};
		const resolver = resolverFrom(async () =>
			admitted(async () => {
				throw new Error("uncertain close");
			}),
		);
		const manager = new McpRuntimeManager({ generationResolver: resolver, maxConnections: 1 });
		const first = manager.callTool("same", "first", {}, { leaseMode: "exclusive" });
		await started.promise;
		const firstRejected = expect(first).rejects.toMatchObject({ code: "MCP_QUARANTINED" });
		const second = manager.callTool(
			"same",
			"queued",
			{},
			{
				leaseMode: "exclusive",
				exclusiveContention: "queue",
			},
		);
		const secondRejected = expect(second).rejects.toMatchObject({ code: "MCP_QUARANTINED" });
		allowOperation.resolve();
		await Promise.all([firstRejected, secondRejected]);
		expect(resolver.resolve).toHaveBeenCalledOnce();
		expect(manager.snapshot()).toMatchObject({
			queuedOperationCount: 0,
			quarantinedConnectionCount: 1,
		});
		await expect(manager.close()).rejects.toThrow();
	});

	it("bounds the queue across generations and leaves admitted operations independent", async () => {
		const allowOperation = deferred();
		runtimeHarness.callToolHook = async () => {
			await allowOperation.promise;
			return { content: [] };
		};
		const resolver = resolverFrom(async () => admitted());
		const manager = new McpRuntimeManager({
			generationResolver: resolver,
			maxConnections: 2,
			maxQueuedOperations: 1,
		});
		const first = manager.callTool("one", "first", {}, { leaseMode: "exclusive" });
		const other = manager.callTool("two", "other", {}, { leaseMode: "exclusive" });
		const queued = manager.callTool(
			"one",
			"queued",
			{},
			{
				leaseMode: "exclusive",
				exclusiveContention: "queue",
			},
		);
		await expect(
			manager.callTool(
				"two",
				"over-limit",
				{},
				{
					leaseMode: "exclusive",
					exclusiveContention: "queue",
				},
			),
		).rejects.toMatchObject({ code: "MCP_QUEUE_FULL" });
		expect(manager.snapshot()).toMatchObject({ queuedOperationCount: 1, maxQueuedOperations: 1 });
		allowOperation.resolve();
		await Promise.all([first, other, queued]);
		expect(resolver.resolve).toHaveBeenCalledTimes(3);
		await manager.close();
	});

	it.each(["admission", "operation"] as const)(
		"releases the queue after %s failure without replaying the failed call",
		async (failureStage) => {
			const started = deferred();
			const allowFailure = deferred();
			const failure = new Error("controlled failure");
			let calls = 0;
			let admissions = 0;
			runtimeHarness.callToolHook = async () => {
				calls += 1;
				if (failureStage === "operation" && calls === 1) {
					started.resolve();
					await allowFailure.promise;
					throw failure;
				}
				return { content: [] };
			};
			const resolver = resolverFrom(async () => {
				admissions += 1;
				if (failureStage === "admission" && admissions === 1) {
					started.resolve();
					await allowFailure.promise;
					throw failure;
				}
				return admitted();
			});
			const manager = new McpRuntimeManager({ generationResolver: resolver });
			const first = manager.callTool("same", "first", {}, { leaseMode: "exclusive" });
			await started.promise;
			const rejected =
				failureStage === "admission"
					? expect(first).rejects.toBe(failure)
					: expect(first).rejects.toMatchObject({ code: "MCP_UPSTREAM_FAILED", cause: failure });
			const second = manager.callTool(
				"same",
				"second",
				{},
				{
					leaseMode: "exclusive",
					exclusiveContention: "queue",
				},
			);
			allowFailure.resolve();
			await rejected;
			await expect(second).resolves.toMatchObject({ content: [] });
			expect(admissions).toBe(2);
			expect(calls).toBe(failureStage === "admission" ? 1 : 2);
			expect(manager.snapshot().queuedOperationCount).toBe(0);
			await manager.close();
		},
	);

	it("requires explicit exclusive mode for queueing and validates its bound", async () => {
		const resolver = resolverFrom(async () => admitted());
		const manager = new McpRuntimeManager({ generationResolver: resolver });
		await expect(
			manager.callTool("same", "first", {}, { exclusiveContention: "queue" }),
		).rejects.toThrow('queued contention requires leaseMode "exclusive"');
		const invalidOptions: McpRuntimeOperationOptions = { leaseMode: "exclusive" };
		Reflect.set(invalidOptions, "exclusiveContention", "invalid");
		await expect(manager.probe("same", invalidOptions)).rejects.toThrow(
			'options.exclusiveContention must be "reject" or "queue"',
		);
		expect(
			() => new McpRuntimeManager({ generationResolver: resolver, maxQueuedOperations: 0 }),
		).toThrow("maxQueuedOperations");
		expect(resolver.resolve).not.toHaveBeenCalled();
		await manager.close();
	});

	it("rejects exclusive work while the generation has a retained online keeper", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		await manager.ensureOnline("retained-generation");

		await expect(
			manager.callTool("retained-generation", "controlled", {}, { leaseMode: "exclusive" }),
		).rejects.toMatchObject({ code: MCP_RUNTIME_LEASE_MODE_CONFLICT });
		await expect(
			manager.callTool(
				"retained-generation",
				"controlled",
				{},
				{
					leaseMode: "exclusive",
					exclusiveContention: "queue",
				},
			),
		).rejects.toMatchObject({ code: MCP_RUNTIME_LEASE_MODE_CONFLICT });
		expect(runtimeHarness.instances).toHaveLength(1);
		await manager.close();
	});

	it("fences an exclusive operation when its generation is retired", async () => {
		const operationStarted = deferred();
		const close = vi.fn(async () => undefined);
		runtimeHarness.callToolHook = async (signal) => {
			if (signal === undefined) throw new Error("The operation signal is required.");
			operationStarted.resolve();
			await rejectWhenAborted(signal);
		};
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted(close)),
		});
		const operation = manager.callTool(
			"credential-binding",
			"controlled",
			{},
			{
				leaseMode: "exclusive",
			},
		);
		await operationStarted.promise;

		const offline = manager.setOffline("credential-binding");
		await expect(operation).rejects.toMatchObject({ code: "MCP_GENERATION_RETIRED" });
		await expect(offline).resolves.toMatchObject({ phase: "offline" });
		expect(close).toHaveBeenCalledOnce();
		expect(manager.snapshot().connectionCount).toBe(0);
		await manager.close();
	});

	it("keeps a positional abort signal as the cancellation-only tool call option", async () => {
		const operationStarted = deferred();
		runtimeHarness.callToolHook = async (signal) => {
			if (signal === undefined) throw new Error("The operation signal is required.");
			operationStarted.resolve();
			await rejectWhenAborted(signal);
		};
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		await manager.ensureOnline("generation-one");
		const ownedRuntime = runtimeHarness.instances[0]!;
		const actualServerName = ownedRuntime.options.servers?.[0]?.name;
		if (actualServerName === undefined) throw new Error("The managed server name is required.");
		const caller = new AbortController();
		const callerCancellation = new Error("caller cancelled managed tool call");

		const operation = manager.callTool(
			"generation-one",
			"controlled",
			{ value: "kept" },
			caller.signal,
		);
		await operationStarted.promise;

		expect(ownedRuntime.callTool).toHaveBeenCalledWith(
			actualServerName,
			{ name: "controlled", arguments: { value: "kept" } },
			{ signal: expect.any(AbortSignal) },
		);
		caller.abort(callerCancellation);
		await expect(operation).rejects.toBe(callerCancellation);
		await manager.close();
	});

	it("pins a caller-supplied tool definition on the managed client runtime call", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		await manager.ensureOnline("generation-one");
		const ownedRuntime = runtimeHarness.instances[0]!;
		const actualServerName = ownedRuntime.options.servers?.[0]?.name;
		if (actualServerName === undefined) throw new Error("The managed server name is required.");
		const caller = new AbortController();
		const toolDefinition = Object.freeze({
			name: "controlled",
			inputSchema: {
				type: "object" as const,
				properties: { value: { type: "string" as const } },
				required: ["value"],
			},
		}) satisfies Tool;

		await expect(
			manager.callTool(
				"generation-one",
				"controlled",
				{ value: "kept" },
				{ signal: caller.signal, toolDefinition },
			),
		).resolves.toMatchObject({ content: [] });

		expect(ownedRuntime.callTool).toHaveBeenCalledWith(
			actualServerName,
			{ name: "controlled", arguments: { value: "kept" } },
			{ signal: expect.any(AbortSignal), toolDefinition },
		);
		await manager.close();
	});

	it("rejects tool call options that are neither a signal nor an options object", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		await manager.ensureOnline("generation-one");
		const ownedRuntime = runtimeHarness.instances[0]!;

		await expect(
			manager.callTool(
				"generation-one",
				"controlled",
				{},
				// Intentionally models malformed JavaScript input at the runtime boundary.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				"cancel" as unknown as AbortSignal,
			),
		).rejects.toMatchObject({
			name: "TypeError",
			message: "callTool options must be an AbortSignal or a tool call options object.",
		});
		expect(ownedRuntime.callTool).not.toHaveBeenCalled();
		await manager.close();
	});

	it("rejects an unknown operation lease mode before resolving a generation", async () => {
		const resolver = resolverFrom(async () => admitted());
		const manager = new McpRuntimeManager({ generationResolver: resolver });

		await expect(
			manager.refreshCatalog("generation-one", {
				// Intentionally models malformed JavaScript at the public runtime boundary.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				leaseMode: "idle" as unknown as "shared",
			}),
		).rejects.toMatchObject({
			name: "TypeError",
			message: 'refreshCatalog options.leaseMode must be "shared", "exclusive", or "concurrent".',
		});
		expect(resolver.resolve).not.toHaveBeenCalled();
		await manager.close();
	});

	it("publishes state and probe snapshots that satisfy the exported validators", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		const online = await manager.ensureOnline("generation-one");
		const probe = await manager.probe("generation-one");
		const untracked = manager.state("unknown-generation");

		expect(mcpRuntimeStateSnapshotSchema["~standard"].validate(online)).toEqual({ value: online });
		expect(mcpRuntimeStateSnapshotSchema["~standard"].validate(untracked)).toEqual({
			value: untracked,
		});
		expect(mcpRuntimeProbeSnapshotSchema["~standard"].validate(probe)).toEqual({ value: probe });
		expect(probe.capabilities).toBeDefined();
		expect(mcpRuntimeCapabilitiesSnapshotSchema["~standard"].validate(probe.capabilities)).toEqual({
			value: probe.capabilities,
		});

		runtimeHarness.instances[0]!.connected = false;
		const degraded = manager.state("generation-one");
		expect(degraded).toMatchObject({ phase: "degraded", errorCode: "MCP_CONNECTION_LOST" });
		expect(mcpRuntimeStateSnapshotSchema["~standard"].validate(degraded)).toEqual({
			value: degraded,
		});

		const offline = await manager.setOffline("generation-one");
		expect(mcpRuntimeStateSnapshotSchema["~standard"].validate(offline)).toEqual({
			value: offline,
		});

		for (const state of [online, untracked, degraded, offline]) {
			expect(Object.isFrozen(state)).toBe(true);
			expect(Object.values(state)).not.toContain(undefined);
		}
		expect(Object.isFrozen(online.capabilities)).toBe(true);
		await manager.close();
	});

	it("exposes the owned runtime identity and preserves caller-bound tool call options", async () => {
		const operationStarted = deferred();
		runtimeHarness.callToolHook = async (signal) => {
			if (signal === undefined) throw new Error("The operation signal is required.");
			operationStarted.resolve();
			await rejectWhenAborted(signal);
		};
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		await manager.ensureOnline("generation-one");
		const ownedRuntime = runtimeHarness.instances[0]!;
		const actualServerName = ownedRuntime.options.servers?.[0]?.name;
		if (actualServerName === undefined) throw new Error("The managed server name is required.");
		const caller = new AbortController();
		const callerCancellation = new Error("caller cancelled managed operation");
		const toolDefinition = Object.freeze({
			name: "controlled",
			inputSchema: {
				type: "object" as const,
				properties: { value: { type: "string" as const } },
				required: ["value"],
			},
		}) satisfies Tool;
		let operationSignal: AbortSignal | undefined;

		const operation = manager.withClientRuntime(
			"generation-one",
			async (context) => {
				operationSignal = context.signal;
				expect(context.runtime).toBe(ownedRuntime);
				expect(context.serverName).toBe(actualServerName);
				return context.runtime.callTool(
					context.serverName,
					{ name: toolDefinition.name, arguments: { value: "preserved" } },
					{
						signal: context.signal,
						toolDefinition,
						allowInputRequired: true,
					},
				);
			},
			caller.signal,
		);
		await operationStarted.promise;

		expect(actualServerName).toMatch(/^managed-/);
		expect(actualServerName).not.toBe("generation-one");
		expect(operationSignal).toBeDefined();
		expect(ownedRuntime.callTool).toHaveBeenCalledWith(
			actualServerName,
			{ name: "controlled", arguments: { value: "preserved" } },
			{
				signal: operationSignal,
				toolDefinition,
				allowInputRequired: true,
			},
		);

		caller.abort(callerCancellation);
		await expect(operation).rejects.toBe(callerCancellation);
		expect(operationSignal).toMatchObject({ aborted: true, reason: callerCancellation });
		await manager.close();
	});

	it("keeps withClientRuntime tool calls bound to generation retirement", async () => {
		const operationStarted = deferred();
		runtimeHarness.callToolHook = async (signal) => {
			if (signal === undefined) throw new Error("The operation signal is required.");
			operationStarted.resolve();
			await rejectWhenAborted(signal);
		};
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		await manager.ensureOnline("generation-one");
		let operationSignal: AbortSignal | undefined;

		const operation = manager.withClientRuntime("generation-one", async (context) => {
			operationSignal = context.signal;
			return context.runtime.callTool(
				context.serverName,
				{ name: "controlled", arguments: {} },
				{ signal: context.signal, allowInputRequired: true },
			);
		});
		await operationStarted.promise;

		const offline = manager.setOffline("generation-one");
		await expect(operation).rejects.toMatchObject({ code: "MCP_GENERATION_RETIRED" });
		expect(operationSignal).toMatchObject({ aborted: true });
		await expect(offline).resolves.toMatchObject({ phase: "offline" });
		await manager.close();
	});

	it("preserves an explicit caller cancellation reason", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		await manager.ensureOnline("generation-one");
		const controller = new AbortController();
		const cancellation = new Error("caller cancelled");
		controller.abort(cancellation);

		await expect(manager.probe("generation-one", controller.signal)).rejects.toBe(cancellation);
		await manager.close();
	});

	it("bounds retained failed state across unique generation keys", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => Promise.reject(new Error("unavailable"))),
			maxConnections: 1,
			maxStateEntries: 2,
		});
		for (let index = 1; index <= 5; index += 1) {
			await expect(manager.ensureOnline(`failed-${String(index)}`)).rejects.toBeInstanceOf(Error);
		}

		expect(manager.state("failed-1").phase).toBe("offline");
		expect(manager.state("failed-4").phase).toBe("failed");
		expect(manager.state("failed-5").phase).toBe("failed");
		await manager.close();
	});

	it("does not evict an owned runtime state for a capacity-failing key", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
			maxConnections: 1,
			maxStateEntries: 1,
		});
		await manager.ensureOnline("owned-generation");

		await expect(manager.ensureOnline("capacity-failing-generation")).rejects.toMatchObject({
			code: "MCP_CAPACITY_EXCEEDED",
		});
		expect(manager.state("owned-generation").phase).toBe("online");
		expect(manager.state("capacity-failing-generation").phase).toBe("offline");
		await manager.close();
	});

	it("reconciles an unexpectedly disconnected keeper as degraded on read", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		await manager.ensureOnline("generation-one");
		expect(manager.state("generation-one").phase).toBe("online");

		runtimeHarness.instances[0]!.connected = false;
		expect(manager.state("generation-one")).toMatchObject({
			phase: "degraded",
			errorCode: "MCP_CONNECTION_LOST",
		});
		await manager.close();
	});

	it("keeps a failed reconnect with an owned keeper as protected degraded state", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
			maxConnections: 1,
			maxStateEntries: 1,
		});
		await manager.ensureOnline("owned-generation");
		const runtime = runtimeHarness.instances[0]!;
		runtime.connected = false;
		runtime.connectFailure = new Error("controlled reconnect failure");

		await expect(manager.ensureOnline("owned-generation")).rejects.toMatchObject({
			code: "MCP_UPSTREAM_FAILED",
		});
		expect(manager.state("owned-generation")).toMatchObject({
			phase: "degraded",
			errorCode: "MCP_UPSTREAM_FAILED",
		});
		await expect(manager.ensureOnline("capacity-failing-generation")).rejects.toMatchObject({
			code: "MCP_CAPACITY_EXCEEDED",
		});
		expect(manager.state("owned-generation").phase).toBe("degraded");
		await manager.close();
	});

	it("falls back from an out-of-range diagnostics clock", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
			now: () => Number.MAX_VALUE,
		});

		expect(() => manager.state("unknown-generation")).not.toThrow();
		expect(Date.parse(manager.state("unknown-generation").lastTransitionAt)).not.toBeNaN();
		await manager.close();
	});

	it("pings legacy generations instead of using modern discovery", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		await manager.ensureOnline("legacy-generation");
		const runtime = runtimeHarness.instances[0]!;
		runtime.protocolEra = "legacy";

		await expect(manager.probe("legacy-generation")).resolves.toMatchObject({
			reachable: true,
			protocolVersion: "2025-11-25",
			protocolEra: "legacy",
			capabilities: {
				tools: true,
				resources: true,
				prompts: true,
				completion: true,
				subscriptions: true,
			},
		});
		await expect(manager.refreshCatalog("legacy-generation")).resolves.toMatchObject({
			tools: [],
			resources: [],
			resourceTemplates: [],
			prompts: [],
		});
		expect(runtime.discover).not.toHaveBeenCalled();
		expect(runtime.ping).toHaveBeenCalledTimes(2);
		expect(runtime.listTools).toHaveBeenCalledOnce();
		expect(runtime.listResources).toHaveBeenCalledOnce();
		expect(runtime.listResourceTemplates).toHaveBeenCalledOnce();
		expect(runtime.listPrompts).toHaveBeenCalledOnce();
		await manager.close();
	});

	it("treats only protocol method-not-found from optional template discovery as empty", async () => {
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
		});
		await manager.ensureOnline("template-optional-generation");
		const runtime = runtimeHarness.instances[0]!;
		runtime.listTools.mockResolvedValueOnce({
			tools: [{ name: "search", inputSchema: { type: "object" } }],
		});
		runtime.listResourceTemplates.mockRejectedValueOnce(
			new ProtocolError(ProtocolErrorCode.MethodNotFound, "Method not found"),
		);

		await expect(manager.refreshCatalog("template-optional-generation")).resolves.toMatchObject({
			tools: [{ name: "search" }],
			resources: [],
			resourceTemplates: [],
			prompts: [],
		});

		const invalidParams = new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			"Invalid template request",
		);
		runtime.listResourceTemplates.mockRejectedValueOnce(invalidParams);
		await expect(manager.refreshCatalog("template-optional-generation")).rejects.toMatchObject({
			code: "MCP_UPSTREAM_FAILED",
			cause: invalidParams,
		});
		await manager.close();
	});

	it("keeps a shared catalog lease until every parallel discovery request settles", async () => {
		const resourcesStarted = deferred();
		const allowResources = deferred();
		const catalogFailure = new Error("controlled tools discovery failure");
		const close = vi.fn(async () => undefined);
		runtimeHarness.listToolsHook = async () => Promise.reject(catalogFailure);
		runtimeHarness.listResourcesHook = async () => {
			resourcesStarted.resolve();
			await allowResources.promise;
			return { resources: [] };
		};
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted(close)),
			now: () => 1_700_000_000_000,
		});

		let settled = false;
		const refresh = manager.refreshCatalog("catalog-generation").finally(() => {
			settled = true;
		});
		await resourcesStarted.promise;
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(close).not.toHaveBeenCalled();

		allowResources.resolve();
		await expect(refresh).rejects.toMatchObject({
			code: "MCP_UPSTREAM_FAILED",
			cause: catalogFailure,
		});
		expect(close).toHaveBeenCalledOnce();
		expect(manager.snapshot()).toMatchObject({
			connectionCount: 0,
			onlineKeeperCount: 0,
		});
		expect(manager.state("catalog-generation").phase).toBe("offline");
		await manager.close();
	});

	it("returns a timestamped forced-refresh catalog through an exclusive lease", async () => {
		const toolsStarted = deferred();
		const allowTools = deferred();
		const close = vi.fn(async () => undefined);
		runtimeHarness.listToolsHook = async () => {
			toolsStarted.resolve();
			await allowTools.promise;
			return { tools: [] };
		};
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted(close)),
			now: () => 1_700_000_000_000,
		});

		const refresh = manager.refreshCatalog("catalog-generation", { leaseMode: "exclusive" });
		await toolsStarted.promise;
		const runtime = runtimeHarness.instances[0]!;
		expect(runtime.listResources).not.toHaveBeenCalled();
		allowTools.resolve();

		await expect(refresh).resolves.toEqual({
			discoveredAt: "2023-11-14T22:13:20.000Z",
			tools: [],
			resources: [],
			resourceTemplates: [],
			prompts: [],
		});
		expect(runtime.listTools).toHaveBeenCalledWith(
			expect.any(String),
			undefined,
			expect.objectContaining({ cacheMode: "refresh" }),
		);
		expect(runtime.listTools.mock.invocationCallOrder[0]).toBeLessThan(
			runtime.listResources.mock.invocationCallOrder[0]!,
		);
		expect(close).toHaveBeenCalledOnce();
		expect(manager.snapshot().connectionCount).toBe(0);
		await manager.close();
	});

	it("publishes bounded key-free state events and allows unsubscription", async () => {
		const events: McpRuntimeStateTransitionEvent[] = [];
		const listenerError = vi.fn();
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
			now: () => 1_700_000_000_000,
			onListenerError: listenerError,
		});
		const unsubscribe = manager.subscribe((event) => {
			events.push(event);
		});
		manager.subscribe(() => {
			throw new Error("diagnostic failure");
		});

		await expect(manager.ensureOnline("secret-generation-key")).resolves.toMatchObject({
			phase: "online",
		});
		expect(listenerError).toHaveBeenCalled();
		expect(events.map((event) => event.phase)).toEqual(["queued", "connecting", "online"]);
		for (const event of events) {
			expect(JSON.stringify(event)).not.toContain("secret-generation-key");
			expect(Object.keys(event)).not.toContain("generationKey");
		}

		unsubscribe();
		const eventCount = events.length;
		await manager.setOffline("secret-generation-key");
		expect(events).toHaveLength(eventCount);
		await manager.close();
	});

	it("passes one observer to every runtime without using generation keys as targets", async () => {
		const observer: McpLifecycleObserver = { onEvent: vi.fn() };
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => admitted()),
			maxConnections: 2,
			observer,
		});
		await manager.ensureOnline("customer-a:generation-1");
		await manager.ensureOnline("customer-b:generation-9");

		expect(runtimeHarness.instances).toHaveLength(2);
		for (const [index, runtime] of runtimeHarness.instances.entries()) {
			expect(runtime.options.observer).toBe(observer);
			const serverName = runtime.options.servers?.[0]?.name;
			expect(serverName).toMatch(/^managed-/);
			expect(serverName).not.toBe(
				index === 0 ? "customer-a:generation-1" : "customer-b:generation-9",
			);
		}
		await manager.close();
	});

	it("preserves host resolver failures for application-level error mapping", async () => {
		const hostError = Object.assign(new Error("retired by the host"), {
			code: "MCP_GENERATION_RETIRED",
			status: 409,
		});
		const manager = new McpRuntimeManager({
			generationResolver: resolverFrom(async () => Promise.reject(hostError)),
		});

		await expect(manager.ensureOnline("retired-generation")).rejects.toBe(hostError);
		expect(manager.state("retired-generation")).toMatchObject({
			phase: "failed",
			errorCode: "MCP_GENERATION_RETIRED",
		});
		await manager.close();
	});
});

function resolverFrom(
	resolve: (generationKey: string, signal: AbortSignal) => Promise<McpAdmittedRuntimeGeneration>,
): McpRuntimeGenerationResolver & { readonly resolve: ReturnType<typeof vi.fn> } {
	return { resolve: vi.fn(resolve) };
}

function admitted(
	close: () => Promise<void> = async () => undefined,
): McpAdmittedRuntimeGeneration {
	return Object.freeze({
		transport: Object.freeze({ kind: "http" as const, url: "https://mcp.example.test" }),
		close,
	});
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

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<never>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}
