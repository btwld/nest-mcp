export { McpClientIdMetadataError, McpOAuthConfigError } from "./mcp-oauth.errors.ts";
export type { McpClientIdMetadataFailure, McpOAuthConfigErrorCode } from "./mcp-oauth.errors.ts";

export {
	createMcpTokenKeyRing,
	generateMcpSigningKey,
	McpAccessTokenError,
	signMcpAccessToken,
	verifyMcpAccessToken,
} from "./jwt/issuer.ts";
export type {
	McpAccessTokenClaims,
	McpAccessTokenVerifyFailure,
	McpAccessTokenVerifyOptions,
	McpTokenKeyRing,
	McpTokenKeyRingOptions,
	McpTokenSigningAlgorithm,
	McpTokenSigningKey,
	McpTokenSigningKeyInput,
} from "./jwt/issuer.ts";

export { createJwksTokenVerifier, createMcpProxyTokenVerifier } from "./mcp-oauth-verifier.ts";
export type {
	McpJwksTokenVerifierOptions,
	McpProxyTokenVerifierOptions,
} from "./mcp-oauth-verifier.ts";

export { createMcpOAuthPrincipalClaims } from "./mcp-oauth-principal.ts";
export type {
	McpOAuthPrincipalClaims,
	McpOAuthPrincipalClaimsOptions,
} from "./mcp-oauth-principal.ts";

export { McpOAuthSecretKeyring } from "./crypto/secrets.ts";
export { buildMcpAuthorizationServerMetadata } from "./mcp-oauth-metadata.ts";
export type { McpAuthorizationServerMetadataInput } from "./mcp-oauth-metadata.ts";
export { McpUpstreamAdapter } from "./upstream/mcp-oauth-upstream.ts";
export type {
	McpUpstreamAdapterOptions,
	McpUpstreamAuthorizationServer,
} from "./upstream/mcp-oauth-upstream.ts";
export {
	azureUpstream,
	genericUpstream,
	githubUpstream,
	googleUpstream,
} from "./providers/index.ts";
export type {
	McpAzurePresetInput,
	McpGenericPresetInput,
	McpUpstreamPresetInput,
} from "./providers/index.ts";
export { hashClientSecret, verifyClientSecret } from "./proxy/client-secret.ts";
export { McpOAuthProxy } from "./proxy/mcp-oauth-proxy.ts";
export type {
	McpOAuthProxyOptions,
	McpOAuthProxyTtl,
	McpUpstreamSubjectResolver,
} from "./proxy/mcp-oauth-proxy.ts";
export type { McpOAuthClient, McpOAuthClientResolver } from "./proxy/http.ts";
export { renderDefaultConsent } from "./proxy/consent.ts";
export type { McpConsentRenderer, McpConsentViewModel } from "./proxy/consent.ts";
export { createMcpOAuthRouter } from "./mcp-oauth-router.ts";
export type { McpOAuthRouter, McpOAuthRouterOptions } from "./mcp-oauth-router.ts";
export { McpOAuthServer } from "./mcp-oauth-server.ts";
export type { McpOAuthServerOptions } from "./mcp-oauth-server.ts";

// Convenience re-exports so the main entry has the full proxy-wiring surface.
// The ./cimd and ./stores subpaths remain independently importable and never
// pull in @nest-mcp/server.
export { createSsrfGuardedFetch } from "./cimd/ssrf-fetch.ts";
export type {
	McpFetchLike,
	McpGuardedHostPolicyOptions,
	McpSsrfGuardedFetchOptions,
} from "./cimd/ssrf-fetch.ts";
export {
	admitMcpHttpEndpoint,
	createStreamingSsrfGuardedFetch,
	MCP_STREAM_IDLE_TIMEOUT_MS,
	MCP_STREAM_MAX_RESPONSE_BYTES,
	MCP_STREAM_MAX_SSE_EVENT_BYTES,
	openGuardedFetch,
} from "./cimd/streaming-fetch.ts";
export type {
	McpAdmittedHttpEndpoint,
	McpEndpointAdmissionPolicy,
	McpGuardedFetchLease,
	McpGuardedFetchLeaseOptions,
	McpStreamingFetchLike,
	McpStreamingSsrfGuardedFetchOptions,
} from "./cimd/streaming-fetch.ts";
export {
	createMcpClientIdMetadataResolver,
	isClientIdMetadataUrl,
} from "./cimd/client-id-metadata.ts";
export type {
	McpClientIdMetadata,
	McpClientIdMetadataResolver,
	McpClientIdMetadataResolverOptions,
} from "./cimd/client-id-metadata.ts";
export { McpMemoryOAuthStore, McpOAuthStoreCapacityError } from "./stores/memory-store.ts";
export type { McpMemoryOAuthStoreOptions } from "./stores/memory-store.ts";
export {
	McpDiskOAuthStore,
	McpOAuthStoreDecryptError,
	withEncryptedValues,
} from "./stores/index.ts";
export type {
	McpDiskOAuthStoreOptions,
	McpEncryptedStoreOptions,
	McpOAuthEncryptionKey,
} from "./stores/index.ts";
export type {
	McpOAuthStore,
	McpOAuthStoreMaintenance,
	McpOAuthStoreWriteOptions,
} from "./stores/store.types.ts";
