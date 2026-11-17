import { createHash } from "node:crypto";

import {
	OAuthError,
	discoverAuthorizationServerMetadata,
	discoverOAuthProtectedResourceMetadata,
	exchangeAuthorization,
	refreshAuthorization,
	startAuthorization,
} from "@modelcontextprotocol/client";
import type {
	AddClientAuthentication,
	AuthorizationServerMetadata,
	FetchLike,
	OAuthClientInformationMixed,
	OAuthTokens,
} from "@modelcontextprotocol/client";

import {
	createOAuthState,
	createOAuthStateLookupDigest,
	createPkceS256Challenge,
	parseOAuthCallbackParameters,
	validateOAuthState,
} from "./state.ts";
import type { McpOAuthCallbackParameterInput } from "./state.ts";
import {
	isInternalMcpClientOAuthProtocolError,
	markInternalMcpClientOAuthProtocolError,
} from "./protocol-error-brand.ts";
import { isMcpClientOAuthScopeToken } from "./scope.ts";
import {
	assertOAuthSnapshotKeys,
	oauthSnapshotBoolean,
	oauthSnapshotString,
	oauthSnapshotStrings,
	parseOAuthSnapshot,
	type McpClientOAuthSnapshotOptions,
} from "./snapshot-data.ts";

const DEFAULT_AUTHORIZATION_TRANSACTION_TTL_MS = 10 * 60 * 1_000;
const MAX_AUTHORIZATION_TRANSACTION_TTL_MS = 60 * 60 * 1_000;
const MAX_URL_LENGTH = 4_096;
const MAX_CLIENT_ID_LENGTH = 2_048;
const MAX_CLIENT_SECRET_LENGTH = 8_192;
const MAX_TOKEN_LENGTH = 65_536;
const MAX_SCOPE_COUNT = 128;
const MAX_SCOPE_STRING_LENGTH = 4_096;
const MAX_METADATA_LIST_LENGTH = 256;
const MAX_METADATA_VALUE_LENGTH = 2_048;
const AUTHORITY_DIGEST_DOMAIN = "nest-mcp.client.oauth-authority.v1\u0000";
const PRIVATE_KEY_JWT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const PRIVATE_KEY_JWT_PARAMETER_NAMES = Object.freeze([
	"client_id",
	"client_assertion_type",
	"client_assertion",
]);

/** Stable, secret-free failure categories for the strict outbound OAuth facade. */
export const McpClientOAuthProtocolErrorCode = {
	InvalidOptions: "MCP_CLIENT_OAUTH_INVALID_OPTIONS",
	EndpointRejected: "MCP_CLIENT_OAUTH_ENDPOINT_REJECTED",
	DiscoveryFailed: "MCP_CLIENT_OAUTH_DISCOVERY_FAILED",
	AuthorityInvalid: "MCP_CLIENT_OAUTH_AUTHORITY_INVALID",
	ClientUnsupported: "MCP_CLIENT_OAUTH_CLIENT_UNSUPPORTED",
	TransactionInvalid: "MCP_CLIENT_OAUTH_TRANSACTION_INVALID",
	AuthorizationDenied: "MCP_CLIENT_OAUTH_AUTHORIZATION_DENIED",
	AuthorizationFailed: "MCP_CLIENT_OAUTH_AUTHORIZATION_FAILED",
	InvalidGrant: "MCP_CLIENT_OAUTH_INVALID_GRANT",
	InvalidClient: "MCP_CLIENT_OAUTH_INVALID_CLIENT",
	TokenExchangeFailed: "MCP_CLIENT_OAUTH_TOKEN_EXCHANGE_FAILED",
	TokenRefreshFailed: "MCP_CLIENT_OAUTH_TOKEN_REFRESH_FAILED",
	RefreshOutcomeUnknown: "MCP_CLIENT_OAUTH_REFRESH_OUTCOME_UNKNOWN",
} as const;

export type McpClientOAuthProtocolErrorCode =
	(typeof McpClientOAuthProtocolErrorCode)[keyof typeof McpClientOAuthProtocolErrorCode];

/**
 * Public protocol-error shape. Library-emitted instances use fixed, secret-free messages; callers
 * constructing this class directly remain responsible for their message and receive no internal
 * authenticity brand.
 */
export class McpClientOAuthProtocolError extends Error {
	readonly code: McpClientOAuthProtocolErrorCode;

	constructor(code: McpClientOAuthProtocolErrorCode, message: string) {
		super(message);
		this.name = "McpClientOAuthProtocolError";
		this.code = code;
	}
}

function createInternalProtocolError(
	code: McpClientOAuthProtocolErrorCode,
	message: string,
): McpClientOAuthProtocolError {
	return markInternalMcpClientOAuthProtocolError(new McpClientOAuthProtocolError(code, message));
}

export type McpClientOAuthEndpointKind =
	"resource-metadata" | "authorization-server-metadata" | "authorization" | "token";

export interface McpClientOAuthEndpointPolicyInput {
	/** A disposable URL copy. Mutating it never changes the destination used by the facade. */
	readonly endpoint: URL;
	readonly kind: McpClientOAuthEndpointKind;
	readonly credentialed: boolean;
	readonly exactResource: string;
	readonly exactIssuer: string;
	readonly resource: URL;
	readonly issuer: URL;
	readonly signal?: AbortSignal;
}

/** Only literal `true` admits an endpoint; false, undefined, or an exception fails closed. */
export type McpClientOAuthEndpointPolicy = (
	input: McpClientOAuthEndpointPolicyInput,
) => boolean | PromiseLike<boolean>;

export interface McpClientOAuthProtocolOptions {
	/**
	 * A host-owned SSRF-hardened fetch. It must pin DNS, reject redirects, and bound bodies/time.
	 * It must never automatically retry credentialed token POSTs: the facade invokes the host fetch
	 * once and must receive ambiguous failures unchanged. The facade also forces `redirect: "error"`
	 * and applies `endpointPolicy` before each call.
	 */
	readonly fetch: FetchLike;
	readonly endpointPolicy: McpClientOAuthEndpointPolicy;
	readonly authorizationTransactionTtlMs?: number;
	readonly now?: () => number;
}

export interface McpClientOAuthDiscoveryInput {
	/** MCP HTTP endpoint used to derive RFC 9728 discovery locations. */
	readonly serverUrl: string;
	/** Exact RFC 8707 resource indicator expected in RFC 9728 metadata. */
	readonly resource: string;
	/** Exact authorization-server issuer selected by application policy. */
	readonly issuer: string;
	readonly resourceMetadataUrl?: string;
	readonly signal?: AbortSignal;
}

/**
 * A bounded, serializable authority snapshot. It intentionally excludes registration endpoints
 * and unknown metadata so it cannot enable Dynamic Client Registration.
 */
