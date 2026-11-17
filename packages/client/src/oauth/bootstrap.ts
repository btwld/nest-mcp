import {
	LATEST_PROTOCOL_VERSION,
	discoverAuthorizationServerMetadata,
	discoverOAuthProtectedResourceMetadata,
	resourceUrlFromServerUrl,
} from "@modelcontextprotocol/client";
import type {
	AuthorizationServerMetadata,
	FetchLike,
	OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client";

import { parseMcpClientOAuthAuthority, type McpClientOAuthAuthority } from "./protocol.ts";
import { isMcpClientOAuthScopeToken } from "./scope.ts";
import {
	assertOAuthSnapshotKeys,
	oauthSnapshotBoolean,
	oauthSnapshotRecord,
	oauthSnapshotString,
	oauthSnapshotStrings,
	parseOAuthSnapshot,
	type McpClientOAuthSnapshotOptions,
} from "./snapshot-data.ts";

const MAX_URL_LENGTH = 4_096;
const MAX_PROTOCOL_VERSION_LENGTH = 64;
const MAX_AUTHORIZATION_SERVER_COUNT = 16;
const MAX_METADATA_LIST_LENGTH = 256;
const MAX_METADATA_VALUE_LENGTH = 2_048;
const MAX_SCOPE_COUNT = 128;
const MAX_SCOPE_STRING_LENGTH = 4_096;
const MAX_WWW_AUTHENTICATE_LENGTH = 8_192;
const STRICT_TOKEN_ENDPOINT_AUTHENTICATION_METHODS: ReadonlySet<string> = new Set([
	"none",
	"client_secret_basic",
	"client_secret_post",
	"private_key_jwt",
]);

/** Stable, secret-free failure categories for OAuth bootstrap discovery. */
export const McpClientOAuthBootstrapErrorCode = {
	InvalidOptions: "MCP_CLIENT_OAUTH_BOOTSTRAP_INVALID_OPTIONS",
	EndpointRejected: "MCP_CLIENT_OAUTH_BOOTSTRAP_ENDPOINT_REJECTED",
	DiscoveryFailed: "MCP_CLIENT_OAUTH_BOOTSTRAP_DISCOVERY_FAILED",
	ProtectedResourceInvalid: "MCP_CLIENT_OAUTH_BOOTSTRAP_PROTECTED_RESOURCE_INVALID",
	AuthorityInvalid: "MCP_CLIENT_OAUTH_BOOTSTRAP_AUTHORITY_INVALID",
} as const;

export type McpClientOAuthBootstrapErrorCode =
	(typeof McpClientOAuthBootstrapErrorCode)[keyof typeof McpClientOAuthBootstrapErrorCode];

/** A bounded public error. Its message never contains remote response data or URLs. */
export class McpClientOAuthBootstrapError extends Error {
	readonly code: McpClientOAuthBootstrapErrorCode;

	constructor(code: McpClientOAuthBootstrapErrorCode) {
		super(bootstrapErrorMessage(code));
		this.name = "McpClientOAuthBootstrapError";
		this.code = code;
	}
}

export type McpClientOAuthBootstrapEndpointKind =
	"resource-metadata" | "authorization-server-metadata" | "authorization" | "token";

export interface McpClientOAuthBootstrapEndpointPolicyInput {
	/** A disposable copy. Mutating it never changes the endpoint used by the bootstrap. */
	readonly endpoint: URL;
	readonly kind: McpClientOAuthBootstrapEndpointKind;
	readonly credentialed: boolean;
	readonly serverUrl: URL;
	/** Present only after protected-resource metadata has been validated. */
	readonly resource?: URL;
	/** Exact, non-normalized RFC 8707 resource string corresponding to `resource`. */
	readonly exactResource?: string;
	/** Present only after an advertised authorization server has been selected. */
	readonly issuer?: URL;
	/** Exact, non-normalized issuer identifier corresponding to `issuer`. */
	readonly exactIssuer?: string;
	readonly signal?: AbortSignal;
}

/** Only literal `true` admits an endpoint; every other result fails closed. */
export type McpClientOAuthBootstrapEndpointPolicy = (
	input: McpClientOAuthBootstrapEndpointPolicyInput,
) => boolean | PromiseLike<boolean>;

export interface McpClientOAuthBootstrapOptions {
	/**
	 * A host-owned SSRF-hardened fetch. It must pin DNS, reject redirects, and bound response
	 * bodies and time. The bootstrap additionally forces `redirect: "error"` and calls the
	 * endpoint policy before every generated discovery request.
	 */
	readonly fetch: FetchLike;
	readonly endpointPolicy: McpClientOAuthBootstrapEndpointPolicy;
	readonly protocolVersion?: string;
}

/** Values extracted by the host from the MCP server's `WWW-Authenticate: Bearer` challenge. */
export interface McpClientOAuthBootstrapChallenge {
	readonly resourceMetadataUrl?: string;
	readonly scope?: string;
}

export interface McpClientOAuthBootstrapDiscoveryInput {
	readonly serverUrl: string;
	/**
	 * Challenge values take priority over constructed well-known locations and resource metadata
	 * scopes, as required by the MCP authorization specification.
	 */
	readonly challenge?: McpClientOAuthBootstrapChallenge;
	/**
	 * Raw response header from the initial `401`. The bootstrap extracts a bounded Bearer
	 * `resource_metadata` and `scope`; it is mutually exclusive with `challenge`.
	 */
	readonly wwwAuthenticate?: string;
	/** Exact issuer previously selected by host policy from a selection-required result. */
	readonly issuer?: string;
	readonly signal?: AbortSignal;
}

/** Bounded protected-resource discovery material that a host may persist. */
export interface McpClientOAuthBootstrapResource {
	readonly serverUrl: string;
	readonly resource: string;
	readonly resourceMetadataUrl: string;
	readonly scopesSupported?: readonly string[];
}

export interface McpClientOAuthBootstrapIssuerCandidate {
	readonly issuer: string;
}

/**
 * Reasons a current-spec authority cannot be handed to the intentionally stricter runtime
 * protocol. These are compatibility facts, not a reason to trust or expose its endpoints.
 */
export const McpClientOAuthStrictCompatibilityIssue = {
	AuthorizationCodeResponseUnsupported: "authorization_code_response_unsupported",
	PkceS256Unsupported: "pkce_s256_unsupported",
	TokenEndpointAuthenticationUnsupported: "token_endpoint_authentication_unsupported",
	AuthorizationCodeGrantUnsupported: "authorization_code_grant_unsupported",
	QueryResponseModeUnsupported: "query_response_mode_unsupported",
	/** @deprecated RFC 9207 support is optional and this issue is no longer emitted. */
	AuthorizationResponseIssuerUnsupported: "authorization_response_issuer_unsupported",
} as const;

export type McpClientOAuthStrictCompatibilityIssue =
	(typeof McpClientOAuthStrictCompatibilityIssue)[keyof typeof McpClientOAuthStrictCompatibilityIssue];

/** A selected authority that composes directly with `McpClientOAuthProtocol.startAuthorization`. */
export interface McpClientOAuthBootstrapCandidate {
	readonly authority: McpClientOAuthAuthority;
	readonly clientIdMetadataDocumentSupported: boolean;
	/**
	 * A validated, bounded legacy capability only. Discovery never invokes Dynamic Client
	 * Registration; a host must opt into any future registration operation separately.
	 */
	readonly legacyDynamicRegistrationEndpoint?: string;
}

export interface McpClientOAuthBootstrapSelectionRequired {
	readonly kind: "authorization-server-selection-required";
	readonly resource: McpClientOAuthBootstrapResource;
	readonly scopes?: readonly string[];
	readonly candidates: readonly McpClientOAuthBootstrapIssuerCandidate[];
}

export interface McpClientOAuthBootstrapReady {
	readonly kind: "ready";
	readonly resource: McpClientOAuthBootstrapResource;
	readonly scopes?: readonly string[];
	readonly candidate: McpClientOAuthBootstrapCandidate;
}

export interface McpClientOAuthBootstrapStrictProtocolUnsupported {
	readonly kind: "strict-protocol-unsupported";
	readonly resource: McpClientOAuthBootstrapResource;
	readonly scopes?: readonly string[];
	/** Validated RFC 8414/OIDC issuer; no unadmitted endpoint metadata is exposed. */
	readonly issuer: string;
	readonly issues: readonly McpClientOAuthStrictCompatibilityIssue[];
}

export type McpClientOAuthBootstrapDiscoveryResult =
	| McpClientOAuthBootstrapSelectionRequired
	| McpClientOAuthBootstrapReady
	| McpClientOAuthBootstrapStrictProtocolUnsupported;

/** Decode bounded host-persisted discovery without fetching, admitting endpoints, or registering clients. */
export function parseMcpClientOAuthBootstrapDiscoveryResult(
	value: unknown,
	options: McpClientOAuthSnapshotOptions = {},
): McpClientOAuthBootstrapDiscoveryResult {
	return parseOAuthSnapshot(value, options, (record, maximum) => {
		const resourceValue = oauthSnapshotRecord(record.resource);
		assertOAuthSnapshotKeys(resourceValue, [
			"serverUrl",
			"resource",
			"resourceMetadataUrl",
			"scopesSupported",
		]);
		const url = (input: unknown, query = true): string => {
			const text = oauthSnapshotString(input, maximum);
			requireSecureUrl(text, query);
			return text;
		};
		const scopes = (input: unknown) =>
			normalizeScopeList(
				oauthSnapshotStrings(input, MAX_SCOPE_COUNT),
				McpClientOAuthBootstrapErrorCode.InvalidOptions,
			);
		const resource: McpClientOAuthBootstrapResource = Object.freeze({
			serverUrl: url(resourceValue.serverUrl),
			resource: url(resourceValue.resource),
			resourceMetadataUrl: url(resourceValue.resourceMetadataUrl),
			...(resourceValue.scopesSupported === undefined
				? {}
				: { scopesSupported: scopes(resourceValue.scopesSupported) }),
		});
		const selectedScopes = record.scopes === undefined ? undefined : scopes(record.scopes);
		if (record.kind === "authorization-server-selection-required") {
			assertOAuthSnapshotKeys(record, ["kind", "resource", "scopes", "candidates"]);
			if (
				!Array.isArray(record.candidates) ||
				record.candidates.length < 2 ||
				record.candidates.length > MAX_AUTHORIZATION_SERVER_COUNT
			) {
				throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
			}
			const candidates: readonly unknown[] = record.candidates;
			const issuers = candidates.map((item) => {
				const candidate = oauthSnapshotRecord(item);
				assertOAuthSnapshotKeys(candidate, ["issuer"]);
				return url(candidate.issuer, false);
			});
			if (new Set(issuers).size !== issuers.length)
				throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
			return freezeSelectionRequired(resource, selectedScopes, issuers);
		}
		if (record.kind === "ready") {
			assertOAuthSnapshotKeys(record, ["kind", "resource", "scopes", "candidate"]);
			const candidate = oauthSnapshotRecord(record.candidate);
			assertOAuthSnapshotKeys(candidate, [
				"authority",
				"clientIdMetadataDocumentSupported",
				"legacyDynamicRegistrationEndpoint",
			]);
			const authority = parseMcpClientOAuthAuthority(candidate.authority, options);
			if (authority.serverUrl !== resource.serverUrl || authority.resource !== resource.resource) {
				throw bootstrapError(McpClientOAuthBootstrapErrorCode.AuthorityInvalid);
			}
			return freezeReady(resource, selectedScopes, {
				authority,
				clientIdMetadataDocumentSupported: oauthSnapshotBoolean(
					candidate.clientIdMetadataDocumentSupported,
				),
				...(candidate.legacyDynamicRegistrationEndpoint === undefined
					? {}
					: {
							legacyDynamicRegistrationEndpoint: url(candidate.legacyDynamicRegistrationEndpoint),
						}),
			});
		}
		if (record.kind === "strict-protocol-unsupported") {
			assertOAuthSnapshotKeys(record, ["kind", "resource", "scopes", "issuer", "issues"]);
			const issues = oauthSnapshotStrings(record.issues, 6);
			if (
				issues.length === 0 ||
				!issues.every(isCompatibilityIssue) ||
				new Set(issues).size !== issues.length
			) {
				throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
			}
			return freezeStrictUnsupported(resource, selectedScopes, url(record.issuer, false), issues);
		}
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
	});
}

function isCompatibilityIssue(value: string): value is McpClientOAuthStrictCompatibilityIssue {
	return Object.values(McpClientOAuthStrictCompatibilityIssue).some((issue) => issue === value);
}

/**
 * Parses the bounded fields needed from a raw `WWW-Authenticate` header. It deliberately drops
 * attacker-controlled OAuth error text and returns `undefined` when no Bearer challenge exists.
 */
export function parseMcpClientOAuthBootstrapChallenge(
	wwwAuthenticate: string,
): McpClientOAuthBootstrapChallenge | undefined {
	if (
		typeof wwwAuthenticate !== "string" ||
		wwwAuthenticate.length === 0 ||
		wwwAuthenticate.length > MAX_WWW_AUTHENTICATE_LENGTH ||
		containsForbiddenHeaderCharacter(wwwAuthenticate)
	) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
	}
	const bearer = findBearerChallenge(wwwAuthenticate);
	if (bearer === undefined) return undefined;
	const parameters = parseBearerParameters(bearer);
	if (parameters === null) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
	}
	return Object.freeze({
		...(parameters.resourceMetadataUrl === undefined
			? {}
			: { resourceMetadataUrl: requireSecureUrl(parameters.resourceMetadataUrl, true).href }),
		...(parameters.scope === undefined
			? {}
			: { scope: normalizeScopeString(parameters.scope).join(" ") }),
	});
}

