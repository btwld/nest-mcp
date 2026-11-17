import { describe, expect, it, vi } from "vitest";

import {
	MCP_RUNTIME_GENERATION_FENCED,
	MCP_RUNTIME_MANAGER_CLOSED,
	MCP_RUNTIME_OWNER_RELEASED,
	MCP_RUNTIME_OWNERSHIP_CAPACITY_EXCEEDED,
	MCP_RUNTIME_OWNERSHIP_INVALID_OPTIONS,
	MCP_RUNTIME_RETIREMENT_FAILED,
	McpRuntimeManagerError,
	McpRuntimeOwnership,
	McpRuntimeOwnershipError,
	type McpRuntimeRetirementPort,
} from "../src/index.ts";

describe("McpRuntimeOwnership", () => {
	it("cooperatively retires only the final distinct owner reference", async () => {
		const retire = vi.fn(async () => undefined);
		const setOffline = vi.fn(async () => undefined);
		const manager = { retire, setOffline };
		const ownership = createOwnership(manager);
		const first = ownership.createOwner();
		const second = ownership.createOwner();

		const firstRetention = first.retain("shared-generation");
		expect(first.retain("shared-generation")).toBe(firstRetention);
		await Promise.all([firstRetention, second.retain("shared-generation")]);
		expect(Object.isFrozen(first)).toBe(true);
		expect(ownership.snapshot()).toMatchObject({
			ownerCount: 2,
			generationCount: 1,
			referenceCount: 2,
		});

		await first.release();
		expect(retire).not.toHaveBeenCalled();
		expect(ownership.snapshot()).toMatchObject({ ownerCount: 1, referenceCount: 1 });

		const release = second.release();
		expect(second.release()).toBe(release);
		await expect(release).resolves.toBeUndefined();
		expect(retire).toHaveBeenCalledExactlyOnceWith("shared-generation");
		expect(setOffline).not.toHaveBeenCalled();
		expect(ownership.snapshot()).toMatchObject({
			ownerCount: 0,
			generationCount: 0,
			referenceCount: 0,
		});
		await expect(second.retain("shared-generation")).rejects.toMatchObject({
			code: MCP_RUNTIME_OWNER_RELEASED,
		});
	});

	it("holds a cooperative retirement barrier and permits reuse only after it settles", async () => {
		const firstRetirement = deferred<void>();
		const retire = vi
			.fn<(key: string) => Promise<void>>()
			.mockImplementationOnce(async () => firstRetirement.promise)
			.mockResolvedValueOnce(undefined);
		const ownership = createOwnership({ retire });
		const releasing = ownership.createOwner();
		const waiting = ownership.createOwner();
		await releasing.retain("generation");

		const release = releasing.release();
		await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
		const waitingRetention = waiting.retain("generation");
		expect(waiting.retain("generation")).toBe(waitingRetention);
		expect(ownership.snapshot().pendingReferenceCount).toBe(1);
		expect(retire).toHaveBeenCalledOnce();

		firstRetirement.resolve();
		await Promise.all([release, waitingRetention]);
		expect(retire).toHaveBeenCalledOnce();
		await waiting.release();
		expect(retire).toHaveBeenCalledTimes(2);
	});

	it("marks release terminal while a bounded retain is waiting on a barrier", async () => {
		const retirement = deferred<void>();
		const retire = vi
			.fn<(key: string) => Promise<void>>()
			.mockImplementationOnce(async () => retirement.promise)
			.mockResolvedValueOnce(undefined);
		const ownership = createOwnership({ retire }, { maxReferences: 1 });
		const initial = ownership.createOwner();
		const waiting = ownership.createOwner();
		const other = ownership.createOwner();
		await initial.retain("generation");
		const initialRelease = initial.release();
		await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());

		const waitingRetention = waiting.retain("generation");
		expect(ownership.snapshot()).toMatchObject({
			referenceCount: 0,
			pendingReferenceCount: 1,
		});
		await expect(other.retain("other-generation")).rejects.toMatchObject({
			code: MCP_RUNTIME_OWNERSHIP_CAPACITY_EXCEEDED,
		});
		await waiting.release();
		await expect(waitingRetention).rejects.toMatchObject({ code: MCP_RUNTIME_OWNER_RELEASED });
		expect(ownership.snapshot().pendingReferenceCount).toBe(0);
		await other.retain("other-generation");

		retirement.resolve();
		await initialRelease;
		await other.release();
		expect(retire).toHaveBeenCalledTimes(2);
	});

	it("force retires current references and terminally fences every pre-existing owner", async () => {
		const retirement = deferred<void>();
		const retire = vi.fn(async () => retirement.promise);
		const ownership = createOwnership({ retire });
		const retained = ownership.createOwner();
		const preExisting = ownership.createOwner();
		await retained.retain("forced-generation");

		const forced = ownership.forceRetire("forced-generation");
		expect(ownership.forceRetire("forced-generation")).toBe(forced);
		const fresh = ownership.createOwner();
		await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
		expect(ownership.snapshot()).toMatchObject({
			referenceCount: 0,
			retiringGenerationCount: 1,
			fencedGenerationCount: 1,
		});
		const retainedAttempt = retained.retain("forced-generation");
		const preExistingAttempt = preExisting.retain("forced-generation");
		const freshAttempt = fresh.retain("forced-generation");
		expect(fresh.retain("forced-generation")).toBe(freshAttempt);
		expect(ownership.snapshot().pendingReferenceCount).toBe(3);

		retirement.resolve();
		await forced;
		await expect(retainedAttempt).rejects.toMatchObject({ code: MCP_RUNTIME_GENERATION_FENCED });
		await expect(preExistingAttempt).rejects.toMatchObject({
			code: MCP_RUNTIME_GENERATION_FENCED,
		});
		await freshAttempt;
		expect(ownership.snapshot()).toMatchObject({
			generationCount: 1,
			referenceCount: 1,
			fencedGenerationCount: 1,
		});

		await Promise.all([retained.release(), preExisting.release()]);
		await fresh.release();
		expect(retire).toHaveBeenCalledTimes(2);
	});

	it("advances the terminal fence on every force call sharing one retirement barrier", async () => {
		const retirement = deferred<void>();
		const retire = vi.fn(async () => retirement.promise);
		const ownership = createOwnership({ retire });
		const original = ownership.createOwner();
		await original.retain("generation");

		const firstForce = ownership.forceRetire("generation");
		const betweenForces = ownership.createOwner();
		const pendingRetention = betweenForces.retain("generation");
		await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());

		const secondForce = ownership.forceRetire("generation");
		expect(secondForce).toBe(firstForce);
		retirement.resolve();
		await Promise.all([firstForce, secondForce]);
		await expect(pendingRetention).rejects.toMatchObject({
			code: MCP_RUNTIME_GENERATION_FENCED,
		});

		const afterForces = ownership.createOwner();
		await afterForces.retain("generation");
		await Promise.all([original.release(), betweenForces.release()]);
		await afterForces.release();
		expect(retire).toHaveBeenCalledTimes(2);
	});

	it("does not overlap a forced replacement with its previous manager retirement", async () => {
		const firstRetirement = deferred<void>();
		const secondRetirement = deferred<void>();
		const retire = vi
			.fn<(key: string) => Promise<void>>()
			.mockImplementationOnce(async () => firstRetirement.promise)
			.mockImplementationOnce(async () => secondRetirement.promise);
		const ownership = createOwnership({ retire });
		const oldOwner = ownership.createOwner();

		const firstForce = ownership.forceRetire("generation");
		const replacementOwner = ownership.createOwner();
		const replacementRetention = replacementOwner.retain("generation");
		expect(retire).toHaveBeenCalledTimes(0);
		await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());

		firstRetirement.resolve();
		await Promise.all([firstForce, replacementRetention]);
		const secondForce = ownership.forceRetire("generation");
		await vi.waitFor(() => expect(retire).toHaveBeenCalledTimes(2));
		secondRetirement.resolve();
		await secondForce;
		await Promise.all([oldOwner.release(), replacementOwner.release()]);
	});

	it("escalates a cooperative barrier to a terminal force fence without duplicate retirement", async () => {
		const retirement = deferred<void>();
		const retire = vi.fn(async () => retirement.promise);
		const ownership = createOwnership({ retire });
		const releasing = ownership.createOwner();
		const spectator = ownership.createOwner();
		await releasing.retain("generation");
		const release = releasing.release();
		await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());

		const force = ownership.forceRetire("generation");
		expect(ownership.forceRetire("generation")).toBe(force);
		const fresh = ownership.createOwner();
		const spectatorRetention = spectator.retain("generation");
		const freshRetention = fresh.retain("generation");
		retirement.resolve();
		await Promise.all([release, force, freshRetention]);
		expect(retire).toHaveBeenCalledOnce();
		await expect(spectatorRetention).rejects.toMatchObject({
			code: MCP_RUNTIME_GENERATION_FENCED,
		});
		await Promise.all([spectator.release(), fresh.release()]);
		expect(retire).toHaveBeenCalledTimes(2);
	});

	it("keeps failed cleanup barriers terminal and rematerializes key-free failures", async () => {
		const secretKey = "private-generation-marker";
		const retire = vi.fn(async (key: string) => {
			throw new Error(`manager leaked ${key}`);
		});
		const ownership = createOwnership({ retire });
		const existing = ownership.createOwner();
		await existing.retain(secretKey);

		const forced = ownership.forceRetire(secretKey);
		expect(ownership.forceRetire(secretKey)).toBe(forced);
		const failure = await captureRejection(forced);
		expect(failure).toBeInstanceOf(McpRuntimeOwnershipError);
		expect(failure).toMatchObject({ code: MCP_RUNTIME_RETIREMENT_FAILED });
		expect(String(failure)).not.toContain(secretKey);
		expect(readCause(failure)).toBeUndefined();
		await expect(ownership.forceRetire(secretKey)).rejects.toBe(failure);

		const fresh = ownership.createOwner();
		for (const owner of [existing, fresh]) {
			await expect(owner.retain(secretKey)).rejects.toMatchObject({
				code: MCP_RUNTIME_GENERATION_FENCED,
			});
		}
		expect(ownership.snapshot()).toMatchObject({
			generationCount: 1,
			fencedGenerationCount: 1,
		});
		await Promise.all([existing.release(), fresh.release()]);
	});

	it("aggregates all final-release failures without retaining manager details", async () => {
		const retire = vi.fn(async (key: string) => {
			if (key !== "successful-generation") throw new Error(`secret ${key}`);
		});
		const ownership = createOwnership({ retire });
		const owner = ownership.createOwner();
		await Promise.all([
			owner.retain("successful-generation"),
			owner.retain("failed-generation-one"),
			owner.retain("failed-generation-two"),
		]);

		const release = owner.release();
		expect(owner.release()).toBe(release);
		const failure = await captureRejection(release);
		expect(failure).toBeInstanceOf(AggregateError);
		if (!(failure instanceof AggregateError)) throw new Error("Expected an aggregate failure.");
		const aggregate = failure;
		expect(aggregate.errors).toHaveLength(2);
		for (const error of aggregate.errors) {
			expect(error).toBeInstanceOf(McpRuntimeOwnershipError);
			expect(error).toMatchObject({ code: MCP_RUNTIME_RETIREMENT_FAILED });
		}
		const serialized = `${String(failure)} ${aggregate.errors.map(String).join(" ")}`;
		expect(serialized).not.toContain("failed-generation");
		expect(serialized).not.toContain("secret");
		expect(retire).toHaveBeenCalledTimes(3);
		expect(ownership.snapshot()).toMatchObject({
			ownerCount: 0,
			generationCount: 2,
			fencedGenerationCount: 2,
		});
	});

	it("treats manager closure as completed retirement", async () => {
		const retire = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(
				new McpRuntimeManagerError(MCP_RUNTIME_MANAGER_CLOSED, "The manager is closed."),
			)
			.mockRejectedValueOnce(Object.freeze({ code: MCP_RUNTIME_MANAGER_CLOSED }));
		const ownership = createOwnership({ retire });
		const owner = ownership.createOwner();
		await owner.retain("cooperative-generation");

		await expect(owner.release()).resolves.toBeUndefined();
		await expect(ownership.forceRetire("forced-generation")).resolves.toBeUndefined();
		expect(retire).toHaveBeenCalledTimes(2);
		expect(ownership.snapshot()).toMatchObject({
			generationCount: 0,
			fencedGenerationCount: 0,
		});
	});

	it("enforces owner, generation, and reference bounds with key-free snapshots", async () => {
		const ownership = createOwnership(
			{ retire: vi.fn(async () => undefined) },
			{ maxOwners: 2, maxGenerations: 1, maxReferences: 1 },
		);
		const first = ownership.createOwner();
		const second = ownership.createOwner();
		expect(() => ownership.createOwner()).toThrowError(
			expect.objectContaining({ code: MCP_RUNTIME_OWNERSHIP_CAPACITY_EXCEEDED }),
		);

		await first.retain("not-visible-in-snapshot");
		await expect(second.retain("not-visible-in-snapshot")).rejects.toMatchObject({
			code: MCP_RUNTIME_OWNERSHIP_CAPACITY_EXCEEDED,
		});
		await expect(second.retain("another-private-key")).rejects.toMatchObject({
			code: MCP_RUNTIME_OWNERSHIP_CAPACITY_EXCEEDED,
		});

		const snapshot = ownership.snapshot();
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(snapshot).toEqual({
			maxOwners: 2,
			maxGenerations: 1,
			maxReferences: 1,
			ownerCount: 2,
			generationCount: 1,
			referenceCount: 1,
			pendingReferenceCount: 0,
			retiringGenerationCount: 0,
			fencedGenerationCount: 0,
		});
		expect(JSON.stringify(snapshot)).not.toContain("not-visible-in-snapshot");
		await Promise.all([first.release(), second.release()]);
	});

	it("keeps terminal failures charged against generation capacity", async () => {
		const ownership = createOwnership(
			{ retire: vi.fn(async () => Promise.reject(new Error("cleanup failed"))) },
			{ maxGenerations: 1 },
		);
		await expect(ownership.forceRetire("failed-generation")).rejects.toMatchObject({
			code: MCP_RUNTIME_RETIREMENT_FAILED,
		});
		const owner = ownership.createOwner();
		await expect(owner.retain("different-generation")).rejects.toMatchObject({
			code: MCP_RUNTIME_OWNERSHIP_CAPACITY_EXCEEDED,
		});
		await owner.release();
	});

	it("reports force-retirement capacity through its promised lifecycle boundary", async () => {
		const retirement = deferred<void>();
		const ownership = createOwnership(
			{ retire: vi.fn(async () => retirement.promise) },
			{ maxGenerations: 1 },
		);
		const first = ownership.forceRetire("first-generation");

		let second: Promise<void> | undefined;
		expect(() => {
			second = ownership.forceRetire("second-generation");
		}).not.toThrow();
		await expect(second).rejects.toMatchObject({
			code: MCP_RUNTIME_OWNERSHIP_CAPACITY_EXCEEDED,
		});

		retirement.resolve();
		await first;
	});

	it.each([
		undefined,
		null,
		{},
		{ manager: {} },
		{ manager: { retire: async () => undefined }, maxOwners: 0 },
		{ manager: { retire: async () => undefined }, maxGenerations: 1.5 },
		{ manager: { retire: async () => undefined }, maxReferences: Number.POSITIVE_INFINITY },
	])("rejects invalid options without reflecting their contents: %j", (options) => {
		let failure: unknown;
		try {
			Reflect.construct(McpRuntimeOwnership, [options]);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(McpRuntimeOwnershipError);
		expect(failure).toMatchObject({ code: MCP_RUNTIME_OWNERSHIP_INVALID_OPTIONS });
	});
});

function createOwnership(
	manager: McpRuntimeRetirementPort<string>,
	limits: {
		readonly maxOwners?: number;
		readonly maxGenerations?: number;
		readonly maxReferences?: number;
	} = {},
): McpRuntimeOwnership<string> {
	return new McpRuntimeOwnership({ manager, ...limits });
}

function deferred<Value>() {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("Expected the promise to reject.");
}

function readCause(error: unknown): unknown {
	if (typeof error !== "object" || error === null) return undefined;
	return Reflect.get(error, "cause");
}