export interface McpClientOAuthAuthority {
	readonly serverUrl: string;
	readonly resource: string;
	readonly issuer: string;
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly responseTypesSupported: readonly string[];
	readonly codeChallengeMethodsSupported: readonly string[];
	readonly tokenEndpointAuthMethodsSupported: readonly string[];
	readonly grantTypesSupported?: readonly string[];
	readonly resourceScopesSupported?: readonly string[];
	readonly authorizationScopesSupported?: readonly string[];
	/** Whether RFC 9207 requires an `iss` parameter in the authorization response. */
	readonly authorizationResponseIssuerParameterSupported: boolean;
}

export type McpClientOAuthClientAuthentication =
	| { readonly method: "none" }
	| { readonly method: "client_secret_basic"; readonly clientSecret: string }
	| { readonly method: "client_secret_post"; readonly clientSecret: string }
	| {
			readonly method: "private_key_jwt";
			readonly addClientAuthentication: AddClientAuthentication;
	  };

/** Client information must be provisioned out of band; this API has no registration operation. */
export interface McpClientOAuthClient {
	readonly clientId: string;
	readonly authentication: McpClientOAuthClientAuthentication;
}

export interface McpClientOAuthStartAuthorizationInput {
	readonly authority: McpClientOAuthAuthority;
	readonly client: McpClientOAuthClient;
	readonly redirectUri: string;
	readonly scopes?: readonly string[];
	readonly signal?: AbortSignal;
}

/**
 * Secret-bearing redirect transaction. Persist it encrypted and bind it to the browser session.
 * `stateDigest` is suitable for lookup; plaintext state is intentionally not retained here.
 */
export interface McpClientOAuthAuthorizationTransaction {
	readonly authority: McpClientOAuthAuthority;
	/** Non-secret corruption/swap coordinate; authenticated host storage remains mandatory. */
	readonly authorityDigest: string;
	readonly stateDigest: string;
	readonly codeVerifier: string;
	readonly redirectUri: string;
	readonly clientId: string;
	readonly clientAuthenticationMethod: McpClientOAuthClientAuthentication["method"];
	readonly scope?: string;
	readonly createdAtMs: number;
}

export interface McpClientOAuthStartAuthorizationResult {
	readonly authorizationUrl: string;
	readonly transaction: McpClientOAuthAuthorizationTransaction;
}

export interface McpClientOAuthExchangeAuthorizationInput {
	/**
	 * The host must first parse state, atomically take the transaction by its digest, and then call
	 * this method exactly once. A network-ambiguous exchange must never make the code replayable.
	 */
	readonly transaction: McpClientOAuthAuthorizationTransaction;
	readonly client: McpClientOAuthClient;
	readonly callback: McpOAuthCallbackParameterInput;
	readonly signal?: AbortSignal;
}

export interface McpClientOAuthRefreshInput {
	readonly authority: McpClientOAuthAuthority;
	readonly client: McpClientOAuthClient;
	/** Current effective grant, retained when a conforming refresh response omits `scope`. */
	readonly currentScope?: string;
	readonly refreshToken: string;
	readonly signal?: AbortSignal;
}

interface McpClientOAuthHostFetchAttempt {
	invoked: boolean;
	responseReturned: boolean;
}

/**
 * Strict, framework-neutral OAuth protocol facade for outbound MCP clients.
 *
 * It deliberately exposes no dynamic registration and never constructs an OAuthClientProvider,
 * preventing the MCP transport from launching interactive or DCR flows implicitly.
 */
export class McpClientOAuthProtocol {
	readonly #fetch: FetchLike;
	readonly #endpointPolicy: McpClientOAuthEndpointPolicy;
	readonly #authorizationTransactionTtlMs: number;
	readonly #now: () => number;

	constructor(options: McpClientOAuthProtocolOptions) {
		if (
			typeof options !== "object" ||
			options === null ||
			typeof options.fetch !== "function" ||
			typeof options.endpointPolicy !== "function" ||
			(options.now !== undefined && typeof options.now !== "function")
		) {
			throw invalidOptionsError();
		}
		const ttlMs = options.authorizationTransactionTtlMs ?? DEFAULT_AUTHORIZATION_TRANSACTION_TTL_MS;
		if (
			!Number.isSafeInteger(ttlMs) ||
			ttlMs <= 0 ||
			ttlMs > MAX_AUTHORIZATION_TRANSACTION_TTL_MS
		) {
			throw invalidOptionsError();
		}
		this.#fetch = options.fetch;
		this.#endpointPolicy = options.endpointPolicy;
		this.#authorizationTransactionTtlMs = ttlMs;
		this.#now = options.now ?? Date.now;
	}

