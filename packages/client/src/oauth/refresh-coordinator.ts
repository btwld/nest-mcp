import { randomUUID } from "node:crypto";

import {
	McpClientOAuthCredentialInvalidationReason,
	createMcpClientOAuthCredentialSnapshot,
	isMcpClientOAuthCredentialRevision,
	nextMcpClientOAuthCredentialRevision,
	type McpClientOAuthCredentialInvalidationResult,
	type McpClientOAuthCredentialRevision,
	type McpClientOAuthCredentialSnapshot,
	type McpClientOAuthCredentialStore,
	type McpClientOAuthCredentialStoreContext,
	type McpClientOAuthRefreshClaimId,
	type McpClientOAuthRefreshClaimReleaseResult,
	type McpClientOAuthRefreshClaimResult,
	type McpClientOAuthRefreshCommitResult,
	type McpClientOAuthTerminalRefreshReason,
} from "./credential-store.ts";
import { isInternalMcpClientOAuthProtocolError } from "./protocol-error-brand.ts";
import { McpClientOAuthProtocolErrorCode } from "./protocol.ts";

const DEFAULT_MAX_IN_FLIGHT_KEYS = 100;
const CALLER_ABORTED = Symbol("caller-aborted");
const GENERATION_RETIRED = Symbol("generation-retired");

/** Stable, secret-free refresh-coordinator failures. */
export const McpClientOAuthRefreshErrorCode = {
	InvalidOptions: "MCP_CLIENT_OAUTH_REFRESH_INVALID_OPTIONS",
	Closed: "MCP_CLIENT_OAUTH_REFRESH_COORDINATOR_CLOSED",
	CapacityExceeded: "MCP_CLIENT_OAUTH_REFRESH_CAPACITY_EXCEEDED",
	RevisionInFlight: "MCP_CLIENT_OAUTH_REFRESH_REVISION_IN_FLIGHT",
	CredentialMissing: "MCP_CLIENT_OAUTH_CREDENTIAL_MISSING",
	CredentialInvalidated: "MCP_CLIENT_OAUTH_CREDENTIAL_INVALIDATED",
	RevisionMismatch: "MCP_CLIENT_OAUTH_CREDENTIAL_REVISION_MISMATCH",
	RefreshFailed: "MCP_CLIENT_OAUTH_REFRESH_FAILED",
	StoreFailed: "MCP_CLIENT_OAUTH_CREDENTIAL_STORE_FAILED",
	InvalidStoreResult: "MCP_CLIENT_OAUTH_CREDENTIAL_STORE_RESULT_INVALID",
	InvalidationHookFailed: "MCP_CLIENT_OAUTH_INVALIDATION_HOOK_FAILED",
	CallerAborted: "MCP_CLIENT_OAUTH_REFRESH_CALLER_ABORTED",
	InternalFailure: "MCP_CLIENT_OAUTH_REFRESH_INTERNAL_FAILURE",
} as const;

export type McpClientOAuthRefreshErrorCode =
	(typeof McpClientOAuthRefreshErrorCode)[keyof typeof McpClientOAuthRefreshErrorCode];

/**
 * Public coordinator error. Errors emitted across coordinator boundaries are rematerialized by
 * code so their fixed messages never retain identity, credential, or caught error data.
 */
export class McpClientOAuthRefreshError extends Error {
	readonly code: McpClientOAuthRefreshErrorCode;

	constructor(code: McpClientOAuthRefreshErrorCode, message: string) {
		super(message);
		this.name = "McpClientOAuthRefreshError";
		this.code = code;
	}
}

export interface McpClientOAuthRefreshContext {
	/** Shared operation cancellation; never tied to one caller waiting for the result. */
	readonly signal: AbortSignal;
}

export interface McpClientOAuthRefreshOperationOptions {
	/** Cancels only this caller's wait and never the shared refresh or persistence mutation. */
	readonly signal?: AbortSignal;
}

export interface McpClientOAuthInvalidateOptions extends McpClientOAuthRefreshOperationOptions {
	readonly reason?: McpClientOAuthCredentialInvalidationReason;
}

/** Explicitly states whether a caught refresh failure can safely reuse the exact generation. */
export type McpClientOAuthRefreshFailureDisposition =
	| { readonly kind: "retry-safe" }
	| {
			readonly kind: "terminal";
			readonly reason: McpClientOAuthTerminalRefreshReason;
	  };

export interface McpClientOAuthInvalidatedContext {
	readonly revision: McpClientOAuthCredentialRevision;
	readonly reason: McpClientOAuthCredentialInvalidationReason;
}

export interface McpClientOAuthRefreshCoordinatorOptions<Identity, Credential extends object> {
	readonly store: McpClientOAuthCredentialStore<Identity, Credential>;
	/**
	 * Exchanges the complete current credential set for one complete replacement set.
	 * The identity must be a stable, non-secret binding chosen by the host application.
	 * It may perform at most one credentialed token exchange per invocation; neither it nor its
	 * fetch middleware may retry a token POST. An ambiguous outcome must be thrown for terminal
	 * settlement.
	 */
	readonly refresh: (
		identity: Identity,
		current: McpClientOAuthCredentialSnapshot<Credential>,
		context: McpClientOAuthRefreshContext,
	) => Promise<Readonly<Credential>> | Readonly<Credential>;
	/**
	 * Classifies a caught refresh failure. Returning `retry-safe` is an assertion that no
	 * credentialed refresh request was dispatched; throws and invalid results fail terminally.
	 */
	readonly classifyRefreshFailure?: (error: unknown) => McpClientOAuthRefreshFailureDisposition;
	/**
	 * Called only when the exact generation is unusable: after durable or observed invalidation,
	 * external disappearance, or local fail-closed retirement when durable state is uncertain.
	 * Successful local rotation and observation of a newer generation follow that binding without
	 * eviction. Delivery is at most once for one in-process coalesced settlement; this is not a
	 * durable or cross-process exactly-once guarantee. `ObservedExternal` proves absence; a terminal
	 * reason may instead represent durable invalidation or local fail-closed retirement.
	 * The hook is awaited and must only initiate lease retirement; it must never await active-lease
	 * drain, because refresh may be settling a 401 from that same lease.
	 */
	readonly onInvalidated?: (
		identity: Identity,
		context: McpClientOAuthInvalidatedContext,
	) => Promise<void> | void;
	/** Hard bound over distinct opaque identities with accepted work or local fail-closed fences. */
	readonly maxInFlightKeys?: number;
}

