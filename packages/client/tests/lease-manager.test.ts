import { describe, expect, it, vi } from "vitest";

import {
	MCP_CLIENT_LEASE_CAPACITY_EXCEEDED,
	MCP_CLIENT_LEASE_INVALIDATED,
	MCP_CLIENT_LEASE_MANAGER_CLOSED,
	MCP_CLIENT_LEASE_RELEASE_MODE_CONFLICT,
	McpClientLeaseManager,
} from "../src/index.ts";

interface TestResource {
	readonly id: string;
}

describe("McpClientLeaseManager", () => {
	it("notifies availability only after cleanup and isolates observer failures", async () => {
		const cleanup = deferred<void>();
		const observer = vi.fn(() => {
			throw new Error("observer");
		});
		const manager = new McpClientLeaseManager<string, TestResource>({
			maxResources: 1,
			create: async (id) => ({ id }),
			close: async () => cleanup.promise,
			onCapacityAvailable: observer,
		});
		expect(manager.canAcquire("a")).toBe(true);
		const lease = await manager.acquire("a");
		expect(manager.canAcquire("a")).toBe(true);
		expect(manager.canAcquire("b")).toBe(false);
		const closing = lease.release();
		expect(manager.canAcquire("a")).toBe(false);
		expect(observer).not.toHaveBeenCalled();
		cleanup.resolve();
		await closing;
		expect(observer).toHaveBeenCalledOnce();
		expect(manager.canAcquire("b")).toBe(true);
		await manager.close();
		expect(manager.canAcquire("b")).toBe(false);
	});

	it("deduplicates concurrent creation and maintains one reference per lease", async () => {
		const resource = { id: "shared" };
		const created = deferred<TestResource>();
		const create = vi.fn(async () => created.promise);
		const close = vi.fn(async () => undefined);
		const manager = new McpClientLeaseManager<string, TestResource>({ create, close });

		const firstLease = manager.acquire("stable-key", { releaseMode: "idle" });
		const secondLease = manager.acquire("stable-key", { releaseMode: "idle" });
		await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
		expect(manager.snapshot()).toMatchObject({
			resourceCount: 1,
			pendingResourceCount: 1,
			referenceCount: 2,
		});

		created.resolve(resource);
		const [first, second] = await Promise.all([firstLease, secondLease]);
		expect(first.resource).toBe(resource);
		expect(second.resource).toBe(resource);
		expect(manager.snapshot()).toMatchObject({
			activeResourceCount: 1,
			referenceCount: 2,
		});

		await first.release();
		expect(close).not.toHaveBeenCalled();
		expect(manager.snapshot().referenceCount).toBe(1);
		await second.release();
		expect(manager.snapshot()).toMatchObject({
			idleResourceCount: 1,
			referenceCount: 0,
		});
		await manager.close();
		expect(close).toHaveBeenCalledOnce();
	});

	it("keeps opaque identities isolated and diagnostics key-free", async () => {
		const close = vi.fn(async () => undefined);
		const manager = new McpClientLeaseManager<string, TestResource>({
			maxResources: 2,
			create: async (identity) => ({ id: `resource-for-${identity}` }),
			close,
		});
		const firstIdentity = "opaque-first-marker";
		const secondIdentity = "opaque-second-marker";

		const first = await manager.acquire(firstIdentity);
		const second = await manager.acquire(secondIdentity);
		expect(first.resource).not.toBe(second.resource);
		expect(JSON.stringify(manager.snapshot())).not.toContain(firstIdentity);
		expect(JSON.stringify(manager.snapshot())).not.toContain(secondIdentity);

		let capacityError: unknown;
		try {
			await manager.acquire("opaque-overflow-marker");
		} catch (error) {
			capacityError = error;
		}
		expect(capacityError).toMatchObject({ code: MCP_CLIENT_LEASE_CAPACITY_EXCEEDED });
		expect(String(capacityError)).not.toContain(firstIdentity);
		expect(String(capacityError)).not.toContain(secondIdentity);
		expect(manager.size).toBe(2);

		await Promise.all([first.release(), second.release()]);
		expect(close).toHaveBeenCalledTimes(2);
		await manager.close();
	});

	it("pins release mode and closes only after the final close-mode release", async () => {
		let generation = 0;
		const close = vi.fn(async () => undefined);
		const manager = new McpClientLeaseManager<string, TestResource>({
			create: async () => ({ id: `generation-${String(++generation)}` }),
			close,
		});
		const identity = "credential-bound-marker";
		const first = await manager.acquire(identity);
		const second = await manager.acquire(identity, { releaseMode: "close" });

		await expect(manager.acquire(identity, { releaseMode: "idle" })).rejects.toMatchObject({
			code: MCP_CLIENT_LEASE_RELEASE_MODE_CONFLICT,
		});
		await first.release();
		expect(close).not.toHaveBeenCalled();

		const finalRelease = second.release();
		expect(second.release()).toBe(finalRelease);
		await finalRelease;
		expect(second.released).toBe(true);
		expect(close).toHaveBeenCalledExactlyOnceWith(second.resource);
		expect(manager.size).toBe(0);

		const replacement = await manager.acquire(identity);
		expect(replacement.resource.id).toBe("generation-2");
		await replacement.release();
		await manager.close();
	});

	it("reuses anonymous resources until their idle TTL expires", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			let generation = 0;
			const close = vi.fn(async () => undefined);
			const manager = new McpClientLeaseManager<string, TestResource>({
				idleTtlMs: 1_000,
				create: async () => ({ id: `anonymous-${String(++generation)}` }),
				close,
			});

			const first = await manager.acquire("anonymous", { releaseMode: "idle" });
			await first.release();
			await vi.advanceTimersByTimeAsync(999);
			expect(close).not.toHaveBeenCalled();

			const reused = await manager.acquire("anonymous", { releaseMode: "idle" });
			expect(reused.resource).toBe(first.resource);
			await reused.release();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(close).toHaveBeenCalledExactlyOnceWith(first.resource);
			expect(manager.size).toBe(0);
			await manager.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("retires an active generation immediately and drains its leases before close", async () => {
		let generation = 0;
		const close = vi.fn(async () => undefined);
		const manager = new McpClientLeaseManager<string, TestResource>({
			create: async () => ({ id: `resource-${String(++generation)}` }),
			close,
		});
		const identity = "rotated-marker";
		const stale = await manager.acquire(identity);

		const invalidation = manager.invalidate(identity);
		expect(close).not.toHaveBeenCalled();
		expect(manager.snapshot()).toMatchObject({
			closingResourceCount: 1,
			referenceCount: 1,
		});

		const replacement = await manager.acquire(identity);
		expect(replacement.resource.id).toBe("resource-2");
		await stale.release();
		await expect(invalidation).resolves.toBe(true);
		expect(close).toHaveBeenCalledExactlyOnceWith(stale.resource);
		expect(manager.size).toBe(1);

		await replacement.release();
		expect(close).toHaveBeenCalledTimes(2);
		await manager.close();
	});

	it("rejects pending acquisition promptly and disposes a stale factory result", async () => {
		const staleCreated = deferred<TestResource>();
		const staleResource = { id: "stale" };
		const replacementResource = { id: "replacement" };
		const close = vi.fn(async () => undefined);
		let firstSignal: AbortSignal | undefined;
		let calls = 0;
		const manager = new McpClientLeaseManager<string, TestResource>({
			maxResources: 2,
			create: async (_identity, context) => {
				calls += 1;
				if (calls === 1) {
					firstSignal = context.signal;
					return staleCreated.promise;
				}
				return replacementResource;
			},
			close,
		});
		const identity = "pending-rotation-marker";
		const staleAcquisition = manager.acquire(identity);
		await vi.waitFor(() => expect(firstSignal).toBeDefined());

		const invalidation = manager.invalidate(identity);
		expect(firstSignal?.aborted).toBe(true);
		await expect(staleAcquisition).rejects.toMatchObject({
			code: MCP_CLIENT_LEASE_INVALIDATED,
		});
		const replacement = await manager.acquire(identity);
		expect(replacement.resource).toBe(replacementResource);

		staleCreated.resolve(staleResource);
		await expect(invalidation).resolves.toBe(true);
		expect(close).toHaveBeenCalledExactlyOnceWith(staleResource);
		expect(manager.snapshot()).toMatchObject({
			resourceCount: 1,
			activeResourceCount: 1,
		});

		await replacement.release();
		expect(close).toHaveBeenCalledWith(replacementResource);
		await manager.close();
	});

	it("rejects new identities at active capacity and admits after release", async () => {
		const close = vi.fn(async () => undefined);
		const manager = new McpClientLeaseManager<string, TestResource>({
			maxResources: 1,
			create: async (identity) => ({ id: identity }),
			close,
		});
		const active = await manager.acquire("active-marker");

		await expect(manager.acquire("overflow-marker")).rejects.toMatchObject({
			code: MCP_CLIENT_LEASE_CAPACITY_EXCEEDED,
		});
		expect(manager.size).toBe(1);
		await active.release();

		const admitted = await manager.acquire("admitted-marker");
		expect(admitted.resource.id).toBe("admitted-marker");
		await admitted.release();
		await manager.close();
	});

	it("evicts an idle resource to preserve the hard capacity bound", async () => {
		const close = vi.fn(async () => undefined);
		const manager = new McpClientLeaseManager<string, TestResource>({
			maxResources: 1,
			idleTtlMs: 60_000,
			create: async (identity) => ({ id: identity }),
			close,
		});
		const first = await manager.acquire("first", { releaseMode: "idle" });
		await first.release();

		const second = await manager.acquire("second", { releaseMode: "idle" });
		expect(close).toHaveBeenCalledExactlyOnceWith(first.resource);
		expect(manager.size).toBe(1);
		await second.release();
		await manager.close();
	});

	it("cancels one waiter without aborting a shared creation", async () => {
		const created = deferred<TestResource>();
		let factorySignal: AbortSignal | undefined;
		const close = vi.fn(async () => undefined);
		const manager = new McpClientLeaseManager<string, TestResource>({
			create: async (_identity, context) => {
				factorySignal = context.signal;
				return created.promise;
			},
			close,
		});
		const controller = new AbortController();
		const reason = new Error("caller stopped waiting");
		const cancelled = manager.acquire("shared", { signal: controller.signal });
		const retained = manager.acquire("shared");
		await vi.waitFor(() => expect(factorySignal).toBeDefined());

		controller.abort(reason);
		await expect(cancelled).rejects.toBe(reason);
		expect(factorySignal?.aborted).toBe(false);
		created.resolve({ id: "shared" });

		const lease = await retained;
		expect(manager.snapshot().referenceCount).toBe(1);
		await lease.release();
		await manager.close();
	});

	it("retires a creation when its only acquiring caller cancels", async () => {
		const created = deferred<TestResource>();
		const staleResource = { id: "cancelled" };
		let factorySignal: AbortSignal | undefined;
		const close = vi.fn(async () => undefined);
		const manager = new McpClientLeaseManager<string, TestResource>({
			create: async (_identity, context) => {
				factorySignal = context.signal;
				return created.promise;
			},
			close,
		});
		const controller = new AbortController();
		const reason = new Error("caller stopped waiting");
		const acquisition = manager.acquire("cancelled", {
			releaseMode: "idle",
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(factorySignal).toBeDefined());

		controller.abort(reason);
		await expect(acquisition).rejects.toBe(reason);
		expect(factorySignal?.aborted).toBe(true);
		expect(manager.snapshot().closingResourceCount).toBe(1);

		const shutdown = manager.close();
		created.resolve(staleResource);
		await shutdown;
		expect(close).toHaveBeenCalledExactlyOnceWith(staleResource);
	});

	it.each(["caller", "generation", "shutdown"] as const)(
		"waits for abandoned acquisition cleanup when opted in during %s cancellation",
		async (cancellation) => {
			const created = deferred<TestResource>();
			const allowClose = deferred<void>();
			const create = vi.fn(async () => created.promise);
			const close = vi.fn(async () => allowClose.promise);
			const manager = new McpClientLeaseManager<string, TestResource>({ create, close });
			const controller = new AbortController();
			const reason = new Error("cancelled acquisition");
			let settled = false;
			const acquisition = manager
				.acquire("isolated", {
					signal: controller.signal,
					awaitCleanupOnCancel: true,
				})
				.finally(() => {
					settled = true;
				});
			await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
			const rejected =
				cancellation === "caller"
					? expect(acquisition).rejects.toBe(reason)
					: expect(acquisition).rejects.toMatchObject({
							code:
								cancellation === "generation"
									? MCP_CLIENT_LEASE_INVALIDATED
									: MCP_CLIENT_LEASE_MANAGER_CLOSED,
						});
			const retirement =
				cancellation === "generation"
					? manager.invalidate("isolated")
					: cancellation === "shutdown"
						? manager.close()
						: undefined;
			if (cancellation === "caller") controller.abort(reason);
			created.resolve({ id: "isolated" });
			await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
			expect(settled).toBe(false);
			expect(manager.snapshot().closingResourceCount).toBe(1);
			allowClose.resolve();
			await Promise.all([rejected, retirement]);
			expect(manager.size).toBe(0);
			await manager.close();
		},
	);

	it("keeps opt-in acquisition cancellation local when another caller shares creation", async () => {
		const created = deferred<TestResource>();
		const create = vi.fn(async () => created.promise);
		const close = vi.fn(async () => undefined);
		const manager = new McpClientLeaseManager<string, TestResource>({ create, close });
		const caller = new AbortController();
		const reason = new Error("cancel just one");
		const first = manager.acquire("shared", { signal: caller.signal, awaitCleanupOnCancel: true });
		const second = manager.acquire("shared");
		const rejected = expect(first).rejects.toBe(reason);
		caller.abort(reason);
		await rejected;
		expect(manager.snapshot().referenceCount).toBe(1);
		expect(close).not.toHaveBeenCalled();
		created.resolve({ id: "shared" });
		await (await second).release();
		await manager.close();
	});

	it("aborts pending factories and settles every generation during idempotent shutdown", async () => {
		const pendingCreated = deferred<TestResource>();
		let pendingSignal: AbortSignal | undefined;
		const closedResources: string[] = [];
		const manager = new McpClientLeaseManager<string, TestResource>({
			maxResources: 2,
			create: async (identity, context) => {
				if (identity === "pending") {
					pendingSignal = context.signal;
					return pendingCreated.promise;
				}
				return { id: identity };
			},
			close: async (resource) => {
				closedResources.push(resource.id);
			},
		});
		const active = await manager.acquire("active", { releaseMode: "idle" });
		const pending = manager.acquire("pending");
		await vi.waitFor(() => expect(pendingSignal).toBeDefined());

		const firstClose = manager.close();
		expect(manager.close()).toBe(firstClose);
		expect(pendingSignal?.aborted).toBe(true);
		await expect(pending).rejects.toMatchObject({ code: MCP_CLIENT_LEASE_MANAGER_CLOSED });
		expect(manager.snapshot().closed).toBe(true);
		expect(closedResources).not.toContain("active");

		pendingCreated.resolve({ id: "pending" });
		await active.release();
		await firstClose;
		expect(closedResources).toEqual(expect.arrayContaining(["active", "pending"]));
		expect(closedResources).toHaveLength(2);
		await expect(manager.acquire("after-close")).rejects.toMatchObject({
			code: MCP_CLIENT_LEASE_MANAGER_CLOSED,
		});
		await expect(manager[Symbol.asyncDispose]()).resolves.toBeUndefined();
	});
});

function deferred<Value>(): {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value) => void;
} {
	let resolvePromise: ((value: Value) => void) | undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(value: Value): void {
			resolvePromise?.(value);
		},
	};
}