/**
 * Framework-neutral discovery bootstrap for an application-owned interactive OAuth flow.
 *
 * It owns no persistence, tenant policy, browser redirect, client registration, or token state.
 * Hosts retain those responsibilities and pass a ready authority to `McpClientOAuthProtocol`.
 */
export class McpClientOAuthBootstrap {
	readonly #fetch: FetchLike;
	readonly #endpointPolicy: McpClientOAuthBootstrapEndpointPolicy;
	readonly #protocolVersion: string;

	constructor(options: McpClientOAuthBootstrapOptions) {
		if (
			typeof options !== "object" ||
			options === null ||
			typeof options.fetch !== "function" ||
			typeof options.endpointPolicy !== "function"
		) {
			throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
		}
		this.#fetch = options.fetch;
		this.#endpointPolicy = options.endpointPolicy;
		this.#protocolVersion = normalizeProtocolVersion(
			options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
		);
	}

	async discover(
		input: McpClientOAuthBootstrapDiscoveryInput,
	): Promise<McpClientOAuthBootstrapDiscoveryResult> {
		const operation = normalizeDiscoveryInput(input);
		throwIfAborted(operation.signal);

		let discoveredResourceMetadataUrl: string | undefined;
		let metadata: OAuthProtectedResourceMetadata;
		try {
			metadata = await discoverOAuthProtectedResourceMetadata(
				operation.serverUrl,
				{
					protocolVersion: this.#protocolVersion,
					...(operation.challenge?.resourceMetadataUrl === undefined
						? {}
						: { resourceMetadataUrl: operation.challenge.resourceMetadataUrl }),
				},
				this.#createFetch({
					kind: "resource-metadata",
					credentialed: false,
					serverUrl: operation.serverUrl,
					signal: operation.signal,
					onAcceptedResponse(endpoint, response) {
						if (response.ok) discoveredResourceMetadataUrl = endpoint;
					},
				}),
			);
		} catch (error) {
			throwIfAborted(operation.signal);
			if (error instanceof McpClientOAuthBootstrapError) throw error;
			throw bootstrapError(McpClientOAuthBootstrapErrorCode.DiscoveryFailed);
		}

		throwIfAborted(operation.signal);
		const resource = normalizeProtectedResource({
			serverUrl: operation.serverUrl,
			resourceMetadataUrl:
				discoveredResourceMetadataUrl ?? operation.challenge?.resourceMetadataUrl,
			challengeResourceMetadataUrl: operation.challenge?.resourceMetadataUrl,
			metadata,
		});
		const scopes = selectScopes(operation.challenge?.scope, resource.scopesSupported);
		const issuers = normalizeAuthorizationServers(metadata.authorization_servers);
		if (operation.issuer === undefined && issuers.length > 1) {
			return freezeSelectionRequired(resource, scopes, issuers);
		}

		const issuer = operation.issuer ?? issuers[0];
		if (issuer === undefined || !issuers.includes(issuer)) {
			throw bootstrapError(McpClientOAuthBootstrapErrorCode.AuthorityInvalid);
		}

		let authorizationMetadata: AuthorizationServerMetadata | undefined;
		try {
			authorizationMetadata = await discoverAuthorizationServerMetadata(issuer, {
				fetchFn: this.#createFetch({
					kind: "authorization-server-metadata",
					credentialed: false,
					serverUrl: operation.serverUrl,
					resource: resource.resource,
					issuer,
					signal: operation.signal,
				}),
				protocolVersion: this.#protocolVersion,
			});
		} catch (error) {
			throwIfAborted(operation.signal);
			if (error instanceof McpClientOAuthBootstrapError) throw error;
			throw bootstrapError(McpClientOAuthBootstrapErrorCode.DiscoveryFailed);
		}
		throwIfAborted(operation.signal);
		if (authorizationMetadata === undefined || authorizationMetadata.issuer !== issuer) {
			throw bootstrapError(McpClientOAuthBootstrapErrorCode.AuthorityInvalid);
		}

		const compatibilityIssues = strictCompatibilityIssues(authorizationMetadata);
		if (compatibilityIssues.length > 0) {
			return freezeStrictUnsupported(resource, scopes, issuer, compatibilityIssues);
		}

		const authority = createStrictAuthority({
			serverUrl: operation.serverUrl,
			resource,
			issuer,
			metadata: authorizationMetadata,
			...(operation.challenge?.scope === undefined
				? {}
				: { challengedScope: operation.challenge.scope }),
		});
		await this.#authorizeEndpoint(authority.authorizationEndpoint, {
			kind: "authorization",
			credentialed: false,
			serverUrl: operation.serverUrl,
			resource: authority.resource,
			issuer,
			signal: operation.signal,
		});
		await this.#authorizeEndpoint(authority.tokenEndpoint, {
			kind: "token",
			credentialed: true,
			serverUrl: operation.serverUrl,
			resource: authority.resource,
			issuer,
			signal: operation.signal,
		});

		const legacyDynamicRegistrationEndpoint = normalizeOptionalLegacyRegistrationEndpoint(
			authorizationMetadata.registration_endpoint,
		);
		return freezeReady(resource, scopes, {
			authority,
			clientIdMetadataDocumentSupported:
				authorizationMetadata.client_id_metadata_document_supported === true,
			...(legacyDynamicRegistrationEndpoint === undefined
				? {}
				: { legacyDynamicRegistrationEndpoint }),
		});
	}

	#createFetch(input: {
		readonly kind: "resource-metadata" | "authorization-server-metadata";
		readonly credentialed: false;
		readonly serverUrl: string;
		readonly resource?: string;
		readonly issuer?: string;
		readonly signal: AbortSignal | undefined;
		readonly onAcceptedResponse?: (endpoint: string, response: Response) => void;
	}): FetchLike {
		return async (url, init) => {
			throwIfAborted(input.signal);
			const endpoint = requireSecureUrl(String(url), true);
			await this.#authorizeEndpoint(endpoint.href, input);
			throwIfAborted(input.signal);
			const signal = combineAbortSignals(input.signal, init?.signal);
			const requestInit: RequestInit = { ...init, redirect: "error" };
			if (signal !== undefined) requestInit.signal = signal;
			const response = await this.#fetch(new URL(endpoint.href), requestInit);
			throwIfAborted(input.signal);
			if (
				response.redirected ||
				(response.url.length > 0 && !isExactResponseUrl(response.url, endpoint.href))
			) {
				throw bootstrapError(McpClientOAuthBootstrapErrorCode.EndpointRejected);
			}
			input.onAcceptedResponse?.(endpoint.href, response);
			return response;
		};
	}

	async #authorizeEndpoint(
		endpointValue: string,
		input: {
			readonly kind: McpClientOAuthBootstrapEndpointKind;
			readonly credentialed: boolean;
			readonly serverUrl: string;
			readonly resource?: string;
			readonly issuer?: string;
			readonly signal: AbortSignal | undefined;
		},
	): Promise<void> {
		throwIfAborted(input.signal);
		const endpoint = requireSecureUrl(endpointValue, true);
		let admitted: unknown;
		try {
			admitted = await awaitWithSignal(
				Promise.resolve().then(() =>
					this.#endpointPolicy(
						Object.freeze({
							endpoint: new URL(endpoint.href),
							kind: input.kind,
							credentialed: input.credentialed,
							serverUrl: new URL(input.serverUrl),
							...(input.resource === undefined ? {} : { resource: new URL(input.resource) }),
							...(input.resource === undefined ? {} : { exactResource: input.resource }),
							...(input.issuer === undefined
								? {}
								: { issuer: new URL(input.issuer), exactIssuer: input.issuer }),
							...(input.signal === undefined ? {} : { signal: input.signal }),
						}),
					),
				),
				input.signal,
			);
		} catch {
			throwIfAborted(input.signal);
			throw bootstrapError(McpClientOAuthBootstrapErrorCode.EndpointRejected);
		}
		throwIfAborted(input.signal);
		if (admitted !== true) {
			throw bootstrapError(McpClientOAuthBootstrapErrorCode.EndpointRejected);
		}
	}
}

