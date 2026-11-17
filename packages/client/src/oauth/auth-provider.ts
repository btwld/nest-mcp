import type { AuthProvider } from "@modelcontextprotocol/client";

import {
	createMcpClientOAuthCredentialSnapshot,
	isMcpClientOAuthCredentialRevision,
	type McpClientOAuthCredentialSnapshot,
	type McpClientOAuthCredentialRevision,
	type McpClientOAuthCredentialStore,
} from "./credential-store.ts";
import type { McpClientOAuthRefreshCoordinator } from "./refresh-coordinator.ts";

const MAX_BEARER_TOKEN_LENGTH = 65_536;
const BEARER_TOKEN_PATTERN = /^[-A-Za-z0-9._~+/]+=*$/u;

type UnauthorizedContext = Parameters<NonNullable<AuthProvider["onUnauthorized"]>>[0];

/** Stable, identity- and secret-free transport-bridge failures. */
export const McpClientOAuthAuthProviderErrorCode = {
	InvalidOptions: "MCP_CLIENT_OAUTH_AUTH_PROVIDER_INVALID_OPTIONS",
	Closed: "MCP_CLIENT_OAUTH_AUTH_PROVIDER_CLOSED",
	CredentialMissing: "MCP_CLIENT_OAUTH_AUTH_PROVIDER_CREDENTIAL_MISSING",
	CredentialRevisionChanged: "MCP_CLIENT_OAUTH_AUTH_PROVIDER_CREDENTIAL_REVISION_CHANGED",
	StoreFailed: "MCP_CLIENT_OAUTH_AUTH_PROVIDER_STORE_FAILED",
	InvalidStoreResult: "MCP_CLIENT_OAUTH_AUTH_PROVIDER_STORE_RESULT_INVALID",
	TokenMissing: "MCP_CLIENT_OAUTH_AUTH_PROVIDER_TOKEN_MISSING",
	TokenInvalid: "MCP_CLIENT_OAUTH_AUTH_PROVIDER_TOKEN_INVALID",
	TokenAccessorFailed: "MCP_CLIENT_OAUTH_AUTH_PROVIDER_TOKEN_ACCESSOR_FAILED",
	RefreshFailed: "MCP_CLIENT_OAUTH_AUTH_PROVIDER_REFRESH_FAILED",
} as const;

export type McpClientOAuthAuthProviderErrorCode =
	(typeof McpClientOAuthAuthProviderErrorCode)[keyof typeof McpClientOAuthAuthProviderErrorCode];

/** Error whose public fields and message never contain an identity, token, or upstream response. */
export class McpClientOAuthAuthProviderError extends Error {
	readonly code: McpClientOAuthAuthProviderErrorCode;

	constructor(code: McpClientOAuthAuthProviderErrorCode) {
		super(authProviderErrorMessage(code));
		this.name = "McpClientOAuthAuthProviderError";
		this.code = code;
	}
}

export interface McpClientOAuthBearerTokenAccessorContext {
	/** Provider-lifecycle cancellation. Accessors must stop promptly when it aborts. */
	readonly signal: AbortSignal;
}

/**
 * Selects the bearer token from one complete, immutable credential generation.
 * Returning `undefined` is a deterministic missing-token failure.
 */
export type McpClientOAuthBearerTokenAccessor<Credential extends object> = (
	snapshot: McpClientOAuthCredentialSnapshot<Credential>,
	context: McpClientOAuthBearerTokenAccessorContext,
) => string | undefined | PromiseLike<string | undefined>;

export interface McpClientOAuthAuthProviderOptions<Identity, Credential extends object> {
	/** One opaque, stable, non-secret credential binding. It is never exposed by the provider. */
	readonly identity: Identity;
	/** Pin one operation to an exact revision. Rotation requires a new provider; delayed 401s cannot refresh its replacement. */
	readonly expectedCredentialRevision?: McpClientOAuthCredentialRevision;
	readonly store: McpClientOAuthCredentialStore<Identity, Credential>;
	readonly refreshCoordinator: McpClientOAuthRefreshCoordinator<Identity, Credential>;
	readonly selectBearerToken: McpClientOAuthBearerTokenAccessor<Credential>;
}

