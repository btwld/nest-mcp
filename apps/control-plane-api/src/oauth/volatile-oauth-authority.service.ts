import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { FetchLike, OAuthClientInformationContext } from "@modelcontextprotocol/client";
import { auth, refreshAuthorization } from "@nest-mcp/client";
import {
	createOAuthStateLookupDigest,
	McpClientOAuthAuthProvider,
	McpClientOAuthRefreshCoordinator,
	parseOAuthCallbackParameters,
	validateOAuthState,
	type McpOAuthCallbackParameters,
} from "@nest-mcp/client/oauth";

import { ControlPlaneError } from "../common/control-plane.error.ts";
import { ControlPlaneConfigService } from "../config/control-plane-config.service.ts";
import { OAuthNetworkPolicyService } from "./oauth-network-policy.service.ts";
import type { OAuthConnectionView, OAuthRuntimeBridgeLease } from "./oauth.types.ts";
import {
	VolatileOAuthCredentialStore,
	type OAuthRuntimeCredential,
} from "./volatile-oauth-credential.store.ts";
import { VolatileOAuthProvider } from "./volatile-oauth-provider.ts";

const MAX_PROJECTED_SCOPES = 64;
const MAX_PROJECTED_SCOPE_LENGTH = 256;

type RuntimeAuthBridge = McpClientOAuthAuthProvider<string, OAuthRuntimeCredential>;

interface PendingAuthorization {
	readonly connectionId: string;
	readonly generationKey: string;
	readonly endpoint: string;
	readonly stateDigest: string;
	readonly createdAtMs: number;
	readonly provider: VolatileOAuthProvider;
	readonly fetch: FetchLike;
}

export interface PreparedOAuthAuthorization {
	readonly connectionId: string;
	readonly generationKey: string;
	readonly endpoint: string;
	readonly provider: VolatileOAuthProvider;
	readonly fetch: FetchLike;
}

interface SafeAuthorizationState {
	readonly status: OAuthConnectionView["status"];
	readonly scopes: readonly string[];
	readonly authorizationServerHost?: string;
	readonly errorCode?: string;
}

export interface TakenOAuthCallback {
	readonly attempt: PendingAuthorization;
	readonly callback: McpOAuthCallbackParameters;
}

@Injectable()
export class VolatileOAuthAuthorityService implements OnApplicationShutdown {
	readonly #pendingByConnection = new Map<string, PendingAuthorization>();
	readonly #pendingByStateDigest = new Map<string, PendingAuthorization>();
	readonly #connectionByGeneration = new Map<string, string>();
	readonly #bridges = new Map<string, Set<RuntimeAuthBridge>>();
	readonly #states = new Map<string, SafeAuthorizationState>();
	readonly #credentials = new VolatileOAuthCredentialStore();
	readonly #refresh: McpClientOAuthRefreshCoordinator<string, OAuthRuntimeCredential>;

