import { describe, expect, it, vi } from "vitest";

import {
	McpClientOAuthCredentialInvalidationReason,
	createMcpClientOAuthCredentialRevision,
	createMcpClientOAuthCredentialSnapshot,
	nextMcpClientOAuthCredentialRevision,
	type McpClientOAuthCredentialSnapshot,
	type McpClientOAuthCredentialStore,
	type McpClientOAuthRefreshClaimId,
} from "../src/oauth/credential-store.ts";
import { markInternalMcpClientOAuthProtocolError } from "../src/oauth/protocol-error-brand.ts";
import {
	McpClientOAuthProtocolError,
	McpClientOAuthProtocolErrorCode,
} from "../src/oauth/protocol.ts";
import {
	McpClientOAuthRefreshCoordinator,
	McpClientOAuthRefreshError,
	McpClientOAuthRefreshErrorCode,
	type McpClientOAuthInvalidatedContext,
} from "../src/oauth/refresh-coordinator.ts";

interface TestCredential {
	readonly accessToken: string;
	readonly refreshToken: string;
}

describe("OAuth credential revisions", () => {
	it("accepts only exact positive safe revisions and freezes snapshot wrappers", () => {
		const credential = { accessToken: "access", refreshToken: "refresh" };
		const first = createMcpClientOAuthCredentialRevision(1);
		const snapshot = createMcpClientOAuthCredentialSnapshot(first, credential);

		expect(first).toBe(1);
		expect(nextMcpClientOAuthCredentialRevision(first)).toBe(2);
		expect(snapshot).toEqual({ revision: 1, credential });
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(snapshot.credential).toBe(credential);

		for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => createMcpClientOAuthCredentialRevision(invalid)).toThrow(RangeError);
		}
		expect(() => createMcpClientOAuthCredentialRevision(Number.MAX_SAFE_INTEGER + 1)).toThrow(
			RangeError,
		);
		expect(() =>
			nextMcpClientOAuthCredentialRevision(
				createMcpClientOAuthCredentialRevision(Number.MAX_SAFE_INTEGER),
			),
		).toThrow(RangeError);
	});
});

