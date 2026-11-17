declare const MCP_CLIENT_OAUTH_CREDENTIAL_REVISION: unique symbol;

/** A database-safe, positive revision used for exact credential-generation CAS. */
export type McpClientOAuthCredentialRevision = number & {
	readonly [MCP_CLIENT_OAUTH_CREDENTIAL_REVISION]: "McpClientOAuthCredentialRevision";
};

/** Fresh, opaque ownership proof for one durable pre-dispatch refresh claim. */
export interface McpClientOAuthRefreshClaimId {
	readonly value: string;
}

/** Stable reasons used for exact-generation invalidation or disappearance notification. */
export const McpClientOAuthCredentialInvalidationReason = {
	Explicit: "explicit",
	InvalidGrant: "invalid-grant",
	/** The exact generation was absent when observed, without a local invalidation mutation. */
	ObservedExternal: "observed-external",
	TerminalRefreshFailure: "terminal-refresh-failure",
} as const;

export type McpClientOAuthCredentialInvalidationReason =
	(typeof McpClientOAuthCredentialInvalidationReason)[keyof typeof McpClientOAuthCredentialInvalidationReason];

/** Terminal refresh reasons accepted from a refresh-failure classifier. */
export type McpClientOAuthTerminalRefreshReason =
	| typeof McpClientOAuthCredentialInvalidationReason.InvalidGrant
	| typeof McpClientOAuthCredentialInvalidationReason.TerminalRefreshFailure;

/**
 * One authoritative credential generation.
 *
 * `credential` is the complete replacement set, including a rotated refresh token when one was
 * returned. The wrapper is immutable; credential implementations must likewise treat their value
 * as immutable and replace it atomically instead of editing it in place.
 */
export interface McpClientOAuthCredentialSnapshot<Credential extends object> {
	readonly revision: McpClientOAuthCredentialRevision;
	readonly credential: Readonly<Credential>;
}

/** Cancellation owned by the coordinator lifecycle, never by one caller waiting on shared work. */
export interface McpClientOAuthCredentialStoreContext {
	readonly signal: AbortSignal;
}

export interface McpClientOAuthRefreshClaimed<Credential extends object> {
	readonly status: "claimed";
	/** The exact generation durably fenced for this claim before any refresh request is sent. */
	readonly snapshot: McpClientOAuthCredentialSnapshot<Credential>;
}

export interface McpClientOAuthRefreshClaimBusy {
	readonly status: "busy";
}

export interface McpClientOAuthRefreshClaimConflict {
	readonly status: "conflict";
}

export type McpClientOAuthRefreshClaimResult<Credential extends object> =
	| McpClientOAuthRefreshClaimed<Credential>
	| McpClientOAuthRefreshClaimBusy
	| McpClientOAuthRefreshClaimConflict;

export interface McpClientOAuthRefreshCommitApplied<Credential extends object> {
	readonly status: "applied";
	/** The authoritative, complete replacement persisted at exactly the next revision. */
	readonly snapshot: McpClientOAuthCredentialSnapshot<Credential>;
}

export interface McpClientOAuthRefreshCommitConflict {
	readonly status: "conflict";
}

export type McpClientOAuthRefreshCommitResult<Credential extends object> =
	McpClientOAuthRefreshCommitApplied<Credential> | McpClientOAuthRefreshCommitConflict;

export interface McpClientOAuthRefreshClaimReleased {
	readonly status: "released";
}

export interface McpClientOAuthRefreshClaimReleaseConflict {
	readonly status: "conflict";
}

export type McpClientOAuthRefreshClaimReleaseResult =
	McpClientOAuthRefreshClaimReleased | McpClientOAuthRefreshClaimReleaseConflict;

/** Exact CAS for non-refresh credential writers such as an authorization callback. */
export interface McpClientOAuthCredentialCompareAndSwapApplied<Credential extends object> {
	readonly status: "applied";
	readonly snapshot: McpClientOAuthCredentialSnapshot<Credential>;
}

export interface McpClientOAuthCredentialCompareAndSwapConflict {
	readonly status: "conflict";
}

export type McpClientOAuthCredentialCompareAndSwapResult<Credential extends object> =
	| McpClientOAuthCredentialCompareAndSwapApplied<Credential>
	| McpClientOAuthCredentialCompareAndSwapConflict;

export interface McpClientOAuthCredentialInvalidationApplied {
	readonly status: "applied";
}

