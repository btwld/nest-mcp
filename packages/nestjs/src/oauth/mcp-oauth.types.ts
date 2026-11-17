import type { AuthInfo, OAuthMetadata, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import type { MaybePromise } from "@nest-mcp/core";
import type {
	McpConsentRenderer,
	McpFetchLike,
	McpOAuthClientResolver,
	McpOAuthProxyTtl,
	McpOAuthStore,
	McpTokenKeyRing,
	McpUpstreamAuthorizationServer,
	McpUpstreamSubjectResolver,
} from "@nest-mcp/auth";
import type { McpProviderToken } from "../mcp-provider.types.ts";

/** Verifies a bearer access token; mirrors the SDK `OAuthTokenVerifier` contract. */
export interface McpOAuthTokenVerifierProvider extends OAuthTokenVerifier {}

/**
 * Fail-closed anonymous admission. Consulted only after bearer verification
 * refuses a request; returning an `AuthInfo` admits the request under that
 * identity, `undefined` preserves the original `401`/`403`.
 */
export interface McpAnonymousAccessPolicy {
	permit(request: Request): MaybePromise<AuthInfo | undefined>;
}

/** RFC 9728/8414 discovery metadata to publish alongside a protected resource. */
export interface McpNestOAuthMetadataOptions {
	/** Authorization-server metadata (RFC 8414) of the IdP this server trusts. */
	readonly oauthMetadata: OAuthMetadata;
	readonly serviceDocumentationUrl?: string;
	readonly scopesSupported?: readonly string[];
	readonly resourceName?: string;
}

export interface McpNestOAuthResourceOptions {
	/** Public URL of this MCP server; the RFC 9728 `resource` identifier. */
	readonly resourceServerUrl: string;
	readonly requiredScopes?: readonly string[];
	/** Injectable bearer-token verifier (e.g. the proxy's own or a JWKS verifier). */
	readonly verifier: McpProviderToken<McpOAuthTokenVerifierProvider>;
	/** Publish protected-resource + authorization-server metadata. */
	readonly metadata?: McpNestOAuthMetadataOptions;
	/** Injectable fail-closed anonymous fallback; omit to require a valid token. */
	readonly anonymous?: McpProviderToken<McpAnonymousAccessPolicy>;
}

/** Supplies the access-token signing key ring (from a config/secret provider). */
export interface McpOAuthSigningKeyProvider {
	getSigningKeys(): McpTokenKeyRing;
}

/** Supplies the HKDF master secret for cookies, CSRF, and subject pseudonyms. */
export interface McpOAuthSecretProvider {
	getMasterSecret(): Uint8Array | string;
}

/** Supplies the upstream authorization-server configuration (issuer, client, scopes). */
export interface McpOAuthUpstreamProvider {
	getUpstream(): McpUpstreamAuthorizationServer;
}

/** Supplies the consent screen. */
export interface McpOAuthConsentProvider {
	render: McpConsentRenderer;
}

/** Maps upstream tokens to a stable subject for non-OIDC providers. */
export interface McpOAuthSubjectResolverProvider {
	resolveSubject: McpUpstreamSubjectResolver;
}

/** Supplies the SSRF-guarded outbound fetch used for upstream discovery/token calls. */
export interface McpOAuthFetchProvider {
	fetch: McpFetchLike;
}

/** CIMD resolution options for the proxy's `/authorize` client lookup. */
export interface McpNestClientIdMetadataOptions {
	readonly enabled: boolean;
	readonly allowedHosts?: readonly string[];
	readonly maxDocumentBytes?: number;
	readonly fetchTimeoutMs?: number;
}

export interface McpNestOAuthProxyOptions {
	/** This server's own issuer (origin, no trailing slash). */
	readonly issuer: string;
	readonly basePath?: string;
	/** Canonical resource URL(s) the proxy mints tokens for. */
	readonly resources: readonly string[];
	readonly scopesSupported?: readonly string[];
	readonly signingKeys: McpProviderToken<McpOAuthSigningKeyProvider>;
	readonly secret: McpProviderToken<McpOAuthSecretProvider>;
	readonly upstream: McpProviderToken<McpOAuthUpstreamProvider>;
	/** Token/state storage. `McpOAuthStore` is itself the provider (structural). */
	readonly stateStore: McpProviderToken<McpOAuthStore>;
	readonly tokenStore?: McpProviderToken<McpOAuthStore>;
	/** Resolver for preconfigured/registered (non-CIMD) clients. */
	readonly clientResolver?: McpProviderToken<McpOAuthClientResolver>;
	readonly consent?: McpProviderToken<McpOAuthConsentProvider>;
	readonly subjectResolver?: McpProviderToken<McpOAuthSubjectResolverProvider>;
	/** SSRF-guarded outbound fetch for upstream discovery/token calls; defaults to the built-in guard. */
	readonly fetch?: McpProviderToken<McpOAuthFetchProvider>;
	readonly cimd?: McpNestClientIdMetadataOptions;
	readonly ttl?: McpOAuthProxyTtl;
	/** Bearer scopes required to reach the protected MCP handler. */
	readonly requiredScopes?: readonly string[];
	/** Fail-closed anonymous fallback for the resource gate. */
	readonly anonymous?: McpProviderToken<McpAnonymousAccessPolicy>;
}

/** Per-server OAuth configuration group on `McpNestServerDefinition`. */
export interface McpNestServerOAuthOptions {
	/** Resource-server protection (bearer verification + discovery metadata). */
	readonly resource?: McpNestOAuthResourceOptions;
	/** Authorization-server proxy in front of a real upstream IdP. */
	readonly proxy?: McpNestOAuthProxyOptions;
}