/** Aggregate diagnostics deliberately omit identities, credentials, revisions, and failures. */
export interface McpClientOAuthRefreshCoordinatorSnapshot {
	readonly closed: boolean;
	readonly maxInFlightKeys: number;
	readonly inFlightKeyCount: number;
	readonly refreshCount: number;
	readonly invalidationCount: number;
	readonly waiterCount: number;
}

export type McpClientOAuthInvalidateResult =
	| { readonly status: "invalidated" }
	| { readonly status: "superseded" }
	| { readonly status: "missing" }
	| { readonly status: "conflict" };

type RefreshPhase = "loading" | "refreshing" | "committing" | "settling" | "done";

interface RefreshEntry<Credential extends object> {
	readonly token: symbol;
	readonly revision: McpClientOAuthCredentialRevision;
	readonly claimId: McpClientOAuthRefreshClaimId;
	readonly workController: AbortController;
	readonly settlementController: AbortController;
	readonly retirementController: AbortController;
	phase: RefreshPhase;
	settlementOwnsInvalidation: boolean;
	waiterCount: number;
	retirementError: McpClientOAuthRefreshError | undefined;
	task: Promise<RefreshOutcome<Credential>> | undefined;
}

interface InvalidationEntry {
	readonly token: symbol;
	readonly revision: McpClientOAuthCredentialRevision;
	readonly reason: McpClientOAuthCredentialInvalidationReason;
	readonly controller: AbortController;
	waiterCount: number;
	task: Promise<InvalidationOutcome> | undefined;
}

type RefreshOutcome<Credential extends object> =
	| { readonly status: "success"; readonly snapshot: McpClientOAuthCredentialSnapshot<Credential> }
	| { readonly status: "error"; readonly error: McpClientOAuthRefreshError };

type InvalidationOutcome =
	| { readonly status: "success"; readonly result: McpClientOAuthInvalidateResult }
	| { readonly status: "error"; readonly error: McpClientOAuthRefreshError };

interface AbortWait<Result extends symbol> {
	readonly promise: Promise<Result>;
	detach(): void;
}

/**
 * Bounded, framework-neutral refresh ownership keyed by an opaque, non-secret identity.
 *
 * Calls for the same identity and exact revision share one refresh. A different revision is never
 * joined to existing work. A durable pre-dispatch claim prevents multiple coordinators from
 * sending the same refresh token. Only the holder's exact claim can commit the complete next
 * generation. Commit loss reloads the authoritative winner and never retries the old token.
 * Closing drains accepted mutations; it does not abandon a claimed generation.
 */
export class McpClientOAuthRefreshCoordinator<
	Identity,
	Credential extends object,