	/** Resolves and freezes exact RFC 9728/RFC 8414 authority without following DCR. */
	async discover(input: McpClientOAuthDiscoveryInput): Promise<McpClientOAuthAuthority> {
		const operation = normalizeDiscoveryInput(input);
		throwIfAborted(operation.signal);

		let resourceMetadata;
		try {
			resourceMetadata = await discoverOAuthProtectedResourceMetadata(
				operation.serverUrl,
				operation.resourceMetadataUrl === undefined
					? undefined
					: { resourceMetadataUrl: operation.resourceMetadataUrl },
				this.#createFetch({
					kind: "resource-metadata",
					credentialed: false,
					resource: operation.resource,
					issuer: operation.issuer,
					signal: operation.signal,
				}),
			);
		} catch (error) {
			throwIfAborted(operation.signal);
			if (error instanceof McpClientOAuthProtocolError) {
				throw canonicalizeProtocolError(error, discoveryFailedError);
			}
			throw discoveryFailedError();
		}

		if (
			resourceMetadata.resource !== operation.resource ||
			resourceMetadata.authorization_servers === undefined ||
			!resourceMetadata.authorization_servers.includes(operation.issuer)
		) {
			throw authorityInvalidError();
		}
		if (
			(resourceMetadata.bearer_methods_supported !== undefined &&
				!resourceMetadata.bearer_methods_supported.includes("header")) ||
			resourceMetadata.tls_client_certificate_bound_access_tokens === true ||
			resourceMetadata.dpop_bound_access_tokens_required === true
		) {
			throw authorityInvalidError();
		}

		let metadata: AuthorizationServerMetadata | undefined;
		try {
			metadata = await discoverAuthorizationServerMetadata(operation.issuer, {
				fetchFn: this.#createFetch({
					kind: "authorization-server-metadata",
					credentialed: false,
					resource: operation.resource,
					issuer: operation.issuer,
					signal: operation.signal,
				}),
			});
		} catch (error) {
			throwIfAborted(operation.signal);
			if (error instanceof McpClientOAuthProtocolError) {
				throw canonicalizeProtocolError(error, discoveryFailedError);
			}
			throw discoveryFailedError();
		}

		throwIfAborted(operation.signal);
		if (metadata === undefined || metadata.issuer !== operation.issuer) {
			throw authorityInvalidError();
		}

		const authority = createAuthority({
			serverUrl: operation.serverUrl,
			resource: operation.resource,
			issuer: operation.issuer,
			metadata,
			...(resourceMetadata.scopes_supported === undefined
				? {}
				: { resourceScopesSupported: resourceMetadata.scopes_supported }),
		});
		await this.#authorizeEndpoint(authority.authorizationEndpoint, {
			kind: "authorization",
			credentialed: false,
			resource: authority.resource,
			issuer: authority.issuer,
			signal: operation.signal,
		});
		await this.#authorizeEndpoint(authority.tokenEndpoint, {
			kind: "token",
			credentialed: true,
			resource: authority.resource,
			issuer: authority.issuer,
			signal: operation.signal,
		});
		return authority;
	}

	/** Starts a PKCE S256 authorization request and returns an endpoint-pinned transaction. */
	async startAuthorization(
		input: McpClientOAuthStartAuthorizationInput,
	): Promise<McpClientOAuthStartAuthorizationResult> {
		if (typeof input !== "object" || input === null) throw invalidOptionsError();
		const authority = normalizeAuthority(input.authority);
		const client = normalizeClient(input.client, authority);
		const redirectUri = requireRedirectUri(input.redirectUri).href;
		const scope = normalizeScopes(input.scopes, authority);
		throwIfAborted(input.signal);
		await this.#authorizeEndpoint(authority.authorizationEndpoint, {
			kind: "authorization",
			credentialed: false,
			resource: authority.resource,
			issuer: authority.issuer,
			signal: input.signal,
		});

		const state = createOAuthState();
		let started;
		try {
			started = await startAuthorization(authority.issuer, {
				metadata: toSdkMetadata(authority),
				clientInformation: toSdkClientInformation(client),
				redirectUrl: redirectUri,
				state,
				resource: new URL(authority.resource),
				...(scope === undefined ? {} : { scope }),
			});
		} catch {
			throwIfAborted(input.signal);
			throw authorizationFailedError();
		}
		throwIfAborted(input.signal);
		const codeChallenge = createPkceS256Challenge(started.codeVerifier);
		assertAuthorizationUrl(started.authorizationUrl, {
			exactEndpoint: authority.authorizationEndpoint,
			clientId: client.clientId,
			redirectUri,
			resource: authority.resource,
			state,
			codeChallenge,
			scope,
		});

		const createdAtMs = this.#now();
		if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw invalidOptionsError();
		const transaction = Object.freeze({
			authority: copyAuthority(authority),
			authorityDigest: createAuthorityDigest(authority),
			stateDigest: createOAuthStateLookupDigest(state),
			codeVerifier: started.codeVerifier,
			redirectUri,
			clientId: client.clientId,
			clientAuthenticationMethod: client.authentication.method,
			...(scope === undefined ? {} : { scope }),
			createdAtMs,
		});
		return Object.freeze({ authorizationUrl: started.authorizationUrl.href, transaction });
	}

	/** Redeems a callback against the originally pinned authority exactly once. */
	async exchangeAuthorization(
		input: McpClientOAuthExchangeAuthorizationInput,
	): Promise<OAuthTokens> {
		if (typeof input !== "object" || input === null) throw invalidOptionsError();
		const transaction = normalizeTransaction(input.transaction);
		const authority = transaction.authority;
		const client = normalizeClient(input.client, authority);
		assertTransactionClient(transaction, client);
		const callback = parseOAuthCallbackParameters(input.callback);
		validateOAuthState({
			actualState: callback.state,
			expectedDigest: transaction.stateDigest,
			createdAtMs: transaction.createdAtMs,
			ttlMs: this.#authorizationTransactionTtlMs,
			nowMs: this.#now(),
		});
		assertCallbackIssuer(callback.issuer, authority);
		if (callback.kind === "error") throw authorizationDeniedError();
		throwIfAborted(input.signal);
		await this.#authorizeEndpoint(authority.tokenEndpoint, {
			kind: "token",
			credentialed: true,
			resource: authority.resource,
			issuer: authority.issuer,
			signal: input.signal,
		});

		try {
			const tokens = await exchangeAuthorization(authority.issuer, {
				metadata: toSdkMetadata(authority),
				clientInformation: toSdkClientInformation(client),
				authorizationCode: callback.code,
				codeVerifier: transaction.codeVerifier,
				redirectUri: transaction.redirectUri,
				resource: new URL(authority.resource),
				addClientAuthentication: createClientAuthentication(client, authority),
				fetchFn: this.#createFetch({
					kind: "token",
					credentialed: true,
					resource: authority.resource,
					issuer: authority.issuer,
					signal: input.signal,
					exactEndpoint: authority.tokenEndpoint,
				}),
				...(callback.issuer === undefined ? {} : { iss: callback.issuer }),
			});
			throwIfAborted(input.signal);
			return validateTokens(tokens, "exchange", transaction.scope);
		} catch (error) {
			throwIfAborted(input.signal);
			throw translateTokenError(error, "exchange");
		}
	}

	/** Refreshes with the same exact authority and configured authentication method. */
	async refreshAuthorization(input: McpClientOAuthRefreshInput): Promise<OAuthTokens> {
		if (typeof input !== "object" || input === null) throw invalidOptionsError();
		const authority = normalizeAuthority(input.authority);
		const client = normalizeClient(input.client, authority);
		const currentScope = input.currentScope;
		if (currentScope !== undefined) assertScopeString(currentScope);
		assertSecretValue(input.refreshToken, MAX_TOKEN_LENGTH);
		if (
			authority.grantTypesSupported === undefined ||
			!authority.grantTypesSupported.includes("refresh_token")
		) {
			throw clientUnsupportedError();
		}
		throwIfAborted(input.signal);
		await this.#authorizeEndpoint(authority.tokenEndpoint, {
			kind: "token",
			credentialed: true,
			resource: authority.resource,
			issuer: authority.issuer,
			signal: input.signal,
		});
		const fetchAttempt: McpClientOAuthHostFetchAttempt = {
			invoked: false,
			responseReturned: false,
		};

		try {
			const tokens = await refreshAuthorization(authority.issuer, {
				metadata: toSdkMetadata(authority),
				clientInformation: toSdkClientInformation(client),
				refreshToken: input.refreshToken,
				resource: new URL(authority.resource),
				addClientAuthentication: createClientAuthentication(client, authority),
				fetchFn: this.#createFetch({
					kind: "token",
					credentialed: true,
					resource: authority.resource,
					issuer: authority.issuer,
					signal: input.signal,
					exactEndpoint: authority.tokenEndpoint,
					hostFetchAttempt: fetchAttempt,
				}),
			});
			throwIfAborted(input.signal);
			return validateTokens(tokens, "refresh", currentScope);
		} catch (error) {
			if (!fetchAttempt.invoked) throwIfAborted(input.signal);
			throw translateTokenError(error, "refresh", fetchAttempt);
		}
	}

	#createFetch(input: {
		readonly kind: McpClientOAuthEndpointKind;
		readonly credentialed: boolean;
		readonly resource: string;
		readonly issuer: string;
		readonly signal: AbortSignal | undefined;
		readonly exactEndpoint?: string;
		readonly hostFetchAttempt?: McpClientOAuthHostFetchAttempt;
	}): FetchLike {
		return async (url, init) => {
			throwIfAborted(input.signal);
			const endpoint = requireSecureUrl(String(url), { query: true });
			if (input.exactEndpoint !== undefined && endpoint.href !== input.exactEndpoint) {
				throw endpointRejectedError();
			}
			await this.#authorizeEndpoint(endpoint.href, input);
			throwIfAborted(input.signal);
			const signal = combineAbortSignals(input.signal, init?.signal);
			const requestInit: RequestInit = { ...init, redirect: "error" };
			if (signal !== undefined) requestInit.signal = signal;
			if (input.hostFetchAttempt !== undefined) input.hostFetchAttempt.invoked = true;
			const response = await this.#fetch(new URL(endpoint.href), requestInit);
			if (input.hostFetchAttempt !== undefined) input.hostFetchAttempt.responseReturned = true;
			throwIfAborted(input.signal);
			if (
				response.redirected ||
				(input.exactEndpoint !== undefined &&
					response.url.length > 0 &&
					!isExactResponseUrl(response.url, input.exactEndpoint))
			) {
				throw endpointRejectedError();
			}
			return response;
		};
	}

	async #authorizeEndpoint(
		endpointValue: string,
		input: {
			readonly kind: McpClientOAuthEndpointKind;
			readonly credentialed: boolean;
			readonly resource: string;
			readonly issuer: string;
			readonly signal: AbortSignal | undefined;
		},
	): Promise<void> {
		throwIfAborted(input.signal);
		const endpoint = requireSecureUrl(endpointValue, { query: true });
		let admitted: unknown;
		try {
			admitted = await awaitWithSignal(
				Promise.resolve().then(() =>
					this.#endpointPolicy(
						Object.freeze({
							endpoint: new URL(endpoint.href),
							kind: input.kind,
							credentialed: input.credentialed,
							exactResource: input.resource,
							exactIssuer: input.issuer,
							resource: new URL(input.resource),
							issuer: new URL(input.issuer),
							...(input.signal === undefined ? {} : { signal: input.signal }),
						}),
					),
				),
				input.signal,
			);
		} catch {
			throwIfAborted(input.signal);
			throw endpointRejectedError();
		}
		throwIfAborted(input.signal);
		if (admitted !== true) throw endpointRejectedError();
	}
}

