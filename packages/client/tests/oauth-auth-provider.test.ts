import type { AuthProvider, OAuthClientProvider } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
	McpClientOAuthAuthProvider,
	McpClientOAuthAuthProviderError,
	McpClientOAuthAuthProviderErrorCode,
	type McpClientOAuthBearerTokenAccessor,
} from "../src/oauth/auth-provider.ts";
import {
	createMcpClientOAuthCredentialSnapshot,
	nextMcpClientOAuthCredentialRevision,
	type McpClientOAuthCredentialSnapshot,
	type McpClientOAuthCredentialStore,
	type McpClientOAuthRefreshClaimId,
} from "../src/oauth/credential-store.ts";
import { McpClientOAuthRefreshCoordinator } from "../src/oauth/refresh-coordinator.ts";

interface TestCredential {
	readonly accessToken: string | undefined;
	readonly refreshToken: string;
}

describe("McpClientOAuthAuthProvider", () => {
	it("rejects invalid or throwing runtime options with a fixed typed error", () => {
		const throwingOptions = Object.defineProperty({}, "identity", {
			get() {
				throw new Error("constructor-secret-marker");
			},
		});
		for (const options of [null, undefined, throwingOptions]) {
			let thrown: unknown;
			try {
				Reflect.construct(McpClientOAuthAuthProvider, [options]);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(McpClientOAuthAuthProviderError);
			expect(thrown).toMatchObject({
				code: McpClientOAuthAuthProviderErrorCode.InvalidOptions,
			});
			expect(String(thrown)).not.toContain("constructor-secret-marker");
		}
	});

	it("keeps each minimal provider bound to exactly one opaque credential identity", async () => {
		const first = credentialSnapshot(1, "first-access", "first-refresh");
		const second = credentialSnapshot(3, "second-access", "second-refresh");
		const memory = createMemoryStore([
			["first-binding", first],
			["second-binding", second],
		]);
		const refresh = vi.fn(async () => first.credential);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh,
		});
		const firstProvider = createProvider("first-binding", memory.store, coordinator);
		const secondProvider = createProvider("second-binding", memory.store, coordinator);

		await expect(firstProvider.token()).resolves.toBe("first-access");
		await expect(secondProvider.token()).resolves.toBe("second-access");
		expect(memory.load.mock.calls.map(([identity]) => identity)).toEqual([
			"first-binding",
			"second-binding",
		]);
		expect(refresh).not.toHaveBeenCalled();

		await Promise.all([firstProvider.close(), secondProvider.close()]);
		expect(coordinator.closed).toBe(false);
		await coordinator.close();
	});

	it("singleflights concurrent 401 refreshes and publishes only the current token generation", async () => {
		const initial = credentialSnapshot(7, "old-access", "old-refresh");
		const memory = createMemoryStore([["shared-binding", initial]]);
		const rotation = deferred<Readonly<TestCredential>>();
		const refresh = vi.fn(
			async (identity: string, current: McpClientOAuthCredentialSnapshot<TestCredential>) => {
				expect(identity).toBe("shared-binding");
				expect(current.revision).toBe(initial.revision);
				return rotation.promise;
			},
		);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh,
		});
		const firstProvider = createProvider("shared-binding", memory.store, coordinator);
		const secondProvider = createProvider("shared-binding", memory.store, coordinator);

		const first401 = firstProvider.onUnauthorized(unauthorizedContext());
		const second401 = secondProvider.onUnauthorized(unauthorizedContext());
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
		expect(coordinator.snapshot()).toMatchObject({
			inFlightKeyCount: 1,
			refreshCount: 1,
			waiterCount: 2,
		});

		const replacement = {
			accessToken: "current-access",
			refreshToken: "rotated-refresh",
		};
		rotation.resolve(replacement);
		await expect(Promise.all([first401, second401])).resolves.toEqual([undefined, undefined]);
		expect(refresh).toHaveBeenCalledOnce();
		expect(memory.commitRefresh).toHaveBeenCalledOnce();
		expect(memory.records.get("shared-binding")).toEqual({
			revision: 8,
			credential: replacement,
		});
		await expect(firstProvider.token()).resolves.toBe("current-access");
		await expect(secondProvider.token()).resolves.toBe("current-access");

		await Promise.all([firstProvider.close(), secondProvider.close()]);
		await coordinator.close();
	});

	it("pins concurrent providers across rotation and refuses delayed 401s before another refresh", async () => {
		const initial = credentialSnapshot(7, "old-access", "old-refresh");
		const memory = createMemoryStore([["shared-binding", initial]]);
		const rotation = deferred<Readonly<TestCredential>>();
		const refresh = vi.fn(async () => rotation.promise);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh,
		});
		const provider = () =>
			new McpClientOAuthAuthProvider({
				identity: "shared-binding",
				store: memory.store,
				refreshCoordinator: coordinator,
				expectedCredentialRevision: initial.revision,
				selectBearerToken: (snapshot) => snapshot.credential.accessToken,
			});
		const providers = [provider(), provider(), provider()];
		try {
			await expect(Promise.all(providers.map((item) => item.token()))).resolves.toEqual([
				"old-access",
				"old-access",
				"old-access",
			]);
			const outcomes = Promise.allSettled(
				providers.slice(0, 2).map((item) => item.onUnauthorized(unauthorizedContext())),
			);
			await vi.waitFor(() => expect(coordinator.snapshot().waiterCount).toBe(2));
			rotation.resolve({ accessToken: "next-access", refreshToken: "next-refresh" });
			for (const outcome of await outcomes) {
				expect(outcome).toMatchObject({
					status: "rejected",
					reason: { code: McpClientOAuthAuthProviderErrorCode.CredentialRevisionChanged },
				});
			}
			await expect(providers[2]!.onUnauthorized(unauthorizedContext())).rejects.toMatchObject({
				code: McpClientOAuthAuthProviderErrorCode.CredentialRevisionChanged,
			});
			await expect(providers[0]!.token()).rejects.toMatchObject({
				code: McpClientOAuthAuthProviderErrorCode.CredentialRevisionChanged,
			});
			expect(refresh).toHaveBeenCalledOnce();
			expect(memory.commitRefresh).toHaveBeenCalledOnce();
			const current = memory.records.get("shared-binding")!;
			expect(current.revision).toBe(8);
			const fresh = new McpClientOAuthAuthProvider({
				identity: "shared-binding",
				store: memory.store,
				refreshCoordinator: coordinator,
				expectedCredentialRevision: current.revision,
				selectBearerToken: (snapshot) => snapshot.credential.accessToken,
			});
			try {
				await expect(fresh.token()).resolves.toBe("next-access");
			} finally {
				await fresh.close();
			}
		} finally {
			rotation.resolve({ accessToken: "next-access", refreshToken: "next-refresh" });
			await Promise.all(providers.map((item) => item.close()));
			await coordinator.close();
		}
	});

	it("rejects a winner published between pinned preflight and refresh without dispatching a refresh", async () => {
		const initial = credentialSnapshot(1, "old-access", "old-refresh");
		const winner = credentialSnapshot(2, "new-access", "new-refresh");
		const memory = createMemoryStore([["binding", winner]]);
		memory.load.mockResolvedValueOnce(initial);
		const refresh = vi.fn(async () => winner.credential);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh,
		});
		const provider = new McpClientOAuthAuthProvider({
			identity: "binding",
			store: memory.store,
			refreshCoordinator: coordinator,
			expectedCredentialRevision: initial.revision,
			selectBearerToken: (snapshot) => snapshot.credential.accessToken,
		});
		try {
			await expect(provider.onUnauthorized(unauthorizedContext())).rejects.toMatchObject({
				code: McpClientOAuthAuthProviderErrorCode.CredentialRevisionChanged,
			});
			expect(refresh).not.toHaveBeenCalled();
			expect(memory.commitRefresh).not.toHaveBeenCalled();
		} finally {
			await provider.close();
			await coordinator.close();
		}
	});

	it("validates an optional exact credential revision at construction", async () => {
		const memory = createMemoryStore([]);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async () => ({ accessToken: "access", refreshToken: "refresh" }),
		});
		try {
			for (const revision of [0, -1, 1.5, NaN, "1", null]) {
				expect(() =>
					Reflect.construct(McpClientOAuthAuthProvider, [
						{
							identity: "binding",
							store: memory.store,
							refreshCoordinator: coordinator,
							expectedCredentialRevision: revision,
							selectBearerToken: () => "access",
						},
					]),
				).toThrow(
					expect.objectContaining({ code: McpClientOAuthAuthProviderErrorCode.InvalidOptions }),
				);
			}
		} finally {
			await coordinator.close();
		}
	});

	it("accepts an authoritative newer revision without retrying a stale refresh token", async () => {
		const initial = credentialSnapshot(2, "stale-access", "stale-refresh");
		const winner = credentialSnapshot(3, "winner-access", "winner-refresh");
		const load = vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>()
			.mockResolvedValueOnce(initial)
			.mockResolvedValue(winner);
		const compareAndSwap =
			vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["compareAndSwap"]>();
		const invalidate = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>();
		const store: McpClientOAuthCredentialStore<string, TestCredential> = {
			...createConflictingRefreshClaimMethods(),
			load,
			compareAndSwap,
			invalidate,
		};
		const refresh = vi.fn(async () => ({
			accessToken: "loser-access",
			refreshToken: "loser-refresh",
		}));
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store,
			refresh,
		});
		const provider = createProvider("cas-binding", store, coordinator);

		await expect(provider.onUnauthorized(unauthorizedContext())).resolves.toBeUndefined();
		expect(load).toHaveBeenCalledTimes(3);
		expect(refresh).not.toHaveBeenCalled();
		expect(compareAndSwap).not.toHaveBeenCalled();
		await expect(provider.token()).resolves.toBe("winner-access");

		await provider.close();
		await coordinator.close();
	});

	it("rejects missing and invalid bearer tokens without exposing credentials or upstream data", async () => {
		const identity = "opaque-identity-secret-marker";
		const invalidToken = "invalid-token-secret-marker\nforged-log-line";
		const accessorDetail = "accessor-upstream-secret-marker";
		const storeDetail = "store-upstream-secret-marker";
		const memory = createMemoryStore([
			["token-missing", credentialSnapshot(1, undefined, "missing-refresh-marker")],
			["token-invalid", credentialSnapshot(1, invalidToken, "invalid-refresh-marker")],
			["accessor-fails", credentialSnapshot(1, "accessor-token-marker", "refresh")],
		]);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async () => ({ accessToken: "unused", refreshToken: "unused" }),
		});

		await expectSafeFailure(
			createProvider(identity, memory.store, coordinator).token(),
			McpClientOAuthAuthProviderErrorCode.CredentialMissing,
			[identity],
		);
		await expectSafeFailure(
			createProvider("token-missing", memory.store, coordinator).token(),
			McpClientOAuthAuthProviderErrorCode.TokenMissing,
			["missing-refresh-marker"],
		);
		await expectSafeFailure(
			createProvider("token-invalid", memory.store, coordinator).token(),
			McpClientOAuthAuthProviderErrorCode.TokenInvalid,
			[invalidToken, "invalid-refresh-marker", "forged-log-line"],
		);
		const failingAccessor: McpClientOAuthBearerTokenAccessor<TestCredential> = async () => {
			throw new Error(accessorDetail);
		};
		await expectSafeFailure(
			createProvider("accessor-fails", memory.store, coordinator, failingAccessor).token(),
			McpClientOAuthAuthProviderErrorCode.TokenAccessorFailed,
			[accessorDetail, "accessor-token-marker"],
		);

		const failedLoad = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>(
			async () => {
				throw new Error(storeDetail);
			},
		);
		const failedStore: McpClientOAuthCredentialStore<string, TestCredential> = {
			load: failedLoad,
			claimRefresh: memory.claimRefresh,
			commitRefresh: memory.commitRefresh,
			releaseRefreshClaim: memory.releaseRefreshClaim,
			compareAndSwap: memory.compareAndSwap,
			invalidate: memory.invalidate,
		};
		const failedCoordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: failedStore,
			refresh: async () => ({ accessToken: "unused", refreshToken: "unused" }),
		});
		await expectSafeFailure(
			createProvider(identity, failedStore, failedCoordinator).token(),
			McpClientOAuthAuthProviderErrorCode.StoreFailed,
			[identity, storeDetail],
		);

		await coordinator.close();
		await failedCoordinator.close();
	});

	it("sanitizes refresh failures without exposing the binding, credential, or upstream body", async () => {
		const identity = "refresh-identity-secret-marker";
		const accessToken = "refresh-access-secret-marker";
		const refreshToken = "refresh-token-secret-marker";
		const upstreamBody = "upstream-response-body-secret-marker";
		const memory = createMemoryStore([
			[identity, credentialSnapshot(4, accessToken, refreshToken)],
		]);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async () => {
				throw new Error(upstreamBody);
			},
		});
		const provider = createProvider(identity, memory.store, coordinator);

		await expectSafeFailure(
			provider.onUnauthorized(unauthorizedContext()),
			McpClientOAuthAuthProviderErrorCode.RefreshFailed,
			[identity, accessToken, refreshToken, upstreamBody],
		);

		await provider.close();
		await coordinator.close();
	});

	it("canonicalizes a store snapshot getter that throws a spoofed provider error", async () => {
		const marker = "snapshot-getter-secret-marker";
		const spoofed = new McpClientOAuthAuthProviderError(
			McpClientOAuthAuthProviderErrorCode.TokenInvalid,
		);
		spoofed.message = marker;
		const hostileSnapshot = new Proxy(credentialSnapshot(1, "access", "refresh"), {
			get(target, property, receiver) {
				if (property === "revision" || property === "credential") throw spoofed;
				return Reflect.get(target, property, receiver);
			},
		});
		const store: McpClientOAuthCredentialStore<string, TestCredential> = {
			...createConflictingRefreshClaimMethods(),
			load: vi.fn(async () => hostileSnapshot),
			compareAndSwap: vi
				.fn<McpClientOAuthCredentialStore<string, TestCredential>["compareAndSwap"]>()
				.mockResolvedValue({ status: "conflict" }),
			invalidate: vi
				.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>()
				.mockResolvedValue({ status: "conflict" }),
		};
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store,
			refresh: async () => ({ accessToken: "unused", refreshToken: "unused" }),
		});
		const provider = createProvider("hostile-snapshot", store, coordinator);

		const error = await captureRejection(provider.token());
		expect(error).toMatchObject({
			code: McpClientOAuthAuthProviderErrorCode.InvalidStoreResult,
		});
		expect(String(error)).not.toContain(marker);

		await provider.close();
		await coordinator.close();
	});

	it("aborts and drains accepted bridge work, then deterministically fences new work", async () => {
		const loadEntered = deferred<void>();
		let storeSignal: AbortSignal | undefined;
		const load = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>(
			async (_identity, context) => {
				storeSignal = context.signal;
				loadEntered.resolve();
				await waitForAbort(context.signal);
				throw new Error("aborted-store-secret-marker");
			},
		);
		const compareAndSwap =
			vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["compareAndSwap"]>();
		const invalidate = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>();
		const store: McpClientOAuthCredentialStore<string, TestCredential> = {
			...createConflictingRefreshClaimMethods(),
			load,
			compareAndSwap,
			invalidate,
		};
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store,
			refresh: async () => ({ accessToken: "unused", refreshToken: "unused" }),
		});
		const provider = createProvider("close-binding", store, coordinator);

		const accepted = provider.token();
		await loadEntered.promise;
		const close = provider.close();
		expect(provider.close()).toBe(close);
		expect(storeSignal?.aborted).toBe(true);
		await expectSafeFailure(accepted, McpClientOAuthAuthProviderErrorCode.Closed, [
			"close-binding",
			"aborted-store-secret-marker",
		]);
		await expect(close).resolves.toBeUndefined();
		expect(provider.closed).toBe(true);
		expect(coordinator.closed).toBe(false);
		await expect(provider.token()).rejects.toMatchObject({
			code: McpClientOAuthAuthProviderErrorCode.Closed,
		});
		await expect(provider.onUnauthorized(unauthorizedContext())).rejects.toMatchObject({
			code: McpClientOAuthAuthProviderErrorCode.Closed,
		});
		await expect(provider[Symbol.asyncDispose]()).resolves.toBeUndefined();

		await coordinator.close();
	});

	it("registers accepted work before a synchronous store can reentrantly close it", async () => {
		const initial = credentialSnapshot(1, "access", "refresh");
		const loadEntered = deferred<void>();
		const heldLoad = deferred<McpClientOAuthCredentialSnapshot<TestCredential> | undefined>();
		let provider: McpClientOAuthAuthProvider<string, TestCredential> | undefined;
		let closeFromStore: Promise<void> | undefined;
		const load = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>(
			(_identity, _context) => {
				const activeProvider = provider;
				if (activeProvider === undefined) throw new Error("Provider was not initialized.");
				closeFromStore = activeProvider.close();
				loadEntered.resolve();
				return heldLoad.promise;
			},
		);
		const compareAndSwap =
			vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["compareAndSwap"]>();
		const invalidate = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>();
		const store: McpClientOAuthCredentialStore<string, TestCredential> = {
			...createConflictingRefreshClaimMethods(),
			load,
			compareAndSwap,
			invalidate,
		};
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store,
			refresh: async () => ({ accessToken: "unused", refreshToken: "unused" }),
		});
		provider = createProvider("reentrant-binding", store, coordinator);

		const accepted = provider.token();
		await loadEntered.promise;
		const reentrantClose = closeFromStore;
		if (reentrantClose === undefined) throw new Error("Store did not close the provider.");
		let closeSettled = false;
		void reentrantClose.then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);

		heldLoad.resolve(initial);
		await expectSafeFailure(accepted, McpClientOAuthAuthProviderErrorCode.Closed, [
			"reentrant-binding",
			"access",
			"refresh",
		]);
		await expect(reentrantClose).resolves.toBeUndefined();
		expect(closeSettled).toBe(true);
		await coordinator.close();
	});

	it("implements only the official minimal AuthProvider shape", async () => {
		const memory = createMemoryStore([
			["minimal-binding", credentialSnapshot(1, "access", "refresh")],
		]);
		const coordinator = new McpClientOAuthRefreshCoordinator<string, TestCredential>({
			store: memory.store,
			refresh: async () => ({ accessToken: "new-access", refreshToken: "new-refresh" }),
		});
		const provider = createProvider("minimal-binding", memory.store, coordinator);
		const officialMinimalProvider: AuthProvider = provider;
		type IsOAuthClientProvider = typeof provider extends OAuthClientProvider ? true : false;
		const staticallyAssignableToOAuthClientProvider: IsOAuthClientProvider = false;

		expect(officialMinimalProvider).toBe(provider);
		expect(staticallyAssignableToOAuthClientProvider).toBe(false);
		expect(isClassifiableAsOAuthClientProvider(provider)).toBe(false);
		for (const forbiddenMember of [
			"tokens",
			"clientInformation",
			"saveTokens",
			"saveClientInformation",
			"clientMetadata",
			"redirectUrl",
			"redirectToAuthorization",
		]) {
			expect(forbiddenMember in provider).toBe(false);
		}

		await provider.close();
		await coordinator.close();
	});
});

