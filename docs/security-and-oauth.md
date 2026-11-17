# Security and OAuth

An MCP runtime gives callers access to executable capabilities. Authenticate transports, authorize every logical operation, constrain outbound connectivity, and assume tool metadata and results are untrusted content.

## Separate the roles

OAuth behavior is different on each side of the protocol:

| Runtime role | OAuth responsibility                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Client       | Obtain, store, refresh, and attach a credential for a specific upstream resource                                        |
| Server       | Act as an OAuth resource server: publish protected-resource metadata, verify bearer tokens, and enforce required scopes |
| Gateway      | Authenticate the downstream caller as a resource server, then authenticate independently to each upstream as a client   |

The MCP server should not become a _general_ Authorization Server — issuing credentials from its own user database, hosting password or social login, or standing in as an identity provider. For new deployments, use a dedicated identity provider. A narrower, explicitly-configured **authorization-server proxy** in front of a real IdP is a supported pattern: it holds the upstream tokens server-side and mints its own audience-scoped access tokens, so the MCP client never receives an upstream credential. `@nest-mcp/auth` provides the building blocks (see "Resource-server protection with @nest-mcp/auth" below). The official v1 Authorization Server helpers remain only in the frozen legacy package.

## Client-side authentication

`@nest-mcp/client` passes `authProvider` directly to the official Streamable HTTP transport. Supported provider shapes include:

- a simple bearer-token `AuthProvider` for credentials owned by another secret store;
- an interactive `OAuthClientProvider` with authorization redirect, PKCE verifier, registration, token, and discovery persistence;
- client credentials for service-to-service access;
- private-key JWT client authentication; and
- cross-application assertion exchange.

That pass-through is useful for application-owned service identities. A multi-tenant host with
shared or per-user credentials should use `@nest-mcp/client/oauth` instead. Its strict facade
accepts only pre-provisioned clients, performs RFC 9728 and RFC 8414 discovery in two separately
policy-checked phases, requires exact configured resource and issuer values, requires PKCE S256,
validates RFC 9207 authorization-response issuer identification when advertised or returned, and
pins the discovered endpoints into the single-use callback transaction. It never calls the SDK full-flow orchestrator, never
performs Dynamic Client Registration, and never rediscovers a token endpoint while redeeming an
authorization code.

The strict surface requires a host-supplied guarded fetch and a fail-closed endpoint policy. The
fetch must reject redirects, DNS rebinding and private destinations, excessive response bodies,
and timeouts; policy should additionally constrain exact origins and ports. Re-check the frozen
token endpoint immediately before credentials are added. Keep OAuth network traffic separate from
general MCP fetch middleware because middleware and header-enabled request logging can observe
codes, Basic credentials, token form bodies, and bearer tokens. The guarded fetch must not retry a
credentialed token `POST`: a durable refresh claim authorizes one wire exchange only, and ambiguous
network outcomes must return to the coordinator unchanged.

Client providers must:

- key registrations and credentials by authorization-server issuer;
- bind access-token requests to the protected resource through the RFC 8707 `resource` value when available;
- validate the published resource URL against the MCP destination;
- keep PKCE verifier and OAuth state confidential and single-use;
- validate redirect URIs exactly;
- encrypt durable tokens and client secrets at rest;
- coalesce concurrent refreshes and prevent refresh-token replay; and
- return a fresh transport after an interactive authorization hand-off when required by the SDK flow.