	constructor(
		private readonly config: ControlPlaneConfigService,
		private readonly network: OAuthNetworkPolicyService,
	) {
		this.#refresh = new McpClientOAuthRefreshCoordinator<string, OAuthRuntimeCredential>({
			store: this.#credentials,
			maxInFlightKeys: config.maxConnections,
			refresh: async (generationKey, current) =>
				this.#refreshCredential(generationKey, current.credential),
			onInvalidated: (generationKey) => this.#requireReauthorization(generationKey),
		});
	}

	registerConnection(connectionId: string): void {
		if (this.#states.has(connectionId)) return;
		this.#states.set(connectionId, authorizationRequiredState());
	}

	isAuthorized(generationKey: string): boolean {
		const credential = this.#credentials.peek(generationKey);
		return (
			credential !== undefined && this.#states.get(credential.connectionId)?.status === "authorized"
		);
	}

	view(connectionId: string, generationKey: string): OAuthConnectionView {
		const state = this.#states.get(connectionId) ?? authorizationRequiredState();
		const credential = this.#credentials.peek(generationKey);
		const effective =
			credential === undefined || state.status !== "authorized"
				? state
				: authorizedState(credential);
		return Object.freeze({
			kind: "oauth" as const,
			status: effective.status,
			scopes: Object.freeze([...effective.scopes]),
			...(effective.authorizationServerHost === undefined
				? {}
				: { authorizationServerHost: effective.authorizationServerHost }),
			...(effective.errorCode === undefined ? {} : { errorCode: effective.errorCode }),
		});
	}

	async beginAuthorization(input: {
		readonly connectionId: string;
		readonly generationKey: string;
		readonly endpoint: string;
	}): Promise<string> {
		this.cancelPending(input.connectionId, false);
		this.#states.set(input.connectionId, authorizingState());
		const provider = new VolatileOAuthProvider({
			redirectUrl:
				this.config.oauthCallbackUrl ?? "http://127.0.0.1:5173/api/v1/mcp/oauth/callback",
			clientName: "Nest MCP local MCP manager",
		});
		const guardedFetch = this.network.createFetch(input.endpoint, () => provider.discoveryState());
		try {
			const result = await auth(provider, {
				serverUrl: input.endpoint,
				fetchFn: guardedFetch,
			});
			if (result !== "REDIRECT") throw oauthUpstreamFailedError();
			const redirect = provider.takeAuthorizationRedirect();
			const authorizationUrl = this.network.admitAuthorizationRedirect(
				redirect.authorizationUrl,
				provider.discoveryState(),
			);
			const attempt = Object.freeze({
				...input,
				stateDigest: redirect.stateDigest,
				createdAtMs: redirect.createdAtMs,
				provider,
				fetch: guardedFetch,
			});
			this.#pendingByConnection.set(input.connectionId, attempt);
			this.#pendingByStateDigest.set(attempt.stateDigest, attempt);
			this.#states.set(input.connectionId, discoveredState(provider));
			return authorizationUrl;
		} catch (error) {
			provider.invalidateCredentials("all");
			const mapped = mapOAuthFailure(error);
			this.#states.set(input.connectionId, failedState(mapped.code));
			throw mapped;
		}
	}

	takeCallback(parameters: URLSearchParams): TakenOAuthCallback {
		let callback: McpOAuthCallbackParameters;
		try {
			callback = parseOAuthCallbackParameters(parameters);
		} catch {
			throw oauthCallbackInvalidError();
		}
		let stateDigest: string;
		try {
			stateDigest = createOAuthStateLookupDigest(callback.state);
		} catch {
			throw oauthCallbackInvalidError();
		}
		const attempt = this.#pendingByStateDigest.get(stateDigest);
		if (attempt === undefined) throw oauthCallbackInvalidError();
		this.#pendingByStateDigest.delete(stateDigest);
		if (this.#pendingByConnection.get(attempt.connectionId) === attempt) {
			this.#pendingByConnection.delete(attempt.connectionId);
		}
		try {
			validateOAuthState({
				actualState: callback.state,
				expectedDigest: attempt.stateDigest,
				createdAtMs: attempt.createdAtMs,
				ttlMs: this.config.oauthTransactionTtlMs ?? 10 * 60 * 1_000,
			});
		} catch {
			attempt.provider.invalidateCredentials("all");
			this.#states.set(attempt.connectionId, failedState("MCP_OAUTH_CALLBACK_INVALID"));
			throw oauthCallbackInvalidError();
		}
		return Object.freeze({ attempt, callback });
	}

	discardTaken(taken: TakenOAuthCallback, errorCode: string): void {
		taken.attempt.provider.invalidateCredentials("all");
		this.#states.set(taken.attempt.connectionId, failedState(errorCode));
	}

	async exchangeCallback(taken: TakenOAuthCallback): Promise<PreparedOAuthAuthorization> {
		const { attempt, callback } = taken;
		if (callback.kind === "error") {
			attempt.provider.invalidateCredentials("all");
			this.#states.set(attempt.connectionId, failedState("MCP_OAUTH_AUTHORIZATION_DENIED"));
			throw oauthAuthorizationDeniedError();
		}
		try {
			const result = await auth(attempt.provider, {
				serverUrl: attempt.endpoint,
				authorizationCode: callback.code,
				...(callback.issuer === undefined ? {} : { iss: callback.issuer }),
				fetchFn: attempt.fetch,
			});
			if (result !== "AUTHORIZED" || attempt.provider.currentAccessToken() === undefined) {
				throw oauthUpstreamFailedError();
			}
			return Object.freeze({
				connectionId: attempt.connectionId,
				generationKey: attempt.generationKey,
				endpoint: attempt.endpoint,
				provider: attempt.provider,
				fetch: attempt.fetch,
			});
		} catch (error) {
			attempt.provider.invalidateCredentials("all");
			const mapped = mapOAuthFailure(error);
			this.#states.set(attempt.connectionId, failedState(mapped.code));
			throw mapped;
		}
	}

	/** Moves the authorization material out of the browser session into the runtime credential. */
	publishAuthorization(active: PreparedOAuthAuthorization, generationKey: string): void {
		const credential = captureCredential(active);
		active.provider.clearAuthorizationTransaction();
		active.provider.invalidateCredentials("all");
		this.#credentials.publish(generationKey, credential);
		this.#connectionByGeneration.set(generationKey, credential.connectionId);
		this.#states.set(credential.connectionId, authorizedState(credential));
	}

	discardPrepared(active: PreparedOAuthAuthorization): void {
		active.provider.invalidateCredentials("all");
		this.#states.set(active.connectionId, failedState("MCP_OAUTH_UPSTREAM_FAILED"));
	}

	acquireRuntimeBridge(generationKey: string): OAuthRuntimeBridgeLease {
		if (!this.isAuthorized(generationKey)) throw oauthAuthorizationRequiredError();
		const bridge: RuntimeAuthBridge = new McpClientOAuthAuthProvider({
			identity: generationKey,
			store: this.#credentials,
			refreshCoordinator: this.#refresh,
			selectBearerToken: (snapshot) => snapshot.credential.tokens.access_token,
		});
		let bridges = this.#bridges.get(generationKey);
		if (bridges === undefined) {
			bridges = new Set();
			this.#bridges.set(generationKey, bridges);
		}
		bridges.add(bridge);
		return Object.freeze({
			authProvider: bridge,
			close: async () => {
				this.#bridges.get(generationKey)?.delete(bridge);
				await bridge.close();
			},
		});
	}

	cancelPending(connectionId: string, resetState = true): void {
		const pending = this.#pendingByConnection.get(connectionId);
		if (pending !== undefined) {
			this.#pendingByConnection.delete(connectionId);
			this.#pendingByStateDigest.delete(pending.stateDigest);
			pending.provider.invalidateCredentials("all");
		}
		if (resetState) this.#states.set(connectionId, authorizationRequiredState());
	}

	fenceGeneration(generationKey: string): void {
		for (const bridge of this.#bridges.get(generationKey) ?? []) void bridge.close();
		this.#bridges.delete(generationKey);
		this.#connectionByGeneration.delete(generationKey);
		this.#credentials.remove(generationKey);
	}

	resetConnection(connectionId: string, generationKey: string): void {
		this.cancelPending(connectionId, false);
		this.fenceGeneration(generationKey);
		this.#states.set(connectionId, authorizationRequiredState());
	}

	removeConnection(connectionId: string, generationKey: string): void {
		this.cancelPending(connectionId, false);
		this.fenceGeneration(generationKey);
		this.#states.delete(connectionId);
	}

	onApplicationShutdown(): void {
		for (const connectionId of this.#pendingByConnection.keys()) {
			this.cancelPending(connectionId, false);
		}
		for (const generationKey of this.#connectionByGeneration.keys()) {
			this.fenceGeneration(generationKey);
		}
		void this.#refresh.close();
		this.#credentials.clear();
		this.#states.clear();
	}

	/**
	 * One credentialed token exchange per invocation, as the refresh coordinator
	 * requires: the guarded fetch never retries, and the coordinator settles an
	 * ambiguous outcome by retiring the generation.
	 */
	async #refreshCredential(
		generationKey: string,
		current: Readonly<OAuthRuntimeCredential>,
	): Promise<Readonly<OAuthRuntimeCredential>> {
		const refreshToken = current.tokens.refresh_token;
		if (refreshToken === undefined) throw oauthAuthorizationRequiredError();
		const metadata = current.discovery.authorizationServerMetadata;
		const tokens = await refreshAuthorization(current.discovery.authorizationServerUrl, {
			...(metadata === undefined ? {} : { metadata }),
			clientInformation: current.clientInformation,
			refreshToken,
			...(current.resourceUrl === undefined ? {} : { resource: new URL(current.resourceUrl) }),
			fetchFn: this.network.createFetch(current.endpoint, () => current.discovery),
		});
		const updated = Object.freeze({
			...current,
			tokens: Object.freeze({
				...tokens,
				refresh_token: tokens.refresh_token ?? refreshToken,
				issuer: current.issuer,
			}),
		});
		// A generation fenced while the exchange was in flight keeps whatever state
		// the fencing caller published; the commit that follows conflicts anyway.
		if (this.#connectionByGeneration.get(generationKey) === current.connectionId) {
			this.#states.set(current.connectionId, authorizedState(updated));
		}
		return updated;
	}

	#requireReauthorization(generationKey: string): void {
		const connectionId = this.#connectionByGeneration.get(generationKey);
		const previous = connectionId === undefined ? undefined : this.#states.get(connectionId);
		this.fenceGeneration(generationKey);
		if (connectionId === undefined) return;
		this.#states.set(connectionId, reauthorizationRequiredState(previous));
	}
}

