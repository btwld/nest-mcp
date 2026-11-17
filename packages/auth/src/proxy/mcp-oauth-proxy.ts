import { checkResourceAllowed, OAuthErrorCode } from "@modelcontextprotocol/server";
import type { OAuthTokens } from "@modelcontextprotocol/client";
import type { OAuthMetadata, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { McpOAuthConfigError } from "../mcp-oauth.errors.ts";
import {
	constantTimeEquals,
	McpOAuthSecretKeyring,
	randomToken,
	sha256Base64Url,
} from "../crypto/secrets.ts";
import { signMcpAccessToken } from "../jwt/issuer.ts";
import type { McpTokenKeyRing } from "../jwt/issuer.ts";
import { createMcpProxyTokenVerifier } from "../mcp-oauth-verifier.ts";
import { buildMcpAuthorizationServerMetadata } from "../mcp-oauth-metadata.ts";
import { isClientIdMetadataUrl } from "../cimd/client-id-metadata.ts";
import type { McpClientIdMetadataResolver } from "../cimd/client-id-metadata.ts";
import type { McpOAuthStore } from "../stores/store.types.ts";
import type { McpUpstreamAdapter } from "../upstream/mcp-oauth-upstream.ts";
import { renderDefaultConsent } from "./consent.ts";
import type { McpConsentRenderer } from "./consent.ts";
import { isS256Method, isValidS256Challenge, verifyPkceS256 } from "./pkce.ts";
import { verifyClientSecret } from "./client-secret.ts";
import { decodeRecord, encodeRecord, issuerFingerprint, recordKey } from "./records.ts";
import type { McpAuthzRecord, McpCodeRecord, McpGrantRecord, McpRefreshRecord } from "./records.ts";
import {
	isSameOriginRequest,
	jsonResponse,
	oauthErrorResponse,
	parseCookies,
	redirectErrorResponse,
	redirectResponse,
	renderErrorResponse,
	setCookieHeader,
	withSetCookie,
} from "./http.ts";
import type { McpOAuthClient, McpOAuthClientResolver } from "./http.ts";

const COOKIE_AUTHZ_PREFIX = "__Host-nest_mcp_authz_";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** Token-endpoint auth methods the proxy can actually enforce at `/token`. */
const SUPPORTED_CLIENT_AUTH_METHODS = new Set<McpOAuthClient["tokenEndpointAuthMethod"]>([
	"none",
	"client_secret_basic",
	"client_secret_post",
]);

/** Per-transaction session cookie name, so parallel authorizations don't clobber each other. */
function authzCookieName(txId: string): string {
	return `${COOKIE_AUTHZ_PREFIX}${txId}`;
}

export interface McpOAuthProxyTtl {
	readonly authorizationRequestSeconds?: number;
	readonly authorizationCodeSeconds?: number;
	readonly refreshTokenSeconds?: number;
	readonly grantSeconds?: number;
	readonly accessTokenSeconds?: number;
}

/** Validation context passed to a subject resolver so it can bind claims to the upstream. */
export interface McpUpstreamSubjectContext {
	readonly upstreamIssuer: string;
	readonly upstreamClientId: string;
	readonly now: () => number;
}

/** Extracts a stable subject (and optional tenant) from the upstream token set. */
export type McpUpstreamSubjectResolver = (
	tokens: OAuthTokens,
	context: McpUpstreamSubjectContext,
) => {
	readonly subject: string;
	readonly tenantId?: string;
};

export interface McpOAuthProxyOptions {
	/** This server's own issuer (origin, no trailing slash). */
	readonly issuer: string;
	readonly basePath?: string;
	/** Canonical resource URL(s) this proxy issues tokens for (RFC 8707). */
	readonly resources: readonly (URL | string)[];
	readonly scopesSupported?: readonly string[];
	readonly signingKeys: McpTokenKeyRing;
	readonly secrets: McpOAuthSecretKeyring;
	readonly upstream: McpUpstreamAdapter;
	readonly stateStore: McpOAuthStore;
	/** Defaults to `stateStore`. */
	readonly tokenStore?: McpOAuthStore;
	readonly cimd?: McpClientIdMetadataResolver;
	readonly clientResolver?: McpOAuthClientResolver;
	readonly consentRenderer?: McpConsentRenderer;
	readonly resolveUpstreamSubject?: McpUpstreamSubjectResolver;
	readonly ttl?: McpOAuthProxyTtl;
	readonly now?: () => number;
}

const DEFAULT_TTL = {
	authorizationRequestSeconds: 600,
	authorizationCodeSeconds: 60,
	refreshTokenSeconds: 2_592_000,
	grantSeconds: 2_592_000,
	accessTokenSeconds: 900,
} as const;

/**
 * OAuth 2.1 authorization-server proxy in front of a real upstream IdP. It
 * holds upstream tokens server-side and mints its own audience-scoped access
 * tokens; the downstream client never receives an upstream credential.
 */
export class McpOAuthProxy {
	readonly #issuer: string;
	readonly #basePath: string;
	readonly #issuerFp: string;
	readonly #resources: readonly string[];
	readonly #scopesSupported: ReadonlySet<string> | undefined;
	readonly #ring: McpTokenKeyRing;
	readonly #secrets: McpOAuthSecretKeyring;
	readonly #upstream: McpUpstreamAdapter;
	readonly #stateStore: McpOAuthStore;
	readonly #tokenStore: McpOAuthStore;
	readonly #cimd: McpClientIdMetadataResolver | undefined;
	readonly #clientResolver: McpOAuthClientResolver | undefined;
	readonly #renderConsent: McpConsentRenderer;
	readonly #resolveSubject: McpUpstreamSubjectResolver;
	readonly #now: () => number;
	readonly #ttl: Required<McpOAuthProxyTtl>;
	readonly #metadata: OAuthMetadata;
	readonly #verifier: OAuthTokenVerifier;

	constructor(options: McpOAuthProxyOptions) {
		if (options.resources.length === 0) {
			throw new McpOAuthConfigError("INVALID_OPTIONS", "The proxy requires at least one resource.");
		}
		this.#issuer = options.issuer.replace(/\/$/, "");
		this.#basePath = normalizeBasePath(options.basePath);
		this.#issuerFp = issuerFingerprint(this.#issuer);
		this.#resources = options.resources.map((resource) => new URL(resource).href);
		this.#scopesSupported =
			options.scopesSupported === undefined ? undefined : new Set(options.scopesSupported);
		this.#ring = options.signingKeys;
		this.#secrets = options.secrets;
		this.#upstream = options.upstream;
		this.#stateStore = options.stateStore;
		this.#tokenStore = options.tokenStore ?? options.stateStore;
		this.#cimd = options.cimd;
		this.#clientResolver = options.clientResolver;
		this.#renderConsent = options.consentRenderer ?? renderDefaultConsent;
		this.#resolveSubject = options.resolveUpstreamSubject ?? defaultSubjectResolver;
		this.#now = options.now ?? Date.now;
		this.#ttl = { ...DEFAULT_TTL, ...definedTtl(options.ttl) };
		this.#metadata = buildMcpAuthorizationServerMetadata({
			issuer: this.#issuer,
			...(options.basePath === undefined ? {} : { basePath: options.basePath }),
			...(options.scopesSupported === undefined
				? {}
				: { scopesSupported: options.scopesSupported }),
			clientIdMetadataDocumentSupported: options.cimd !== undefined,
		});
		this.#verifier = createMcpProxyTokenVerifier({
			ring: this.#ring,
			issuer: this.#issuer,
			resources: this.#resources,
			now: this.#now,
			// gid is the revocation lever: a deny tombstone keyed by grant id makes
			// grant revocation (refresh reuse, code replay) effective for tokens
			// already minted, within their remaining lifetime.
			isRevoked: async (_jti, claims) => {
				if (claims.gid === undefined) return false;
				const denied = await this.#tokenStore.get(
					recordKey(this.#issuerFp, "jti-deny", claims.gid),
				);
				return denied !== undefined;
			},
		});
	}

	/** Deletes a grant and denies its still-valid access tokens (keyed by gid). */
	async #revokeGrant(grantId: string): Promise<void> {
		await this.#tokenStore.delete(recordKey(this.#issuerFp, "grant", grantId));
		await this.#tokenStore.set(recordKey(this.#issuerFp, "jti-deny", grantId), "1", {
			ttlSeconds: this.#ttl.accessTokenSeconds,
		});
	}

	/** SDK `OAuthTokenVerifier` for the tokens this proxy mints. */
	get verifier(): OAuthTokenVerifier {
		return this.#verifier;
	}

	/** RFC 8414 authorization-server metadata document. */
	get authorizationServerMetadata(): OAuthMetadata {
		return this.#metadata;
	}

	/** Normalized route prefix for the `/oauth/*` endpoints (well-known stays at root). */
	get basePath(): string {
		return this.#basePath;
	}

	/** RFC 9728 protected-resource metadata for a configured resource (defaults to the first). */
	protectedResourceMetadata(resource?: string): {
		readonly resource: string;
		readonly authorization_servers: readonly string[];
	} {
		const target = resource === undefined ? this.#resources[0] : this.#matchResource(resource);
		if (target === undefined) {
			throw new McpOAuthConfigError("INVALID_OPTIONS", "Unknown protected resource.");
		}
		return Object.freeze({
			resource: target,
			authorization_servers: Object.freeze([this.#issuer]),
		});
	}

	/** Public JWKS for verifying issued access tokens. */
	jwks(): { keys: readonly Readonly<Record<string, unknown>>[] } {
		return this.#ring.publicJwks();
	}

	/** GET /oauth/authorize */
	async authorize(request: Request): Promise<Response> {
		try {
			return await this.#authorize(request);
		} catch (error) {
			return renderStoreFault(error);
		}
	}

	async #authorize(request: Request): Promise<Response> {
		const params = new URL(request.url).searchParams;
		const clientId = params.get("client_id");
		if (clientId === null || clientId.length === 0) {
			return renderErrorResponse(400, "invalid_request", "Missing client_id.");
		}
		const client = await this.#resolveClient(clientId);
		if (client === undefined) {
			return renderErrorResponse(400, "invalid_client", "Unknown or unresolvable client.");
		}
		// Reject a client whose token-endpoint auth method cannot be honored, before
		// any state is written — otherwise it would pass /authorize but strand a
		// live grant at /token.
		if (!SUPPORTED_CLIENT_AUTH_METHODS.has(client.tokenEndpointAuthMethod)) {
			return renderErrorResponse(
				400,
				"invalid_client",
				"Unsupported token_endpoint_auth_method for this client.",
			);
		}
		const redirectUri = params.get("redirect_uri");
		if (redirectUri === null || !client.redirectUris.includes(redirectUri)) {
			return renderErrorResponse(
				400,
				"invalid_request",
				"redirect_uri is not registered for this client.",
			);
		}
		// Post-redirect-validation errors return to the client.
		const state = params.get("state") ?? undefined;
		const fail = (error: string, description?: string): Response =>
			redirectErrorResponse(redirectUri, error, {
				iss: this.#issuer,
				...(state === undefined ? {} : { state }),
				...(description === undefined ? {} : { description }),
			});
		if (params.get("response_type") !== "code") return fail("unsupported_response_type");
		const codeChallenge = params.get("code_challenge");
		if (
			codeChallenge === null ||
			!isS256Method(params.get("code_challenge_method") ?? undefined) ||
			!isValidS256Challenge(codeChallenge)
		) {
			return fail("invalid_request", "A well-formed S256 code_challenge is required.");
		}
		const resource = params.get("resource");
		const boundResource = resource === null ? undefined : this.#matchResource(resource);
		if (boundResource === undefined)
			return fail("invalid_target", "A valid resource parameter is required.");
		const requestedScopes = (params.get("scope") ?? "")
			.split(" ")
			.filter((scope) => scope.length > 0);
		if (
			this.#scopesSupported !== undefined &&
			!requestedScopes.every((scope) => this.#scopesSupported?.has(scope))
		) {
			return fail("invalid_scope");
		}

		const txId = randomToken(18);
		const sessionSecret = randomToken();
		const csrf = randomToken();
		let upstream;
		try {
			upstream = await this.#upstream.startAuthorization({
				redirectUri: this.#callbackUrl(),
				state: txId,
				resource: new URL(boundResource),
			});
		} catch {
			return fail("temporarily_unavailable", "The upstream authorization server is unavailable.");
		}
		const record: McpAuthzRecord = {
			txId,
			clientId: client.clientId,
			clientKind: client.source,
			clientName: client.clientName,
			redirectUri,
			codeChallenge,
			resource: boundResource,
			scope: requestedScopes,
			upstreamIssuer: this.#upstream.issuer,
			upstreamCodeVerifier: upstream.codeVerifier,
			upstreamAuthorizationUrl: upstream.authorizationUrl,
			upstreamNonce: "",
			sessionBindingHash: sha256Base64Url(sessionSecret),
			csrf,
			createdAt: this.#now(),
			...(state === undefined ? {} : { clientState: state }),
		};
		await this.#stateStore.set(recordKey(this.#issuerFp, "authz", txId), encodeRecord(record), {
			ttlSeconds: this.#ttl.authorizationRequestSeconds,
		});
		const consent = await this.#renderConsent({
			clientName: client.clientName,
			clientIdHost: hostOf(client.clientId),
			redirectHost: hostOf(redirectUri),
			scopes: requestedScopes,
			resource: boundResource,
			loopbackOnly: client.loopbackOnly,
			formAction: `${this.#basePath}/oauth/authorize/consent`,
			transactionId: txId,
			csrfToken: csrf,
		});
		return withSetCookie(
			consent,
			setCookieHeader(authzCookieName(txId), sessionSecret, {
				maxAgeSeconds: this.#ttl.authorizationRequestSeconds,
			}),
		);
	}

	/** POST /oauth/authorize/consent */
	async handleConsent(request: Request, form: URLSearchParams): Promise<Response> {
		try {
			return await this.#handleConsent(request, form);
		} catch (error) {
			return renderStoreFault(error);
		}
	}

	async #handleConsent(request: Request, form: URLSearchParams): Promise<Response> {
		const txId = form.get("tx");
		const cookie = txId === null ? undefined : parseCookies(request)[authzCookieName(txId)];
		if (txId === null || cookie === undefined) {
			return renderErrorResponse(403, "invalid_request", "Consent session is missing.");
		}
		const record = decodeRecord<McpAuthzRecord>(
			await this.#stateStore.get(recordKey(this.#issuerFp, "authz", txId)),
		);
		if (record === undefined) {
			return renderErrorResponse(403, "invalid_request", "Consent session has expired.");
		}
		if (!constantTimeEquals(sha256Base64Url(cookie), record.sessionBindingHash)) {
			return renderErrorResponse(403, "invalid_request", "Consent session binding mismatch.");
		}
		const csrf = form.get("csrf");
		if (csrf === null || !constantTimeEquals(csrf, record.csrf)) {
			return renderErrorResponse(403, "invalid_request", "Invalid CSRF token.");
		}
		if (!isSameOriginRequest(request)) {
			return renderErrorResponse(
				403,
				"invalid_request",
				"Cross-origin consent submission refused.",
			);
		}
		const action = form.get("action");
		if (action !== "approve" && action !== "deny") {
			return renderErrorResponse(400, "invalid_request", "Missing consent decision.");
		}
		if (action === "deny") {
			await this.#stateStore.delete(recordKey(this.#issuerFp, "authz", txId));
			return redirectErrorResponse(record.redirectUri, "access_denied", {
				iss: this.#issuer,
				...(record.clientState === undefined ? {} : { state: record.clientState }),
			});
		}
		return redirectResponse(record.upstreamAuthorizationUrl);
	}

	/** GET /oauth/callback */
	async handleCallback(request: Request): Promise<Response> {
		try {
			return await this.#handleCallback(request);
		} catch (error) {
			return renderStoreFault(error);
		}
	}

	async #handleCallback(request: Request): Promise<Response> {
		const params = new URL(request.url).searchParams;
		const txId = params.get("state");
		if (txId === null) return renderErrorResponse(400, "invalid_request", "Missing state.");
		const authzKey = recordKey(this.#issuerFp, "authz", txId);
		// Read non-destructively first: the transaction is consumed only after the
		// session cookie is verified, so a request without the victim's cookie
		// cannot burn a live authorization transaction.
		const record = decodeRecord<McpAuthzRecord>(await this.#stateStore.get(authzKey));
		if (record === undefined) {
			return renderErrorResponse(400, "invalid_request", "Unknown or expired authorization.");
		}
		const cookie = parseCookies(request)[authzCookieName(txId)];
		if (
			cookie === undefined ||
			!constantTimeEquals(sha256Base64Url(cookie), record.sessionBindingHash)
		) {
			return renderErrorResponse(403, "invalid_request", "Authorization session mismatch.");
		}
		// Session verified — now atomically consume the transaction (single-use).
		if ((await this.#stateStore.take(authzKey)) === undefined) {
			return renderErrorResponse(400, "invalid_request", "Authorization already completed.");
		}
		const clientError = params.get("error");
		if (clientError !== null) {
			return redirectErrorResponse(record.redirectUri, sanitizeUpstreamError(clientError), {
				iss: this.#issuer,
				...(record.clientState === undefined ? {} : { state: record.clientState }),
			});
		}
		const code = params.get("code");
		if (code === null) {
			return redirectErrorResponse(record.redirectUri, "invalid_request", {
				iss: this.#issuer,
				...(record.clientState === undefined ? {} : { state: record.clientState }),
			});
		}
		const iss = params.get("iss");
		let tokens: OAuthTokens;
		try {
			tokens = await this.#upstream.exchangeCode({
				authorizationCode: code,
				codeVerifier: record.upstreamCodeVerifier,
				redirectUri: this.#callbackUrl(),
				resource: new URL(record.resource),
				...(iss === null ? {} : { iss }),
			});
		} catch {
			return redirectErrorResponse(record.redirectUri, "server_error", {
				iss: this.#issuer,
				...(record.clientState === undefined ? {} : { state: record.clientState }),
			});
		}
		let subject: string;
		let tenantId: string | undefined;
		try {
			const resolved = this.#resolveSubject(tokens, {
				upstreamIssuer: record.upstreamIssuer,
				upstreamClientId: this.#upstream.clientId,
				now: this.#now,
			});
			subject = this.#secrets.subjectPseudonym(record.upstreamIssuer, resolved.subject);
			tenantId = resolved.tenantId;
		} catch {
			return redirectErrorResponse(record.redirectUri, "server_error", {
				iss: this.#issuer,
				...(record.clientState === undefined ? {} : { state: record.clientState }),
			});
		}
		const grantId = randomToken(18);
		const grant: McpGrantRecord = {
			grantId,
			clientId: record.clientId,
			subject,
			resource: record.resource,
			scope: record.scope,
			upstream: {
				accessToken: tokens.access_token,
				...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
				...(tokens.expires_in === undefined
					? {}
					: { expiresAt: Math.floor(this.#now() / 1_000) + tokens.expires_in }),
			},
			generation: 0,
			createdAt: this.#now(),
			...(tenantId === undefined ? {} : { tenantId }),
		};
		await this.#tokenStore.set(recordKey(this.#issuerFp, "grant", grantId), encodeRecord(grant), {
			ttlSeconds: this.#ttl.grantSeconds,
		});
		const authorizationCode = randomToken();
		const codeRecord: McpCodeRecord = {
			clientId: record.clientId,
			redirectUri: record.redirectUri,
			codeChallenge: record.codeChallenge,
			resource: record.resource,
			scope: record.scope,
			grantId,
			subject,
			...(tenantId === undefined ? {} : { tenantId }),
		};
		await this.#tokenStore.set(
			recordKey(this.#issuerFp, "code", sha256Base64Url(authorizationCode)),
			encodeRecord(codeRecord),
			{ ttlSeconds: this.#ttl.authorizationCodeSeconds },
		);
		const target = new URL(record.redirectUri);
		target.searchParams.set("code", authorizationCode);
		if (record.clientState !== undefined) target.searchParams.set("state", record.clientState);
		target.searchParams.set("iss", this.#issuer);
		return redirectResponse(target.href);
	}

	/** POST /oauth/token */
	async token(request: Request, form: URLSearchParams): Promise<Response> {
		const grantType = form.get("grant_type");
		try {
			if (grantType === "authorization_code") return await this.#exchangeCode(request, form);
			if (grantType === "refresh_token") return await this.#exchangeRefreshToken(request, form);
			if (grantType === TOKEN_EXCHANGE_GRANT) return await this.#exchangeToken(request, form);
			return oauthErrorResponse(
				400,
				OAuthErrorCode.UnsupportedGrantType,
				"Unsupported grant_type.",
			);
		} catch (error) {
			// Storage capacity/backends and other internal faults must not escape as
			// a raw 500; map to a spec-compliant retryable error.
			return storeFaultResponse(error);
		}
	}

	/** Loads the upstream tokens behind a verified access token (for gateway delegation). */
	async loadUpstreamTokens(grantId: string): Promise<McpGrantRecord["upstream"] | undefined> {
		const grant = decodeRecord<McpGrantRecord>(
			await this.#tokenStore.get(recordKey(this.#issuerFp, "grant", grantId)),
		);
		return grant?.upstream;
	}

	async #exchangeCode(request: Request, form: URLSearchParams): Promise<Response> {
		const presentedClientId = clientIdFrom(request, form);
		if (presentedClientId === undefined) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidClient, "client_id is required.");
		}
		const code = form.get("code");
		if (code === null) return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "Missing code.");
		const codeKey = recordKey(this.#issuerFp, "code", sha256Base64Url(code));
		const spentKey = recordKey(this.#issuerFp, "code-spent", sha256Base64Url(code));
		// Read non-destructively and validate the presenter BEFORE consuming, so a
		// bogus request cannot burn a legitimate client's one-time code.
		const codeRecord = decodeRecord<McpCodeRecord>(await this.#tokenStore.get(codeKey));
		if (codeRecord === undefined) {
			const spent = decodeRecord<{ grantId: string }>(await this.#tokenStore.get(spentKey));
			if (spent !== undefined) {
				// A code presented twice is treated as compromised: kill its grant.
				await this.#revokeGrant(spent.grantId);
				return oauthErrorResponse(
					400,
					OAuthErrorCode.InvalidGrant,
					"Authorization code already used.",
				);
			}
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "Invalid authorization code.");
		}
		if (presentedClientId !== codeRecord.clientId) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "client_id mismatch.");
		}
		const client = await this.#resolveClient(codeRecord.clientId);
		if (client === undefined)
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "Unknown client.");
		const authFailure = this.#authenticateClient(request, form, client);
		if (authFailure !== undefined) return authFailure;
		if (form.get("redirect_uri") !== codeRecord.redirectUri) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "redirect_uri mismatch.");
		}
		const codeVerifier = form.get("code_verifier");
		if (codeVerifier === null || !verifyPkceS256(codeVerifier, codeRecord.codeChallenge)) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "PKCE verification failed.");
		}
		// All checks passed — consume the code atomically. If the take loses a
		// concurrent race, another request already redeemed it.
		if ((await this.#tokenStore.take(codeKey)) === undefined) {
			return oauthErrorResponse(
				400,
				OAuthErrorCode.InvalidGrant,
				"Authorization code already used.",
			);
		}
		await this.#tokenStore.set(spentKey, encodeRecord({ grantId: codeRecord.grantId }), {
			ttlSeconds: this.#ttl.authorizationCodeSeconds,
		});
		const grant = decodeRecord<McpGrantRecord>(
			await this.#tokenStore.get(recordKey(this.#issuerFp, "grant", codeRecord.grantId)),
		);
		if (grant === undefined)
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "Grant not found.");
		return this.#issueTokens(grant, codeRecord.scope);
	}

	async #exchangeRefreshToken(request: Request, form: URLSearchParams): Promise<Response> {
		const presentedClientId = clientIdFrom(request, form);
		if (presentedClientId === undefined) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidClient, "client_id is required.");
		}
		const handle = form.get("refresh_token");
		if (handle === null)
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "Missing refresh_token.");
		const refreshKey = recordKey(this.#issuerFp, "refresh", sha256Base64Url(handle));
		const spentKey = recordKey(this.#issuerFp, "refresh-spent", sha256Base64Url(handle));
		// Read non-destructively and fully validate the presenter BEFORE consuming
		// or writing any tombstone, so a rejected retry (bad scope, wrong client)
		// never escalates to grant revocation.
		const record = decodeRecord<McpRefreshRecord>(await this.#tokenStore.get(refreshKey));
		if (record === undefined) {
			const spent = decodeRecord<McpRefreshRecord>(await this.#tokenStore.get(spentKey));
			if (spent !== undefined && spent.clientId === presentedClientId) {
				// Reuse of a rotated handle by its owner: revoke the whole grant family.
				await this.#revokeGrant(spent.grantId);
				return oauthErrorResponse(
					400,
					OAuthErrorCode.InvalidGrant,
					"Refresh token reuse detected.",
				);
			}
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "Invalid refresh_token.");
		}
		if (presentedClientId !== record.clientId) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "client_id mismatch.");
		}
		const client = await this.#resolveClient(record.clientId);
		if (client === undefined)
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "Unknown client.");
		const authFailure = this.#authenticateClient(request, form, client);
		if (authFailure !== undefined) return authFailure;
		const grant = decodeRecord<McpGrantRecord>(
			await this.#tokenStore.get(recordKey(this.#issuerFp, "grant", record.grantId)),
		);
		if (grant === undefined)
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "Grant not found.");
		const requestedScope = form.get("scope");
		const scope =
			requestedScope === null
				? grant.scope
				: requestedScope.split(" ").filter((entry) => entry.length > 0);
		if (!scope.every((entry) => grant.scope.includes(entry))) {
			return oauthErrorResponse(
				400,
				OAuthErrorCode.InvalidScope,
				"Requested scope exceeds the grant.",
			);
		}
		// Validation passed — consume the handle atomically and arm the reuse marker.
		if ((await this.#tokenStore.take(refreshKey)) === undefined) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "Invalid refresh_token.");
		}
		await this.#tokenStore.set(spentKey, encodeRecord(record), {
			ttlSeconds: this.#ttl.refreshTokenSeconds,
		});
		let nextGrant = grant;
		if (grant.upstream.refreshToken !== undefined) {
			try {
				const tokens = await this.#upstream.refresh({
					refreshToken: grant.upstream.refreshToken,
					resource: new URL(grant.resource),
				});
				nextGrant = {
					...grant,
					upstream: {
						accessToken: tokens.access_token,
						...(tokens.refresh_token === undefined
							? { refreshToken: grant.upstream.refreshToken }
							: { refreshToken: tokens.refresh_token }),
						...(tokens.expires_in === undefined
							? {}
							: { expiresAt: Math.floor(this.#now() / 1_000) + tokens.expires_in }),
					},
					generation: grant.generation + 1,
				};
				await this.#tokenStore.set(
					recordKey(this.#issuerFp, "grant", grant.grantId),
					encodeRecord(nextGrant),
					{ ttlSeconds: this.#ttl.grantSeconds },
				);
			} catch {
				// Restore the consumed handle at the same generation; clear the reuse marker.
				await this.#tokenStore.set(refreshKey, encodeRecord(record), {
					ttlSeconds: this.#ttl.refreshTokenSeconds,
				});
				await this.#tokenStore.delete(spentKey);
				return oauthErrorResponse(
					503,
					OAuthErrorCode.TemporarilyUnavailable,
					"Upstream refresh failed.",
				);
			}
		}
		return this.#issueTokens(nextGrant, scope);
	}

	/**
	 * RFC 8693 token exchange: the proxy acts as its own STS. A confidential
	 * client presents a valid access token this proxy minted and receives a new
	 * access token for a configured resource, with a subset of the grant's
	 * scopes. No refresh token is issued for an exchanged (delegation) token.
	 */
	async #exchangeToken(request: Request, form: URLSearchParams): Promise<Response> {
		const presentedClientId = clientIdFrom(request, form);
		if (presentedClientId === undefined) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidClient, "client_id is required.");
		}
		const subjectToken = form.get("subject_token");
		const subjectTokenType = form.get("subject_token_type");
		if (subjectToken === null) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidRequest, "Missing subject_token.");
		}
		// RFC 8693: subject_token_type is REQUIRED, and this STS only exchanges its
		// own access tokens. Recognized-but-unimplemented parameters fail closed.
		if (subjectTokenType !== ACCESS_TOKEN_TYPE) {
			return oauthErrorResponse(
				400,
				OAuthErrorCode.InvalidRequest,
				"subject_token_type must be urn:ietf:params:oauth:token-type:access_token.",
			);
		}
		if (form.get("actor_token") !== null) {
			return oauthErrorResponse(
				400,
				OAuthErrorCode.InvalidRequest,
				"actor_token is not supported.",
			);
		}
		const requestedTokenType = form.get("requested_token_type");
		if (requestedTokenType !== null && requestedTokenType !== ACCESS_TOKEN_TYPE) {
			return oauthErrorResponse(
				400,
				OAuthErrorCode.InvalidRequest,
				"Only access-token exchange is supported.",
			);
		}
		const resource = form.get("resource");
		const target = resource === null ? undefined : this.#matchResource(resource);
		if (target === undefined) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidTarget, "A valid resource is required.");
		}
		// Token exchange is machine-to-machine: only an authenticated confidential
		// client may act as the exchanging party.
		const client = await this.#resolveClient(presentedClientId);
		if (client === undefined || client.tokenEndpointAuthMethod === "none") {
			return oauthErrorResponse(
				400,
				OAuthErrorCode.InvalidClient,
				"Token exchange requires a confidential client.",
			);
		}
		const authFailure = this.#authenticateClient(request, form, client);
		if (authFailure !== undefined) return authFailure;
		let subject;
		try {
			subject = await this.#verifier.verifyAccessToken(subjectToken);
		} catch {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "Invalid subject_token.");
		}
		const gid = grantIdFromAuthInfo(subject);
		if (gid === undefined) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "subject_token has no grant.");
		}
		const grant = decodeRecord<McpGrantRecord>(
			await this.#tokenStore.get(recordKey(this.#issuerFp, "grant", gid)),
		);
		if (grant === undefined) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "Grant not found.");
		}
		// The target must stay within the resource the user actually consented to,
		// so exchange cannot hop to a sibling resource the grant never covered.
		if (!checkResourceAllowed({ requestedResource: target, configuredResource: grant.resource })) {
			return oauthErrorResponse(
				400,
				OAuthErrorCode.InvalidTarget,
				"resource is outside the grant's consented resource.",
			);
		}
		// Scope is bound to the PRESENTED token, not the whole grant: a down-scoped
		// subject token cannot be re-widened by exchange. The grant bound is kept
		// as defense in depth against a stale token whose grant was later narrowed.
		const requestedScope = form.get("scope");
		const scope =
			requestedScope === null
				? subject.scopes
				: requestedScope.split(" ").filter((entry) => entry.length > 0);
		if (!scope.every((entry) => subject.scopes.includes(entry) && grant.scope.includes(entry))) {
			return oauthErrorResponse(
				400,
				OAuthErrorCode.InvalidScope,
				"Requested scope exceeds the subject token.",
			);
		}
		const now = Math.floor(this.#now() / 1_000);
		// Never let an exchanged token outlive its subject token — this breaks the
		// exchange→exchange renewal chain that would otherwise turn a leaked
		// short-lived token into indefinitely renewable access.
		const exp = Math.min(now + this.#ttl.accessTokenSeconds, subject.expiresAt ?? 0);
		if (exp <= now) {
			return oauthErrorResponse(400, OAuthErrorCode.InvalidGrant, "subject_token is expired.");
		}
		const accessToken = signMcpAccessToken(this.#ring, {
			iss: this.#issuer,
			aud: target,
			sub: grant.subject,
			client_id: presentedClientId,
			scope: scope.join(" "),
			gid,
			iat: now,
			nbf: now,
			exp,
			jti: randomToken(16),
			...(grant.tenantId === undefined ? {} : { tid: grant.tenantId }),
		});
		return jsonResponse(200, {
			access_token: accessToken,
			issued_token_type: ACCESS_TOKEN_TYPE,
			token_type: "Bearer",
			expires_in: exp - now,
			scope: scope.join(" "),
		});
	}

	async #issueTokens(grant: McpGrantRecord, scope: readonly string[]): Promise<Response> {
		const now = Math.floor(this.#now() / 1_000);
		const exp = now + this.#ttl.accessTokenSeconds;
		const accessToken = signMcpAccessToken(this.#ring, {
			iss: this.#issuer,
			aud: grant.resource,
			sub: grant.subject,
			client_id: grant.clientId,
			scope: scope.join(" "),
			gid: grant.grantId,
			iat: now,
			nbf: now,
			exp,
			jti: randomToken(16),
			...(grant.tenantId === undefined ? {} : { tid: grant.tenantId }),
		});
		const refreshHandle = randomToken();
		const refreshRecord: McpRefreshRecord = {
			grantId: grant.grantId,
			generation: grant.generation,
			clientId: grant.clientId,
		};
		await this.#tokenStore.set(
			recordKey(this.#issuerFp, "refresh", sha256Base64Url(refreshHandle)),
			encodeRecord(refreshRecord),
			{ ttlSeconds: this.#ttl.refreshTokenSeconds },
		);
		return jsonResponse(200, {
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: this.#ttl.accessTokenSeconds,
			refresh_token: refreshHandle,
			scope: scope.join(" "),
		});
	}

	#authenticateClient(
		request: Request,
		form: URLSearchParams,
		client: McpOAuthClient,
	): Response | undefined {
		if (client.tokenEndpointAuthMethod === "none") return undefined;
		if (client.tokenEndpointAuthMethod === "private_key_jwt") {
			return oauthErrorResponse(
				400,
				OAuthErrorCode.InvalidClient,
				"Unsupported client authentication method.",
			);
		}
		const credentials = extractClientCredentials(request, form);
		if (
			credentials === undefined ||
			client.clientSecretHash === undefined ||
			credentials.clientId !== client.clientId ||
			!verifyClientSecret(credentials.clientSecret, client.clientSecretHash)
		) {
			return oauthErrorResponse(
				401,
				OAuthErrorCode.InvalidClient,
				"Client authentication failed.",
				{ "www-authenticate": 'Basic realm="oauth"' },
			);
		}
		return undefined;
	}

	async #resolveClient(clientId: string): Promise<McpOAuthClient | undefined> {
		if (this.#cimd !== undefined && isClientIdMetadataUrl(clientId)) {
			try {
				const metadata = await this.#cimd.resolve(clientId);
				return {
					clientId: metadata.clientId,
					clientName: metadata.clientName,
					redirectUris: metadata.redirectUris,
					tokenEndpointAuthMethod: metadata.tokenEndpointAuthMethod,
					loopbackOnly: metadata.loopbackOnly,
					source: "cimd",
				};
			} catch {
				return undefined;
			}
		}
		if (this.#clientResolver !== undefined) {
			return this.#clientResolver.resolveClient(clientId);
		}
		return undefined;
	}

	#matchResource(resource: string): string | undefined {
		let url: URL;
		try {
			url = new URL(resource);
		} catch {
			return undefined;
		}
		// RFC 8707 resource identifiers carry no fragment; reject every component
		// `checkResourceAllowed` ignores (fragment, query, userinfo) so the returned
		// audience is canonical for the equivalence class the check validated —
		// otherwise a query/userinfo could ride into `aud` unchecked.
		if (url.hash !== "" || url.search !== "" || url.username !== "" || url.password !== "") {
			return undefined;
		}
		const canonical = url.href;
		// Bind the token to the exact requested resource when it is allowed by a
		// configured resource — not the configured parent, so a sub-resource request
		// yields a sub-resource-scoped audience.
		const allowed = this.#resources.some((configured) =>
			checkResourceAllowed({ requestedResource: canonical, configuredResource: configured }),
		);
		return allowed ? canonical : undefined;
	}

	#callbackUrl(): string {
		return new URL(`${this.#basePath}/oauth/callback`, this.#issuer).href;
	}
}