function normalizeDiscoveryInput(input: McpClientOAuthBootstrapDiscoveryInput): {
	readonly serverUrl: string;
	readonly challenge?: Readonly<McpClientOAuthBootstrapChallenge>;
	readonly issuer?: string;
	readonly signal: AbortSignal | undefined;
} {
	if (typeof input !== "object" || input === null) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
	}
	if (input.challenge !== undefined && input.wwwAuthenticate !== undefined) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
	}
	const serverUrl = requireSecureUrl(input.serverUrl, true).href;
	let challenge =
		input.wwwAuthenticate === undefined
			? undefined
			: parseMcpClientOAuthBootstrapChallenge(input.wwwAuthenticate);
	if (input.challenge !== undefined) {
		if (typeof input.challenge !== "object" || input.challenge === null) {
			throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
		}
		challenge = Object.freeze({
			...(input.challenge.resourceMetadataUrl === undefined
				? {}
				: {
						resourceMetadataUrl: requireSecureUrl(input.challenge.resourceMetadataUrl, true).href,
					}),
			...(input.challenge.scope === undefined
				? {}
				: { scope: normalizeScopeString(input.challenge.scope).join(" ") }),
		});
	}
	if (input.issuer !== undefined) requireSecureUrl(input.issuer, false);
	const issuer = input.issuer;
	return Object.freeze({
		serverUrl,
		...(challenge === undefined ? {} : { challenge }),
		...(issuer === undefined ? {} : { issuer }),
		signal: input.signal,
	});
}

