---
"@nest-mcp/auth": minor
"@nest-mcp/server": minor
"@nest-mcp/nestjs": minor
---

Add `@nest-mcp/auth`, a framework-neutral OAuth toolkit for MCP resource servers, and wire it into
the Nest adapter through a per-server `oauth` option group (Phase 1 of the authorization-server
proxy roadmap).

- **`@nest-mcp/auth`**: Client ID Metadata Document resolution (SEP-991) with strict URL admission,
  document validation against `@modelcontextprotocol/core` schemas, and an SSRF-hardened `node:https`
  fetcher that pins DNS at connect time (no `undici` dependency); a bounded, TTL-first
  `McpOAuthStore` contract that maps onto Redis primitives, plus a capacity-rejecting in-memory
  implementation; an asymmetric-by-default (EdDSA/ES256, HS256 for dev) JWT key ring, issuer, and
  verifier with JWKS publication and algorithm pinning; `createMcpProxyTokenVerifier` and
  `createJwksTokenVerifier` (`OAuthTokenVerifier`); and a token-free principal-claims projection.
  Subpaths `./cimd`, `./stores`, and `./testing`; `jose` is an optional peer needed only for JWKS
  verification.
- **`@nest-mcp/server`**: `McpResourceServer` gains an optional fail-closed `anonymous` policy,
  consulted only after bearer verification refuses a request.
- **`@nest-mcp/nestjs`**: `McpNestServerDefinition.oauth.resource` composes `McpResourceServer` bearer
  verification and RFC 9728/8414 metadata around the HTTP handler using injected provider tokens
  (`verifier`, optional `anonymous`), exposed via `McpRuntimeService.composeHttpHandler()` and the
  HTTP controller's default composition seam.

Adds the OAuth 2.1 **authorization-server proxy** in front of a real upstream IdP: `@nest-mcp/auth`
gains `McpOAuthProxy` (authorize → consent → callback → token, refresh rotation with reuse
detection, two-tier PKCE, RFC 8707 resource binding, RFC 9207 `iss` validation via the client SDK),
`createMcpOAuthRouter`, `McpOAuthServer`, `McpUpstreamAdapter` over the official client OAuth
helpers, provider presets (`googleUpstream`/`githubUpstream`/`azureUpstream`/`genericUpstream`), a
bounded `McpMemoryOAuthStore`, and an SSRF-guarded `createSsrfGuardedFetch`. `@nest-mcp/nestjs` adds the
`oauth.proxy` option group (all extensibility via provider tokens — no key material in options),
`McpOAuthControllerFor` (explicit per-endpoint routes, dispatch by handler identity), and
`McpOAuthService.upstreamTokens()` for gateway user-delegation. The proxy holds upstream tokens
server-side and mints its own EdDSA/ES256 access tokens, so the downstream MCP client never receives
an upstream credential. Adversarially reviewed (56-agent workflow); all confirmed findings fixed
before merge.