Strict host-managed flows must additionally atomically take a pending transaction by the
domain-separated state digest before inspecting callback success or error values. The transaction
remains consumed after an ambiguous exchange. Persist it with authenticated encryption and bind it
to the browser session, exact issuer/resource/endpoints, provisioned client coordinate, and host
scope/owner/revision. Use `McpClientOAuthRefreshCoordinator` with an exact-revision commit and a
durable pre-dispatch claim so concurrent processes cannot present the same rotating refresh token.
Only the exact claim owner may commit the replacement. Retry-safe pre-dispatch failures may release
the claim; abandoned or indeterminate post-dispatch claims must become terminal and must never
reactivate the old generation. Indeterminate outcomes invalidate the old generation instead of
replaying it, and terminal invalidation evicts credential-bound runtime leases. Successful token
rotation remains inside the same stable binding; if runtime leases are keyed by the token revision,
release and reacquire them rather than pooling across that change. An invalidation hook runs while
the failed operation may still hold its lease: initiate lease retirement and return immediately;
never await draining invalidation from the hook or the operation and lease release can deadlock.

Attach credentials to MCP transports through one `McpClientOAuthAuthProvider` per exact binding and
set `onInsufficientScope: "throw"`. The bridge deliberately lacks the SDK `OAuthClientProvider`
shape, so a `401` can refresh the bound generation but cannot begin registration, redirect a user,
or silently widen scopes. Close the bridge when its credential-bound runtime lease is released.
The SDK callback does not identify the credential revision attached to the failed request, so
concurrent delayed `401` responses cannot be attributed exactly. Credentialed transports should be
close-on-release unless the host supplies request-correlated refresh and revision fencing.

`McpRuntimeManager`'s ordinary online generation is pooled: its keeper means an operation lease
release does not close the credential bridge. That shared mode therefore does not satisfy the
close-on-release alternative by itself. When a host cannot provide request-correlated refresh
fencing, invoke `probe`, `refreshCatalog`, `withClientRuntime`, `callTool`, `readResource`, or
`getPrompt` with `{ leaseMode: "exclusive" }` and do not call `ensureOnline()` for that generation.
The manager gives the operation a unique non-pooled runtime, rejects overlapping same-generation
work, and completes runtime plus admitted-material cleanup before the operation settles. Retirement
still aborts and drains the exclusive lease. Its convenience delegates issue one protocol request;
exclusive catalog refresh serializes its list requests. A `withClientRuntime` callback relying on
this alternative must likewise avoid parallel credentialed requests. Hosts with a request-correlated
fetch boundary and exact revision fence may retain the ordinary shared generation.

The transport may retry once after a `401` when the provider refreshes or completes authorization. Runtime middleware observes one logical call; fetch middleware observes each wire attempt.

Authentication failures are not protocol-era evidence. A `401` or `403` response to `server/discover` must remain an auth error and must not trigger a guess that the server is legacy.

### Passive authentication inspection

