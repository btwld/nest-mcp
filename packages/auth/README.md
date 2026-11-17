# @nest-mcp/auth

Framework-neutral OAuth toolkit for [Model Context Protocol](https://modelcontextprotocol.io) v2
servers. It targets the stateless 2026-07-28 revision and builds on
`@modelcontextprotocol/{client,core,server}` v2 as peer dependencies.

> Alpha. Ships both the resource-server building blocks (Client ID Metadata Document resolution,
> token storage, JWT issuing/verification) and the OAuth 2.1 authorization-server proxy
> (`McpOAuthProxy`: authorize/consent/callback/token with two-tier PKCE, refresh rotation, and
> upstream token swap), durable/encrypted stores, and RFC 8693 token exchange.

## Install

```sh
pnpm add @nest-mcp/auth@alpha @modelcontextprotocol/client@2 @modelcontextprotocol/core@2 @modelcontextprotocol/server@2
# jose is an optional peer, needed only for createJwksTokenVerifier
pnpm add jose
```

## Exports

| Entry       | Contents                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `.`         | JWT key ring + issuer/verifier, proxy and JWKS `OAuthTokenVerifier`s, principal-claims projection, errors |
| `./cimd`    | Client ID Metadata Document resolver and the SSRF-hardened document, OAuth, and streaming fetchers        |
| `./stores`  | `McpOAuthStore` contract and the bounded in-memory implementation                                         |
| `./testing` | An ephemeral signing ring and access-token minter for tests                                               |

`./cimd` and `./stores` never import `@nest-mcp/server` or `@modelcontextprotocol/server`, so a
gateway or client host can adopt CIMD validation or the storage contract on its own.

## Client ID Metadata Documents

CIMD (SEP-991) replaces Dynamic Client Registration for 2026-07-28. A `client_id` is an HTTPS URL
whose document describes the client. Resolution is strict and SSRF-hardened:

```ts
import { createMcpClientIdMetadataResolver } from "@nest-mcp/auth/cimd";

const resolver = createMcpClientIdMetadataResolver({
	allowedHosts: [".apps.example.com"], // optional trust policy
	maxDocumentBytes: 8_192,
});

const metadata = await resolver.resolve("https://app.example.com/oauth/client.json");
```

- URL admission (before any network I/O): HTTPS only, path required, no dot-segments/fragment/userinfo,
  no query by default, bounded length, IP-literal and host-allowlist checks.
- The fetcher uses `node:https` with a connection-time `lookup` hook, so the addresses validated are
  exactly the addresses connected to — no DNS-rebinding window, no `undici` dependency. Redirects are
  never followed; loopback, private, link-local (incl. `169.254.169.254`), NAT64, 6to4, and
  IPv4-mapped IPv6 ranges are blocked.
- Successful documents are cached (LRU, TTL clamped, `no-store` honored). Failures are never cached;
  repeated failures open a per-host circuit breaker.

## Guarded outbound transports

Three fetchers share one scheme/host policy and one connect-time `lookup` hook, so a URL is judged
by identical rules whichever one carries it:

| Export                            | Body handling                          | Use for                                            |
| --------------------------------- | -------------------------------------- | -------------------------------------------------- |
| `createNodeDocumentFetcher`       | Buffered, hard byte cap                | CIMD documents                                     |
| `createSsrfGuardedFetch`          | Buffered (256 KiB), hard total timeout | OAuth discovery and token endpoints                |
| `createStreamingSsrfGuardedFetch` | Streamed `ReadableStream`              | MCP HTTP transports, including `text/event-stream` |

All three accept the same two policy switches, both fail-closed (unset preserves the historical
behavior — https only, any host outside the blocked ranges):

- `allowedHosts` — exact hostnames, compared after normalization (lowercased, one trailing dot
  removed, IPv6 brackets stripped). `normalizeGuardedHost` is exported for hosts that keep their own
  list.
- `allowLoopbackHttp` — permits `http:` to a host whose **every** resolved address is loopback
  (127.0.0.0/8 or `::1`); a mixed answer set still fails, `https:` keeps blocking loopback, and
  `::ffff:127.0.0.1` is deliberately not loopback. `isLoopbackAddress` is exported.

### Streaming transport fetch

`createStreamingSsrfGuardedFetch` is a complete `FetchLike`, so it drops straight into
`McpHttpClientTransportDefinition.fetch` (or `StreamableHTTPClientTransport`'s `fetch`) with no cast:

```ts
import { createStreamingSsrfGuardedFetch } from "@nest-mcp/auth/cimd";

const fetch = createStreamingSsrfGuardedFetch({
	allowedHosts: ["mcp.example.com"],
	idleTimeoutMs: 300_000,
});
```

It keeps the connect-time DNS pinning, blocked-range predicate, SNI pinning, and forced
`accept-encoding: identity` of the buffering fetch, is `redirect: "manual"` by construction (a 3xx is
rejected, never followed), and hands back a live body:

- `maxResponseBytes` (default 4 MiB) is a running total for ordinary responses, also checked against
  a declared `Content-Length` before a byte is read.
- `maxSseEventBytes` (default 1 MiB) replaces it for `text/event-stream`: the budget is **per event**
  (CR/LF/CRLF framing, reset at each blank line) with no total cap, so a healthy session can stream
  for as long as it lives.
- `idleTimeoutMs` (default 5 minutes) bounds the gap between bytes while the body is being read.

Any violation errors the stream and destroys the connection. Requests may carry the body shapes the
transport and the OAuth helpers send — a JSON string, `URLSearchParams`, raw bytes, `Blob`,
`FormData`, or a `ReadableStream`.

### Admit before you decrypt

For hosts that must reject an endpoint before unsealing the credential it would have carried,
admission is a separate step. `admitMcpHttpEndpoint` resolves and judges the endpoint once;
`openGuardedFetch` then binds a lease whose sockets replay only those pinned answers:

```ts
import { admitMcpHttpEndpoint, openGuardedFetch } from "@nest-mcp/auth/cimd";

const admitted = await admitMcpHttpEndpoint(endpoint, { allowedHosts, allowLoopbackHttp: false });
const { fetch, close } = openGuardedFetch(admitted); // decrypt the token only past this line
try {
	/* … */
} finally {
	await close();
}
```

Every request on the lease must stay on the admitted origin, and the record itself is not forgeable:
`openGuardedFetch` refuses an object this module did not admit.

## Tokens

Mint and verify RFC 9068 `at+jwt` access tokens with a key ring. EdDSA is the default so replicas and
resource servers share only a public key:

```ts
import {
	createMcpTokenKeyRing,
	generateMcpSigningKey,
	createMcpProxyTokenVerifier,
} from "@nest-mcp/auth";

const ring = createMcpTokenKeyRing({ keys: [generateMcpSigningKey("EdDSA")] });
const verifier = createMcpProxyTokenVerifier({
	ring,
	issuer: "https://mcp.example.com",
	resources: ["https://mcp.example.com/mcp"],
});
```

`verifier` satisfies the SDK `OAuthTokenVerifier` contract, so it drops straight into
`McpResourceServer` (or the Nest `oauth.resource` group). The verifier pins the signature algorithm
from the resolved key — never the token header — and projects only allowlisted `{sub, tid}` claims.

For servers fronting an external authorization server, `createJwksTokenVerifier` validates tokens
against a remote JWKS (requires `jose`).

## Storage

`McpOAuthStore` is a bounded, TTL-first contract that maps one-to-one onto Redis primitives
(`GET`/`SET EX`/`SET NX EX`/`GETDEL`/`DEL`) with no scan operations, so a distributed adapter needs
no API change. Implementations compose:

- `McpMemoryOAuthStore` — bounded in-memory; rejects writes at capacity rather than evicting live records.
- `McpDiskOAuthStore` — single-node filesystem persistence with an atomic, cross-process `take`.
- `withEncryptedValues(store, { keys })` — AES-256-GCM at rest with key rotation; the AEAD binds each
  ciphertext to its key id and storage key so records cannot be relocated.

```ts
import { McpDiskOAuthStore, withEncryptedValues } from "@nest-mcp/auth/stores";

const store = withEncryptedValues(new McpDiskOAuthStore({ directory: "/var/lib/mcp-oauth" }), {
	keys: [{ id: "2026-02", secret: process.env.OAUTH_STORE_KEY! }],
});
```

## Authorization-server proxy

`McpOAuthProxy` fronts a real upstream IdP, holding upstream tokens server-side and minting its own
audience-scoped access tokens. The upstream leg reuses the official `@modelcontextprotocol/client`
OAuth helpers (discovery, PKCE, RFC 9207 `iss` validation) through `McpUpstreamAdapter`; provider
presets (`googleUpstream`, `githubUpstream`, `azureUpstream`, `genericUpstream`) supply the issuer,
scopes, and quirks. Compose it as a fetch facade with `McpOAuthServer`, or serve it in NestJS via
`McpOAuthControllerFor` and the `oauth.proxy` option group. See `docs/security-and-oauth.md` for the
threat model and the invariants it enforces.

## NestJS

The `@nest-mcp/nestjs` adapter consumes this package through the per-server `oauth` option group
(`oauth.resource` for resource-server protection, `oauth.proxy` for the authorization-server proxy).
See `@nest-mcp/nestjs` and `docs/security-and-oauth.md`.