/**
 * Per-binding bridge from revisioned OAuth credentials to the SDK's minimal `AuthProvider`.
 *
 * It intentionally has no `tokens()` or `clientInformation()` members, so the official
 * transport cannot classify it as an `OAuthClientProvider` and cannot start interactive or
 * Dynamic Client Registration flows. The store and coordinator are borrowed; closing this
 * bridge never closes either dependency. It follows successful credential revisions within one
 * stable binding by default. Set expectedCredentialRevision for an operation that must close
 * and be reacquired after rotation; its token and refresh paths both enforce the exact revision.
 */
export class McpClientOAuthAuthProvider<Identity, Credential extends object>
	implements AuthProvider, AsyncDisposable
{
	readonly #identity: Identity;
	readonly #expectedCredentialRevision: McpClientOAuthCredentialRevision | undefined;
	readonly #store: McpClientOAuthCredentialStore<Identity, Credential>;
	readonly #refreshCoordinator: McpClientOAuthRefreshCoordinator<Identity, Credential>;
	readonly #selectBearerToken: McpClientOAuthBearerTokenAccessor<Credential>;
	readonly #lifecycleController = new AbortController();
	readonly #inFlight = new Set<Promise<unknown>>();
	#closed = false;
	#closeTask: Promise<void> | undefined;

	constructor(options: McpClientOAuthAuthProviderOptions<Identity, Credential>) {
		const normalized = normalizeOptions(options);
		this.#identity = normalized.identity;
		this.#expectedCredentialRevision = normalized.expectedCredentialRevision;
		this.#store = normalized.store;
		this.#refreshCoordinator = normalized.refreshCoordinator;
		this.#selectBearerToken = normalized.selectBearerToken;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Loads the authoritative generation on every request; no token is cached in the bridge. */
	token(): Promise<string | undefined> {
		return this.#start(async () => {
			const snapshot = await this.#loadCurrent();
			return this.#readBearerToken(snapshot);
		});
	}

	/**
	 * Refreshes exactly the authoritative revision loaded for this binding. Concurrent 401s join
	 * in the coordinator. A process-external claim or winner is accepted only after an authoritative
	 * reload; only a strictly newer revision completes this call, and this bridge never retries the
	 * stale refresh token. The
	 * SDK does not identify the failed request's credential revision in this callback. A delayed 401
	 * can therefore arrive after another request published a newer generation and refresh that newer
	 * generation. An expectedCredentialRevision fences this reload before refresh: a pinned provider
	 * never refreshes or adopts a replacement. Its successful refresh still publishes for a fresh
	 * acquisition, while the old operation fails closed. Unpinned hosts need request correlation
	 * or conservative close/reacquire; the transport bounds each wire request to one retry.
	 */
	onUnauthorized(_context: UnauthorizedContext): Promise<void> {
		return this.#start(async () => {
			const current = await this.#loadCurrent();
			let refreshed: McpClientOAuthCredentialSnapshot<Credential>;
			try {
				refreshed = await this.#refreshCoordinator.refresh(this.#identity, current.revision, {
					signal: this.#lifecycleController.signal,
				});
			} catch {
				this.#assertActive();
				const winner = await this.#loadOptional();
				if (winner !== undefined && winner.revision > current.revision) {
					await this.#readBearerToken(winner);
					return;
				}
				throw refreshFailedError();
			}

			this.#assertActive();
			const published = await this.#loadCurrent();
			if (published.revision < refreshed.revision) throw invalidStoreResultError();
			await this.#readBearerToken(published);
		});
	}

	/** Fences new work, cancels this provider's waits, and drains all accepted bridge calls. */
	close(): Promise<void> {
		if (this.#closeTask !== undefined) return this.#closeTask;
		this.#closed = true;
		this.#lifecycleController.abort(providerClosedAbortReason());
		const accepted = [...this.#inFlight];
		this.#closeTask = Promise.allSettled(accepted).then(() => undefined);
		return this.#closeTask;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	#start<Result>(operation: () => Promise<Result>): Promise<Result> {
		if (this.#closed) return Promise.reject(providerClosedError());
		const task = Promise.resolve().then(operation);
		this.#inFlight.add(task);
		const remove = (): void => {
			this.#inFlight.delete(task);
		};
		void task.then(remove, remove);
		return task;
	}

	async #loadCurrent(): Promise<McpClientOAuthCredentialSnapshot<Credential>> {
		const snapshot = await this.#loadOptional();
		if (snapshot === undefined) throw credentialMissingError();
		return snapshot;
	}

	async #loadOptional(): Promise<McpClientOAuthCredentialSnapshot<Credential> | undefined> {
		this.#assertActive();
		let snapshot: McpClientOAuthCredentialSnapshot<Credential> | undefined;
		try {
			snapshot = await this.#store.load(
				this.#identity,
				Object.freeze({ signal: this.#lifecycleController.signal }),
			);
		} catch {
			this.#assertActive();
			throw storeFailedError();
		}
		this.#assertActive();
		if (snapshot === undefined) return undefined;

		let captured: McpClientOAuthCredentialSnapshot<Credential>;
		try {
			if (
				!isMcpClientOAuthCredentialRevision(snapshot.revision) ||
				!isObjectLike(snapshot.credential)
			) {
				throw invalidStoreResultError();
			}
			captured = createMcpClientOAuthCredentialSnapshot<Credential>(
				snapshot.revision,
				snapshot.credential,
			);
		} catch {
			throw invalidStoreResultError();
		}
		if (
			this.#expectedCredentialRevision !== undefined &&
			captured.revision !== this.#expectedCredentialRevision
		) {
			throw new McpClientOAuthAuthProviderError(
				McpClientOAuthAuthProviderErrorCode.CredentialRevisionChanged,
			);
		}
		return captured;
	}

	async #readBearerToken(snapshot: McpClientOAuthCredentialSnapshot<Credential>): Promise<string> {
		this.#assertActive();
		let token: string | undefined;
		try {
			token = await this.#selectBearerToken(
				snapshot,
				Object.freeze({ signal: this.#lifecycleController.signal }),
			);
		} catch {
			this.#assertActive();
			throw tokenAccessorFailedError();
		}
		this.#assertActive();
		if (token === undefined) throw tokenMissingError();
		if (!isValidBearerToken(token)) throw tokenInvalidError();
		return token;
	}

	#assertActive(): void {
		if (this.#closed || this.#lifecycleController.signal.aborted) {
			throw providerClosedError();
		}
	}
}

