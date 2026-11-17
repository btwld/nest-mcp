---
"@nest-mcp/auth": minor
---

Add durable/encrypted OAuth storage and RFC 8693 token exchange to the authorization-server proxy.

- **Encrypted store decorator** (`withEncryptedValues`): AES-256-GCM at rest with a 12-byte IV and an
  AEAD binding of `version|keyId|storageKey`, so a record cannot be relocated to a different key or
  storage slot. Multi-key rotation (first key writes, all decrypt); an unknown key id or failed tag
  surfaces as a missing record — never plaintext, never a thrown error.
- **Disk store** (`McpDiskOAuthStore`): single-node filesystem persistence with per-record TTL,
  atomic writes, a cross-process atomic `take` via `rename`, path-traversal- and collision-safe key
  hashing, and a `sweep()` maintenance pass. Compose it under `withEncryptedValues` for
  confidentiality at rest.
- **RFC 8693 token exchange**: `McpOAuthProxy` handles
  `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` as its own STS — a confidential,
  authenticated client exchanges a proxy-minted `subject_token` for a new access token scoped to a
  configured `resource` with a subset of the grant's scopes (no refresh token). Advertised in
  authorization-server metadata.

Retires the "persistent OAuth token stores" and "token exchange" items from the CHANGELOG roadmap.
Adversarially reviewed (18 confirmed findings, incl. a disk `setIfAbsent` race, a token-exchange
scope re-widening, and an exchange-chain lifetime extension); all fixed before merge — the disk store
now serializes same-key writers and uses `link`-based creation, encrypted values pin a 128-bit auth
tag and offer a fail-closed `strict` mode, and exchange binds scope to the presented token, clamps
the issued token's lifetime to the subject token's, and keeps the target within the grant's resource.