function createProvider(
	identity: string,
	store: McpClientOAuthCredentialStore<string, TestCredential>,
	refreshCoordinator: McpClientOAuthRefreshCoordinator<string, TestCredential>,
	selectBearerToken: McpClientOAuthBearerTokenAccessor<TestCredential> = (snapshot) =>
		snapshot.credential.accessToken,
): McpClientOAuthAuthProvider<string, TestCredential> {
	return new McpClientOAuthAuthProvider({
		identity,
		store,
		refreshCoordinator,
		selectBearerToken,
	});
}

function credentialSnapshot(
	revision: number,
	accessToken: string | undefined,
	refreshToken: string,
): McpClientOAuthCredentialSnapshot<TestCredential> {
	return createMcpClientOAuthCredentialSnapshot(revision, { accessToken, refreshToken });
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
	readonly compareAndSwap: ReturnType<
		typeof vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["compareAndSwap"]>
	>;
	readonly invalidate: ReturnType<
		typeof vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["invalidate"]>
	>;
} {
	const records = new Map(initial);
	const claims = new Map<
		string,
		{
			readonly revision: McpClientOAuthCredentialSnapshot<TestCredential>["revision"];
			readonly claimId: McpClientOAuthRefreshClaimId;
		}
	>();
	const load = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["load"]>(
		async (identity, context) => {
			context.signal.throwIfAborted();
			return records.get(identity);
		},
	);
	const claimRefresh = vi.fn<McpClientOAuthCredentialStore<string, TestCredential>["claimRefresh"]>(
		async (identity, expectedRevision, claimId, context) => {
			context.signal.throwIfAborted();
			const current = records.get(identity);
			if (current?.revision !== expectedRevision) return { status: "conflict" };
			const existing = claims.get(identity);
			if (existing !== undefined) {
				if (existing.revision === expectedRevision && existing.claimId === claimId) {
					return { status: "claimed", snapshot: current };
				}
				return { status: "busy" };
			}
			claims.set(identity, { revision: expectedRevision, claimId });
			return { status: "claimed", snapshot: current };
		},
	);
	const commitRefresh = vi.fn<
		McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]
	>(async (identity, expectedRevision, claimId, credential, context) => {
		context.signal.throwIfAborted();
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
	>(async (identity, expectedRevision, claimId, context) => {
		context.signal.throwIfAborted();
		const current = records.get(identity);
		const claim = claims.get(identity);
		if (
			current?.revision !== expectedRevision ||
			claim?.revision !== expectedRevision ||
			claim.claimId !== claimId
		) {
			return { status: "conflict" };
		}
		claims.delete(identity);
		return { status: "released" };
	});
	const compareAndSwap = vi.fn<
		McpClientOAuthCredentialStore<string, TestCredential>["compareAndSwap"]
	>(async (identity, expectedRevision, credential, context) => {
		context.signal.throwIfAborted();
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
		async (identity, expectedRevision, _reason, context) => {
			context.signal.throwIfAborted();
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
		compareAndSwap,
		invalidate,
	};
}

function createConflictingRefreshClaimMethods(): Pick<
	McpClientOAuthCredentialStore<string, TestCredential>,
	"claimRefresh" | "commitRefresh" | "releaseRefreshClaim"
> {
	return {
		claimRefresh: vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["claimRefresh"]>()
			.mockResolvedValue({ status: "conflict" }),
		commitRefresh: vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["commitRefresh"]>()
			.mockResolvedValue({ status: "conflict" }),
		releaseRefreshClaim: vi
			.fn<McpClientOAuthCredentialStore<string, TestCredential>["releaseRefreshClaim"]>()
			.mockResolvedValue({ status: "conflict" }),
	};
}

function unauthorizedContext(): Parameters<NonNullable<AuthProvider["onUnauthorized"]>>[0] {
	return {
		response: new Response(undefined, { status: 401 }),
		serverUrl: new URL("https://mcp.example.test/rpc"),
		fetchFn: async () => new Response(undefined, { status: 204 }),
	};
}

function isClassifiableAsOAuthClientProvider(provider: object): boolean {
	if (!("tokens" in provider) || !("clientInformation" in provider)) return false;
	return typeof provider.tokens === "function" && typeof provider.clientInformation === "function";
}

async function expectSafeFailure(
	promise: Promise<unknown>,
	code: McpClientOAuthAuthProviderErrorCode,
	markers: readonly string[],
): Promise<void> {
	const error = await captureRejection(promise);
	expect(error).toBeInstanceOf(McpClientOAuthAuthProviderError);
	expect(error).toMatchObject({ code });
	const publicFailure = `${String(error)} ${JSON.stringify(error)}`;
	for (const marker of markers) expect(publicFailure).not.toContain(marker);
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
	await new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}