/**
 * Lifts the browser session's material into one immutable runtime credential.
 * The volatile provider is wiped by the caller so the secrets live in exactly
 * one place afterwards.
 */
function captureCredential(active: PreparedOAuthAuthorization): OAuthRuntimeCredential {
	const issuer = active.provider.issuer();
	const discovery = active.provider.discoveryState();
	const context =
		issuer === undefined ? undefined : ({ issuer } satisfies OAuthClientInformationContext);
	const clientInformation =
		context === undefined ? undefined : active.provider.clientInformation(context);
	const tokens = context === undefined ? undefined : active.provider.tokens(context);
	const resourceUrl = active.provider.resourceUrl();
	if (
		issuer === undefined ||
		discovery === undefined ||
		clientInformation === undefined ||
		tokens === undefined
	) {
		throw oauthUpstreamFailedError();
	}
	return Object.freeze({
		connectionId: active.connectionId,
		endpoint: active.endpoint,
		issuer,
		discovery,
		clientInformation,
		tokens,
		...(resourceUrl === undefined ? {} : { resourceUrl }),
	});
}

function authorizedState(credential: Readonly<OAuthRuntimeCredential>): SafeAuthorizationState {
	const discovery = credential.discovery;
	const scopeValues =
		grantedScopes(credential.tokens.scope) ??
		discovery.resourceMetadata?.scopes_supported ??
		discovery.authorizationServerMetadata?.scopes_supported ??
		[];
	return Object.freeze({
		status: "authorized" as const,
		scopes: boundedScopes(scopeValues),
		...hostBinding(
			discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl,
		),
	});
}