`detectMcpClientAuthentication` (`@nest-mcp/client/oauth`) composes the official SDK's protocol
negotiation with the existing guarded OAuth bootstrap. The current
[MCP HTTP transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
uses POST and per-request discovery; the helper also completes the SDK's legacy handshake,
cancels its optional GET stream, and attempts DELETE for any session it creates. A successful
GET or missing `WWW-Authenticate` header cannot prove an anonymous MCP endpoint.

The detector reports `anonymous` only after validated credential-free MCP connection/discovery.
Per-operation authorization may still apply. Under the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
a denied request can lead to protected-resource and issuer metadata discovery; the detector
reports `oauth-required` only when that discovery validates. Unsupported strict-runtime
capabilities and issuer selection remain explicit bootstrap result variants. A bare `401`
supports well-known discovery; a bare `403` or non-Bearer challenge remains indeterminate.
Malformed or unavailable discovery never downgrades authentication to anonymous.

Hosts retain permission, tenant, endpoint, and network admission policy. An exact-endpoint MCP
fetch can be supplied separately from a guarded `discoveryFetch`; neither may inject credentials.
All metadata URLs pass the bootstrap endpoint policy. Reads share an aggregate byte/request
budget and deadline, including SSE framing; remaining bodies, client/transport, and session
cleanup are bounded. The host always releases its admitted network lease, since a helper cannot
forcibly close sockets held by an uncooperative host fetch. Inspection performs no enrollment,
feature invocation, or persistence. Recheck host admission and authorization before creating or
activating a connection; an inspection result is not a permission grant.

## Server-side resource protection

`McpResourceServer` from `@nest-mcp/server/auth` wraps a web-standard MCP handler as a resource
server:

1. Serve RFC 9728 protected-resource metadata and related authorization-server metadata.
2. Verify the bearer token before passing the request to the MCP handler.
3. Validate issuer, signature, expiry/not-before, audience/resource, and required scopes.
4. Pass the resulting `AuthInfo` into the official request context.
5. Project only token-free principal data into Nest MCP operation context.

The safe principal includes OAuth client/scopes/resource metadata by default. When policy must
distinguish end users or tenants behind one client, a framework-neutral server can configure
`principalClaims(authInfo)`; a Nest server references a singleton provider whose
`resolvePrincipalClaims(authInfo)` method performs the same narrow projection. Project only
verified `subject` and `tenantId` strings. Never treat `clientId` as an end-user identity, and never
copy `AuthInfo.extra` wholesale into policy or telemetry context.

Missing, malformed, or expired tokens should return `401 invalid_token`. A valid token missing required scopes should return `403 insufficient_scope`. Both responses should include the correct `WWW-Authenticate: Bearer` challenge and protected-resource metadata URL so a compliant client can begin or step up its OAuth flow.

Do not rely on CORS, a session ID, a client-supplied identity header, or tool arguments as authentication.

### Resource-server protection with @nest-mcp/auth

`@nest-mcp/auth` supplies the framework-neutral pieces a resource server needs, and the Nest adapter
wires them through the per-server `oauth` option group. Every extensibility point is a provider token,
never a raw callback or inline secret:

```ts
McpModule.forRoot({
	collaborators: { providers: [{ provide: TOKEN_VERIFIER, useValue: verifier }] },
	servers: [
		{
			name: "artifact",
			serverInfo: { name: "artifact", version: "1.0.0" },
			oauth: {
				resource: {
					resourceServerUrl: "https://mcp.example.com/mcp",
					requiredScopes: ["mcp:invoke"],
					verifier: TOKEN_VERIFIER, // McpOAuthTokenVerifierProvider
					metadata: { oauthMetadata }, // RFC 8414 AS metadata (no secrets)
					anonymous: ANON_POLICY, // optional, fail-closed
				},
			},
		},
	],
});
```

The verifier is any `OAuthTokenVerifier`: `createMcpProxyTokenVerifier` for tokens the deployment
mints itself, or `createJwksTokenVerifier` for an external IdP. Tokens are RFC 9068 `at+jwt`,
signed with **asymmetric keys by default** (EdDSA/ES256) so replicas and resource servers share only
a public key published at a JWKS endpoint; the verifier pins the signature algorithm from the
resolved key rather than the token header, closing algorithm-confusion downgrades. Access tokens
carry a space-delimited `scope` string, a single audience bound to the RFC 8707 resource, and a
grant id that acts as an instant server-side revocation lever.

The `anonymous` policy is a provider, never a boolean: it is consulted only after bearer verification
refuses a request, and returning `undefined` preserves the original `401`/`403`. Anonymous requests
reach handlers with no principal, so `handlerAuthorization` still fails closed.

### Client ID Metadata Documents (CIMD)

CIMD (SEP-991) is the 2026-07-28 replacement for Dynamic Client Registration: a `client_id` is an
HTTPS URL whose document describes the client. `@nest-mcp/auth/cimd` resolves and validates these
documents with a strict, fail-closed pipeline:

- **URL admission before any I/O**: HTTPS only, path required, no dot-segments (checked on the raw
  string, since `URL` silently resolves them), no fragment/userinfo, no query by default, bounded
  length, and IP-literal/host-allowlist enforcement.
- **SSRF-hardened fetch**: a `node:https` request with a connection-time `lookup` hook validates the
  exact addresses the socket will use, so there is no DNS-rebinding window. Redirects are refused,
  and loopback, RFC 1918/6598, link-local (`169.254.169.254`), NAT64 (`64:ff9b::/96`), 6to4, and
  IPv4-mapped IPv6 ranges are blocked. Responses stream through a hard byte cap.
- **Document validation** via `@modelcontextprotocol/core`'s schemas plus CIMD prohibitions: the
  `client_id` must self-reference, `client_secret*` must be absent, the auth method must be `none` or
  `private_key_jwt`, and redirect URIs must be HTTPS or loopback.
- **Caching**: successful documents are cached (LRU, TTL clamped, `no-store` honored). Failures are
  never cached (per CIMD §4.4); repeated failures open a per-host circuit breaker that rate-limits
  rather than caching an error response.

Because a CIMD `client_id` is a URL, hash it before using it as a metric label to keep telemetry
low-cardinality, and never log the resolved document contents.

### Acting as an authorization-server proxy

`@nest-mcp/auth`'s `McpOAuthProxy` (wired through the Nest `oauth.proxy` option group and served by
`McpOAuthControllerFor`) fronts a real upstream IdP. It holds the upstream tokens server-side and
mints its own audience-scoped access tokens, so the MCP client never receives an upstream
credential. Every extensibility point is a provider token; no key material or client secret appears
in module options (they arrive via a `ConfigService`-backed provider).