> implements AsyncDisposable {
	readonly #store: McpClientOAuthCredentialStore<Identity, Credential>;
	readonly #refreshCredential: McpClientOAuthRefreshCoordinatorOptions<
		Identity,
		Credential
	>["refresh"];
	readonly #classifyRefreshFailure: NonNullable<
		McpClientOAuthRefreshCoordinatorOptions<Identity, Credential>["classifyRefreshFailure"]
	>;
	readonly #onInvalidated:
		McpClientOAuthRefreshCoordinatorOptions<Identity, Credential>["onInvalidated"] | undefined;
	readonly #maxInFlightKeys: number;
	readonly #refreshes = new Map<Identity, RefreshEntry<Credential>>();
	readonly #invalidations = new Map<Identity, InvalidationEntry>();
	readonly #retiredRevisions = new Map<Identity, McpClientOAuthCredentialRevision>();
	#closed = false;
	#closeTask: Promise<void> | undefined;

	constructor(options: McpClientOAuthRefreshCoordinatorOptions<Identity, Credential>) {
		if (!isObjectLike(options)) throw invalidOptionsError();

		let store: McpClientOAuthCredentialStore<Identity, Credential>;
		let refreshCredential: McpClientOAuthRefreshCoordinatorOptions<Identity, Credential>["refresh"];
		let classifyRefreshFailure:
			| McpClientOAuthRefreshCoordinatorOptions<Identity, Credential>["classifyRefreshFailure"]
			| undefined;
		let onInvalidated:
			McpClientOAuthRefreshCoordinatorOptions<Identity, Credential>["onInvalidated"] | undefined;
		let maxInFlightKeys: number;
		try {
			store = options.store;
			refreshCredential = options.refresh;
			classifyRefreshFailure = options.classifyRefreshFailure;
			onInvalidated = options.onInvalidated;
			maxInFlightKeys = options.maxInFlightKeys ?? DEFAULT_MAX_IN_FLIGHT_KEYS;
		} catch {
			throw invalidOptionsError();
		}

		if (!isCredentialStore(store) || typeof refreshCredential !== "function") {
			throw invalidOptionsError();
		}
		if (classifyRefreshFailure !== undefined && typeof classifyRefreshFailure !== "function") {
			throw invalidOptionsError();
		}
		if (onInvalidated !== undefined && typeof onInvalidated !== "function") {
			throw invalidOptionsError();
		}
		if (!Number.isSafeInteger(maxInFlightKeys) || maxInFlightKeys <= 0) {
			throw invalidOptionsError();
		}

		this.#store = store;
		this.#refreshCredential = refreshCredential;
		this.#classifyRefreshFailure = classifyRefreshFailure ?? classifyMcpClientOAuthRefreshFailure;
		this.#onInvalidated = onInvalidated;
		this.#maxInFlightKeys = maxInFlightKeys;
	}

	get closed(): boolean {
		return this.#closed;
	}

	snapshot(): McpClientOAuthRefreshCoordinatorSnapshot {
		let waiterCount = 0;
		for (const entry of this.#refreshes.values()) waiterCount += entry.waiterCount;
		for (const entry of this.#invalidations.values()) waiterCount += entry.waiterCount;

		return Object.freeze({
			closed: this.#closed,
			maxInFlightKeys: this.#maxInFlightKeys,
			inFlightKeyCount: this.#inFlightKeyCount(),
			refreshCount: this.#refreshes.size,
			invalidationCount: this.#invalidations.size,
			waiterCount,
		});
	}

	async refresh(
		identity: Identity,
		expectedRevision: McpClientOAuthCredentialRevision,
		options: McpClientOAuthRefreshOperationOptions = {},
	): Promise<McpClientOAuthCredentialSnapshot<Credential>> {
		this.#assertOpen();
		assertRevision(expectedRevision);
		throwIfCallerAborted(options.signal);

		const invalidation = this.#invalidations.get(identity);
		if (invalidation !== undefined) throw credentialInvalidatedError();
		this.#assertGenerationUsable(identity, expectedRevision);

		const existing = this.#refreshes.get(identity);
		if (existing !== undefined) {
			if (existing.revision !== expectedRevision) throw revisionInFlightError();
			return this.#waitForRefresh(existing, options.signal);
		}

		this.#assertCapacity(identity);
		const entry = this.#createRefreshEntry(identity, expectedRevision);
		return this.#waitForRefresh(entry, options.signal);
	}

	async invalidate(
		identity: Identity,
		expectedRevision: McpClientOAuthCredentialRevision,
		options: McpClientOAuthInvalidateOptions = {},
	): Promise<McpClientOAuthInvalidateResult> {
		this.#assertOpen();
		assertRevision(expectedRevision);
		throwIfCallerAborted(options.signal);
		const reason = options.reason ?? McpClientOAuthCredentialInvalidationReason.Explicit;
		assertInvalidationReason(reason);

		const existing = this.#invalidations.get(identity);
		if (existing !== undefined) {
			if (existing.revision !== expectedRevision || existing.reason !== reason) {
				throw revisionInFlightError();
			}
			return this.#waitForInvalidation(existing, options.signal);
		}

		this.#assertCapacity(identity);
		const refreshEntry = this.#refreshes.get(identity);
		const matchingRefresh = refreshEntry?.revision === expectedRevision ? refreshEntry : undefined;
		if (
			matchingRefresh?.phase === "settling" &&
			matchingRefresh.settlementOwnsInvalidation &&
			matchingRefresh.retirementError === undefined
		) {
			return this.#waitForSettlingInvalidation(matchingRefresh, options.signal);
		}
		const entry = this.#createInvalidationEntry(
			identity,
			expectedRevision,
			reason,
			matchingRefresh,
		);
		if (matchingRefresh !== undefined) this.#retireRefresh(matchingRefresh);
		return this.#waitForInvalidation(entry, options.signal);
	}

	close(): Promise<void> {
		if (this.#closeTask !== undefined) return this.#closeTask;
		this.#closed = true;
		const tasks = [
			...[...this.#refreshes.values()].map(requireRefreshTask),
			...[...this.#invalidations.values()].map(requireInvalidationTask),
		];
		this.#closeTask = Promise.all(tasks).then(() => {
			this.#retiredRevisions.clear();
		});
		return this.#closeTask;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	#createRefreshEntry(
		identity: Identity,
		revision: McpClientOAuthCredentialRevision,
	): RefreshEntry<Credential> {
		const entry: RefreshEntry<Credential> = {
			token: Symbol("mcp-client-oauth-refresh"),
			revision,
			claimId: createRefreshClaimId(),
			workController: new AbortController(),
			settlementController: new AbortController(),
			retirementController: new AbortController(),
			phase: "loading",
			settlementOwnsInvalidation: false,
			waiterCount: 0,
			retirementError: undefined,
			task: undefined,
		};
		this.#refreshes.set(identity, entry);
		entry.task = Promise.resolve()
			.then(async () => this.#executeRefresh(identity, entry))
			.catch(() => refreshErrorOutcome(internalFailureError()));
		void entry.task.then(() => {
			entry.phase = "done";
			if (this.#refreshes.get(identity)?.token === entry.token) {
				this.#refreshes.delete(identity);
			}
		});
		return entry;
	}

	#createInvalidationEntry(
		identity: Identity,
		revision: McpClientOAuthCredentialRevision,
		reason: McpClientOAuthCredentialInvalidationReason,
		matchingRefresh: RefreshEntry<Credential> | undefined,
	): InvalidationEntry {
		const entry: InvalidationEntry = {
			token: Symbol("mcp-client-oauth-invalidation"),
			revision,
			reason,
			controller: new AbortController(),
			waiterCount: 0,
			task: undefined,
		};
		this.#invalidations.set(identity, entry);
		const refreshTask =
			matchingRefresh === undefined ? undefined : requireRefreshTask(matchingRefresh);
		entry.task = Promise.resolve()
			.then(async () => this.#executeInvalidation(identity, entry, refreshTask))
			.catch(() => invalidationErrorOutcome(internalFailureError()));
		void entry.task.then(() => {
			if (this.#invalidations.get(identity)?.token === entry.token) {
				this.#invalidations.delete(identity);
			}
		});
		return entry;
	}

	async #executeRefresh(
		identity: Identity,
		entry: RefreshEntry<Credential>,
	): Promise<RefreshOutcome<Credential>> {
		let claim: McpClientOAuthRefreshClaimResult<Credential>;
		try {
			claim = await this.#claimRefresh(identity, entry, entry.workController.signal);
		} catch (error) {
			if (entry.retirementError !== undefined) {
				return refreshErrorOutcome(entry.retirementError);
			}
			entry.phase = "settling";
			return this.#settleClaimUncertainty(identity, entry, sanitizeCoordinatorError(error));
		}
		if (entry.retirementError !== undefined) {
			return refreshErrorOutcome(entry.retirementError);
		}
		if (claim.status !== "claimed") {
			entry.phase = "settling";
			return this.#settleUnclaimed(identity, entry, claim.status);
		}
		const current = claim.snapshot;
		this.#clearRetiredRevision(identity, current.revision);

		entry.phase = "refreshing";
		let replacement: Readonly<Credential>;
		try {
			replacement = await this.#refreshCredential(identity, current, {
				signal: entry.workController.signal,
			});
		} catch (error) {
			if (entry.retirementError !== undefined) {
				return refreshErrorOutcome(entry.retirementError);
			}
			return this.#handleRefreshFailure(identity, entry, error);
		}
		if (entry.retirementError !== undefined) {
			return refreshErrorOutcome(entry.retirementError);
		}
		if (!isObjectLike(replacement)) {
			return this.#retireGeneration(
				identity,
				entry,
				McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			);
		}

		entry.phase = "committing";
		let result;
		try {
			result = await this.#commitRefresh(
				identity,
				entry,
				replacement,
				entry.settlementController.signal,
			);
		} catch (error) {
			if (entry.retirementError !== undefined) {
				return refreshErrorOutcome(entry.retirementError);
			}
			entry.phase = "settling";
			return this.#settleCommitUncertainty(
				identity,
				entry,
				McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
				sanitizeCoordinatorError(error),
			);
		}
		if (result.status === "applied") return refreshSuccessOutcome(result.snapshot);
		if (entry.retirementError !== undefined) {
			return refreshErrorOutcome(entry.retirementError);
		}

		entry.phase = "settling";
		return this.#settleCommitUncertainty(
			identity,
			entry,
			McpClientOAuthCredentialInvalidationReason.ObservedExternal,
			revisionMismatchError(),
		);
	}

	async #handleRefreshFailure(
		identity: Identity,
		entry: RefreshEntry<Credential>,
		error: unknown,
	): Promise<RefreshOutcome<Credential>> {
		let disposition: McpClientOAuthRefreshFailureDisposition;
		try {
			disposition = this.#classifyRefreshFailure(error);
		} catch {
			disposition = terminalRefreshFailureDisposition();
		}
		const normalized = normalizeRefreshFailureDisposition(disposition);
		if (normalized.kind === "retry-safe") {
			return this.#releaseRetrySafeClaim(identity, entry);
		}
		return this.#retireGeneration(identity, entry, normalized.reason);
	}

	async #releaseRetrySafeClaim(
		identity: Identity,
		entry: RefreshEntry<Credential>,
	): Promise<RefreshOutcome<Credential>> {
		entry.phase = "settling";
		let result: McpClientOAuthRefreshClaimReleaseResult;
		try {
			result = await this.#releaseRefreshClaim(identity, entry, entry.settlementController.signal);
		} catch (error) {
			if (entry.retirementError !== undefined) {
				return refreshErrorOutcome(entry.retirementError);
			}
			return refreshErrorOutcome(sanitizeCoordinatorError(error));
		}
		if (entry.retirementError !== undefined) {
			return refreshErrorOutcome(entry.retirementError);
		}
		if (result.status === "released") return refreshErrorOutcome(refreshFailedError());

		let current: McpClientOAuthCredentialSnapshot<Credential> | undefined;
		try {
			current = await this.#load(identity, entry.settlementController.signal);
		} catch (error) {
			if (entry.retirementError !== undefined) {
				return refreshErrorOutcome(entry.retirementError);
			}
			return refreshErrorOutcome(sanitizeCoordinatorError(error));
		}
		if (entry.retirementError !== undefined) {
			return refreshErrorOutcome(entry.retirementError);
		}
		if (current === undefined) {
			entry.settlementOwnsInvalidation = true;
			try {
				await this.#notifyInvalidated(
					identity,
					entry.revision,
					McpClientOAuthCredentialInvalidationReason.ObservedExternal,
				);
			} catch (error) {
				return refreshErrorOutcome(sanitizeCoordinatorError(error));
			}
			return refreshErrorOutcome(credentialInvalidatedError());
		}
		if (current.revision > entry.revision) return refreshSuccessOutcome(current);
		if (current.revision === entry.revision) return refreshErrorOutcome(refreshFailedError());
		return refreshErrorOutcome(invalidStoreResultError());
	}

	async #retireGeneration(
		identity: Identity,
		entry: RefreshEntry<Credential>,
		reason: McpClientOAuthTerminalRefreshReason,
	): Promise<RefreshOutcome<Credential>> {
		entry.phase = "settling";
		entry.settlementOwnsInvalidation = true;
		let result: McpClientOAuthCredentialInvalidationResult;
		try {
			result = await this.#invalidateStored(
				identity,
				entry.revision,
				reason,
				entry.settlementController.signal,
			);
		} catch (storeError) {
			return this.#failClosedGeneration(
				identity,
				entry.revision,
				reason,
				sanitizeCoordinatorError(storeError),
			);
		}
		if (result.status === "applied") {
			this.#clearRetiredRevision(identity, entry.revision);
			try {
				await this.#notifyInvalidated(identity, entry.revision, reason);
			} catch (hookError) {
				return refreshErrorOutcome(sanitizeCoordinatorError(hookError));
			}
			return refreshErrorOutcome(credentialInvalidatedError());
		}

		return this.#reloadAfterInvalidationConflict(identity, entry, reason);
	}

	async #settleClaimUncertainty(
		identity: Identity,
		entry: RefreshEntry<Credential>,
		claimFailure: McpClientOAuthRefreshError,
	): Promise<RefreshOutcome<Credential>> {
		return this.#settleCommitUncertainty(
			identity,
			entry,
			McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			claimFailure,
		);
	}

	async #settleUnclaimed(
		identity: Identity,
		entry: RefreshEntry<Credential>,
		status: "busy" | "conflict",
	): Promise<RefreshOutcome<Credential>> {
		let current: McpClientOAuthCredentialSnapshot<Credential> | undefined;
		try {
			current = await this.#load(identity, entry.settlementController.signal);
		} catch (error) {
			if (entry.retirementError !== undefined) {
				return refreshErrorOutcome(entry.retirementError);
			}
			return refreshErrorOutcome(sanitizeCoordinatorError(error));
		}
		if (entry.retirementError !== undefined) {
			return refreshErrorOutcome(entry.retirementError);
		}
		if (current === undefined) {
			entry.settlementOwnsInvalidation = true;
			try {
				await this.#notifyInvalidated(
					identity,
					entry.revision,
					McpClientOAuthCredentialInvalidationReason.ObservedExternal,
				);
			} catch (error) {
				return refreshErrorOutcome(sanitizeCoordinatorError(error));
			}
			return refreshErrorOutcome(credentialMissingError());
		}
		if (current.revision > entry.revision) {
			this.#clearRetiredRevision(identity, current.revision);
			return refreshSuccessOutcome(current);
		}
		if (current.revision === entry.revision) {
			this.#clearRetiredRevision(identity, current.revision);
			return refreshErrorOutcome(
				status === "busy" ? revisionInFlightError() : revisionMismatchError(),
			);
		}
		return refreshErrorOutcome(invalidStoreResultError());
	}

	async #settleCommitUncertainty(
		identity: Identity,
		entry: RefreshEntry<Credential>,
		missingReason:
			| typeof McpClientOAuthCredentialInvalidationReason.ObservedExternal
			| McpClientOAuthTerminalRefreshReason,
		loadFailure: McpClientOAuthRefreshError,
	): Promise<RefreshOutcome<Credential>> {
		entry.settlementOwnsInvalidation = true;
		let winner: McpClientOAuthCredentialSnapshot<Credential> | undefined;
		try {
			winner = await this.#load(identity, entry.settlementController.signal);
		} catch (error) {
			return this.#failClosedGeneration(
				identity,
				entry.revision,
				McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
				sanitizeCoordinatorError(error),
			);
		}
		if (winner === undefined) {
			this.#clearRetiredRevision(identity, entry.revision);
			try {
				await this.#notifyInvalidated(identity, entry.revision, missingReason);
			} catch (error) {
				return refreshErrorOutcome(sanitizeCoordinatorError(error));
			}
			return refreshErrorOutcome(credentialInvalidatedError());
		}
		if (winner.revision > entry.revision) {
			this.#clearRetiredRevision(identity, winner.revision);
			return refreshSuccessOutcome(winner);
		}
		if (winner.revision === entry.revision) {
			return this.#retireGeneration(
				identity,
				entry,
				McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			);
		}
		return this.#failClosedGeneration(
			identity,
			entry.revision,
			McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
			loadFailure.code === McpClientOAuthRefreshErrorCode.InvalidStoreResult
				? loadFailure
				: invalidStoreResultError(),
		);
	}

	async #reloadAfterInvalidationConflict(
		identity: Identity,
		entry: RefreshEntry<Credential>,
		reason: McpClientOAuthTerminalRefreshReason,
	): Promise<RefreshOutcome<Credential>> {
		let winner: McpClientOAuthCredentialSnapshot<Credential> | undefined;
		try {
			winner = await this.#load(identity, entry.settlementController.signal);
		} catch (error) {
			return this.#failClosedGeneration(
				identity,
				entry.revision,
				reason,
				sanitizeCoordinatorError(error),
			);
		}
		if (winner === undefined) {
			this.#clearRetiredRevision(identity, entry.revision);
			try {
				await this.#notifyInvalidated(identity, entry.revision, reason);
			} catch (error) {
				return refreshErrorOutcome(sanitizeCoordinatorError(error));
			}
			return refreshErrorOutcome(credentialInvalidatedError());
		}
		if (winner.revision > entry.revision) {
			this.#clearRetiredRevision(identity, winner.revision);
			return refreshSuccessOutcome(winner);
		}
		if (winner.revision === entry.revision) {
			return this.#failClosedGeneration(
				identity,
				entry.revision,
				reason,
				credentialInvalidatedError(),
			);
		}
		return this.#failClosedGeneration(identity, entry.revision, reason, invalidStoreResultError());
	}

	async #failClosedGeneration(
		identity: Identity,
		revision: McpClientOAuthCredentialRevision,
		reason: McpClientOAuthTerminalRefreshReason,
		error: McpClientOAuthRefreshError,
	): Promise<RefreshOutcome<Credential>> {
		this.#retireRevision(identity, revision);
		try {
			await this.#notifyInvalidated(identity, revision, reason);
		} catch (hookError) {
			return refreshErrorOutcome(sanitizeCoordinatorError(hookError));
		}
		return refreshErrorOutcome(error);
	}

	async #executeInvalidation(
		identity: Identity,
		entry: InvalidationEntry,
		refreshTask: Promise<RefreshOutcome<Credential>> | undefined,
	): Promise<InvalidationOutcome> {
		let outcome: InvalidationOutcome;
		try {
			const result = await this.#invalidateStored(
				identity,
				entry.revision,
				entry.reason,
				entry.controller.signal,
			);
			if (result.status === "applied") {
				this.#clearRetiredRevision(identity, entry.revision);
				await this.#notifyInvalidated(identity, entry.revision, entry.reason);
				outcome = invalidationSuccessOutcome("invalidated");
			} else {
				const current = await this.#load(identity, entry.controller.signal);
				if (current === undefined) {
					this.#clearRetiredRevision(identity, entry.revision);
					await this.#notifyInvalidated(identity, entry.revision, entry.reason);
					outcome = invalidationSuccessOutcome("missing");
				} else if (current.revision > entry.revision) {
					this.#clearRetiredRevision(identity, current.revision);
					outcome = invalidationSuccessOutcome("superseded");
				} else if (current.revision === entry.revision) {
					outcome = invalidationSuccessOutcome("conflict");
				} else outcome = invalidationErrorOutcome(invalidStoreResultError());
			}
		} catch (error) {
			outcome = invalidationErrorOutcome(sanitizeCoordinatorError(error));
		}

		if (refreshTask !== undefined) await refreshTask;
		return outcome;
	}

	async #load(
		identity: Identity,
		signal: AbortSignal,
	): Promise<McpClientOAuthCredentialSnapshot<Credential> | undefined> {
		let value: McpClientOAuthCredentialSnapshot<Credential> | undefined;
		try {
			value = await this.#store.load(identity, storeContext(signal));
		} catch {
			throw storeFailedError();
		}
		if (value === undefined) return undefined;
		return normalizeCredentialSnapshot<Credential>(value);
	}

	async #claimRefresh(
		identity: Identity,
		entry: RefreshEntry<Credential>,
		signal: AbortSignal,
	): Promise<McpClientOAuthRefreshClaimResult<Credential>> {
		let value: McpClientOAuthRefreshClaimResult<Credential>;
		try {
			value = await this.#store.claimRefresh(
				identity,
				entry.revision,
				entry.claimId,
				storeContext(signal),
			);
		} catch {
			throw storeFailedError();
		}
		return normalizeRefreshClaimResult(value, entry.revision);
	}

	async #commitRefresh(
		identity: Identity,
		entry: RefreshEntry<Credential>,
		credential: Readonly<Credential>,
		signal: AbortSignal,
	): Promise<
		| {
				readonly status: "applied";
				readonly snapshot: McpClientOAuthCredentialSnapshot<Credential>;
		  }
		| { readonly status: "conflict" }
	> {
		let value: McpClientOAuthRefreshCommitResult<Credential>;
		try {
			value = await this.#store.commitRefresh(
				identity,
				entry.revision,
				entry.claimId,
				credential,
				storeContext(signal),
			);
		} catch {
			throw storeFailedError();
		}
		return normalizeRefreshCommitResult<Credential>(value, entry.revision);
	}

	async #releaseRefreshClaim(
		identity: Identity,
		entry: RefreshEntry<Credential>,
		signal: AbortSignal,
	): Promise<McpClientOAuthRefreshClaimReleaseResult> {
		let value: McpClientOAuthRefreshClaimReleaseResult;
		try {
			value = await this.#store.releaseRefreshClaim(
				identity,
				entry.revision,
				entry.claimId,
				storeContext(signal),
			);
		} catch {
			throw storeFailedError();
		}
		return normalizeRefreshClaimReleaseResult(value);
	}

	async #invalidateStored(
		identity: Identity,
		expectedRevision: McpClientOAuthCredentialRevision,
		reason: McpClientOAuthCredentialInvalidationReason,
		signal: AbortSignal,
	): Promise<McpClientOAuthCredentialInvalidationResult> {
		let value: McpClientOAuthCredentialInvalidationResult;
		try {
			value = await this.#store.invalidate(
				identity,
				expectedRevision,
				reason,
				storeContext(signal),
			);
		} catch {
			throw storeFailedError();
		}
		return normalizeInvalidationResult(value);
	}

	async #notifyInvalidated(
		identity: Identity,
		revision: McpClientOAuthCredentialRevision,
		reason: McpClientOAuthCredentialInvalidationReason,
	): Promise<void> {
		if (this.#onInvalidated === undefined) return;
		try {
			await this.#onInvalidated(identity, Object.freeze({ revision, reason }));
		} catch {
			throw invalidationHookFailedError();
		}
	}

	#retireRefresh(entry: RefreshEntry<Credential>): void {
		if (entry.retirementError !== undefined) return;
		entry.retirementError = credentialInvalidatedError();
		entry.retirementController.abort(generationInvalidatedAbortReason());
		if (entry.phase === "loading" || entry.phase === "refreshing") {
			entry.workController.abort(generationInvalidatedAbortReason());
		}
	}

	async #waitForRefresh(
		entry: RefreshEntry<Credential>,
		signal: AbortSignal | undefined,
	): Promise<McpClientOAuthCredentialSnapshot<Credential>> {
		entry.waiterCount += 1;
		const caller = signal === undefined ? undefined : waitForAbort(signal, CALLER_ABORTED);
		const retired = waitForAbort(entry.retirementController.signal, GENERATION_RETIRED);
		try {
			const result = await Promise.race([
				requireRefreshTask(entry),
				retired.promise,
				...(caller === undefined ? [] : [caller.promise]),
			]);
			if (result === CALLER_ABORTED) throw callerAbortedError();
			if (result === GENERATION_RETIRED) {
				throw entry.retirementError ?? credentialInvalidatedError();
			}
			if (result.status === "error") throw result.error;
			return result.snapshot;
		} finally {
			entry.waiterCount -= 1;
			caller?.detach();
			retired.detach();
		}
	}

	async #waitForInvalidation(
		entry: InvalidationEntry,
		signal: AbortSignal | undefined,
	): Promise<McpClientOAuthInvalidateResult> {
		entry.waiterCount += 1;
		const caller = signal === undefined ? undefined : waitForAbort(signal, CALLER_ABORTED);
		try {
			const result = await Promise.race([
				requireInvalidationTask(entry),
				...(caller === undefined ? [] : [caller.promise]),
			]);
			if (result === CALLER_ABORTED) throw callerAbortedError();
			if (result.status === "error") throw result.error;
			return result.result;
		} finally {
			entry.waiterCount -= 1;
			caller?.detach();
		}
	}

	async #waitForSettlingInvalidation(
		entry: RefreshEntry<Credential>,
		signal: AbortSignal | undefined,
	): Promise<McpClientOAuthInvalidateResult> {
		entry.waiterCount += 1;
		const caller = signal === undefined ? undefined : waitForAbort(signal, CALLER_ABORTED);
		try {
			const outcome = await Promise.race([
				requireRefreshTask(entry),
				...(caller === undefined ? [] : [caller.promise]),
			]);
			if (outcome === CALLER_ABORTED) throw callerAbortedError();
			if (outcome.status === "success") return createInvalidationResult("superseded");
			if (outcome.error.code === McpClientOAuthRefreshErrorCode.CredentialInvalidated) {
				return createInvalidationResult("invalidated");
			}
			if (outcome.error.code === McpClientOAuthRefreshErrorCode.CredentialMissing) {
				return createInvalidationResult("missing");
			}
			if (outcome.error.code === McpClientOAuthRefreshErrorCode.RevisionMismatch) {
				return createInvalidationResult("conflict");
			}
			throw outcome.error;
		} finally {
			entry.waiterCount -= 1;
			caller?.detach();
		}
	}

	#assertOpen(): void {
		if (this.#closed) throw coordinatorClosedError();
	}

	#assertCapacity(identity: Identity): void {
		if (
			this.#refreshes.has(identity) ||
			this.#invalidations.has(identity) ||
			this.#retiredRevisions.has(identity)
		) {
			return;
		}
		if (this.#inFlightKeyCount() >= this.#maxInFlightKeys) throw capacityExceededError();
	}

	#inFlightKeyCount(): number {
		const identities = new Set(this.#refreshes.keys());
		for (const identity of this.#invalidations.keys()) identities.add(identity);
		for (const identity of this.#retiredRevisions.keys()) identities.add(identity);
		return identities.size;
	}

	#assertGenerationUsable(identity: Identity, revision: McpClientOAuthCredentialRevision): void {
		const retiredRevision = this.#retiredRevisions.get(identity);
		if (retiredRevision === undefined) return;
		if (revision <= retiredRevision) throw credentialInvalidatedError();
	}

	#retireRevision(identity: Identity, revision: McpClientOAuthCredentialRevision): void {
		const current = this.#retiredRevisions.get(identity);
		if (current === undefined || revision > current) this.#retiredRevisions.set(identity, revision);
	}

	#clearRetiredRevision(
		identity: Identity,
		authoritativeRevision: McpClientOAuthCredentialRevision,
	): void {
		const current = this.#retiredRevisions.get(identity);
		if (current !== undefined && current <= authoritativeRevision) {
			this.#retiredRevisions.delete(identity);
		}
	}
}