describe("McpClientOAuthRefreshCoordinator", () => {
	it.each([null, undefined])("rejects runtime options value %s with its typed error", (options) => {
		let thrown: unknown;
		try {
			Reflect.construct(McpClientOAuthRefreshCoordinator, [options]);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(McpClientOAuthRefreshError);
		expect(thrown).toMatchObject({ code: McpClientOAuthRefreshErrorCode.InvalidOptions });
	});

	it("singleflights one opaque key and exact revision and atomically persists the full rotation", async () => {
		const initial = credentialSnapshot(1, "old-access", "old-refresh");
		const memory = createMemoryStore([["credential-key", initial]]);
		const rotated = deferred<Readonly<TestCredential>>();
		const onInvalidated = vi.fn(async () => undefined);
		let sharedSignal: AbortSignal | undefined;
		const refresh = vi.fn(
			async (
				_identity: string,
				_current: McpClientOAuthCredentialSnapshot<TestCredential>,
				context: { readonly signal: AbortSignal },
			) => {
				sharedSignal = context.signal;
				return rotated.promise;
			},
		);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh,
			onInvalidated,
		});

		const first = coordinator.refresh("credential-key", initial.revision);
		const second = coordinator.refresh("credential-key", initial.revision);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
		expect(memory.claimRefresh).toHaveBeenCalledOnce();
		expect(memory.load).not.toHaveBeenCalled();
		expect(sharedSignal?.aborted).toBe(false);
		expect(coordinator.snapshot()).toMatchObject({
			inFlightKeyCount: 1,
			refreshCount: 1,
			waiterCount: 2,
		});

		const completeRotation = {
			accessToken: "new-access",
			refreshToken: "new-rotated-refresh",
		};
		rotated.resolve(completeRotation);
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult).toBe(secondResult);
		expect(firstResult).toEqual({ revision: 2, credential: completeRotation });
		expect(memory.commitRefresh).toHaveBeenCalledExactlyOnceWith(
			"credential-key",
			initial.revision,
			expect.objectContaining({ value: expect.any(String) }),
			completeRotation,
			expect.objectContaining({ signal: expect.anything() }),
		);
		expect(onInvalidated).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(coordinator.snapshot().inFlightKeyCount).toBe(0));
		await coordinator.close();
	});

	it("durably claims before dispatch so two coordinators invoke refresh only once", async () => {
		const identity = "cross-process-key";
		const initial = credentialSnapshot(1, "access", "refresh");
		const memory = createMemoryStore([[identity, initial]]);
		const rotated = deferred<Readonly<TestCredential>>();
		const refresh = vi.fn(async () => rotated.promise);
		const firstCoordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh,
		});
		const secondCoordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh,
		});

		const winner = firstCoordinator.refresh(identity, initial.revision);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
		await expect(secondCoordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.RevisionInFlight,
		});
		expect(refresh).toHaveBeenCalledOnce();
		expect(memory.claimRefresh).toHaveBeenCalledTimes(2);
		expect(memory.load).toHaveBeenCalledOnce();

		rotated.resolve({ accessToken: "new-access", refreshToken: "rotated-refresh" });
		await expect(winner).resolves.toMatchObject({ revision: 2 });
		expect(refresh).toHaveBeenCalledOnce();
		await Promise.all([firstCoordinator.close(), secondCoordinator.close()]);
	});

	it("notifies external disappearance when the expected generation is initially missing", async () => {
		const identity = "missing-key";
		const revision = createMcpClientOAuthCredentialRevision(7);
		const load = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>()
			.mockResolvedValue(undefined);
		const commitRefresh =
			vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]>();
		const invalidate = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>();
		const refresh = vi.fn(async () => ({ accessToken: "unused", refreshToken: "unused" }));
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh,
			onInvalidated,
		});

		await expect(coordinator.refresh(identity, revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialMissing,
		});
		expect(load).toHaveBeenCalledTimes(2);
		expect(refresh).not.toHaveBeenCalled();
		expect(commitRefresh).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
		expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(identity, {
			revision,
			reason: McpClientOAuthCredentialInvalidationReason.ObservedExternal,
		});
		await coordinator.close();
	});

	it("isolates caller cancellation from retained shared refresh work", async () => {
		const initial = credentialSnapshot(1, "access", "refresh");
		const memory = createMemoryStore([["shared-key", initial]]);
		const rotated = deferred<Readonly<TestCredential>>();
		let sharedSignal: AbortSignal | undefined;
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async (_identity, _current, context) => {
				sharedSignal = context.signal;
				return rotated.promise;
			},
		});
		const caller = new AbortController();
		const cancelled = coordinator.refresh("shared-key", initial.revision, {
			signal: caller.signal,
		});
		const retained = coordinator.refresh("shared-key", initial.revision);
		await vi.waitFor(() => expect(sharedSignal).toBeDefined());

		const callerDetail = "caller-error-secret-marker";
		caller.abort(new Error(callerDetail));
		const cancelledError = await captureRejection(cancelled);
		expect(cancelledError).toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CallerAborted,
		});
		expect(String(cancelledError)).not.toContain(callerDetail);
		expect(sharedSignal?.aborted).toBe(false);

		rotated.resolve({ accessToken: "new-access", refreshToken: "new-refresh" });
		await expect(retained).resolves.toMatchObject({ revision: 2 });
		expect(memory.commitRefresh).toHaveBeenCalledOnce();
		await coordinator.close();
	});

	it("reloads a cross-process CAS winner without retrying the rotated refresh token", async () => {
		const initial = credentialSnapshot(4, "old-access", "old-refresh-token");
		const winner = credentialSnapshot(5, "winner-access", "winner-refresh-token");
		const load = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>()
			.mockResolvedValueOnce(initial)
			.mockResolvedValueOnce(winner);
		const commitRefresh = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]>()
			.mockResolvedValue({ status: "conflict" });
		const invalidate = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>()
			.mockResolvedValue({ status: "conflict" });
		const refresh = vi.fn(async () => ({
			accessToken: "loser-access",
			refreshToken: "loser-rotated-refresh-token",
		}));
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh,
			onInvalidated,
		});

		const result = await coordinator.refresh("cas-key", initial.revision);
		expect(result).toEqual(winner);
		expect(refresh).toHaveBeenCalledOnce();
		expect(commitRefresh).toHaveBeenCalledExactlyOnceWith(
			"cas-key",
			initial.revision,
			expect.objectContaining({ value: expect.any(String) }),
			{
				accessToken: "loser-access",
				refreshToken: "loser-rotated-refresh-token",
			},
			expect.any(Object),
		);
		expect(load).toHaveBeenCalledTimes(2);
		expect(invalidate).not.toHaveBeenCalled();
		expect(onInvalidated).not.toHaveBeenCalled();
		await coordinator.close();
	});

	it("notifies external disappearance when an ordinary CAS conflict reload is missing", async () => {
		const identity = "disappeared-after-cas-key";
		const initial = credentialSnapshot(4, "old-access", "old-refresh");
		const load = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>()
			.mockResolvedValueOnce(initial)
			.mockResolvedValueOnce(undefined);
		const commitRefresh = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]>()
			.mockResolvedValue({ status: "conflict" });
		const invalidate = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>();
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh: async () => ({ accessToken: "new-access", refreshToken: "rotated-refresh" }),
			onInvalidated,
		});

		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		expect(load).toHaveBeenCalledTimes(2);
		expect(commitRefresh).toHaveBeenCalledOnce();
		expect(invalidate).not.toHaveBeenCalled();
		expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(identity, {
			revision: initial.revision,
			reason: McpClientOAuthCredentialInvalidationReason.ObservedExternal,
		});
		await coordinator.close();
	});

	it("accepts an authoritative newer winner after an ambiguous commit without replay", async () => {
		const identity = "ambiguous-commit-winner-key";
		const initial = credentialSnapshot(4, "old-access", "old-refresh");
		const winner = credentialSnapshot(5, "winner-access", "winner-refresh");
		let current = initial;
		const load = vi.fn<TestCredentialStore["load"]>(async () => current);
		const commitRefresh = vi.fn<TestCredentialStore["commitRefresh"]>(async () => {
			current = winner;
			throw new Error("ambiguous-store-detail");
		});
		const invalidate = vi.fn<TestCredentialStore["invalidate"]>();
		const refresh = vi.fn(async () => ({
			accessToken: "candidate-access",
			refreshToken: "candidate-refresh",
		}));
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh,
			onInvalidated,
		});

		await expect(coordinator.refresh(identity, initial.revision)).resolves.toEqual(winner);
		await expect(coordinator.refresh(identity, initial.revision)).resolves.toEqual(winner);
		expect(refresh).toHaveBeenCalledOnce();
		expect(commitRefresh).toHaveBeenCalledOnce();
		expect(invalidate).not.toHaveBeenCalled();
		expect(onInvalidated).not.toHaveBeenCalled();
		await coordinator.close();
	});

	it("invalidates an old revision still visible after an ambiguous commit and never replays", async () => {
		const identity = "ambiguous-commit-old-key";
		const initial = credentialSnapshot(6, "old-access", "old-refresh");
		let current: McpClientOAuthCredentialSnapshot<TestCredential> | undefined = initial;
		const load = vi.fn<TestCredentialStore["load"]>(async () => current);
		const commitRefresh = vi.fn<TestCredentialStore["commitRefresh"]>(async () => {
			throw new Error("ambiguous-commit-marker");
		});
		const invalidate = vi.fn<TestCredentialStore["invalidate"]>(
			async (_identity, expectedRevision) => {
				if (current?.revision !== expectedRevision) return { status: "conflict" };
				current = undefined;
				return { status: "applied" };
			},
		);
		const refresh = vi.fn(async () => ({
			accessToken: "candidate-access",
			refreshToken: "candidate-refresh",
		}));
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh,
			onInvalidated,
		});

		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		expect(invalidate).toHaveBeenCalledExactlyOnceWith(
			identity,
			initial.revision,
			McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			expect.any(Object),
		);
		expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(identity, {
			revision: initial.revision,
			reason: McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
		});

		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialMissing,
		});
		expect(refresh).toHaveBeenCalledOnce();
		await coordinator.close();
	});

	it("keeps a local terminal fence when ambiguous commit invalidation is unavailable", async () => {
		const identity = "fail-closed-commit-key";
		const initial = credentialSnapshot(1, "old-access", "old-refresh");
		const load = vi.fn<TestCredentialStore["load"]>(async () => initial);
		const commitRefresh = vi.fn<TestCredentialStore["commitRefresh"]>(async () => {
			throw new Error("ambiguous-commit-marker");
		});
		const invalidate = vi.fn<TestCredentialStore["invalidate"]>(async () => {
			throw new Error("unavailable-store-marker");
		});
		const refresh = vi.fn(async () => ({
			accessToken: "candidate-access",
			refreshToken: "candidate-refresh",
		}));
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh,
			onInvalidated,
		});

		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.StoreFailed,
		});
		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		await expect(
			coordinator.refresh(identity, nextMcpClientOAuthCredentialRevision(initial.revision)),
		).rejects.toMatchObject({ code: McpClientOAuthRefreshErrorCode.InvalidStoreResult });
		expect(refresh).toHaveBeenCalledOnce();
		expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(identity, {
			revision: initial.revision,
			reason: McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
		});
		await coordinator.close();
	});

	it("terminally settles an ambiguous durable claim before any refresh dispatch", async () => {
		const identity = "ambiguous-claim-key";
		const initial = credentialSnapshot(3, "access", "refresh");
		let current: McpClientOAuthCredentialSnapshot<TestCredential> | undefined = initial;
		const load = vi.fn<TestCredentialStore["load"]>(async () => current);
		const claimRefresh = vi.fn<TestCredentialStore["claimRefresh"]>(async () => {
			throw new Error("ambiguous-claim-marker");
		});
		const invalidate = vi.fn<TestCredentialStore["invalidate"]>(
			async (_identity, expectedRevision) => {
				if (current?.revision !== expectedRevision) return { status: "conflict" };
				current = undefined;
				return { status: "applied" };
			},
		);
		const refresh = vi.fn(async () => ({ accessToken: "unused", refreshToken: "unused" }));
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, claimRefresh, invalidate }),
			refresh,
		});

		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		expect(refresh).not.toHaveBeenCalled();
		expect(invalidate).toHaveBeenCalledExactlyOnceWith(
			identity,
			initial.revision,
			McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			expect.any(Object),
		);
		await coordinator.close();
	});

	it("terminally invalidates an unclassified refresh throw without exposing its details", async () => {
		const identity = "opaque-identity-marker";
		const token = "refresh-token-secret-marker";
		const upstreamDetail = "upstream-error-detail-marker";
		const initial = credentialSnapshot(9, "access-token-marker", token);
		const memory = createMemoryStore([[identity, initial]]);
		const onInvalidated = vi.fn(
			async (_identity: string, _context: McpClientOAuthInvalidatedContext) => undefined,
		);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async () => {
				throw {
					code: "invalid_grant",
					error_description: upstreamDetail,
					refresh_token: token,
				};
			},
			onInvalidated,
		});

		const error = await captureRejection(coordinator.refresh(identity, initial.revision));
		expect(error).toBeInstanceOf(McpClientOAuthRefreshError);
		expect(error).toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		for (const marker of [identity, token, upstreamDetail, "access-token-marker"]) {
			expect(String(error)).not.toContain(marker);
			expect(JSON.stringify(error)).not.toContain(marker);
		}
		expect(memory.invalidate).toHaveBeenCalledExactlyOnceWith(
			identity,
			initial.revision,
			McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			expect.any(Object),
		);
		expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(identity, {
			revision: initial.revision,
			reason: McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
		});
		expect(Object.isFrozen(onInvalidated.mock.calls[0]?.[1])).toBe(true);
		expect(memory.records.has(identity)).toBe(false);
		expect(JSON.stringify(coordinator.snapshot())).not.toContain(identity);
		expect(JSON.stringify(coordinator.snapshot())).not.toContain(token);
		await coordinator.close();
	});

	it("classifies the strict protocol invalid_grant error as terminal", async () => {
		const identity = "strict-protocol-key";
		const initial = credentialSnapshot(3, "access", "refresh");
		const memory = createMemoryStore([[identity, initial]]);
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async () => {
				throw markInternalMcpClientOAuthProtocolError(
					new McpClientOAuthProtocolError(
						McpClientOAuthProtocolErrorCode.InvalidGrant,
						"Sanitized strict protocol failure.",
					),
				);
			},
			onInvalidated,
		});

		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		expect(memory.invalidate).toHaveBeenCalledExactlyOnceWith(
			identity,
			initial.revision,
			McpClientOAuthCredentialInvalidationReason.InvalidGrant,
			expect.any(Object),
		);
		expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(identity, {
			revision: initial.revision,
			reason: McpClientOAuthCredentialInvalidationReason.InvalidGrant,
		});
		await coordinator.close();
	});

	it("invalidates the exact revision when the strict refresh outcome is unknown", async () => {
		const identity = "unknown-outcome-key";
		const initial = credentialSnapshot(5, "access", "refresh");
		const memory = createMemoryStore([[identity, initial]]);
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async () => {
				throw markInternalMcpClientOAuthProtocolError(
					new McpClientOAuthProtocolError(
						McpClientOAuthProtocolErrorCode.RefreshOutcomeUnknown,
						"The refresh outcome is unknown.",
					),
				);
			},
			onInvalidated,
		});

		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		expect(memory.invalidate).toHaveBeenCalledExactlyOnceWith(
			identity,
			initial.revision,
			McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			expect.any(Object),
		);
		expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(identity, {
			revision: initial.revision,
			reason: McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
		});
		await coordinator.close();
	});

	it("treats a strict invalid_client response as terminal because a token POST was dispatched", async () => {
		const identity = "strict-invalid-client-key";
		const initial = credentialSnapshot(5, "access", "refresh");
		const memory = createMemoryStore([[identity, initial]]);
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async () => {
				throw markInternalMcpClientOAuthProtocolError(
					new McpClientOAuthProtocolError(
						McpClientOAuthProtocolErrorCode.InvalidClient,
						"The token endpoint rejected client authentication.",
					),
				);
			},
			onInvalidated,
		});

		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		expect(memory.invalidate).toHaveBeenCalledExactlyOnceWith(
			identity,
			initial.revision,
			McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			expect.any(Object),
		);
		expect(memory.releaseRefreshClaim).not.toHaveBeenCalled();
		expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(identity, {
			revision: initial.revision,
			reason: McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
		});
		await coordinator.close();
	});

	it("releases a claim only for a trusted retry-safe strict-protocol failure", async () => {
		const identity = "retry-safe-key";
		const initial = credentialSnapshot(2, "access", "refresh");
		const memory = createMemoryStore([[identity, initial]]);
		const refresh = vi
			.fn<() => Promise<Readonly<TestCredential>>>()
			.mockRejectedValueOnce(
				markInternalMcpClientOAuthProtocolError(
					new McpClientOAuthProtocolError(
						McpClientOAuthProtocolErrorCode.TokenRefreshFailed,
						"A definitive pre-dispatch failure.",
					),
				),
			)
			.mockResolvedValueOnce({ accessToken: "new-access", refreshToken: "new-refresh" });
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh,
			onInvalidated,
		});

		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.RefreshFailed,
		});
		expect(memory.releaseRefreshClaim).toHaveBeenCalledOnce();
		expect(memory.invalidate).not.toHaveBeenCalled();
		expect(onInvalidated).not.toHaveBeenCalled();

		await expect(coordinator.refresh(identity, initial.revision)).resolves.toMatchObject({
			revision: 3,
		});
		expect(refresh).toHaveBeenCalledTimes(2);
		await coordinator.close();
	});

	it("does not trust a public protocol-error constructor to declare a retry-safe outcome", async () => {
		const marker = "spoofed-protocol-message-marker";
		const identity = "untrusted-protocol-key";
		const initial = credentialSnapshot(1, "access", "refresh");
		const memory = createMemoryStore([[identity, initial]]);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async () => {
				throw new McpClientOAuthProtocolError(
					McpClientOAuthProtocolErrorCode.TokenRefreshFailed,
					marker,
				);
			},
		});

		const error = await captureRejection(coordinator.refresh(identity, initial.revision));
		expect(error).toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		expect(String(error)).not.toContain(marker);
		expect(memory.invalidate).toHaveBeenCalledExactlyOnceWith(
			identity,
			initial.revision,
			McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			expect.any(Object),
		);
		expect(memory.releaseRefreshClaim).not.toHaveBeenCalled();
		await coordinator.close();
	});

	it("terminally invalidates a malformed resolved replacement and never replays it", async () => {
		const identity = "malformed-replacement-key";
		const initial = credentialSnapshot(1, "access", "refresh");
		const memory = createMemoryStore([[identity, initial]]);
		const refresh = vi.fn(async () => null!);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh,
		});

		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		expect(memory.invalidate).toHaveBeenCalledExactlyOnceWith(
			identity,
			initial.revision,
			McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			expect.any(Object),
		);
		await expect(coordinator.refresh(identity, initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialMissing,
		});
		expect(refresh).toHaveBeenCalledOnce();
		await coordinator.close();
	});

	it("uses a custom terminal classifier but never exposes its source failure", async () => {
		const initial = credentialSnapshot(1, "access", "refresh");
		const memory = createMemoryStore([["terminal-key", initial]]);
		const rawError = new Error("terminal-classifier-secret-marker");
		const classifyRefreshFailure = vi.fn(() => ({
			kind: "terminal" as const,
			reason: McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
		}));
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async () => {
				throw rawError;
			},
			classifyRefreshFailure,
		});

		const error = await captureRejection(coordinator.refresh("terminal-key", initial.revision));
		expect(classifyRefreshFailure).toHaveBeenCalledExactlyOnceWith(rawError);
		expect(error).toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		expect(String(error)).not.toContain("terminal-classifier-secret-marker");
		expect(memory.invalidate).toHaveBeenCalledWith(
			"terminal-key",
			initial.revision,
			McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			expect.any(Object),
		);
		await coordinator.close();
	});

	it("joins explicit invalidation to terminal settlement with one store mutation and hook", async () => {
		const identity = "settling-key";
		const initial = credentialSnapshot(8, "access", "refresh");
		const invalidationStarted = deferred<void>();
		const allowInvalidation = deferred<void>();
		let storeSignal: AbortSignal | undefined;
		const load = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>()
			.mockResolvedValue(initial);
		const commitRefresh =
			vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]>();
		const invalidate = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>(
			async (_identity, _revision, _reason, context) => {
				storeSignal = context.signal;
				invalidationStarted.resolve();
				await allowInvalidation.promise;
				return { status: "applied" };
			},
		);
		const onInvalidated = vi.fn(
			async (_identity: string, _context: McpClientOAuthInvalidatedContext) => undefined,
		);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh: async () => {
				throw { code: "invalid_grant" };
			},
			onInvalidated,
		});
		const refreshing = coordinator.refresh(identity, initial.revision);
		await invalidationStarted.promise;

		const caller = new AbortController();
		const cancelled = coordinator.invalidate(identity, initial.revision, {
			reason: McpClientOAuthCredentialInvalidationReason.Explicit,
			signal: caller.signal,
		});
		const retained = coordinator.invalidate(identity, initial.revision, {
			reason: McpClientOAuthCredentialInvalidationReason.Explicit,
		});
		caller.abort(new Error("settling-caller-detail"));
		await expect(cancelled).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CallerAborted,
		});
		expect(storeSignal?.aborted).toBe(false);
		expect(invalidate).toHaveBeenCalledOnce();
		expect(coordinator.snapshot()).toMatchObject({
			refreshCount: 1,
			invalidationCount: 0,
			waiterCount: 2,
		});

		allowInvalidation.resolve();
		await expect(refreshing).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		await expect(retained).resolves.toEqual({ status: "invalidated" });
		expect(invalidate).toHaveBeenCalledExactlyOnceWith(
			identity,
			initial.revision,
			McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			expect.any(Object),
		);
		expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(identity, {
			revision: initial.revision,
			reason: McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
		});
		await coordinator.close();
	});

	it("lets explicit invalidation own notification when a claimed refresh is committing", async () => {
		const identity = "committing-invalidation-key";
		const initial = credentialSnapshot(8, "access", "refresh");
		let current: McpClientOAuthCredentialSnapshot<TestCredential> | undefined = initial;
		const commitStarted = deferred<void>();
		const allowCommit = deferred<void>();
		const load = vi.fn<TestCredentialStore["load"]>(async () => current);
		const commitRefresh = vi.fn<TestCredentialStore["commitRefresh"]>(async () => {
			commitStarted.resolve();
			await allowCommit.promise;
			return { status: "conflict" };
		});
		const invalidate = vi.fn<TestCredentialStore["invalidate"]>(
			async (_identity, expectedRevision) => {
				if (current?.revision !== expectedRevision) return { status: "conflict" };
				current = undefined;
				return { status: "applied" };
			},
		);
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh: async () => ({ accessToken: "new-access", refreshToken: "new-refresh" }),
			onInvalidated,
		});
		const refreshing = coordinator.refresh(identity, initial.revision);
		const refreshFailure = captureRejection(refreshing);
		await commitStarted.promise;

		const invalidating = coordinator.invalidate(identity, initial.revision, {
			reason: McpClientOAuthCredentialInvalidationReason.Explicit,
		});
		await vi.waitFor(() => expect(onInvalidated).toHaveBeenCalledOnce());
		await expect(refreshFailure).resolves.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		allowCommit.resolve();
		await expect(invalidating).resolves.toEqual({ status: "invalidated" });
		expect(invalidate).toHaveBeenCalledOnce();
		expect(load).toHaveBeenCalledOnce();
		expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(identity, {
			revision: initial.revision,
			reason: McpClientOAuthCredentialInvalidationReason.Explicit,
		});
		await coordinator.close();
	});

	it("does not join explicit invalidation to a retry-safe claim release", async () => {
		const identity = "releasing-invalidation-key";
		const initial = credentialSnapshot(9, "access", "refresh");
		let current: McpClientOAuthCredentialSnapshot<TestCredential> | undefined = initial;
		const releaseStarted = deferred<void>();
		const allowRelease = deferred<void>();
		const load = vi.fn<TestCredentialStore["load"]>(async () => current);
		const releaseRefreshClaim = vi.fn<TestCredentialStore["releaseRefreshClaim"]>(async () => {
			releaseStarted.resolve();
			await allowRelease.promise;
			return current === undefined ? { status: "conflict" } : { status: "released" };
		});
		const invalidate = vi.fn<TestCredentialStore["invalidate"]>(
			async (_identity, expectedRevision) => {
				if (current?.revision !== expectedRevision) return { status: "conflict" };
				current = undefined;
				return { status: "applied" };
			},
		);
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, releaseRefreshClaim, invalidate }),
			refresh: async () => {
				throw markInternalMcpClientOAuthProtocolError(
					new McpClientOAuthProtocolError(
						McpClientOAuthProtocolErrorCode.TokenRefreshFailed,
						"A definitive pre-dispatch failure.",
					),
				);
			},
			onInvalidated,
		});
		const refreshing = coordinator.refresh(identity, initial.revision);
		const refreshFailure = captureRejection(refreshing);
		await releaseStarted.promise;

		const invalidating = coordinator.invalidate(identity, initial.revision);
		await vi.waitFor(() => expect(onInvalidated).toHaveBeenCalledOnce());
		allowRelease.resolve();
		await expect(refreshFailure).resolves.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		await expect(invalidating).resolves.toEqual({ status: "invalidated" });
		expect(releaseRefreshClaim).toHaveBeenCalledOnce();
		expect(invalidate).toHaveBeenCalledOnce();
		expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(identity, {
			revision: initial.revision,
			reason: McpClientOAuthCredentialInvalidationReason.Explicit,
		});
		await coordinator.close();
	});

	it("returns a newer winner when terminal invalidation loses its exact CAS", async () => {
		const initial = credentialSnapshot(2, "old-access", "old-refresh");
		const winner = credentialSnapshot(3, "winner-access", "winner-refresh");
		const load = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>()
			.mockResolvedValueOnce(initial)
			.mockResolvedValueOnce(winner);
		const commitRefresh =
			vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]>();
		const invalidate = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>()
			.mockResolvedValue({ status: "conflict" });
		const onInvalidated = vi.fn(async () => undefined);
		const refresh = vi.fn(async () => {
			throw { code: "invalid_grant" };
		});
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh,
			onInvalidated,
		});

		await expect(coordinator.refresh("winner-key", initial.revision)).resolves.toEqual(winner);
		expect(refresh).toHaveBeenCalledOnce();
		expect(invalidate).toHaveBeenCalledOnce();
		expect(load).toHaveBeenCalledTimes(2);
		expect(commitRefresh).not.toHaveBeenCalled();
		expect(onInvalidated).not.toHaveBeenCalled();
		await coordinator.close();
	});

	it("fences an active exact generation before explicit invalidation and drains its task", async () => {
		const initial = credentialSnapshot(6, "access", "refresh");
		const memory = createMemoryStore([["invalidate-key", initial]]);
		let sharedSignal: AbortSignal | undefined;
		const refreshStarted = deferred<void>();
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async (_identity, _current, context) => {
				sharedSignal = context.signal;
				refreshStarted.resolve();
				await waitForAbort(context.signal);
				throw context.signal.reason;
			},
		});
		const refreshing = coordinator.refresh("invalidate-key", initial.revision);
		await refreshStarted.promise;

		const invalidation = coordinator.invalidate("invalidate-key", initial.revision, {
			reason: McpClientOAuthCredentialInvalidationReason.Explicit,
		});
		const refreshError = await captureRejection(refreshing);
		expect(refreshError).toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		expect(sharedSignal?.aborted).toBe(true);
		await expect(invalidation).resolves.toEqual({ status: "invalidated" });
		expect(memory.commitRefresh).not.toHaveBeenCalled();
		expect(memory.invalidate).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(coordinator.snapshot().inFlightKeyCount).toBe(0));
		await coordinator.close();
	});

	it("does not cancel shared invalidation when its first caller stops waiting", async () => {
		const initial = credentialSnapshot(3, "access", "refresh");
		const pendingInvalidation = deferred<{ readonly status: "applied" }>();
		let invalidationSignal: AbortSignal | undefined;
		const load = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>()
			.mockResolvedValue(initial);
		const commitRefresh =
			vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]>();
		const invalidate = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>(
			async (_identity, _revision, _reason, context) => {
				invalidationSignal = context.signal;
				return pendingInvalidation.promise;
			},
		);
		const onInvalidated = vi.fn(async () => undefined);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh: async () => ({ accessToken: "unused", refreshToken: "unused" }),
			onInvalidated,
		});
		const caller = new AbortController();
		const cancelled = coordinator.invalidate("invalidation-key", initial.revision, {
			signal: caller.signal,
		});
		await vi.waitFor(() => expect(invalidationSignal).toBeDefined());

		caller.abort(new Error("caller-invalidation-detail"));
		await expect(cancelled).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CallerAborted,
		});
		expect(invalidationSignal?.aborted).toBe(false);

		const retained = coordinator.invalidate("invalidation-key", initial.revision);
		pendingInvalidation.resolve({ status: "applied" });
		await expect(retained).resolves.toEqual({ status: "invalidated" });
		expect(invalidate).toHaveBeenCalledOnce();
		expect(onInvalidated).toHaveBeenCalledOnce();
		await coordinator.close();
	});

	it("enforces a hard identity bound and rejects a different revision without joining", async () => {
		const first = credentialSnapshot(1, "first-access", "first-refresh");
		const second = credentialSnapshot(1, "second-access", "second-refresh");
		const memory = createMemoryStore([
			["first-sensitive-key", first],
			["second-sensitive-key", second],
		]);
		const rotated = deferred<Readonly<TestCredential>>();
		const refresh = vi.fn(async () => rotated.promise);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh,
			maxInFlightKeys: 1,
		});
		const accepted = coordinator.refresh("first-sensitive-key", first.revision);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

		const capacityError = await captureRejection(
			coordinator.refresh("second-sensitive-key", second.revision),
		);
		expect(capacityError).toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CapacityExceeded,
		});
		expect(String(capacityError)).not.toContain("first-sensitive-key");
		expect(String(capacityError)).not.toContain("second-sensitive-key");
		await expect(
			coordinator.refresh("first-sensitive-key", createMcpClientOAuthCredentialRevision(2)),
		).rejects.toMatchObject({ code: McpClientOAuthRefreshErrorCode.RevisionInFlight });
		expect(refresh).toHaveBeenCalledOnce();

		rotated.resolve({ accessToken: "new", refreshToken: "rotated" });
		await accepted;
		await coordinator.close();
	});

	it("sanitizes synchronous store and refresh failures", async () => {
		const identity = "store-key-secret-marker";
		const storeDetail = "store-error-detail-marker";
		const store = createTestStore({
			load() {
				throw new Error(storeDetail);
			},
			invalidate() {
				throw new Error("unused-invalidate-detail");
			},
		});
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store,
			refresh: async () => ({ accessToken: "unused", refreshToken: "unused" }),
		});

		const error = await captureRejection(
			coordinator.refresh(identity, createMcpClientOAuthCredentialRevision(1)),
		);
		expect(error).toMatchObject({ code: McpClientOAuthRefreshErrorCode.StoreFailed });
		expect(String(error)).not.toContain(identity);
		expect(String(error)).not.toContain(storeDetail);
		await coordinator.close();

		const initial = credentialSnapshot(1, "access-token", "refresh-token");
		const memory = createMemoryStore([[identity, initial]]);
		const refreshDetail = "refresh-error-detail-marker";
		const failedRefresh = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh() {
				throw new Error(refreshDetail);
			},
		});
		const refreshError = await captureRejection(failedRefresh.refresh(identity, initial.revision));
		expect(refreshError).toMatchObject({
			code: McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		});
		expect(String(refreshError)).not.toContain(refreshDetail);
		expect(String(refreshError)).not.toContain("refresh-token");
		await failedRefresh.close();
	});

	it("rejects an applied CAS that does not advance to the exact next revision", async () => {
		const initial = credentialSnapshot(7, "access", "refresh");
		const load = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>()
			.mockResolvedValue(initial);
		const commitRefresh = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]>()
			.mockResolvedValue({
				status: "applied",
				snapshot: credentialSnapshot(9, "invalid-access", "invalid-refresh"),
			});
		const invalidate = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>();
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh: async () => ({ accessToken: "new", refreshToken: "rotated" }),
		});

		await expect(coordinator.refresh("revision-key", initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.InvalidStoreResult,
		});
		await coordinator.close();
	});

	it("rematerializes spoofed coordinator errors from untrusted store results", async () => {
		const marker = "spoofed-error-secret-marker";
		const initial = credentialSnapshot(1, "access", "refresh");
		const spoofed = new McpClientOAuthRefreshError(
			McpClientOAuthRefreshErrorCode.InvalidStoreResult,
			marker,
		);
		const malicious = new Proxy(initial, {
			get(target, property, receiver) {
				if (property === "revision") throw spoofed;
				return Reflect.get(target, property, receiver);
			},
		});
		const load = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>()
			.mockResolvedValue(malicious);
		const commitRefresh =
			vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]>();
		const invalidate = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>();
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: createTestStore({ load, commitRefresh, invalidate }),
			refresh: async () => ({ accessToken: "unused", refreshToken: "unused" }),
		});

		const error = await captureRejection(coordinator.refresh("store-key", initial.revision));
		expect(error).toBeInstanceOf(McpClientOAuthRefreshError);
		expect(error).not.toBe(spoofed);
		expect(error).toMatchObject({ code: McpClientOAuthRefreshErrorCode.InvalidStoreResult });
		expect(String(error)).not.toContain(marker);
		expect(JSON.stringify(error)).not.toContain(marker);
		await coordinator.close();
	});

	it("fences new work during idempotent close and drains an accepted refresh without aborting it", async () => {
		const initial = credentialSnapshot(1, "access", "refresh");
		const memory = createMemoryStore([["close-key", initial]]);
		const rotated = deferred<Readonly<TestCredential>>();
		let sharedSignal: AbortSignal | undefined;
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async (_identity, _current, context) => {
				sharedSignal = context.signal;
				return rotated.promise;
			},
		});
		const accepted = coordinator.refresh("close-key", initial.revision);
		await vi.waitFor(() => expect(sharedSignal).toBeDefined());

		const close = coordinator.close();
		expect(coordinator.close()).toBe(close);
		expect(coordinator.closed).toBe(true);
		expect(sharedSignal?.aborted).toBe(false);
		let closeSettled = false;
		void close.then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		await expect(coordinator.refresh("close-key", initial.revision)).rejects.toMatchObject({
			code: McpClientOAuthRefreshErrorCode.Closed,
		});

		rotated.resolve({ accessToken: "new-access", refreshToken: "new-refresh" });
		await expect(accepted).resolves.toMatchObject({ revision: 2 });
		await close;
		expect(closeSettled).toBe(true);
		expect(coordinator.snapshot()).toMatchObject({
			closed: true,
			inFlightKeyCount: 0,
			refreshCount: 0,
			invalidationCount: 0,
		});
		await expect(coordinator[Symbol.asyncDispose]()).resolves.toBeUndefined();
	});
});