function normalizeDiscoveryInput(input: McpClientOAuthDiscoveryInput): {
	readonly serverUrl: string;
	readonly resource: string;
	readonly issuer: string;
	readonly resourceMetadataUrl?: string;
	readonly signal: AbortSignal | undefined;
} {
	if (typeof input !== "object" || input === null) throw invalidOptionsError();
	const serverUrl = requireSecureUrl(input.serverUrl, { query: true }).href;
	const resource = requireCanonicalResource(input.resource);
	requireSecureUrl(input.issuer, { query: false });
	const issuer = input.issuer;
	const resourceMetadataUrl =
		input.resourceMetadataUrl === undefined
			? undefined
			: requireSecureUrl(input.resourceMetadataUrl, { query: true }).href;
	return Object.freeze({
		serverUrl,
		resource,
		issuer,
		...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
		signal: input.signal,
	});
}

function createAuthority(input: {
	readonly serverUrl: string;
	readonly resource: string;
	readonly issuer: string;
	readonly metadata: AuthorizationServerMetadata;
	readonly resourceScopesSupported?: readonly string[];
}): McpClientOAuthAuthority {
	const responseTypesSupported = normalizeMetadataList(input.metadata.response_types_supported);
	const codeChallengeMethodsSupported = normalizeMetadataList(
		input.metadata.code_challenge_methods_supported,
	);
	const tokenEndpointAuthMethodsSupported = normalizeMetadataList(
		input.metadata.token_endpoint_auth_methods_supported,
	);
	if (
		!responseTypesSupported.includes("code") ||
		!codeChallengeMethodsSupported.includes("S256") ||
		tokenEndpointAuthMethodsSupported.length === 0 ||
		(input.metadata.grant_types_supported !== undefined &&
			!input.metadata.grant_types_supported.includes("authorization_code")) ||
		(input.metadata.response_modes_supported !== undefined &&
			!input.metadata.response_modes_supported.includes("query"))
	) {
		throw authorityInvalidError();
	}
	return copyAuthority({
		serverUrl: input.serverUrl,
		resource: input.resource,
		issuer: input.issuer,
		authorizationEndpoint: requireSecureUrl(input.metadata.authorization_endpoint, {
			query: true,
		}).href,
		tokenEndpoint: requireSecureUrl(input.metadata.token_endpoint, { query: true }).href,
		responseTypesSupported,
		codeChallengeMethodsSupported,
		tokenEndpointAuthMethodsSupported,
		...(input.metadata.grant_types_supported === undefined
			? {}
			: { grantTypesSupported: normalizeMetadataList(input.metadata.grant_types_supported) }),
		...(input.resourceScopesSupported === undefined
			? {}
			: { resourceScopesSupported: normalizeScopeMetadataList(input.resourceScopesSupported) }),
		...(input.metadata.scopes_supported === undefined
			? {}
			: {
					authorizationScopesSupported: normalizeScopeMetadataList(input.metadata.scopes_supported),
				}),
		authorizationResponseIssuerParameterSupported:
			input.metadata.authorization_response_iss_parameter_supported === true,
	});
}

/** Decode authenticated host storage; this does not admit endpoints or authorize execution. */
export function parseMcpClientOAuthAuthority(
	value: unknown,
	options: McpClientOAuthSnapshotOptions = {},
): McpClientOAuthAuthority {
	return parseOAuthSnapshot(value, options, (record, maximum) => {
		assertOAuthSnapshotKeys(record, [
			"serverUrl",
			"resource",
			"issuer",
			"authorizationEndpoint",
			"tokenEndpoint",
			"responseTypesSupported",
			"codeChallengeMethodsSupported",
			"tokenEndpointAuthMethodsSupported",
			"grantTypesSupported",
			"resourceScopesSupported",
			"authorizationScopesSupported",
			"authorizationResponseIssuerParameterSupported",
		]);
		return normalizeAuthority({
			serverUrl: oauthSnapshotString(record.serverUrl, maximum),
			resource: oauthSnapshotString(record.resource, maximum),
			issuer: oauthSnapshotString(record.issuer, maximum),
			authorizationEndpoint: oauthSnapshotString(record.authorizationEndpoint, maximum),
			tokenEndpoint: oauthSnapshotString(record.tokenEndpoint, maximum),
			responseTypesSupported: oauthSnapshotStrings(
				record.responseTypesSupported,
				MAX_METADATA_LIST_LENGTH,
			),
			codeChallengeMethodsSupported: oauthSnapshotStrings(
				record.codeChallengeMethodsSupported,
				MAX_METADATA_LIST_LENGTH,
			),
			tokenEndpointAuthMethodsSupported: oauthSnapshotStrings(
				record.tokenEndpointAuthMethodsSupported,
				MAX_METADATA_LIST_LENGTH,
			),
			...(record.grantTypesSupported === undefined
				? {}
				: {
						grantTypesSupported: oauthSnapshotStrings(
							record.grantTypesSupported,
							MAX_METADATA_LIST_LENGTH,
						),
					}),
			...(record.resourceScopesSupported === undefined
				? {}
				: {
						resourceScopesSupported: oauthSnapshotStrings(
							record.resourceScopesSupported,
							MAX_SCOPE_COUNT,
						),
					}),
			...(record.authorizationScopesSupported === undefined
				? {}
				: {
						authorizationScopesSupported: oauthSnapshotStrings(
							record.authorizationScopesSupported,
							MAX_SCOPE_COUNT,
						),
					}),
			authorizationResponseIssuerParameterSupported: oauthSnapshotBoolean(
				record.authorizationResponseIssuerParameterSupported,
			),
		});
	});
}

