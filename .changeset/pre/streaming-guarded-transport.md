---
"@nest-mcp/auth": minor
---

Add a transport-grade streaming SSRF-guarded fetch and give the existing guarded transports an
exact host allowlist and a loopback-http door.

`createStreamingSsrfGuardedFetch` is a complete `FetchLike` — it drops into
`McpHttpClientTransportDefinition.fetch` with no cast — that keeps the connect-time DNS pinning,
blocked-range predicate, SNI pinning, and forced `accept-encoding: identity` of
`createSsrfGuardedFetch` while handing back a live `ReadableStream`, which is what a long-lived
`text/event-stream` MCP session needs and the buffering fetch structurally cannot serve. Redirects
are manual by construction and any 3xx is rejected. `maxResponseBytes` (4 MiB) meters ordinary
bodies as a running total and against a declared `Content-Length`; `text/event-stream` swaps it for
a per-event `maxSseEventBytes` budget (1 MiB, CR/LF/CRLF framing, reset at each blank line) with no
total cap, plus an `idleTimeoutMs` gap between bytes. A violation errors the stream and destroys the
connection. Zero new runtime dependencies — it is built on `node:https`/`node:http` like the
existing guarded fetch.

`admitMcpHttpEndpoint` and `openGuardedFetch` split admission from the connection so a host can
reject an endpoint before decrypting the credential it would have sent; the lease replays only the
answers pinned at admission and confines every request to the admitted origin.

`createSsrfGuardedFetch` and `createNodeDocumentFetcher` gain the shared `allowedHosts` (exact match
after normalization) and `allowLoopbackHttp` (permits `http:` only to a host whose every resolved
address is loopback) options; both are fail-closed, so existing callers see no behavior change.
Also exported: `normalizeGuardedHost`, `isLoopbackAddress`, `McpGuardedHostPolicyOptions`,
`McpResolvedAddress`, and the `MCP_STREAM_*` fence constants. `McpDocumentFetchFailure` gains a
`host-not-allowed` reason, which CIMD resolution maps to the existing `host-not-allowed` failure.