/**
 * Fails terminally by default. Only internally branded strict-protocol errors with a definitive
 * pre-dispatch outcome are retry-safe; public constructor/code lookalikes are not.
 */
export function classifyMcpClientOAuthRefreshFailure(
	error: unknown,
): McpClientOAuthRefreshFailureDisposition {
	if (!isInternalMcpClientOAuthProtocolError(error)) {
		return terminalRefreshFailureDisposition();
	}

	switch (readStringProperty(error, "code")) {
		case McpClientOAuthProtocolErrorCode.InvalidGrant:
			return terminalRefreshFailureDisposition(
				McpClientOAuthCredentialInvalidationReason.InvalidGrant,
			);
		case McpClientOAuthProtocolErrorCode.RefreshOutcomeUnknown:
		case McpClientOAuthProtocolErrorCode.InvalidClient:
			return terminalRefreshFailureDisposition();
		case McpClientOAuthProtocolErrorCode.InvalidOptions:
		case McpClientOAuthProtocolErrorCode.EndpointRejected:
		case McpClientOAuthProtocolErrorCode.DiscoveryFailed:
		case McpClientOAuthProtocolErrorCode.AuthorityInvalid:
		case McpClientOAuthProtocolErrorCode.ClientUnsupported:
		case McpClientOAuthProtocolErrorCode.TransactionInvalid:
		case McpClientOAuthProtocolErrorCode.AuthorizationDenied:
		case McpClientOAuthProtocolErrorCode.AuthorizationFailed:
		case McpClientOAuthProtocolErrorCode.TokenExchangeFailed:
		case McpClientOAuthProtocolErrorCode.TokenRefreshFailed:
			return retrySafeRefreshFailureDisposition();
		default:
			return terminalRefreshFailureDisposition();
	}
}