function credentialSnapshot(
	revision: number,
	accessToken: string,
	refreshToken: string,
): McpClientOAuthCredentialSnapshot<TestCredential> {
	return createMcpClientOAuthCredentialSnapshot(revision, { accessToken, refreshToken });
}

type TestCredentialStore = McpClientOAuthCredentialStore<string, TestCredential>;

function createTestStore(
	overrides: Partial<TestCredentialStore> & Pick<TestCredentialStore, "load">,
): TestCredentialStore {
	const claimRefresh: TestCredentialStore["claimRefresh"] =
		overrides.claimRefresh ??
		(async (identity, expectedRevision, _claimId, context) => {
			const current = await overrides.load(identity, context);
			return current?.revision === expectedRevision
				? { status: "claimed", snapshot: current }
				: { status: "conflict" };
		});
	const commitRefresh: TestCredentialStore["commitRefresh"] =
		overrides.commitRefresh ?? (async () => ({ status: "conflict" }));
	const releaseRefreshClaim: TestCredentialStore["releaseRefreshClaim"] =
		overrides.releaseRefreshClaim ?? (async () => ({ status: "released" }));
	const compareAndSwap: TestCredentialStore["compareAndSwap"] =
		overrides.compareAndSwap ?? (async () => ({ status: "conflict" }));
	const invalidate: TestCredentialStore["invalidate"] =
		overrides.invalidate ?? (async () => ({ status: "conflict" }));
	return {
		load: overrides.load,
		claimRefresh,
		commitRefresh,
		releaseRefreshClaim,
		compareAndSwap,
		invalidate,
	};
}