function extractClientCredentials(
	request: Request,
	form: URLSearchParams,
): { readonly clientId: string; readonly clientSecret: string } | undefined {
	const authorization = request.headers.get("authorization");
	if (authorization !== null && authorization.toLowerCase().startsWith("basic ")) {
		try {
			const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
			const index = decoded.indexOf(":");
			if (index > 0) {
				return {
					clientId: decodeURIComponent(decoded.slice(0, index)),
					clientSecret: decodeURIComponent(decoded.slice(index + 1)),
				};
			}
		} catch {
			return undefined;
		}
	}
	const clientId = form.get("client_id");
	const clientSecret = form.get("client_secret");
	if (clientId !== null && clientSecret !== null) return { clientId, clientSecret };
	return undefined;
}

function grantIdFromAuthInfo(authInfo: {
	readonly extra?: Record<string, unknown>;
}): string | undefined {
	const claims = authInfo.extra?.["claims"];
	if (typeof claims !== "object" || claims === null) return undefined;
	const gid = Reflect.get(claims, "gid");
	return typeof gid === "string" && gid.length > 0 ? gid : undefined;
}

function clientIdFrom(request: Request, form: URLSearchParams): string | undefined {
	const credentials = extractClientCredentials(request, form);
	if (credentials !== undefined) return credentials.clientId;
	return form.get("client_id") ?? undefined;
}