function normalizeCredentialSnapshot<Credential extends object>(
	value: McpClientOAuthCredentialSnapshot<Credential>,
): McpClientOAuthCredentialSnapshot<Credential> {
	try {
		if (!isObjectLike(value)) throw invalidStoreResultError();
		const { credential, revision } = value;
		if (!isMcpClientOAuthCredentialRevision(revision) || !isObjectLike(credential)) {
			throw invalidStoreResultError();
		}
		return createMcpClientOAuthCredentialSnapshot<Credential>(revision, credential);
	} catch (error) {
		throw sanitizeInvalidStoreResult(error);
	}
}

function normalizeRefreshClaimResult<Credential extends object>(
	value: McpClientOAuthRefreshClaimResult<Credential>,
	expectedRevision: McpClientOAuthCredentialRevision,
): McpClientOAuthRefreshClaimResult<Credential> {
	try {
		if (!isObjectLike(value)) throw invalidStoreResultError();
		const { status } = value;
		if (status === "busy" || status === "conflict") return Object.freeze({ status });
		if (status !== "claimed") throw invalidStoreResultError();
		const snapshot = normalizeCredentialSnapshot<Credential>(value.snapshot);
		if (snapshot.revision !== expectedRevision) throw invalidStoreResultError();
		return Object.freeze({ status, snapshot });
	} catch (error) {
		throw sanitizeInvalidStoreResult(error);
	}
}