/** Pure decoding and authority-digest verification; host session binding and atomic take remain required. */
export function parseMcpClientOAuthAuthorizationTransaction(
	value: unknown,
	options: McpClientOAuthSnapshotOptions = {},
): McpClientOAuthAuthorizationTransaction {
	return parseOAuthSnapshot(value, options, (record, maximum) => {
		assertOAuthSnapshotKeys(record, [
			"authority",
			"authorityDigest",
			"stateDigest",
			"codeVerifier",
			"redirectUri",
			"clientId",
			"clientAuthenticationMethod",
			"scope",
			"createdAtMs",
		]);
		const method = record.clientAuthenticationMethod;
		const stateDigest = oauthSnapshotString(record.stateDigest, 43);
		if (
			!isClientAuthenticationMethod(method) ||
			!/^[A-Za-z0-9_-]{43}$/u.test(stateDigest) ||
			typeof record.createdAtMs !== "number"
		)
			throw transactionInvalidError();
		return normalizeTransaction({
			authority: parseMcpClientOAuthAuthority(record.authority, options),
			authorityDigest: oauthSnapshotString(record.authorityDigest, 43),
			stateDigest,
			codeVerifier: oauthSnapshotString(record.codeVerifier, 128),
			redirectUri: oauthSnapshotString(record.redirectUri, maximum),
			clientId: oauthSnapshotString(record.clientId, MAX_CLIENT_ID_LENGTH),
			clientAuthenticationMethod: method,
			...(record.scope === undefined
				? {}
				: { scope: oauthSnapshotString(record.scope, MAX_SCOPE_STRING_LENGTH) }),
			createdAtMs: record.createdAtMs,
		});
	});
}

function normalizeAuthority(authority: McpClientOAuthAuthority): McpClientOAuthAuthority {
	if (typeof authority !== "object" || authority === null) throw authorityInvalidError();
	const normalized = copyAuthority({
		serverUrl: requireSecureUrl(authority.serverUrl, { query: true }).href,
		resource: requireCanonicalResource(authority.resource),
		issuer: requireExactIssuer(authority.issuer),
		authorizationEndpoint: requireSecureUrl(authority.authorizationEndpoint, {
			query: true,
		}).href,
		tokenEndpoint: requireSecureUrl(authority.tokenEndpoint, { query: true }).href,
		responseTypesSupported: normalizeMetadataList(authority.responseTypesSupported),
		codeChallengeMethodsSupported: normalizeMetadataList(authority.codeChallengeMethodsSupported),
		tokenEndpointAuthMethodsSupported: normalizeMetadataList(
			authority.tokenEndpointAuthMethodsSupported,
		),
		...(authority.grantTypesSupported === undefined
			? {}
			: { grantTypesSupported: normalizeMetadataList(authority.grantTypesSupported) }),
		...(authority.resourceScopesSupported === undefined
			? {}
			: {
					resourceScopesSupported: normalizeScopeMetadataList(authority.resourceScopesSupported),
				}),
		...(authority.authorizationScopesSupported === undefined
			? {}
			: {
					authorizationScopesSupported: normalizeScopeMetadataList(
						authority.authorizationScopesSupported,
					),
				}),
		authorizationResponseIssuerParameterSupported:
			authority.authorizationResponseIssuerParameterSupported,
	});
	if (
		typeof normalized.authorizationResponseIssuerParameterSupported !== "boolean" ||
		!normalized.responseTypesSupported.includes("code") ||
		!normalized.codeChallengeMethodsSupported.includes("S256") ||
		normalized.tokenEndpointAuthMethodsSupported.length === 0 ||
		(normalized.grantTypesSupported !== undefined &&
			!normalized.grantTypesSupported.includes("authorization_code"))
	) {
		throw authorityInvalidError();
	}
	return normalized;
}

function copyAuthority(authority: McpClientOAuthAuthority): McpClientOAuthAuthority {
	return Object.freeze({
		serverUrl: authority.serverUrl,
		resource: authority.resource,
		issuer: authority.issuer,
		authorizationEndpoint: authority.authorizationEndpoint,
		tokenEndpoint: authority.tokenEndpoint,
		responseTypesSupported: Object.freeze([...authority.responseTypesSupported]),
		codeChallengeMethodsSupported: Object.freeze([...authority.codeChallengeMethodsSupported]),
		tokenEndpointAuthMethodsSupported: Object.freeze([
			...authority.tokenEndpointAuthMethodsSupported,
		]),
		...(authority.grantTypesSupported === undefined
			? {}
			: { grantTypesSupported: Object.freeze([...authority.grantTypesSupported]) }),
		...(authority.resourceScopesSupported === undefined
			? {}
			: { resourceScopesSupported: Object.freeze([...authority.resourceScopesSupported]) }),
		...(authority.authorizationScopesSupported === undefined
			? {}
			: {
					authorizationScopesSupported: Object.freeze([...authority.authorizationScopesSupported]),
				}),
		authorizationResponseIssuerParameterSupported:
			authority.authorizationResponseIssuerParameterSupported,
	});
}

function createAuthorityDigest(authority: McpClientOAuthAuthority): string {
	const canonical = JSON.stringify([
		authority.serverUrl,
		authority.resource,
		authority.issuer,
		authority.authorizationEndpoint,
		authority.tokenEndpoint,
		authority.responseTypesSupported,
		authority.codeChallengeMethodsSupported,
		authority.tokenEndpointAuthMethodsSupported,
		authority.grantTypesSupported ?? null,
		authority.resourceScopesSupported ?? null,
		authority.authorizationScopesSupported ?? null,
		authority.authorizationResponseIssuerParameterSupported,
	]);
	return createHash("sha256")
		.update(AUTHORITY_DIGEST_DOMAIN, "utf8")
		.update(canonical, "utf8")
		.digest("base64url");
}