Load-bearing invariants (each covered by tests):

- **Token swap, never pass-through.** Issued access tokens are RFC 9068 `at+jwt`, signed with
  asymmetric keys by default (EdDSA/ES256) and published at a JWKS endpoint; the audience is the
  bound RFC 8707 resource, and a `gid` claim ties the token to a server-side grant for revocation.
- **Two-tier PKCE.** The client↔proxy leg requires `S256` (no `plain`, no downgrade) and validates a
  well-formed challenge at `/authorize` and the verifier at `/token`. The proxy↔upstream leg uses its
  own verifier via the SDK; the client's challenge is never forwarded.
- **Single-use, validate-before-consume.** Authorization codes and refresh handles are stored only as
  `sha256(secret)` and consumed with an atomic `take` **after** the presenter is validated, so an
  unauthenticated probe cannot burn a live artifact. A replayed code or reused refresh handle revokes
  the whole grant family (deletes the grant and denies its outstanding access tokens by `gid`).
- **Consent is mandatory and CSRF-protected.** A per-transaction `__Host-` session-binding cookie
  plus a form CSRF token and a strict same-origin check gate the consent POST; the callback verifies
  the session cookie before consuming the transaction. The consent page escapes and normalizes all
  untrusted display text under a strict CSP and never fetches `logo_uri`.
- **Upstream hardening.** Discovery metadata is validated against the configured issuer and an
  endpoint-host policy (issuer host or a true subdomain — no registrable-domain heuristic) before any
  secret is POSTed, and all upstream calls go through the SSRF-guarded fetch. The upstream `id_token`
  is bound by issuer/audience/expiry before its subject seeds the (HKDF-pseudonymized) principal.
- **Fail-closed operations.** Storage capacity or backend faults return `temporarily_unavailable`
  rather than a 500; two proxies sharing an issuer + base path are refused at bootstrap.

The upstream tokens behind a verified access token are reachable via `McpOAuthService.upstreamTokens`
— the credential source for a gateway's user-delegated upstream calls.