function normalizeRefreshCommitResult<Credential extends object>(
	value: McpClientOAuthRefreshCommitResult<Credential>,
	expectedRevision: McpClientOAuthCredentialRevision,
):
	| {
			readonly status: "applied";
			readonly snapshot: McpClientOAuthCredentialSnapshot<Credential>;
	  }
	| { readonly status: "conflict" } {
	try {
		if (!isObjectLike(value)) throw invalidStoreResultError();
		const { status } = value;
		if (status === "conflict") return Object.freeze({ status });
		if (status !== "applied") throw invalidStoreResultError();
		const snapshot = normalizeCredentialSnapshot<Credential>(value.snapshot);
		if (snapshot.revision !== nextMcpClientOAuthCredentialRevision(expectedRevision)) {
			throw invalidStoreResultError();
		}
		return Object.freeze({ status, snapshot });
	} catch (error) {
		throw sanitizeInvalidStoreResult(error);
	}
}

function normalizeRefreshClaimReleaseResult(
	value: McpClientOAuthRefreshClaimReleaseResult,
): McpClientOAuthRefreshClaimReleaseResult {
	try {
		if (!isObjectLike(value)) throw invalidStoreResultError();
		const { status } = value;
		if (status !== "released" && status !== "conflict") throw invalidStoreResultError();
		return Object.freeze({ status });
	} catch (error) {
		throw sanitizeInvalidStoreResult(error);
	}
}

