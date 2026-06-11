---
'@nest-mcp/server': minor
'@nest-mcp/common': minor
---

feat: OAuth/transport hardening for the streamable HTTP transport and `McpAuthModule`

**Behavioral callout — per-request auth context.** Handler and guard contexts
on the streamable HTTP transport are now rebuilt per request from the SDK's
`RequestHandlerExtra`: `ctx.request` is the per-request `RequestInfo`
(`{ headers }`) instead of the session's *initialize* `IncomingMessage`.
Code reading `ctx.request.url` / `ctx.request.method` must migrate to header
inspection (or a controller guard); previously those values were stale
captures from the first request of the session anyway. `ctx.authInfo` and
`ctx.user` are likewise populated from the verified per-request identity.

Streamable HTTP transport:

- `transportOptions.streamableHttp.oauth` — opt-in bearer-token gate
  (`enabled`, `required`, `resourceMetadataUrl`, `bindSessionToUser`).
  Unauthorized requests get HTTP 401 with a `WWW-Authenticate: Bearer ...
  resource_metadata="..."` challenge (RFC 9728 discovery flow). Tokens are
  verified via the overridable `MCP_BEARER_TOKEN_VERIFIER` provider
  (`BearerTokenVerifier` interface, default `JwtBearerTokenVerifier`).
- Session binding: when oauth is enabled, stateful sessions are bound to the
  principal that initialized them; requests from another principal get 403.
  Only active with `oauth.enabled` — existing stateful servers are unaffected.
- DNS-rebinding options forwarded to the SDK transport: `allowedHosts`,
  `allowedOrigins`, `enableDnsRebindingProtection`.
- `controllerGuards` / `controllerDecorators` applied to the generated
  controller (static even with `forRootAsync`, like `endpoint`).
- `filterListsByScopes` McpModule option: `tools/resources/templates/prompts`
  list results hide items whose required scopes the caller's token lacks.

`McpAuthModule` / OAuth server:

- `McpAuthModule.forRootAsync({ imports?, serverUrl?, useFactory, inject? })`
  with the same `jwtSecret` validation as `forRoot`; the well-known controller
  now constructor-injects `MCP_AUTH_OPTIONS`. `MCP_OAUTH_STORE` is provided
  via a factory in both variants, so a store supplied through options/DI wins
  over the in-memory default.
- Well-known compliance: `introspection_endpoint` (+
  `introspection_endpoint_auth_methods_supported`,
  `revocation_endpoint_auth_methods_supported`) in the RFC 8414 document, and
  path-insertion wildcard routes for both
  `/.well-known/oauth-authorization-server/*` and
  `/.well-known/oauth-protected-resource/*` (Nest 10 and 11 wildcard syntax
  both supported).
- RFC 8707 audience binding: access tokens carry
  `aud = resource ?? audience ?? 'mcp-client'`; `validateToken` still does not
  enforce `aud` (non-breaking). Access tokens now also carry a `jti`, making
  them individually revocable.
- Optional `IOAuthStore.recordIssuedToken(rec)` hook invoked for both tokens
  on the initial grant and on refresh, enabling issued-token tracking and
  refresh-chain revocation; revoked refresh `jti`s are rejected before reuse.
- New exports: `resolveGuard`, `McpAuthModuleAsyncOptions`,
  `IssuedTokenRecord` (plus the new transport option types via
  `@nest-mcp/common`).

Requires `@modelcontextprotocol/sdk` peer `^1.26.0` (per-request `authInfo`
and `requestInfo` on `RequestHandlerExtra`).

Fix: refresh tokens now carry the `scope` claim, so access tokens re-minted by
the `refresh_token` grant preserve the originally granted scopes (previously
they came back scope-less and failed every scope check).