**Durable, encrypted storage.** `McpOAuthStore` implementations compose: wrap any store with
`withEncryptedValues({ keys })` for AES-256-GCM at rest (a 128-bit tag pinned at decrypt, and AEAD
additional data binding each ciphertext to its key id and storage key, so records cannot be
relocated), and use `McpDiskOAuthStore` for single-node persistence — owner-only files, a per-key
in-process lock plus `link`-based create so `setIfAbsent` yields a single winner, an atomic
`rename`-based `take`, and a scheduled sweep that reclaims expired records and crash-orphaned staging
files. List the active encryption key first and keep prior keys for decryption to rotate without
downtime; an unknown key id or a failed authentication tag surfaces as a missing record, never as
plaintext. At-rest encryption provides confidentiality, not integrity of _presence_: a store backend
an attacker can write to must be access-controlled (deletion defeats revocation regardless of
encryption). For stores backing security decisions, enable `strict: true` so a present-but-
undecryptable record fails closed instead of reading as absent.

**Token exchange (RFC 8693).** The proxy acts as its own security token service: a confidential,
authenticated client presents a proxy-minted access token as `subject_token` and receives a new
access token for a configured `resource`, with a subset of the grant's scopes and no refresh token.
This is the mechanism a gateway uses to turn a caller's token into an audience-scoped credential for
one upstream — for the upstream _IdP_ tokens themselves, prefer `McpOAuthService.upstreamTokens`,
which never leaves the trust boundary.

## Authorization after authentication

Bearer verification answers “who presented an acceptable credential?” It does not answer “may this caller invoke this capability with these arguments?”

Use `McpAuthorizationPolicy` or the Nest handler policy to decide against:

- principal and tenant;
- runtime role and upstream server;
- method and capability family;
- tool/resource/prompt name;
- resource ownership and data classification;
- requested scopes and policy version; and
- gateway delegation mode.

Nest MCP core enforcement fails closed once a policy is installed. A missing policy passed to the enforcement primitive, thrown policy, malformed decision, or explicit denial raises `McpAuthorizationError` before the terminal handler runs. The runtime cannot infer an application's domain policy, so protected deployments must install authorization explicitly. Keep lifecycle observation outside authorization middleware when denied attempts must be audited.

For expensive or side-effecting tools, authorization should happen both before dispatch and at the domain service that performs the mutation. Do not trust a gateway decision as the only protection on the target service.

### Nest validated handler authorization

For decorated Nest tools, resources, and prompts, configure `handlerAuthorization` with a singleton
provider token whose `authorize()` method implements the policy. The official SDK validates
arguments and resolves the registered callback first; the policy then receives a stable
`McpHandlerInvocationInput` containing the trusted handler kind, name, server name, source, and
validated callback arguments. Its operation context contains the official request method,
cancellation signal, transport kind, and a token-free principal projection for authenticated HTTP
requests.

The execution order is:

1. `handlerLifecycleObserver` starts the payload-free operation event.
2. `handlerAuthorization` makes the mandatory allow/deny decision.
3. `handlerMiddleware` applies application deadlines, concurrency, audit, and other policy.
4. The decorated provider callback runs.

Custom handler middleware cannot short-circuit around `handlerAuthorization`. The same callback pipeline runs for HTTP and stdio, so it is the correct per-tool/resource/prompt authorization seam. Stdio does not create an OAuth principal automatically; authenticate and isolate the process boundary or provide an application identity policy appropriate to that transport.

Catalog exposure runs only after the visibility wave has completed successfully. Search metadata
is opt-in, and lazy list/search or schema-fetch tools receive a frozen projection containing only
the tools visible in that build. Resolver and selector inputs omit handlers, visibility providers,
raw requests, bearer tokens, and provider-specific authentication data. Treat lazy discovery as a
usability optimization only: deferred tools and both lazy meta-tools still enter the ordinary
`handlerAuthorization` pipeline when called. Catalog mode rejects gateway composition and custom
Nest server contributors because those contributors have no public enumeration seam from which a
complete safe projection could be built.

Policies and handler middleware can inspect validated callback arguments because domain authorization may depend on ownership or requested action. Treat that input as sensitive: do not copy it into lifecycle attributes, metric labels, or ordinary logs.