function defaultSubjectResolver(
	tokens: OAuthTokens,
	context: McpUpstreamSubjectContext,
): { subject: string; tenantId?: string } {
	const idToken = Reflect.get(tokens, "id_token");
	if (typeof idToken !== "string") {
		throw new McpOAuthConfigError(
			"INVALID_OPTIONS",
			"Upstream returned no id_token; configure resolveUpstreamSubject for non-OIDC providers.",
		);
	}
	const claims = decodeJwtPayload(idToken);
	// The id_token arrives directly from the validated token endpoint over TLS, so
	// signature verification follows the OIDC §3.1.3.7 exemption; still bind the
	// claims to the expected upstream so a swapped token cannot set the subject.
	if (claims["iss"] !== context.upstreamIssuer) {
		throw new McpOAuthConfigError("INVALID_OPTIONS", "Upstream id_token issuer mismatch.");
	}
	if (!audienceIncludes(claims["aud"], context.upstreamClientId)) {
		throw new McpOAuthConfigError("INVALID_OPTIONS", "Upstream id_token audience mismatch.");
	}
	const exp = claims["exp"];
	if (typeof exp !== "number" || exp <= Math.floor(context.now() / 1_000) - 120) {
		throw new McpOAuthConfigError("INVALID_OPTIONS", "Upstream id_token is expired.");
	}
	const sub = claims["sub"];
	if (typeof sub !== "string" || sub.length === 0) {
		throw new McpOAuthConfigError("INVALID_OPTIONS", "Upstream id_token has no subject.");
	}
	const tid = claims["tid"];
	return { subject: sub, ...(typeof tid === "string" ? { tenantId: tid } : {}) };
}