export interface McpClientOAuthCredentialInvalidationConflict {
	readonly status: "conflict";
}

export type McpClientOAuthCredentialInvalidationResult =
	McpClientOAuthCredentialInvalidationApplied | McpClientOAuthCredentialInvalidationConflict;

/**
 * Persistence port for one opaque, non-secret OAuth credential identity.
 *
 * `claimRefresh` must atomically and durably transition the exact active generation to claimed
 * before returning it. Only its fresh `claimId` may commit or explicitly release that claim. A
 * claimed generation must never become active automatically: stale or abandoned claims are
 * terminal and must be invalidated by store policy. Ambiguous claim/commit failures must leave the
 * exact generation claimed or terminal, never active. A successful commit atomically stores the
 * complete credential set at `expectedRevision + 1`. `invalidate` must invalidate the exact
 * revision even while claimed. Conflict results must not mutate a newer generation.
 */
export interface McpClientOAuthCredentialStore<Identity, Credential extends object> {
	/** Returns the authoritative snapshot for active or durably claimed state; absent is terminal. */
	load(
		identity: Identity,
		context: McpClientOAuthCredentialStoreContext,
	): Promise<McpClientOAuthCredentialSnapshot<Credential> | undefined>;

	claimRefresh(
		identity: Identity,
		expectedRevision: McpClientOAuthCredentialRevision,
		claimId: McpClientOAuthRefreshClaimId,
		context: McpClientOAuthCredentialStoreContext,
	): Promise<McpClientOAuthRefreshClaimResult<Credential>>;

	commitRefresh(
		identity: Identity,
		expectedRevision: McpClientOAuthCredentialRevision,
		claimId: McpClientOAuthRefreshClaimId,
		credential: Readonly<Credential>,
		context: McpClientOAuthCredentialStoreContext,
	): Promise<McpClientOAuthRefreshCommitResult<Credential>>;

	releaseRefreshClaim(
		identity: Identity,
		expectedRevision: McpClientOAuthCredentialRevision,
		claimId: McpClientOAuthRefreshClaimId,
		context: McpClientOAuthCredentialStoreContext,
	): Promise<McpClientOAuthRefreshClaimReleaseResult>;

	/** Non-refresh exact writer. It must never reactivate or overwrite a claimed generation. */
	compareAndSwap(
		identity: Identity,
		expectedRevision: McpClientOAuthCredentialRevision,
		credential: Readonly<Credential>,
		context: McpClientOAuthCredentialStoreContext,
	): Promise<McpClientOAuthCredentialCompareAndSwapResult<Credential>>;

	invalidate(
		identity: Identity,
		expectedRevision: McpClientOAuthCredentialRevision,
		reason: McpClientOAuthCredentialInvalidationReason,
		context: McpClientOAuthCredentialStoreContext,
	): Promise<McpClientOAuthCredentialInvalidationResult>;
}

/** Validates and brands an exact positive credential revision. */
export function createMcpClientOAuthCredentialRevision(
	value: number,
): McpClientOAuthCredentialRevision {
	if (!isMcpClientOAuthCredentialRevision(value)) {
		throw new RangeError("An OAuth credential revision must be a positive safe integer.");
	}
	return value;
}

/** Runtime predicate for values crossing persistence or serialization boundaries. */
export function isMcpClientOAuthCredentialRevision(
	value: unknown,
): value is McpClientOAuthCredentialRevision {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Returns the only revision valid for a successful exact compare-and-swap. */
export function nextMcpClientOAuthCredentialRevision(
	revision: McpClientOAuthCredentialRevision,
): McpClientOAuthCredentialRevision {
	return createMcpClientOAuthCredentialRevision(revision + 1);
}

/** Creates the frozen wrapper shared by stores and refresh callers. */
export function createMcpClientOAuthCredentialSnapshot<Credential extends object>(
	revision: number,
	credential: Readonly<Credential>,
): McpClientOAuthCredentialSnapshot<Credential> {
	assertCredentialObject(credential);
	return Object.freeze({
		revision: createMcpClientOAuthCredentialRevision(revision),
		credential,
	});
}

function assertCredentialObject(credential: object): void {
	if (credential === null || (typeof credential !== "object" && typeof credential !== "function")) {
		throw new TypeError("An OAuth credential snapshot must contain a credential object.");
	}
}