function normalizeProtectedResource(input: {
	readonly serverUrl: string;
	readonly resourceMetadataUrl: string | undefined;
	readonly challengeResourceMetadataUrl: string | undefined;
	readonly metadata: OAuthProtectedResourceMetadata;
}): McpClientOAuthBootstrapResource {
	if (input.resourceMetadataUrl === undefined) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.DiscoveryFailed);
	}
	const resource = requireSecureUrl(input.metadata.resource, true);
	if (input.metadata.resource !== resource.href) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.ProtectedResourceInvalid);
	}
	const metadataEndpoint = requireSecureUrl(input.resourceMetadataUrl, true);
	const sourceBound =
		input.challengeResourceMetadataUrl === undefined
			? protectedResourceWellKnownUrl(resource).href === metadataEndpoint.href
			: resourceUrlFromServerUrl(input.serverUrl).href === resource.href;
	if (!sourceBound) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.ProtectedResourceInvalid);
	}
	if (
		(input.metadata.bearer_methods_supported !== undefined &&
			!input.metadata.bearer_methods_supported.includes("header")) ||
		input.metadata.tls_client_certificate_bound_access_tokens === true ||
		input.metadata.dpop_bound_access_tokens_required === true
	) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.ProtectedResourceInvalid);
	}
	const scopesSupported =
		input.metadata.scopes_supported === undefined
			? undefined
			: normalizeScopeList(
					input.metadata.scopes_supported,
					McpClientOAuthBootstrapErrorCode.ProtectedResourceInvalid,
				);
	return Object.freeze({
		serverUrl: input.serverUrl,
		resource: resource.href,
		resourceMetadataUrl: metadataEndpoint.href,
		...(scopesSupported === undefined ? {} : { scopesSupported }),
	});
}