function createMemoryStore(
	initial: readonly (readonly [string, McpClientOAuthCredentialSnapshot<TestCredential>])[],
): {
	readonly store: McpClientOAuthCredentialStore<string, TestCredential>;
	readonly records: Map<string, McpClientOAuthCredentialSnapshot<TestCredential>>;
	readonly load: ReturnType<
		typeof vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>
	>;
	readonly claimRefresh: ReturnType<
		typeof vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["claimRefresh"]>
	>;
	readonly commitRefresh: ReturnType<
		typeof vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]>
	>;
	readonly releaseRefreshClaim: ReturnType<
		typeof vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["releaseRefreshClaim"]>
	>;
	readonly invalidate: ReturnType<
		typeof vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>
	>;
} {
	const records = new Map(initial);
	const claims = new Map<
		string,
		{
			readonly revision: ReturnType<typeof createMcpClientOAuthCredentialRevision>;
			readonly claimId: McpClientOAuthRefreshClaimId;
		}
	>();
	const load = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>(
		async (identity) => records.get(identity),
	);
	const claimRefresh = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["claimRefresh"]>(
		async (identity, expectedRevision, claimId) => {
			const current = records.get(identity);
			if (current?.revision !== expectedRevision) return { status: "conflict" };
			if (claims.has(identity)) return { status: "busy" };
			claims.set(identity, { revision: expectedRevision, claimId });
			return { status: "claimed", snapshot: current };
		},
	);
	const commitRefresh = vi.fn<
		McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]
	>(async (identity, expectedRevision, claimId, credential) => {
		const current = records.get(identity);
		const claim = claims.get(identity);
		if (
			current?.revision !== expectedRevision ||
			claim?.revision !== expectedRevision ||
			claim.claimId !== claimId
		) {
			return { status: "conflict" };
		}
		const snapshot = createMcpClientOAuthCredentialSnapshot<TestCredential>(
			nextMcpClientOAuthCredentialRevision(expectedRevision),
			credential,
		);
		records.set(identity, snapshot);
		claims.delete(identity);
		return { status: "applied", snapshot };
	});
	const releaseRefreshClaim = vi.fn<
		McpClientOAuthCredentialStore<string, TestCredential>["releaseRefreshClaim"]
	>(async (identity, expectedRevision, claimId) => {
		const claim = claims.get(identity);
		if (claim?.revision !== expectedRevision || claim.claimId !== claimId) {
			return { status: "conflict" };
		}
		claims.delete(identity);
		return { status: "released" };
	});
	const compareAndSwap = vi.fn<
		McpClientOAuthCredentialStore<string, TestCredential>["compareAndSwap"]
	>(async (identity, expectedRevision, credential) => {
		const current = records.get(identity);
		if (current?.revision !== expectedRevision || claims.has(identity)) {
			return { status: "conflict" };
		}
		const snapshot = createMcpClientOAuthCredentialSnapshot<TestCredential>(
			nextMcpClientOAuthCredentialRevision(expectedRevision),
			credential,
		);
		records.set(identity, snapshot);
		return { status: "applied", snapshot };
	});
	const invalidate = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>(
		async (identity, expectedRevision) => {
			const current = records.get(identity);
			if (current?.revision !== expectedRevision) return { status: "conflict" };
			records.delete(identity);
			claims.delete(identity);
			return { status: "applied" };
		},
	);
	return {
		store: {
			load,
			claimRefresh,
			commitRefresh,
			releaseRefreshClaim,
			compareAndSwap,
			invalidate,
		},
		records,
		load,
		claimRefresh,
		commitRefresh,
		releaseRefreshClaim,
		invalidate,
	};
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		throw new Error("Expected the operation to reject.");
	} catch (error) {
		return error;
	}
}

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

async function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>((resolve) =>
		signal.addEventListener("abort", () => resolve(), { once: true }),
	);
}
