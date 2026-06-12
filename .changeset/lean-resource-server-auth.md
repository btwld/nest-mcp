---
'@nest-mcp/server': minor
'@nest-mcp/common': minor
---

**BREAKING: auth layer is now resource-server-only (MCP authorization spec 2025-06-18).**

The embedded OAuth authorization server (`/authorize`, `/token`, `/register`, `/revoke`, `/introspect`, HS256 JWT issuance, GitHub/Azure provider adapters) has been removed. `@nest-mcp/server` now implements exactly the spec-required resource-server role: bearer-token verification with default-on audience validation, RFC 9728 protected-resource metadata, SDK-compatible `WWW-Authenticate` challenges, and session↔principal binding. Token issuance belongs to an external authorization server (Auth0, Keycloak, …) or your own user-land AS — see `docs/server/auth.md` for recipes.

### New API

```ts
McpAuthModule.forRoot({
  resource: 'https://mcp.example.com/mcp',
  authorizationServers: ['https://tenant.auth0.com'],
  jwks: { uri: '…/.well-known/jwks.json', issuer: '…', audience: '…' }, // or `introspection` or `verifier`
});
```

New exports: `McpBearerGuard`, `McpAuthenticatedGuard`, `JwksVerifier` (optional `jose` peer dep), `IntrospectionVerifier`, `MCP_RESOURCE_SERVER_OPTIONS`, `canonicalizeResourceUri`, `McpResourceServerOptions`/`McpResourceServerAsyncOptions`, `JwksVerifierOptions`/`IntrospectionVerifierOptions`. The SSE transport can now be gated too (`transportOptions.sse.oauth.enabled`) — previously it accepted unauthenticated traffic even when OAuth was configured.

### Removed → replacement

| Removed | Replacement |
| --- | --- |
| `McpAuthModuleOptions` (`jwtSecret`, `validateUser`, …) | `McpResourceServerOptions` (`resource`, `authorizationServers`, verifier config) |
| `McpAuthModule.forProvider`, `GitHubProvider`, `AzureAdProvider`, `OAuthCodeExchangeProvider` | External IdP via `jwks`/`introspection` (recipe A in docs) |
| `JwtTokenService`, `MCP_AUTH_OPTIONS`, `TokenPayload`, `TokenResponse` | Your AS issues tokens (recipe C) |
| `OAuthClientService`, `MCP_OAUTH_STORE`, `IOAuthStore`, `MemoryOAuthStore`, `OAuthClient`, `AuthorizationCode` | Client registration/storage is the AS's concern |
| `JwtBearerTokenVerifier` | `JwksVerifier`, `IntrospectionVerifier`, or a custom `BearerTokenVerifier` |
| `JwtAuthGuard` | `McpAuthenticatedGuard` (requires a verified principal; the old header-parsing fallback skipped token-type/revocation checks and was unsafe) |
| `AuthRateLimitGuard` | `@nestjs/throttler` on your own endpoints |
| `AuthAuditService`, `AuditLogEntry` | Application-level logging/interceptors |
| `IssuedTokenRecord`, `McpAuthModuleAsyncOptions`, `TokenIntrospectionResponse` | Gone with the AS (see `McpResourceServerAsyncOptions` for the async options shape) |
| `OAuthProviderAdapter`, `OAuthProviderUser`, `OAuthTokenResponse`, `GitHubProviderConfig`, `GitHubUser`, `AzureAdProviderConfig`, `AzureAdUser` | Gone with the federation adapters (recipe A) |
| `transportOptions.streamableHttp.oauth.resourceMetadataUrl` | Derived from `resource` (path-insertion form, correct scheme) |
| `transportOptions.streamableHttp.oauth.required` | `McpAuthModule.forRoot({ required })` |

### Behavior changes

- 401/403 responses now carry RFC 6749 bodies (`{"error":"invalid_token", …}`) and the SDK `requireBearerAuth` challenge format `WWW-Authenticate: Bearer error="…", error_description="…"[, scope="…"], resource_metadata="…"` (the old format was `Bearer realm="mcp", resource_metadata="…"` with a JSON-RPC body). Official SDK clients parse the new format natively.
- With `required: false`, a request with a present-but-invalid token is now rejected with 401 (previously it passed through anonymously). Anonymous requests (no header) still pass.
- Built-in verifiers enforce token audience against `resource` by default (the spec MUST that was previously skipped); matching is exact after canonicalization — set `jwks.audience` explicitly for other conventions. Tokens without an expiry are rejected, matching the SDK middleware.
- Verifier *infrastructure* failures (JWKS fetch errors, introspection outages) now surface as `500 server_error` instead of `401`, so SDK clients retry instead of discarding tokens and re-authorizing.
- The `resource_metadata` challenge URL uses the configured `resource`'s scheme/host instead of hardcoding `https://` + the `Host` header. The path-insertion metadata route now returns 404 for paths other than the configured resource's path.
- **Global guards now enforce:** a module-level guard (`McpModuleOptions.guards`) returning `false` denies the call with an `AuthorizationError` (previously the return value was silently ignored). `@Public` items are exempt — guards still run for them but cannot deny.
- `McpModule.forRootAsync` now fails at bootstrap when `transportOptions.*.oauth.enabled` differs between the static options object and the factory result — previously a factory-only `oauth.enabled: true` was silently ignored, leaving the endpoint unauthenticated.
- `jsonwebtoken` and `path-to-regexp` dependencies removed; `jose` added as an optional peer dependency (only needed for `JwksVerifier`).