Framework-neutral `McpServerDefinition.middleware` has a narrower purpose: it surrounds an HTTP
exchange before official MCP parsing and does not run for stdio. Nest server configuration accepts
injectable provider tokens for the same layer. Use it for coarse HTTP concerns, not as the sole
authorization boundary for a capability. Likewise, a separately mounted raw Node handler does not
automatically pass through Nest guards or interceptors.

Gateway transforms run after the gateway's mandatory call-time policy. Client transforms have no
implicit authorization policy because the client runtime cannot infer an application's outbound
authorization rules. Exact client transforms are partitioned downstream of every configured general
middleware, so an outbound authorization middleware always precedes them even if listed later.
General transforming middleware remains caller-ordered; place authorization before any such
middleware that may short-circuit. Neither transform layer substitutes for authorization on the
target server.

## Multi-round input and request state

Modern MCP `2026-07-28` represents interactive work with `input_required` results from
`tools/call`, `prompts/get`, or `resources/read`. The client fulfils the embedded requests and
retries the original operation with a fresh request ID. The deprecated 2025 `tasks/*` wire
vocabulary is not a modern background-job runtime and must not be used as the basis for new agent
orchestration.

Every retry is a new authorization event. Re-run capability policy and domain authorization on
each handler entry; an approval from an earlier round does not make the final mutation implicitly
authorized. `inputResponses` contains only the current round and comes from the caller. Validate
accepted form content with `acceptedContent(..., schema)` or branch through `inputResponse` before
using it. Use URL elicitation or an out-of-band flow for credentials, payment details, and other
sensitive input rather than embedding them in a form request.

Modern HTTP server instances are stateless between rounds. If the handler must carry proven facts
forward, place only the minimal non-secret claim in `requestState` and configure the official
`createRequestStateCodec` verifier. The state must have a short TTL and be bound to the originating
method plus the stable tenant and end-user authorization context. Include a signed digest of
immutable operation arguments when changing them would alter what the user approved. The codec is
HMAC integrity protection, not encryption; a client can read the payload. Never mint an approval
claim before validating the response that proves it.

Client auto-fulfilment must have a finite round limit and a whole-flow deadline. Manual mode must
echo server state byte-for-byte without interpreting it, send only responses for the current
round, and preserve cancellation through the official request funnel. A gateway cannot relay
multi-round work safely by exposing raw upstream state: it needs its own signed route envelope,
bound to the downstream caller and re-authorized on every retry.

## Gateway credential separation

A gateway has two independent security contexts:

- **downstream:** the caller's identity and permission to see or invoke a projected capability;
- **upstream:** the gateway's credential or a deliberately exchanged/delegated credential accepted by the selected server.

Safe default: never forward the downstream `Authorization` header to an upstream destination. Choose one strategy per upstream:

- gateway service identity with least-privilege scopes;
- user-delegated token obtained through an explicit token-exchange policy;
- user-owned upstream OAuth provider keyed by user, issuer, and resource; or
- no upstream credential for a public server.

Nest named-client gateway entries implement the service-identity strategy. For delegation,
register an `McpGatewayClientProvider` and pass `{ name, clientProvider: ProviderToken }` in the
server's gateway configuration. The provider's `resolveClient()` method receives the verified
request context and should return a client partitioned by issuer, resource, tenant, principal, and
credential fingerprint. It must not reuse a user-specific client across authorization contexts.
Framework-neutral callers can pass a complete `{ name, client: resolver }` directly to
`McpGateway` from `@nest-mcp/gateway`.

Record which strategy was selected without logging the credential. Capability discovery caches must be partitioned by any identity or scope that can change the advertised capability set.

Gateway URI namespacing is routing, not encryption. The default reversible codec rejects URI userinfo, but query strings and paths remain decodable by downstream callers. Never place access tokens, API keys, or other secrets in an MCP resource URI; use an application-owned keyed or registry-backed codec when upstream topology itself is confidential.

## Outbound HTTP and SSRF