function discoveredState(provider: VolatileOAuthProvider): SafeAuthorizationState {
	const discovery = provider.discoveryState();
	const scopeValues =
		discovery?.resourceMetadata?.scopes_supported ??
		discovery?.authorizationServerMetadata?.scopes_supported ??
		[];
	return Object.freeze({
		status: "authorizing" as const,
		scopes: boundedScopes(scopeValues),
		...hostBinding(
			discovery?.authorizationServerMetadata?.issuer ?? discovery?.authorizationServerUrl,
		),
	});
}

function grantedScopes(scope: string | undefined): readonly string[] | undefined {
	if (scope === undefined) return undefined;
	return [...new Set(scope.split(/\s+/u).filter((value) => value.length > 0))];
}

function boundedScopes(values: readonly unknown[]): readonly string[] {
	return Object.freeze(
		values
			.filter((scope): scope is string => typeof scope === "string")
			.slice(0, MAX_PROJECTED_SCOPES)
			.map((scope) => scope.slice(0, MAX_PROJECTED_SCOPE_LENGTH)),
	);
}

function hostBinding(issuer: string | undefined): { readonly authorizationServerHost?: string } {
	if (issuer === undefined) return {};
	try {
		return { authorizationServerHost: new URL(issuer).host };
	} catch {
		return {};
	}
}

function authorizationRequiredState(): SafeAuthorizationState {
	return Object.freeze({ status: "authorization-required", scopes: Object.freeze([]) });
}

function authorizingState(): SafeAuthorizationState {
	return Object.freeze({ status: "authorizing", scopes: Object.freeze([]) });
}

function reauthorizationRequiredState(
	previous: SafeAuthorizationState | undefined,
): SafeAuthorizationState {
	return Object.freeze({
		status: "reauthorization-required" as const,
		scopes: previous?.scopes ?? Object.freeze([]),
		...(previous?.authorizationServerHost === undefined
			? {}
			: { authorizationServerHost: previous.authorizationServerHost }),
		errorCode: "MCP_OAUTH_AUTHORIZATION_REQUIRED",
	});
}

function failedState(errorCode: string): SafeAuthorizationState {
	return Object.freeze({ status: "failed", scopes: Object.freeze([]), errorCode });
}

function mapOAuthFailure(error: unknown): ControlPlaneError {
	if (error instanceof ControlPlaneError) return error;
	return oauthUpstreamFailedError();
}

function oauthAuthorizationRequiredError(): ControlPlaneError {
	return new ControlPlaneError(
		"MCP_OAUTH_AUTHORIZATION_REQUIRED",
		409,
		"The MCP connection requires OAuth authorization.",
	);
}

function oauthAuthorizationDeniedError(): ControlPlaneError {
	return new ControlPlaneError(
		"MCP_OAUTH_AUTHORIZATION_DENIED",
		403,
		"OAuth authorization was denied.",
	);
}

function oauthCallbackInvalidError(): ControlPlaneError {
	return new ControlPlaneError(
		"MCP_OAUTH_CALLBACK_INVALID",
		400,
		"The OAuth callback is invalid or no longer active.",
	);
}

function oauthUpstreamFailedError(): ControlPlaneError {
	return new ControlPlaneError(
		"MCP_OAUTH_UPSTREAM_FAILED",
		502,
		"The OAuth authorization server could not complete the request.",
	);
}