function normalizeInvalidationResult(
	value: McpClientOAuthCredentialInvalidationResult,
): McpClientOAuthCredentialInvalidationResult {
	try {
		if (!isObjectLike(value)) throw invalidStoreResultError();
		const { status } = value;
		if (status !== "applied" && status !== "conflict") throw invalidStoreResultError();
		return Object.freeze({ status });
	} catch (error) {
		throw sanitizeInvalidStoreResult(error);
	}
}

function refreshSuccessOutcome<Credential extends object>(
	snapshot: McpClientOAuthCredentialSnapshot<Credential>,
): RefreshOutcome<Credential> {
	return Object.freeze({ status: "success", snapshot });
}

function refreshErrorOutcome<Credential extends object>(
	error: McpClientOAuthRefreshError,
): RefreshOutcome<Credential> {
	return Object.freeze({ status: "error", error });
}

function invalidationSuccessOutcome(
	status: McpClientOAuthInvalidateResult["status"],
): InvalidationOutcome {
	return Object.freeze({ status: "success", result: createInvalidationResult(status) });
}

function createInvalidationResult(
	status: McpClientOAuthInvalidateResult["status"],
): McpClientOAuthInvalidateResult {
	return Object.freeze({ status });
}

function invalidationErrorOutcome(error: McpClientOAuthRefreshError): InvalidationOutcome {
	return Object.freeze({ status: "error", error });
}

function requireRefreshTask<Credential extends object>(
	entry: RefreshEntry<Credential>,
): Promise<RefreshOutcome<Credential>> {
	if (entry.task === undefined) throw internalFailureError();
	return entry.task;
}

function requireInvalidationTask(entry: InvalidationEntry): Promise<InvalidationOutcome> {
	if (entry.task === undefined) throw internalFailureError();
	return entry.task;
}

function storeContext(signal: AbortSignal): McpClientOAuthCredentialStoreContext {
	return Object.freeze({ signal });
}

function waitForAbort<Result extends symbol>(
	signal: AbortSignal,
	result: Result,
): AbortWait<Result> {
	if (signal.aborted) return { promise: Promise.resolve(result), detach: noop };
	let resolveAbort: ((value: Result) => void) | undefined;
	const promise = new Promise<Result>((resolve) => {
		resolveAbort = resolve;
	});
	const onAbort = (): void => resolveAbort?.(result);
	signal.addEventListener("abort", onAbort, { once: true });
	return {
		promise,
		detach(): void {
			signal.removeEventListener("abort", onAbort);
		},
	};
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw callerAbortedError();
}

function assertRevision(value: unknown): asserts value is McpClientOAuthCredentialRevision {
	if (!isMcpClientOAuthCredentialRevision(value)) throw invalidOptionsError();
}

