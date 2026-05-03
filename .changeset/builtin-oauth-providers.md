---
'@nest-mcp/server': minor
---

feat(server): add built-in `GitHubProvider` and `AzureAdProvider` for `McpAuthModule`

Two ready-made `OAuthProviderAdapter` implementations covering the most-asked
identity providers, plus a shared `OAuthCodeExchangeProvider` base class
that other Authorization-Code flows can extend. All implementations use
`globalThis.fetch` (Node 20+) — no Passport peer dependencies.

Public surface:

- `GitHubProvider({ clientId, clientSecret, scope?, userAgent? })`
- `AzureAdProvider({ clientId, clientSecret, tenant?, scope? })` — defaults to
  the multi-tenant `common` tenant; supply a tenant GUID or domain to lock
  the issuer to a single Microsoft Entra tenant.
- `OAuthCodeExchangeProvider` — abstract base; subclasses declare
  `authorizationUrl`, `tokenUrl`, `userInfoUrl`, `scope`, and a
  `mapProfile()` callback.

Usage:

```ts
import { McpAuthModule, GitHubProvider } from '@nest-mcp/server';

const provider = new GitHubProvider({
  clientId: process.env.GITHUB_CLIENT_ID!,
  clientSecret: process.env.GITHUB_CLIENT_SECRET!,
});

McpAuthModule.forProvider(provider, { /* ... */ });
```