function normalizeTransaction(
	transaction: McpClientOAuthAuthorizationTransaction,
): McpClientOAuthAuthorizationTransaction {
	if (typeof transaction !== "object" || transaction === null) throw transactionInvalidError();
	const authority = normalizeAuthority(transaction.authority);
	if (transaction.authorityDigest !== createAuthorityDigest(authority)) {
		throw transactionInvalidError();
	}
	const redirectUri = requireRedirectUri(transaction.redirectUri).href;
	assertBoundedOpaqueValue(transaction.clientId, MAX_CLIENT_ID_LENGTH);
	if (!isClientAuthenticationMethod(transaction.clientAuthenticationMethod)) {
		throw transactionInvalidError();
	}
	createPkceS256Challenge(transaction.codeVerifier);
	if (!Number.isSafeInteger(transaction.createdAtMs) || transaction.createdAtMs < 0) {
		throw transactionInvalidError();
	}
	if (transaction.scope !== undefined) assertScopeString(transaction.scope);
	return Object.freeze({
		authority,
		authorityDigest: transaction.authorityDigest,
		stateDigest: transaction.stateDigest,
		codeVerifier: transaction.codeVerifier,
		redirectUri,
		clientId: transaction.clientId,
		clientAuthenticationMethod: transaction.clientAuthenticationMethod,
		...(transaction.scope === undefined ? {} : { scope: transaction.scope }),
		createdAtMs: transaction.createdAtMs,
	});
}

function normalizeClient(
	client: McpClientOAuthClient,
	authority: McpClientOAuthAuthority,
): McpClientOAuthClient {
	if (typeof client !== "object" || client === null) throw clientUnsupportedError();
	assertBoundedOpaqueValue(client.clientId, MAX_CLIENT_ID_LENGTH);
	const authentication = client.authentication;
	if (typeof authentication !== "object" || authentication === null) {
		throw clientUnsupportedError();
	}
	switch (authentication.method) {
		case "none":
			break;
		case "client_secret_basic":
		case "client_secret_post":
			assertSecretValue(authentication.clientSecret, MAX_CLIENT_SECRET_LENGTH);
			break;
		case "private_key_jwt":
			if (typeof authentication.addClientAuthentication !== "function") {
				throw clientUnsupportedError();
			}
			break;
		default:
			throw clientUnsupportedError();
	}
	if (!authority.tokenEndpointAuthMethodsSupported.includes(authentication.method)) {
		throw clientUnsupportedError();
	}
	const copiedAuthentication: McpClientOAuthClientAuthentication =
		authentication.method === "none"
			? Object.freeze({ method: "none" })
			: authentication.method === "private_key_jwt"
				? Object.freeze({
						method: "private_key_jwt",
						addClientAuthentication: authentication.addClientAuthentication,
					})
				: Object.freeze({
						method: authentication.method,
						clientSecret: authentication.clientSecret,
					});
	return Object.freeze({ clientId: client.clientId, authentication: copiedAuthentication });
}

function toSdkClientInformation(client: McpClientOAuthClient): OAuthClientInformationMixed {
	return {
		client_id: client.clientId,
		token_endpoint_auth_method: client.authentication.method,
	};
}