function createRefreshClaimId(): McpClientOAuthRefreshClaimId {
	try {
		return Object.freeze({ value: randomUUID() });
	} catch {
		throw internalFailureError();
	}
}

function retrySafeRefreshFailureDisposition(): McpClientOAuthRefreshFailureDisposition {
	return Object.freeze({ kind: "retry-safe" });
}

function terminalRefreshFailureDisposition(
	reason: McpClientOAuthTerminalRefreshReason = McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure,
): McpClientOAuthRefreshFailureDisposition {
	return Object.freeze({ kind: "terminal", reason });
}

function normalizeRefreshFailureDisposition(
	value: unknown,
): McpClientOAuthRefreshFailureDisposition {
	try {
		if (!isObjectLike(value)) return terminalRefreshFailureDisposition();
		const { kind } = value as { readonly kind?: unknown };
		if (kind === "retry-safe") return retrySafeRefreshFailureDisposition();
		if (kind !== "terminal") return terminalRefreshFailureDisposition();
		const { reason } = value as { readonly reason?: unknown };
		return isTerminalRefreshReason(reason)
			? terminalRefreshFailureDisposition(reason)
			: terminalRefreshFailureDisposition();
	} catch {
		return terminalRefreshFailureDisposition();
	}
}

function assertInvalidationReason(
	value: unknown,
): asserts value is McpClientOAuthCredentialInvalidationReason {
	if (
		value !== McpClientOAuthCredentialInvalidationReason.Explicit &&
		value !== McpClientOAuthCredentialInvalidationReason.ObservedExternal &&
		!isTerminalRefreshReason(value)
	) {
		throw invalidOptionsError();
	}
}

function isTerminalRefreshReason(value: unknown): value is McpClientOAuthTerminalRefreshReason {
	return (
		value === McpClientOAuthCredentialInvalidationReason.InvalidGrant ||
		value === McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure
	);
}

function isCredentialStore(
	value: unknown,
): value is McpClientOAuthCredentialStore<unknown, object> {
	if (!isObjectLike(value)) return false;
	try {
		return (
			typeof Reflect.get(value, "load") === "function" &&
			typeof Reflect.get(value, "claimRefresh") === "function" &&
			typeof Reflect.get(value, "commitRefresh") === "function" &&
			typeof Reflect.get(value, "releaseRefreshClaim") === "function" &&
			typeof Reflect.get(value, "compareAndSwap") === "function" &&
			typeof Reflect.get(value, "invalidate") === "function"
		);
	} catch {
		return false;
	}
}

function isObjectLike(value: unknown): value is object {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

function readStringProperty(value: unknown, property: string): string | undefined {
	if (!isObjectLike(value)) return undefined;
	try {
		const result = Reflect.get(value, property) as unknown;
		return typeof result === "string" ? result : undefined;
	} catch {
		return undefined;
	}
}

function sanitizeCoordinatorError(error: unknown): McpClientOAuthRefreshError {
	try {
		if (!(error instanceof McpClientOAuthRefreshError)) return internalFailureError();
	} catch {
		return internalFailureError();
	}

	switch (readStringProperty(error, "code")) {
		case McpClientOAuthRefreshErrorCode.InvalidOptions:
			return invalidOptionsError();
		case McpClientOAuthRefreshErrorCode.Closed:
			return coordinatorClosedError();
		case McpClientOAuthRefreshErrorCode.CapacityExceeded:
			return capacityExceededError();
		case McpClientOAuthRefreshErrorCode.RevisionInFlight:
			return revisionInFlightError();
		case McpClientOAuthRefreshErrorCode.CredentialMissing:
			return credentialMissingError();
		case McpClientOAuthRefreshErrorCode.CredentialInvalidated:
			return credentialInvalidatedError();
		case McpClientOAuthRefreshErrorCode.RevisionMismatch:
			return revisionMismatchError();
		case McpClientOAuthRefreshErrorCode.RefreshFailed:
			return refreshFailedError();
		case McpClientOAuthRefreshErrorCode.StoreFailed:
			return storeFailedError();
		case McpClientOAuthRefreshErrorCode.InvalidStoreResult:
			return invalidStoreResultError();
		case McpClientOAuthRefreshErrorCode.InvalidationHookFailed:
			return invalidationHookFailedError();
		case McpClientOAuthRefreshErrorCode.CallerAborted:
			return callerAbortedError();
		case McpClientOAuthRefreshErrorCode.InternalFailure:
		default:
			return internalFailureError();
	}
}

function sanitizeInvalidStoreResult(_error: unknown): McpClientOAuthRefreshError {
	return invalidStoreResultError();
}

function invalidOptionsError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.InvalidOptions,
		"The OAuth refresh coordinator options are invalid.",
	);
}

function coordinatorClosedError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.Closed,
		"The OAuth refresh coordinator is closed and cannot accept new work.",
	);
}

function capacityExceededError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.CapacityExceeded,
		"The OAuth refresh coordinator is at capacity.",
	);
}

function revisionInFlightError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.RevisionInFlight,
		"A different OAuth credential revision already has accepted work.",
	);
}

function credentialMissingError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.CredentialMissing,
		"The OAuth credential generation is unavailable.",
	);
}

function credentialInvalidatedError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.CredentialInvalidated,
		"The OAuth credential generation is no longer usable.",
	);
}

function revisionMismatchError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.RevisionMismatch,
		"The OAuth credential revision changed before refresh could be committed.",
	);
}

function refreshFailedError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.RefreshFailed,
		"The OAuth credential refresh failed.",
	);
}

function storeFailedError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.StoreFailed,
		"The OAuth credential store operation failed.",
	);
}

function invalidStoreResultError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.InvalidStoreResult,
		"The OAuth credential store returned an invalid result.",
	);
}

function invalidationHookFailedError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.InvalidationHookFailed,
		"The OAuth credential invalidation hook failed.",
	);
}

function callerAbortedError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.CallerAborted,
		"The caller stopped waiting for OAuth credential work.",
	);
}

function internalFailureError(): McpClientOAuthRefreshError {
	return new McpClientOAuthRefreshError(
		McpClientOAuthRefreshErrorCode.InternalFailure,
		"The OAuth refresh coordinator could not complete the operation.",
	);
}

function generationInvalidatedAbortReason(): DOMException {
	return new DOMException("The OAuth credential generation was invalidated.", "AbortError");
}

function noop(): void {}
