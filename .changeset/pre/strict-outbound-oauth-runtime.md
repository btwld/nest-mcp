---
"@nest-mcp/client": minor
---

Add a dedicated `@nest-mcp/client/oauth` surface for strict, host-managed outbound OAuth. It
provides exact resource and issuer discovery, mandatory endpoint policy checks, PKCE and
digest-only state transactions, pre-registered client authentication, revisioned credential CAS,
durable pre-dispatch refresh claims, bounded refresh coordination, invalidation hooks for runtime
lease eviction, and a per-binding minimal transport provider without implicit redirects or Dynamic
Client Registration.