function createClientAuthentication(
	client: McpClientOAuthClient,
	authority: McpClientOAuthAuthority,
): AddClientAuthentication {
	const exactTokenEndpoint = authority.tokenEndpoint;
	return async (headers, parameters, url, metadata) => {
		if (
			requireSecureUrl(String(url), { query: true }).href !== exactTokenEndpoint ||
			metadata?.token_endpoint !== exactTokenEndpoint
		) {
			throw endpointRejectedError();
		}
		headers.delete("Authorization");
		parameters.delete("client_id");
		parameters.delete("client_secret");
		parameters.delete("client_assertion_type");
		parameters.delete("client_assertion");
		switch (client.authentication.method) {
			case "none":
				parameters.set("client_id", client.clientId);
				return;
			case "client_secret_basic": {
				const username = encodeFormComponent(client.clientId);
				const password = encodeFormComponent(client.authentication.clientSecret);
				headers.set(
					"Authorization",
					`Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
				);
				return;
			}
			case "client_secret_post":
				parameters.set("client_id", client.clientId);
				parameters.set("client_secret", client.authentication.clientSecret);
				return;
			case "private_key_jwt": {
				const signerHeaders = new Headers();
				const signerParameters = new URLSearchParams({ client_id: client.clientId });
				try {
					await client.authentication.addClientAuthentication(
						signerHeaders,
						signerParameters,
						new URL(exactTokenEndpoint),
						toSdkMetadata(authority),
					);
				} catch (error) {
					if (error instanceof McpClientOAuthProtocolError) {
						throw canonicalizeProtocolError(error, clientUnsupportedError);
					}
					throw error;
				}
				const assertion = requirePrivateKeyJwtSignerOutput(
					signerHeaders,
					signerParameters,
					client.clientId,
				);
				parameters.set("client_id", client.clientId);
				parameters.set("client_assertion_type", PRIVATE_KEY_JWT_ASSERTION_TYPE);
				parameters.set("client_assertion", assertion);
				return;
			}
		}
	};
}

function requirePrivateKeyJwtSignerOutput(
	headers: Headers,
	parameters: URLSearchParams,
	exactClientId: string,
): string {
	if ([...headers].length !== 0) throw clientUnsupportedError();
	const entries = [...parameters];
	if (
		entries.length !== PRIVATE_KEY_JWT_PARAMETER_NAMES.length ||
		entries.some(([name]) => !PRIVATE_KEY_JWT_PARAMETER_NAMES.includes(name)) ||
		parameters.getAll("client_id").length !== 1 ||
		parameters.get("client_id") !== exactClientId ||
		parameters.getAll("client_assertion_type").length !== 1 ||
		parameters.get("client_assertion_type") !== PRIVATE_KEY_JWT_ASSERTION_TYPE ||
		parameters.getAll("client_assertion").length !== 1
	) {
		throw clientUnsupportedError();
	}
	const assertion = parameters.get("client_assertion");
	assertSecretValue(assertion, MAX_TOKEN_LENGTH);
	return assertion;
}

function toSdkMetadata(authority: McpClientOAuthAuthority): AuthorizationServerMetadata {
	return {
		issuer: authority.issuer,
		authorization_endpoint: authority.authorizationEndpoint,
		token_endpoint: authority.tokenEndpoint,
		response_types_supported: [...authority.responseTypesSupported],
		code_challenge_methods_supported: [...authority.codeChallengeMethodsSupported],
		token_endpoint_auth_methods_supported: [...authority.tokenEndpointAuthMethodsSupported],
		...(authority.grantTypesSupported === undefined
			? {}
			: { grant_types_supported: [...authority.grantTypesSupported] }),
		...(authority.authorizationScopesSupported === undefined
			? {}
			: { scopes_supported: [...authority.authorizationScopesSupported] }),
		authorization_response_iss_parameter_supported:
			authority.authorizationResponseIssuerParameterSupported,
	};
}

function normalizeScopes(
	scopes: readonly string[] | undefined,
	authority: McpClientOAuthAuthority,
): string | undefined {
	if (scopes === undefined) return undefined;
	if (!Array.isArray(scopes)) throw invalidOptionsError();
	if (scopes.length === 0) return undefined;
	if (scopes.length > MAX_SCOPE_COUNT) throw invalidOptionsError();
	const normalized = [...new Set(scopes)];
	for (const scope of normalized) {
		assertScopeToken(scope);
		if (
			authority.authorizationScopesSupported !== undefined &&
			!authority.authorizationScopesSupported.includes(scope)
		) {
			throw clientUnsupportedError();
		}
		if (
			scope !== "offline_access" &&
			authority.resourceScopesSupported !== undefined &&
			!authority.resourceScopesSupported.includes(scope)
		) {
			throw clientUnsupportedError();
		}
	}
	const value = normalized.join(" ");
	assertScopeString(value);
	return value;
}

function normalizeMetadataList(values: readonly string[] | undefined): readonly string[] {
	if (values === undefined) return Object.freeze([]);
	if (!Array.isArray(values) || values.length > MAX_METADATA_LIST_LENGTH) {
		throw authorityInvalidError();
	}
	const normalized = [...new Set(values)];
	for (const value of normalized) {
		if (
			typeof value !== "string" ||
			value.length === 0 ||
			value.length > MAX_METADATA_VALUE_LENGTH ||
			containsControlCharacter(value)
		) {
			throw authorityInvalidError();
		}
	}
	return Object.freeze(normalized);
}

function assertScopeToken(value: string): void {
	if (!isMcpClientOAuthScopeToken(value)) throw invalidOptionsError();
}

function assertScopeString(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_SCOPE_STRING_LENGTH) {
		throw invalidOptionsError();
	}
	for (const scope of value.split(" ")) assertScopeToken(scope);
}

function normalizeScopeMetadataList(values: readonly string[]): readonly string[] {
	if (!Array.isArray(values) || values.length > MAX_SCOPE_COUNT) throw authorityInvalidError();
	const normalized = [...new Set(values)];
	if (
		!normalized.every(isMcpClientOAuthScopeToken) ||
		normalized.join(" ").length > MAX_SCOPE_STRING_LENGTH
	) {
		throw authorityInvalidError();
	}
	return Object.freeze(normalized);
}

function assertTransactionClient(
	transaction: McpClientOAuthAuthorizationTransaction,
	client: McpClientOAuthClient,
): void {
	if (
		transaction.clientId !== client.clientId ||
		transaction.clientAuthenticationMethod !== client.authentication.method
	) {
		throw transactionInvalidError();
	}
}

function assertCallbackIssuer(
	callbackIssuer: string | undefined,
	authority: McpClientOAuthAuthority,
): void {
	if (callbackIssuer === undefined) {
		if (authority.authorizationResponseIssuerParameterSupported) {
			throw transactionInvalidError();
		}
		return;
	}
	if (callbackIssuer !== authority.issuer) {
		throw transactionInvalidError();
	}
}

function assertAuthorizationUrl(
	value: URL,
	input: {
		readonly exactEndpoint: string;
		readonly clientId: string;
		readonly redirectUri: string;
		readonly resource: string;
		readonly state: string;
		readonly codeChallenge: string;
		readonly scope: string | undefined;
	},
): void {
	const endpoint = requireSecureUrl(input.exactEndpoint, { query: true });
	const actual = requireSecureUrl(value.href, { query: true });
	if (
		actual.origin !== endpoint.origin ||
		actual.pathname !== endpoint.pathname ||
		actual.searchParams.get("response_type") !== "code" ||
		actual.searchParams.get("client_id") !== input.clientId ||
		actual.searchParams.get("redirect_uri") !== input.redirectUri ||
		actual.searchParams.get("resource") !== new URL(input.resource).href ||
		actual.searchParams.get("state") !== input.state ||
		actual.searchParams.get("code_challenge_method") !== "S256" ||
		actual.searchParams.get("code_challenge") !== input.codeChallenge ||
		actual.searchParams.get("scope") !== (input.scope ?? null)
	) {
		throw authorizationFailedError();
	}
}

function validateTokens(
	tokens: OAuthTokens,
	operation: "exchange" | "refresh",
	fallbackScope?: string,
): OAuthTokens {
	assertTokenValue(tokens.access_token, operation);
	if (
		tokens.token_type.length === 0 ||
		tokens.token_type.length > 64 ||
		containsControlCharacter(tokens.token_type) ||
		tokens.token_type.toLowerCase() !== "bearer"
	) {
		throw tokenResponseInvalidError(operation);
	}
	if (tokens.refresh_token !== undefined) assertTokenValue(tokens.refresh_token, operation);
	if (tokens.id_token !== undefined) assertTokenValue(tokens.id_token, operation);
	if (
		tokens.expires_in !== undefined &&
		(!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)
	) {
		throw tokenResponseInvalidError(operation);
	}
	if (
		tokens.scope !== undefined &&
		(tokens.scope.length === 0 ||
			tokens.scope.length > MAX_SCOPE_STRING_LENGTH ||
			tokens.scope.split(" ").length > MAX_SCOPE_COUNT ||
			!tokens.scope.split(" ").every(isMcpClientOAuthScopeToken))
	) {
		throw tokenResponseInvalidError(operation);
	}
	if (
		tokens.scope !== undefined &&
		fallbackScope !== undefined &&
		!isScopeSubset(tokens.scope, fallbackScope)
	) {
		throw tokenResponseInvalidError(operation);
	}
	return tokens.scope === undefined && fallbackScope !== undefined
		? { ...tokens, scope: fallbackScope }
		: tokens;
}

function isScopeSubset(candidate: string, available: string): boolean {
	const availableTokens = new Set(available.split(" "));
	return candidate.split(" ").every((scope) => availableTokens.has(scope));
}

function assertTokenValue(value: string, operation: "exchange" | "refresh"): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_TOKEN_LENGTH ||
		containsControlCharacter(value)
	) {
		throw tokenResponseInvalidError(operation);
	}
}

function assertBoundedOpaqueValue(value: string, maximumLength: number): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximumLength ||
		containsControlCharacter(value)
	) {
		throw clientUnsupportedError();
	}
}

function assertSecretValue(value: string | null, maximumLength: number): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
		throw clientUnsupportedError();
	}
}

function requireSecureUrl(value: string, options: { readonly query: boolean }): URL {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
		throw authorityInvalidError();
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw authorityInvalidError();
	}
	if (
		url.protocol !== "https:" ||
		url.username.length > 0 ||
		url.password.length > 0 ||
		url.hash.length > 0 ||
		(!options.query && url.search.length > 0)
	) {
		throw authorityInvalidError();
	}
	return url;
}

function requireRedirectUri(value: string): URL {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
		throw authorityInvalidError();
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw authorityInvalidError();
	}
	if (
		url.username.length > 0 ||
		url.password.length > 0 ||
		url.hash.length > 0 ||
		(url.protocol !== "https:" && !isLoopbackHttpRedirect(url))
	) {
		throw authorityInvalidError();
	}
	return url;
}

function isLoopbackHttpRedirect(url: URL): boolean {
	if (url.protocol !== "http:") return false;
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host === "[::1]") return true;
	const octets = host.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.every(isDecimalOctet);
}

function isDecimalOctet(value: string): boolean {
	if (!/^\d{1,3}$/u.test(value)) return false;
	const parsed = Number(value);
	return parsed >= 0 && parsed <= 255 && String(parsed) === value;
}

function requireCanonicalResource(value: string): string {
	const resource = requireSecureUrl(value, { query: true });
	if (resource.href !== value) throw authorityInvalidError();
	return value;
}

function requireExactIssuer(value: string): string {
	requireSecureUrl(value, { query: false });
	return value;
}

function combineAbortSignals(
	operationSignal: AbortSignal | undefined,
	requestSignal: AbortSignal | null | undefined,
): AbortSignal | undefined {
	if (operationSignal === undefined) return requestSignal ?? undefined;
	if (requestSignal === undefined || requestSignal === null || requestSignal === operationSignal) {
		return operationSignal;
	}
	return AbortSignal.any([operationSignal, requestSignal]);
}

function awaitWithSignal<Value>(
	promise: PromiseLike<Value>,
	signal: AbortSignal | undefined,
): Promise<Value> {
	if (signal === undefined) return Promise.resolve(promise);
	signal.throwIfAborted();
	return new Promise<Value>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(promise).then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function isExactResponseUrl(actual: string, expected: string): boolean {
	try {
		return requireSecureUrl(actual, { query: true }).href === expected;
	} catch {
		return false;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	signal?.throwIfAborted();
}

function encodeFormComponent(value: string): string {
	const encoded = new URLSearchParams({ value }).toString();
	return encoded.slice("value=".length);
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const point = character.codePointAt(0);
		if (point !== undefined && (point <= 0x1f || (point >= 0x7f && point <= 0x9f))) {
			return true;
		}
	}
	return false;
}

function isClientAuthenticationMethod(
	value: unknown,
): value is McpClientOAuthClientAuthentication["method"] {
	return (
		value === "none" ||
		value === "client_secret_basic" ||
		value === "client_secret_post" ||
		value === "private_key_jwt"
	);
}

function translateTokenError(
	error: unknown,
	operation: "exchange" | "refresh",
	hostFetchAttempt?: McpClientOAuthHostFetchAttempt,
): McpClientOAuthProtocolError {
	if (operation === "refresh" && hostFetchAttempt?.invoked === true) {
		if (hostFetchAttempt.responseReturned && OAuthError.isInstance(error)) {
			if (error.code === "invalid_grant") return invalidGrantError();
			if (error.code === "invalid_client") return invalidClientError();
		}
		return refreshOutcomeUnknownError();
	}
	if (error instanceof McpClientOAuthProtocolError) {
		return canonicalizeProtocolError(
			error,
			operation === "exchange" ? tokenExchangeFailedError : tokenRefreshFailedError,
		);
	}
	if (OAuthError.isInstance(error)) {
		if (error.code === "invalid_grant") return invalidGrantError();
		if (error.code === "invalid_client") return invalidClientError();
	}
	return operation === "exchange" ? tokenExchangeFailedError() : tokenRefreshFailedError();
}

function canonicalizeProtocolError(
	error: McpClientOAuthProtocolError,
	fallback: () => McpClientOAuthProtocolError,
): McpClientOAuthProtocolError {
	if (!isInternalMcpClientOAuthProtocolError(error)) return fallback();
	try {
		switch (error.code) {
			case McpClientOAuthProtocolErrorCode.InvalidOptions:
				return invalidOptionsError();
			case McpClientOAuthProtocolErrorCode.EndpointRejected:
				return endpointRejectedError();
			case McpClientOAuthProtocolErrorCode.DiscoveryFailed:
				return discoveryFailedError();
			case McpClientOAuthProtocolErrorCode.AuthorityInvalid:
				return authorityInvalidError();
			case McpClientOAuthProtocolErrorCode.ClientUnsupported:
				return clientUnsupportedError();
			case McpClientOAuthProtocolErrorCode.TransactionInvalid:
				return transactionInvalidError();
			case McpClientOAuthProtocolErrorCode.AuthorizationDenied:
				return authorizationDeniedError();
			case McpClientOAuthProtocolErrorCode.AuthorizationFailed:
				return authorizationFailedError();
			case McpClientOAuthProtocolErrorCode.InvalidGrant:
				return invalidGrantError();
			case McpClientOAuthProtocolErrorCode.InvalidClient:
				return invalidClientError();
			case McpClientOAuthProtocolErrorCode.TokenExchangeFailed:
				return tokenExchangeFailedError();
			case McpClientOAuthProtocolErrorCode.TokenRefreshFailed:
				return tokenRefreshFailedError();
			case McpClientOAuthProtocolErrorCode.RefreshOutcomeUnknown:
				return refreshOutcomeUnknownError();
		}
	} catch {
		return fallback();
	}
	return fallback();
}

function invalidOptionsError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.InvalidOptions,
		"The MCP OAuth client options are invalid.",
	);
}

function endpointRejectedError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.EndpointRejected,
		"The MCP OAuth endpoint policy rejected the operation.",
	);
}

function discoveryFailedError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.DiscoveryFailed,
		"MCP OAuth authority discovery failed.",
	);
}

function authorityInvalidError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.AuthorityInvalid,
		"The MCP OAuth authority is invalid or does not match the configured identity.",
	);
}

function clientUnsupportedError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.ClientUnsupported,
		"The provisioned MCP OAuth client is invalid or unsupported by this authority.",
	);
}

function transactionInvalidError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.TransactionInvalid,
		"The MCP OAuth authorization transaction is invalid.",
	);
}

function authorizationDeniedError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.AuthorizationDenied,
		"The MCP OAuth authorization request was not approved.",
	);
}

function authorizationFailedError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.AuthorizationFailed,
		"The MCP OAuth authorization request could not be created.",
	);
}

function invalidGrantError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.InvalidGrant,
		"The MCP OAuth authorization grant is no longer valid.",
	);
}

function invalidClientError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.InvalidClient,
		"The provisioned MCP OAuth client was rejected.",
	);
}

function tokenExchangeFailedError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.TokenExchangeFailed,
		"The MCP OAuth authorization code exchange failed.",
	);
}

function tokenRefreshFailedError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.TokenRefreshFailed,
		"The MCP OAuth token refresh failed.",
	);
}

function refreshOutcomeUnknownError(): McpClientOAuthProtocolError {
	return createInternalProtocolError(
		McpClientOAuthProtocolErrorCode.RefreshOutcomeUnknown,
		"The MCP OAuth token refresh outcome is unknown and must not be retried automatically.",
	);
}

function tokenResponseInvalidError(operation: "exchange" | "refresh"): McpClientOAuthProtocolError {
	return operation === "exchange" ? tokenExchangeFailedError() : tokenRefreshFailedError();
}