function normalizeOptions<Identity, Credential extends object>(
	options: McpClientOAuthAuthProviderOptions<Identity, Credential>,
): McpClientOAuthAuthProviderOptions<Identity, Credential> {
	if (!isObjectLike(options)) throw invalidOptionsError();
	let identity: Identity;
	let expectedCredentialRevision: McpClientOAuthCredentialRevision | undefined;
	let store: McpClientOAuthCredentialStore<Identity, Credential>;
	let refreshCoordinator: McpClientOAuthRefreshCoordinator<Identity, Credential>;
	let selectBearerToken: McpClientOAuthBearerTokenAccessor<Credential>;
	try {
		identity = options.identity;
		expectedCredentialRevision = options.expectedCredentialRevision;
		store = options.store;
		refreshCoordinator = options.refreshCoordinator;
		selectBearerToken = options.selectBearerToken;
	} catch {
		throw invalidOptionsError();
	}
	let valid = false;
	try {
		valid =
			(expectedCredentialRevision === undefined ||
				isMcpClientOAuthCredentialRevision(expectedCredentialRevision)) &&
			isObjectLike(store) &&
			typeof store.load === "function" &&
			typeof store.claimRefresh === "function" &&
			typeof store.commitRefresh === "function" &&
			typeof store.releaseRefreshClaim === "function" &&
			typeof store.compareAndSwap === "function" &&
			typeof store.invalidate === "function" &&
			isObjectLike(refreshCoordinator) &&
			typeof refreshCoordinator.refresh === "function" &&
			typeof selectBearerToken === "function";
	} catch {
		valid = false;
	}
	if (!valid) {
		throw invalidOptionsError();
	}
	return Object.freeze({
		identity,
		store,
		refreshCoordinator,
		selectBearerToken,
		...(expectedCredentialRevision === undefined ? {} : { expectedCredentialRevision }),
	});
}