The client transport accepts `http:` and `https:` URLs. A production registry should additionally:

- require HTTPS except for explicit local development;
- allowlist schemes, hosts, ports, and path prefixes;
- resolve and reject loopback, link-local, metadata-service, and private addresses unless explicitly approved;
- repeat destination checks after redirects and DNS resolution;
- disable or tightly bound redirects;
- apply connection, header, body, and total-operation timeouts;
- cap response sizes and concurrent calls; and
- use egress network policy as a second enforcement layer.

Do not accept an MCP server URL directly from a model-generated tool argument.

## Stdio process safety

Stdio transport starts a local command and treats stdout as the JSON-RPC wire. Therefore:

- command, arguments, working directory, and environment come only from trusted configuration;
- use an executable allowlist and preferably an absolute path;
- pass a minimal environment instead of inheriting secrets;
- run with a dedicated OS identity, filesystem sandbox, and resource limits;
- log to stderr only—any stdout logging corrupts the protocol; and
- bound shutdown and forcefully reap child processes that do not exit.

Never interpolate tool input into a shell command. Prefer direct executable/argument arrays over a shell.

## HTTP server hardening

Every `McpServerRuntime` applies a pre-dispatch security posture — configured through
`McpServerDefinition.httpSecurity` — before definition middleware, authorization, or the SDK handler
run. The posture covers `runtime.fetch()`, `runtime.toNodeHandler()`, the Nest HTTP controller, and
web-standard hosts.

| Concern           | Default                                                                                             | Option                                      |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Origin validation | **On** — only localhost-class browser origins pass; requests without an `Origin` header always pass | `allowedOriginHostnames: string[] \| false` |
| Host validation   | Off — proxies rewrite `Host`, and the Origin rung already blocks DNS rebinding                      | `allowedHostnames: string[] \| false`       |
| CORS              | On whenever origin validation is on                                                                 | `cors: McpCorsOptions \| boolean`           |
| Body cap          | 1 MiB, enforced at the Node stream and at the fetch layer                                           | `maxBodyBytes: number \| false`             |

Notes and caveats:

- **Origin validation is the default-deny rung.** Routable browser origins are rejected until you
  list their hostnames. Non-browser MCP clients send no `Origin` header and are unaffected. An empty
  allowlist is a valid deny-all posture. Matching is hostname-only (port- and scheme-agnostic).
- **CORS has exactly one owner per route.** The 2026-07-28 revision's `Mcp-Method`/`Mcp-Name` request
  headers make every browser MCP POST CORS-preflighted, and the SDK handler itself answers preflights
  with `405` — without this posture (or app-level CORS) browser clients cannot connect at all. When
  Nest owns CORS for the whole app, pass `mcpCorsOptions({ origins })` from `@nest-mcp/nestjs` to
  `app.enableCors()` and disable the built-in handling with `cors: false`; never run both.
- **Credentialed CORS is off by default.** Cookie-authenticated MCP endpoints are CSRF-able; prefer
  bearer tokens.
- **Host validation and proxies.** `X-Forwarded-Host` is not consulted. Behind a rewriting proxy,
  keep `allowedHostnames: false` (the default) or list the rewritten internal hostname.
- **Body caps per path.** The Node-level cap protects raw `toNodeHandler()` mounts and non-JSON
  content types that platform parsers skip; the fetch-layer cap covers platform-parsed bodies and
  web-standard hosts. Platform limits (`express.json()` defaults to 100 KB, Fastify `bodyLimit` to
  1 MiB) still apply first when the platform parses.
- **Layering.** An outer hardened facade (the Nest controller's `getHttpSecurityOptions()` override,
  `hardenMcpFetch`, or a `McpValidatedServer` you compose yourself) owns the posture for requests it
  admits; the runtime's inner gate defers to it instead of double-gating.
- Pre-dispatch rejections surface to runtime observers as `request:rejected` events with the HTTP
  status; they never reach lifecycle observers or middleware.