function protectedResourceWellKnownUrl(resource: URL): URL {
	let pathname = resource.pathname;
	if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);
	const metadataUrl = new URL(`/.well-known/oauth-protected-resource${pathname}`, resource.origin);
	metadataUrl.search = resource.search;
	return metadataUrl;
}

function normalizeAuthorizationServers(values: readonly string[] | undefined): readonly string[] {
	if (
		!Array.isArray(values) ||
		values.length === 0 ||
		values.length > MAX_AUTHORIZATION_SERVER_COUNT
	) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.ProtectedResourceInvalid);
	}
	const normalized = [...new Set(values)];
	for (const value of normalized) requireSecureUrl(value, false);
	if (normalized.length === 0) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.ProtectedResourceInvalid);
	}
	return Object.freeze(normalized);
}

function strictCompatibilityIssues(
	metadata: AuthorizationServerMetadata,
): readonly McpClientOAuthStrictCompatibilityIssue[] {
	const issues: McpClientOAuthStrictCompatibilityIssue[] = [];
	const responseTypes = normalizeMetadataList(metadata.response_types_supported);
	const codeChallengeMethods = normalizeMetadataList(metadata.code_challenge_methods_supported);
	const tokenAuthenticationMethods = normalizeMetadataList(
		metadata.token_endpoint_auth_methods_supported,
	);
	if (!responseTypes.includes("code")) {
		issues.push(McpClientOAuthStrictCompatibilityIssue.AuthorizationCodeResponseUnsupported);
	}
	if (!codeChallengeMethods.includes("S256")) {
		issues.push(McpClientOAuthStrictCompatibilityIssue.PkceS256Unsupported);
	}
	if (
		!tokenAuthenticationMethods.some((method) =>
			STRICT_TOKEN_ENDPOINT_AUTHENTICATION_METHODS.has(method),
		)
	) {
		issues.push(McpClientOAuthStrictCompatibilityIssue.TokenEndpointAuthenticationUnsupported);
	}
	if (
		metadata.grant_types_supported !== undefined &&
		!normalizeMetadataList(metadata.grant_types_supported).includes("authorization_code")
	) {
		issues.push(McpClientOAuthStrictCompatibilityIssue.AuthorizationCodeGrantUnsupported);
	}
	if (
		metadata.response_modes_supported !== undefined &&
		!normalizeMetadataList(metadata.response_modes_supported).includes("query")
	) {
		issues.push(McpClientOAuthStrictCompatibilityIssue.QueryResponseModeUnsupported);
	}
	return Object.freeze(issues);
}

