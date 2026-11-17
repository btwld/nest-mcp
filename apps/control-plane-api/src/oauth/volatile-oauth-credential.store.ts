import type {
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
	createMcpClientOAuthCredentialRevision,
	createMcpClientOAuthCredentialSnapshot,
	nextMcpClientOAuthCredentialRevision,
	type McpClientOAuthCredentialCompareAndSwapResult,
	type McpClientOAuthCredentialInvalidationResult,
	type McpClientOAuthCredentialRevision,
	type McpClientOAuthCredentialSnapshot,
	type McpClientOAuthCredentialStore,
	type McpClientOAuthRefreshClaimId,
	type McpClientOAuthRefreshClaimReleaseResult,
	type McpClientOAuthRefreshClaimResult,
	type McpClientOAuthRefreshCommitResult,
} from "@nest-mcp/client/oauth";

/**
 * One published OAuth credential generation. Secret-bearing members stay inside
 * this process and are never projected into a response.
 */
export interface OAuthRuntimeCredential {
	readonly connectionId: string;
	readonly endpoint: string;
	readonly issuer: string;
	readonly discovery: OAuthDiscoveryState;
	readonly clientInformation: StoredOAuthClientInformation;
	readonly tokens: StoredOAuthTokens;
	readonly resourceUrl?: string;
}

type EntryState =
	| Readonly<{ readonly kind: "active" }>
	| Readonly<{ readonly kind: "claimed"; readonly claimId: string }>;

interface CredentialEntry {
	readonly revision: McpClientOAuthCredentialRevision;
	readonly credential: Readonly<OAuthRuntimeCredential>;
	readonly state: EntryState;
}

/**
 * Process-local persistence for the runtime credential of one MCP generation,
 * shaped as the client package's exact-revision store port so the upstream
 * refresh coordinator and auth provider own the refresh protocol. Every
 * operation completes synchronously; the promises satisfy the port only.
 */
export class VolatileOAuthCredentialStore implements McpClientOAuthCredentialStore<
	string,
	OAuthRuntimeCredential
> {
	readonly #entries = new Map<string, CredentialEntry>();

	/** Publishes the first generation for a runtime, replacing any prior binding. */
	publish(identity: string, credential: Readonly<OAuthRuntimeCredential>): void {
		this.#entries.set(
			identity,
			Object.freeze({
				revision: createMcpClientOAuthCredentialRevision(1),
				credential,
				state: Object.freeze({ kind: "active" as const }),
			}),
		);
	}

	/** Synchronous read for the host's own projection; never handed to the SDK. */
	peek(identity: string): Readonly<OAuthRuntimeCredential> | undefined {
		return this.#entries.get(identity)?.credential;
	}

	remove(identity: string): void {
		this.#entries.delete(identity);
	}

	clear(): void {
		this.#entries.clear();
	}

	load(
		identity: string,
	): Promise<McpClientOAuthCredentialSnapshot<OAuthRuntimeCredential> | undefined> {
		const entry = this.#entries.get(identity);
		return Promise.resolve(entry === undefined ? undefined : snapshot(entry));
	}

	claimRefresh(
		identity: string,
		expectedRevision: McpClientOAuthCredentialRevision,
		claimId: McpClientOAuthRefreshClaimId,
	): Promise<McpClientOAuthRefreshClaimResult<OAuthRuntimeCredential>> {
		const entry = this.#entries.get(identity);
		if (entry === undefined || entry.revision !== expectedRevision) {
			return Promise.resolve(Object.freeze({ status: "conflict" as const }));
		}
		if (entry.state.kind === "claimed") {
			return Promise.resolve(Object.freeze({ status: "busy" as const }));
		}
		const claimed = Object.freeze({
			...entry,
			state: Object.freeze({ kind: "claimed" as const, claimId: claimId.value }),
		});
		this.#entries.set(identity, claimed);
		return Promise.resolve(
			Object.freeze({ status: "claimed" as const, snapshot: snapshot(claimed) }),
		);
	}

	commitRefresh(
		identity: string,
		expectedRevision: McpClientOAuthCredentialRevision,
		claimId: McpClientOAuthRefreshClaimId,
		credential: Readonly<OAuthRuntimeCredential>,
	): Promise<McpClientOAuthRefreshCommitResult<OAuthRuntimeCredential>> {
		const entry = this.#entries.get(identity);
		if (!matchesClaim(entry, expectedRevision, claimId)) {
			return Promise.resolve(Object.freeze({ status: "conflict" as const }));
		}
		return Promise.resolve(
			Object.freeze({
				status: "applied" as const,
				snapshot: this.#advance(identity, expectedRevision, credential),
			}),
		);
	}

	releaseRefreshClaim(
		identity: string,
		expectedRevision: McpClientOAuthCredentialRevision,
		claimId: McpClientOAuthRefreshClaimId,
	): Promise<McpClientOAuthRefreshClaimReleaseResult> {
		const entry = this.#entries.get(identity);
		if (!matchesClaim(entry, expectedRevision, claimId)) {
			return Promise.resolve(Object.freeze({ status: "conflict" as const }));
		}
		this.#entries.set(
			identity,
			Object.freeze({ ...entry, state: Object.freeze({ kind: "active" as const }) }),
		);
		return Promise.resolve(Object.freeze({ status: "released" as const }));
	}

	compareAndSwap(
		identity: string,
		expectedRevision: McpClientOAuthCredentialRevision,
		credential: Readonly<OAuthRuntimeCredential>,
	): Promise<McpClientOAuthCredentialCompareAndSwapResult<OAuthRuntimeCredential>> {
		const entry = this.#entries.get(identity);
		if (
			entry === undefined ||
			entry.revision !== expectedRevision ||
			entry.state.kind !== "active"
		) {
			return Promise.resolve(Object.freeze({ status: "conflict" as const }));
		}
		return Promise.resolve(
			Object.freeze({
				status: "applied" as const,
				snapshot: this.#advance(identity, expectedRevision, credential),
			}),
		);
	}

	invalidate(
		identity: string,
		expectedRevision: McpClientOAuthCredentialRevision,
	): Promise<McpClientOAuthCredentialInvalidationResult> {
		const entry = this.#entries.get(identity);
		if (entry === undefined || entry.revision !== expectedRevision) {
			return Promise.resolve(Object.freeze({ status: "conflict" as const }));
		}
		this.#entries.delete(identity);
		return Promise.resolve(Object.freeze({ status: "applied" as const }));
	}

	#advance(
		identity: string,
		expectedRevision: McpClientOAuthCredentialRevision,
		credential: Readonly<OAuthRuntimeCredential>,
	): McpClientOAuthCredentialSnapshot<OAuthRuntimeCredential> {
		const revision = nextMcpClientOAuthCredentialRevision(expectedRevision);
		const entry = Object.freeze({
			revision,
			credential: Object.freeze(credential),
			state: Object.freeze({ kind: "active" as const }),
		});
		this.#entries.set(identity, entry);
		return snapshot(entry);
	}
}

function snapshot(
	entry: CredentialEntry,
): McpClientOAuthCredentialSnapshot<OAuthRuntimeCredential> {
	return createMcpClientOAuthCredentialSnapshot(entry.revision, entry.credential);
}

function matchesClaim(
	entry: CredentialEntry | undefined,
	revision: McpClientOAuthCredentialRevision,
	claimId: McpClientOAuthRefreshClaimId,
): entry is CredentialEntry {
	return (
		entry !== undefined &&
		entry.revision === revision &&
		entry.state.kind === "claimed" &&
		entry.state.claimId === claimId.value
	);
}