function audienceIncludes(aud: unknown, clientId: string): boolean {
	if (typeof aud === "string") return aud === clientId;
	if (Array.isArray(aud)) return aud.includes(clientId);
	return false;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const segment = token.split(".")[1];
	if (segment === undefined) return {};
	try {
		const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return { ...parsed };
	} catch {
		return {};
	}
}

/** Maps an upstream error code to a safe redirected OAuth error. */
function sanitizeUpstreamError(error: string): string {
	const known = new Set([
		"access_denied",
		"invalid_request",
		"invalid_scope",
		"server_error",
		"temporarily_unavailable",
		"unauthorized_client",
		"unsupported_response_type",
	]);
	return known.has(error) ? error : "server_error";
}

/** JSON `temporarily_unavailable` (token endpoint) for a storage/backend fault. */
function storeFaultResponse(_error: unknown): Response {
	return oauthErrorResponse(
		503,
		OAuthErrorCode.TemporarilyUnavailable,
		"The authorization server is temporarily unable to process the request.",
		{ "retry-after": "5" },
	);
}

/** Rendered `temporarily_unavailable` (browser endpoints) for a storage/backend fault. */
function renderStoreFault(_error: unknown): Response {
	return renderErrorResponse(
		503,
		"temporarily_unavailable",
		"The authorization server is temporarily unable to process the request.",
	);
}

function hostOf(value: string): string {
	try {
		return new URL(value).host;
	} catch {
		return value;
	}
}

function normalizeBasePath(basePath: string | undefined): string {
	if (basePath === undefined || basePath === "" || basePath === "/") return "";
	const trimmed = basePath.startsWith("/") ? basePath : `/${basePath}`;
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function definedTtl(ttl: McpOAuthProxyTtl | undefined): Partial<McpOAuthProxyTtl> {
	if (ttl === undefined) return {};
	const result: Record<string, number> = {};
	for (const [key, value] of Object.entries(ttl)) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) result[key] = value;
	}
	return result;
}