function createStrictAuthority(input: {
	readonly serverUrl: string;
	readonly resource: McpClientOAuthBootstrapResource;
	readonly issuer: string;
	readonly metadata: AuthorizationServerMetadata;
	readonly challengedScope?: string;
}): McpClientOAuthAuthority {
	return Object.freeze({
		serverUrl: input.serverUrl,
		resource: input.resource.resource,
		issuer: input.issuer,
		authorizationEndpoint: requireSecureUrl(input.metadata.authorization_endpoint, true).href,
		tokenEndpoint: requireSecureUrl(input.metadata.token_endpoint, true).href,
		responseTypesSupported: normalizeMetadataList(input.metadata.response_types_supported),
		codeChallengeMethodsSupported: normalizeMetadataList(
			input.metadata.code_challenge_methods_supported,
		),
		tokenEndpointAuthMethodsSupported: normalizeMetadataList(
			input.metadata.token_endpoint_auth_methods_supported,
		),
		...(input.metadata.grant_types_supported === undefined
			? {}
			: { grantTypesSupported: normalizeMetadataList(input.metadata.grant_types_supported) }),
		// A challenge scope is authoritative and need not be a subset of either advertised list.
		// Keep the raw PRM list in `resource`, but omit these strict validation hints for this flow.
		...(input.challengedScope !== undefined || input.resource.scopesSupported === undefined
			? {}
			: { resourceScopesSupported: input.resource.scopesSupported }),
		...(input.challengedScope !== undefined || input.metadata.scopes_supported === undefined
			? {}
			: {
					authorizationScopesSupported: normalizeScopeList(
						input.metadata.scopes_supported,
						McpClientOAuthBootstrapErrorCode.AuthorityInvalid,
					),
				}),
		authorizationResponseIssuerParameterSupported:
			input.metadata.authorization_response_iss_parameter_supported === true,
	});
}

function selectScopes(
	challengeScope: string | undefined,
	resourceScopes: readonly string[] | undefined,
): readonly string[] | undefined {
	if (challengeScope !== undefined) return normalizeScopeString(challengeScope);
	return resourceScopes;
}

function normalizeScopeString(value: string): readonly string[] {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_SCOPE_STRING_LENGTH ||
		containsControlCharacter(value)
	) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
	}
	return normalizeScopeList(value.split(" "), McpClientOAuthBootstrapErrorCode.InvalidOptions);
}

function normalizeScopeList(
	values: readonly string[],
	errorCode: McpClientOAuthBootstrapErrorCode,
): readonly string[] {
	if (!Array.isArray(values) || values.length > MAX_SCOPE_COUNT) {
		throw bootstrapError(errorCode);
	}
	const normalized = [...new Set(values)];
	for (const value of normalized) {
		if (!isMcpClientOAuthScopeToken(value)) {
			throw bootstrapError(errorCode);
		}
	}
	return Object.freeze(normalized);
}