A health endpoint stays a plain Nest concern: register an ordinary controller (or Terminus) beside
the MCP route — the MCP catch-all binds only its own controller path.

Beyond the built-in posture:

- Terminate TLS at a trusted boundary and preserve the original scheme/host safely.
- Rate limit by trusted principal and operation, not only IP address.
- Propagate abort signals and deadlines to tools and upstream calls.
- Return generic external errors while retaining structured internal audit context.
- Close handlers and registries during graceful shutdown.
- Use a distributed event bus when subscriptions span nodes; do not mistake an in-process bus for durable delivery.

## Agent and content risks

Authentication proves server identity only to the degree provided by TLS and configured trust. Tool descriptions, prompt templates, resource contents, and tool results can still contain prompt injection or malicious data.

An artifact/agent host should:

- expose only an allowlisted capability projection to each agent;
- display or log the selected server and operation for sensitive actions;
- require confirmation for destructive or high-impact operations;
- validate arguments and structured results against schemas;
- treat text results as data, not higher-priority instructions;
- isolate tenant and workspace paths; and
- keep model-visible errors free of secrets and internal topology.

## Secret and telemetry handling

Never include access tokens, refresh tokens, client secrets, authorization codes, PKCE verifiers, cookies, complete request bodies, or complete tool results in logs or lifecycle attributes. Hash or tokenize stable identifiers when correlation is required. Use low-cardinality policy and server identifiers for metrics.

Nest MCP lifecycle events omit inputs and outputs, and server/gateway operation principals omit bearer tokens and arbitrary token metadata. `@nest-mcp/observability` projects only bounded protocol fields by default; selecting application fields or raw exception recording is an explicit opt-in. Custom observers, telemetry hooks, and SDK fetch logging middleware must preserve those guarantees.

## Deployment checklist

- [ ] HTTPS and outbound destination allowlists are enforced.
- [ ] Every protected server publishes correct RFC 9728 metadata.
- [ ] Issuer, audience/resource, expiry, and scopes are verified.
- [ ] Logical operations have a fail-closed authorization policy.
- [ ] Decorated Nest capabilities use `handlerAuthorization`; HTTP-exchange middleware is not treated as a stdio policy.
- [ ] Gateway downstream and upstream credentials are separate.
- [ ] OAuth pending state is single-use, authenticated-encrypted, session-bound, and pinned to exact issuer, resource, endpoints, client, owner, and revision.
- [ ] When an interactive OAuth authority advertises RFC 9207, every callback carries the exact expected `iss` value; any unadvertised but present `iss` is also compared exactly.
- [ ] OAuth discovery and token calls use a redirect-denying, DNS-pinned, size/time-bounded fetch plus fail-closed endpoint policy.
- [ ] Refresh rotation uses a durable pre-dispatch claim plus exact-revision commit; stale claims never reactivate, and terminal invalidation evicts credential-bound client leases.
- [ ] Stdio definitions are trusted, allowlisted, and sandboxed.
- [ ] Payloads and secrets are redacted from logs and traces.
- [ ] Timeouts, cancellation, concurrency, and size limits are configured.
- [ ] `httpSecurity.allowedOriginHostnames` lists exactly the deployed browser clients (or stays at the localhost default), and each route has a single CORS owner.
- [ ] The OAuth proxy's signing keys are asymmetric and rotated; the HKDF master secret is ≥32 bytes and delivered out-of-band; consent is CSRF-protected; refresh rotation with family revocation is enabled; and the well-known documents resolve at the origin root (excluded from any global prefix).
- [ ] Destructive agent actions require an appropriate confirmation policy.
- [ ] Multi-round state is signed, short-lived, principal/method-bound, and contains no secrets.
- [ ] Shutdown closes inbound handlers before their gateway's upstream clients.

Relevant standards include [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414), [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707), [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728), and PKCE in [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636).