function isObjectLike(value: unknown): value is object {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

function isValidBearerToken(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_BEARER_TOKEN_LENGTH &&
		BEARER_TOKEN_PATTERN.test(value)
	);
}

function invalidOptionsError(): McpClientOAuthAuthProviderError {
	return new McpClientOAuthAuthProviderError(McpClientOAuthAuthProviderErrorCode.InvalidOptions);
}

function providerClosedError(): McpClientOAuthAuthProviderError {
	return new McpClientOAuthAuthProviderError(McpClientOAuthAuthProviderErrorCode.Closed);
}

function credentialMissingError(): McpClientOAuthAuthProviderError {
	return new McpClientOAuthAuthProviderError(McpClientOAuthAuthProviderErrorCode.CredentialMissing);
}

function storeFailedError(): McpClientOAuthAuthProviderError {
	return new McpClientOAuthAuthProviderError(McpClientOAuthAuthProviderErrorCode.StoreFailed);
}

function invalidStoreResultError(): McpClientOAuthAuthProviderError {
	return new McpClientOAuthAuthProviderError(
		McpClientOAuthAuthProviderErrorCode.InvalidStoreResult,
	);
}

function tokenMissingError(): McpClientOAuthAuthProviderError {
	return new McpClientOAuthAuthProviderError(McpClientOAuthAuthProviderErrorCode.TokenMissing);
}

function tokenInvalidError(): McpClientOAuthAuthProviderError {
	return new McpClientOAuthAuthProviderError(McpClientOAuthAuthProviderErrorCode.TokenInvalid);
}

function tokenAccessorFailedError(): McpClientOAuthAuthProviderError {
	return new McpClientOAuthAuthProviderError(
		McpClientOAuthAuthProviderErrorCode.TokenAccessorFailed,
	);
}

function refreshFailedError(): McpClientOAuthAuthProviderError {
	return new McpClientOAuthAuthProviderError(McpClientOAuthAuthProviderErrorCode.RefreshFailed);
}

function authProviderErrorMessage(code: McpClientOAuthAuthProviderErrorCode): string {
	switch (code) {
		case McpClientOAuthAuthProviderErrorCode.InvalidOptions:
			return "The OAuth auth-provider options are invalid.";
		case McpClientOAuthAuthProviderErrorCode.Closed:
			return "The OAuth auth provider is closed and cannot accept new work.";
		case McpClientOAuthAuthProviderErrorCode.CredentialMissing:
			return "The OAuth credential generation is unavailable.";
		case McpClientOAuthAuthProviderErrorCode.CredentialRevisionChanged:
			return "The OAuth credential revision changed; acquire a new operation.";
		case McpClientOAuthAuthProviderErrorCode.StoreFailed:
			return "The OAuth credential store operation failed.";
		case McpClientOAuthAuthProviderErrorCode.InvalidStoreResult:
			return "The OAuth credential store returned an invalid result.";
		case McpClientOAuthAuthProviderErrorCode.TokenMissing:
			return "The OAuth credential has no bearer token.";
		case McpClientOAuthAuthProviderErrorCode.TokenInvalid:
			return "The OAuth bearer token is invalid.";
		case McpClientOAuthAuthProviderErrorCode.TokenAccessorFailed:
			return "The OAuth bearer-token accessor failed.";
		case McpClientOAuthAuthProviderErrorCode.RefreshFailed:
			return "The OAuth credential could not be refreshed.";
		default:
			return "The OAuth auth provider failed.";
	}
}

function providerClosedAbortReason(): DOMException {
	return new DOMException("The OAuth auth provider was closed.", "AbortError");
}