function normalizeMetadataList(values: readonly string[] | undefined): readonly string[] {
	if (values === undefined) return Object.freeze([]);
	if (!Array.isArray(values) || values.length > MAX_METADATA_LIST_LENGTH) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.AuthorityInvalid);
	}
	const normalized = [...new Set(values)];
	for (const value of normalized) {
		if (
			typeof value !== "string" ||
			value.length === 0 ||
			value.length > MAX_METADATA_VALUE_LENGTH ||
			containsControlCharacter(value)
		) {
			throw bootstrapError(McpClientOAuthBootstrapErrorCode.AuthorityInvalid);
		}
	}
	return Object.freeze(normalized);
}

function normalizeOptionalLegacyRegistrationEndpoint(
	value: string | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	try {
		return requireSecureUrl(value, true).href;
	} catch {
		return undefined;
	}
}

function freezeSelectionRequired(
	resource: McpClientOAuthBootstrapResource,
	scopes: readonly string[] | undefined,
	issuers: readonly string[],
): McpClientOAuthBootstrapSelectionRequired {
	return Object.freeze({
		kind: "authorization-server-selection-required",
		resource: copyResource(resource),
		...(scopes === undefined ? {} : { scopes: Object.freeze([...scopes]) }),
		candidates: Object.freeze(
			issuers.map(
				(issuer) => Object.freeze({ issuer }) satisfies McpClientOAuthBootstrapIssuerCandidate,
			),
		),
	});
}

function freezeStrictUnsupported(
	resource: McpClientOAuthBootstrapResource,
	scopes: readonly string[] | undefined,
	issuer: string,
	issues: readonly McpClientOAuthStrictCompatibilityIssue[],
): McpClientOAuthBootstrapStrictProtocolUnsupported {
	return Object.freeze({
		kind: "strict-protocol-unsupported",
		resource: copyResource(resource),
		...(scopes === undefined ? {} : { scopes: Object.freeze([...scopes]) }),
		issuer,
		issues: Object.freeze([...issues]),
	});
}

function freezeReady(
	resource: McpClientOAuthBootstrapResource,
	scopes: readonly string[] | undefined,
	candidate: McpClientOAuthBootstrapCandidate,
): McpClientOAuthBootstrapReady {
	return Object.freeze({
		kind: "ready",
		resource: copyResource(resource),
		...(scopes === undefined ? {} : { scopes: Object.freeze([...scopes]) }),
		candidate: Object.freeze({
			authority: copyAuthority(candidate.authority),
			clientIdMetadataDocumentSupported: candidate.clientIdMetadataDocumentSupported,
			...(candidate.legacyDynamicRegistrationEndpoint === undefined
				? {}
				: {
						legacyDynamicRegistrationEndpoint: candidate.legacyDynamicRegistrationEndpoint,
					}),
		}),
	});
}

function copyResource(resource: McpClientOAuthBootstrapResource): McpClientOAuthBootstrapResource {
	return Object.freeze({
		serverUrl: resource.serverUrl,
		resource: resource.resource,
		resourceMetadataUrl: resource.resourceMetadataUrl,
		...(resource.scopesSupported === undefined
			? {}
			: { scopesSupported: Object.freeze([...resource.scopesSupported]) }),
	});
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

function normalizeProtocolVersion(value: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_PROTOCOL_VERSION_LENGTH ||
		containsControlCharacter(value)
	) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.InvalidOptions);
	}
	return value;
}

function requireSecureUrl(value: string, query: boolean): URL {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.AuthorityInvalid);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.AuthorityInvalid);
	}
	if (
		url.protocol !== "https:" ||
		url.username.length > 0 ||
		url.password.length > 0 ||
		url.hash.length > 0 ||
		(!query && url.search.length > 0)
	) {
		throw bootstrapError(McpClientOAuthBootstrapErrorCode.AuthorityInvalid);
	}
	return url;
}

function isExactResponseUrl(value: string, expected: string): boolean {
	try {
		return new URL(value).href === expected;
	} catch {
		return false;
	}
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

function throwIfAborted(signal: AbortSignal | undefined): void {
	signal?.throwIfAborted();
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

function findBearerChallenge(value: string): string | undefined {
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quoted) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') {
			quoted = true;
			continue;
		}
		if (value.slice(index, index + 6).toLowerCase() !== "bearer") continue;
		let boundary = index - 1;
		while (boundary >= 0 && /\s/u.test(value[boundary] ?? "")) boundary -= 1;
		const before = boundary < 0 ? undefined : value[boundary];
		const after = value[index + 6];
		if ((before === undefined || before === ",") && /\s/u.test(after ?? "")) {
			let parameterStart = index + 6;
			while (parameterStart < value.length && /\s/u.test(value[parameterStart] ?? "")) {
				parameterStart += 1;
			}
			const challengeEnd = findAuthenticationChallengeEnd(value, parameterStart);
			return value.slice(parameterStart, challengeEnd).trimEnd();
		}
	}
	return undefined;
}

function findAuthenticationChallengeEnd(value: string, start: number): number {
	let quoted = false;
	let escaped = false;
	for (let index = start; index < value.length; index += 1) {
		const character = value[index];
		if (quoted) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') {
			quoted = true;
			continue;
		}
		if (character !== ",") continue;
		let cursor = index + 1;
		while (cursor < value.length && /\s/u.test(value[cursor] ?? "")) cursor += 1;
		const tokenStart = cursor;
		while (cursor < value.length && isAuthenticationTokenCharacter(value[cursor])) cursor += 1;
		if (cursor === tokenStart) continue;
		while (cursor < value.length && /\s/u.test(value[cursor] ?? "")) cursor += 1;
		// An auth-param is followed by `=`; another token begins the next challenge.
		if (value[cursor] !== "=") return index;
	}
	return value.length;
}

function isAuthenticationTokenCharacter(value: string | undefined): boolean {
	return value !== undefined && /^[!#$%&'*+\-.^_`|~A-Za-z0-9]$/u.test(value);
}

interface ParsedBearerParameters {
	readonly resourceMetadataUrl?: string;
	readonly scope?: string;
}

/** `null` means the Bearer credential was malformed or repeated a security-relevant field. */
function parseBearerParameters(bearerParameters: string): ParsedBearerParameters | null {
	let offset = 0;
	let resourceMetadataUrl: string | undefined;
	let scope: string | undefined;

	while (offset < bearerParameters.length) {
		while (offset < bearerParameters.length && isOptionalWhitespace(bearerParameters[offset])) {
			offset += 1;
		}
		const nameStart = offset;
		while (
			offset < bearerParameters.length &&
			isAuthenticationTokenCharacter(bearerParameters[offset])
		) {
			offset += 1;
		}
		if (offset === nameStart) return null;
		const name = bearerParameters.slice(nameStart, offset).toLowerCase();

		while (offset < bearerParameters.length && isOptionalWhitespace(bearerParameters[offset])) {
			offset += 1;
		}
		if (bearerParameters[offset] !== "=") return null;
		offset += 1;
		while (offset < bearerParameters.length && isOptionalWhitespace(bearerParameters[offset])) {
			offset += 1;
		}

		let value = "";
		if (bearerParameters[offset] === '"') {
			offset += 1;
			let closed = false;
			while (offset < bearerParameters.length) {
				const character = bearerParameters[offset];
				offset += 1;
				if (character === "\t") return null;
				if (character === "\\") {
					const escaped = bearerParameters[offset];
					if (escaped === undefined || escaped === "\t") return null;
					value += escaped;
					offset += 1;
					continue;
				}
				if (character === '"') {
					closed = true;
					break;
				}
				if (character === undefined) return null;
				value += character;
			}
			if (!closed) return null;
		} else {
			const valueStart = offset;
			while (
				offset < bearerParameters.length &&
				!isOptionalWhitespace(bearerParameters[offset]) &&
				bearerParameters[offset] !== ","
			) {
				offset += 1;
			}
			value = bearerParameters.slice(valueStart, offset);
		}

		if (value.length === 0 && (name === "resource_metadata" || name === "scope")) return null;
		if (name === "resource_metadata") {
			if (resourceMetadataUrl !== undefined) return null;
			resourceMetadataUrl = value;
		} else if (name === "scope") {
			if (scope !== undefined) return null;
			scope = value;
		}

		while (offset < bearerParameters.length && isOptionalWhitespace(bearerParameters[offset])) {
			offset += 1;
		}
		if (offset === bearerParameters.length) break;
		if (bearerParameters[offset] !== ",") return null;
		offset += 1;
		while (offset < bearerParameters.length && isOptionalWhitespace(bearerParameters[offset])) {
			offset += 1;
		}
		if (offset === bearerParameters.length) return null;
	}

	return Object.freeze({
		...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
		...(scope === undefined ? {} : { scope }),
	});
}

function isOptionalWhitespace(value: string | undefined): boolean {
	return value === " " || value === "\t";
}

function containsForbiddenHeaderCharacter(value: string): boolean {
	for (const character of value) {
		const point = character.codePointAt(0);
		if (
			point !== undefined &&
			((point <= 0x1f && point !== 0x09) || (point >= 0x7f && point <= 0x9f))
		) {
			return true;
		}
	}
	return false;
}

function bootstrapError(code: McpClientOAuthBootstrapErrorCode): McpClientOAuthBootstrapError {
	return new McpClientOAuthBootstrapError(code);
}

function bootstrapErrorMessage(code: McpClientOAuthBootstrapErrorCode): string {
	switch (code) {
		case McpClientOAuthBootstrapErrorCode.InvalidOptions:
			return "The OAuth bootstrap options are invalid.";
		case McpClientOAuthBootstrapErrorCode.EndpointRejected:
			return "An OAuth bootstrap endpoint was rejected.";
		case McpClientOAuthBootstrapErrorCode.DiscoveryFailed:
			return "OAuth bootstrap discovery failed.";
		case McpClientOAuthBootstrapErrorCode.ProtectedResourceInvalid:
			return "The OAuth protected-resource metadata is invalid.";
		case McpClientOAuthBootstrapErrorCode.AuthorityInvalid:
			return "The OAuth authorization-server metadata is invalid.";
		default:
			return "OAuth bootstrap failed.";
	}
}
