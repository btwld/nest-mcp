# McpAuthModule

The `McpAuthModule` provides OAuth 2.1 authentication with PKCE, JWT token management, dynamic client registration, and audit logging.

## Setup

```typescript
import { Module } from '@nestjs/common';
import { McpModule, McpAuthModule } from '@nest-mcp/server';
import { McpTransportType } from '@nest-mcp/common';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'my-server',
      version: '1.0.0',
      transport: McpTransportType.STREAMABLE_HTTP,
      guards: [JwtAuthGuard], // apply JWT validation globally
    }),
    McpAuthModule.forRoot({
      jwtSecret: 'your-secret-key-at-least-32-chars-long',
      issuer: 'https://my-server.example.com',
      audience: 'mcp-client',
      serverUrl: 'https://my-server.example.com',
      scopes: ['tools:read', 'tools:write'],
      validateUser: async (req) => {
        // Extract and validate user from the authorization request
        // Return { id: string, ... } or null to deny
        return { id: 'user-1' };
      },
    }),
  ],
})
export class AppModule {}
```

## Async Setup (`forRootAsync`)

Use `McpAuthModule.forRootAsync` when options come from DI (e.g.
`ConfigService`):

```typescript
McpAuthModule.forRootAsync({
  imports: [ConfigModule],
  // Static: controllers are created at module-definition time, so the base
  // path for /authorize, /token, ... must be known up front.
  serverUrl: 'https://my-server.example.com',
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    jwtSecret: config.getOrThrow('JWT_SECRET'),
    serverUrl: config.getOrThrow('SERVER_URL'),
    validateUser: async (req) => ({ id: 'user-1' }),
  }),
}),
```

The factory result is validated the same way as `forRoot` (`jwtSecret` must
be at least 32 characters; validation runs when the factory resolves). The
static `serverUrl` only shapes controller paths — everything else, including
the `serverUrl` used in metadata documents and token claims, comes from the
resolved options.

## McpAuthModuleOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `jwtSecret` | `string` | Yes | Secret for signing JWTs (min 32 characters) |
| `issuer` | `string` | No | JWT issuer claim (defaults to `serverUrl` or `http://localhost:3000`) |
| `audience` | `string` | No | JWT audience claim (default: `'mcp-client'`) |
| `accessTokenExpiresIn` | `string` | No | Access token lifetime (default: `'1d'`) |
| `refreshTokenExpiresIn` | `string` | No | Refresh token lifetime (default: `'30d'`) |
| `serverUrl` | `string` | No | Server base URL for OAuth endpoints |
| `resourceUrl` | `string` | No | Resource URL for token scoping |
| `enableDynamicRegistration` | `boolean` | No | Allow dynamic client registration (default: `true`) |
| `store` | `IOAuthStore` | No | Custom store implementation (default: in-memory) |
| `scopes` | `string[]` | No | Supported OAuth scopes |
| `validateUser` | `(req: unknown) => Promise<{ id: string } \| null>` | No | User validation callback for authorization |
| `authCodeExpiresIn` | `number` | No | Authorization code lifetime in seconds (default: 300) |
| `authRateLimit` | `{ max: number; window: string }` | No | Rate limit for auth endpoints |

## OAuth Endpoints

When `McpAuthModule.forRoot` is imported, the following HTTP endpoints are registered:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/authorize` | OAuth authorization endpoint (PKCE required) |
| POST | `/token` | Token exchange and refresh |
| POST | `/revoke` | Token revocation |
| POST | `/introspect` | Token introspection |
| POST | `/register` | Dynamic client registration |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata |
| GET | `/.well-known/oauth-authorization-server/*` | RFC 8414 path-insertion variant (same metadata) |
| GET | `/.well-known/oauth-protected-resource` | RFC 9728 protected-resource metadata |
| GET | `/.well-known/oauth-protected-resource/*` | RFC 9728 path-insertion variant |

The base path is derived from `serverUrl`. For example, if `serverUrl` is `https://example.com/api`, endpoints are at `/api/authorize`, `/api/token`, etc.

### Discovery Metadata

The authorization-server document advertises, among others,
`authorization_endpoint`, `token_endpoint`, `registration_endpoint`,
`revocation_endpoint` + `revocation_endpoint_auth_methods_supported`, and
`introspection_endpoint` + `introspection_endpoint_auth_methods_supported`.

The **path-insertion** routes serve clients that append the issuer/resource
path to the well-known URL (RFC 8414 §3 / RFC 9728): a request to
`/.well-known/oauth-protected-resource/mcp` returns the protected-resource
document, with `resource` rebuilt as `serverUrl + '/<path>'` when the inserted
path matches the configured resource path (`resourceUrl`'s path, default
`/mcp`).

### Audience Binding (RFC 8707)

When the client passes a `resource` parameter during authorization, issued
access tokens carry that resource as their `aud` claim
(`aud = resource ?? audience ?? 'mcp-client'`). Note that `validateToken`
deliberately does **not** enforce `aud` (non-breaking for existing
deployments) — resource servers that need strict audience checks should
verify the claim themselves (e.g. in a custom `BearerTokenVerifier`).

## OAuth Flow

The module implements the Authorization Code flow with PKCE:

1. Client calls `GET /authorize` with `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method`, and `state`.
2. Server validates the client, authenticates the user via `validateUser`, and returns an authorization code.
3. Client exchanges the code at `POST /token` with `grant_type=authorization_code`, `code`, and `code_verifier`.
4. Server validates the PKCE challenge and returns an access/refresh token pair.
5. Client uses the access token as a Bearer token in subsequent MCP requests.

## JwtAuthGuard

The built-in `JwtAuthGuard` validates Bearer tokens and populates `ctx.user`:

```typescript
import { McpModule, McpAuthModule } from '@nest-mcp/server';
import { JwtAuthGuard } from '@nest-mcp/server';

McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
  guards: [JwtAuthGuard], // global guard
});
```

After validation, `ctx.user` contains:

```typescript
{
  id: string;       // from JWT 'sub' claim
  scopes: string[]; // from JWT 'scope' claim (space-separated)
}
```

## Scope-Filtered Lists (`filterListsByScopes`)

By default, `tools/list`, `resources/list`, `resources/templates/list`, and
`prompts/list` return every registered item regardless of the caller's token.
Set `filterListsByScopes: true` on `McpModule.forRoot` to hide items whose
`@Scopes(...)` requirements are not covered by the caller's verified token
scopes (from the streamable HTTP OAuth gate's `authInfo`):

```typescript
McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
  filterListsByScopes: true,
  transportOptions: { streamableHttp: { oauth: { enabled: true } } },
});
```

Items without required scopes are always listed. Execution-time authorization
still applies independently of list filtering.

## Custom Bearer-Token Verification

The streamable HTTP transport's [OAuth gate](./transports.md#oauth-bearer-gate)
verifies tokens through the `MCP_BEARER_TOKEN_VERIFIER` provider.
`McpAuthModule` registers a JWT implementation (`JwtBearerTokenVerifier`) by
default; override it for opaque tokens, remote introspection, or external
issuers:

```typescript
import {
  MCP_BEARER_TOKEN_VERIFIER,
  type BearerTokenVerifier,
} from '@nest-mcp/server';
import type { McpAuthInfo } from '@nest-mcp/common';

class IntrospectingVerifier implements BearerTokenVerifier {
  async verify(token: string): Promise<McpAuthInfo | null> {
    const res = await fetch('https://idp.example.com/introspect', {
      method: 'POST',
      body: new URLSearchParams({ token }),
    });
    const data = await res.json();
    if (!data.active) return null;
    return {
      token,
      clientId: data.client_id,
      scopes: (data.scope ?? '').split(' ').filter(Boolean),
      expiresAt: data.exp,
      extra: { sub: data.sub },
    };
  }
}

// In your AppModule:
providers: [{ provide: MCP_BEARER_TOKEN_VERIFIER, useClass: IntrospectingVerifier }],
```

## Custom OAuth Store

By default, tokens and clients are stored in memory. For production, implement the `IOAuthStore` interface. A Postgres-backed sketch:

```typescript
import type { IOAuthStore, IssuedTokenRecord } from '@nest-mcp/server';
import { Injectable } from '@nestjs/common';

@Injectable()
class PostgresOAuthStore implements IOAuthStore {
  constructor(private readonly db: DatabaseService) {}

  async storeClient(client) {
    await this.db.query(
      `INSERT INTO oauth_clients (client_id, data) VALUES ($1, $2)
       ON CONFLICT (client_id) DO UPDATE SET data = $2`,
      [client.client_id, client],
    );
    return client;
  }
  async getClient(clientId) {
    const row = await this.db.queryOne(
      'SELECT data FROM oauth_clients WHERE client_id = $1', [clientId]);
    return row?.data;
  }
  async storeAuthCode(code) { /* INSERT INTO oauth_codes ... */ }
  async getAuthCode(code) { /* SELECT ... WHERE expires_at > now() */ }
  async removeAuthCode(code) { /* DELETE FROM oauth_codes ... */ }
  async revokeToken(jti) { /* INSERT INTO revoked_tokens (jti) ... */ }
  async isTokenRevoked(jti) { /* SELECT EXISTS(...) */ }

  // Optional issuance hook — see below.
  async recordIssuedToken(rec: IssuedTokenRecord) {
    await this.db.query(
      `INSERT INTO issued_tokens (jti, type, client_id, user_id, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))`,
      [rec.jti, rec.type, rec.clientId, rec.userId, rec.scope, rec.expiresAt],
    );
  }
}

McpAuthModule.forRoot({
  jwtSecret: '...',
  store: new PostgresOAuthStore(db),
  // ...
});
```

With `forRootAsync`, return the store from the factory — a store provided
there wins over the in-memory default:

```typescript
McpAuthModule.forRootAsync({
  imports: [DatabaseModule],
  inject: [DatabaseService],
  useFactory: (db: DatabaseService) => ({
    jwtSecret: process.env.JWT_SECRET!,
    store: new PostgresOAuthStore(db),
  }),
});
```

### IOAuthStore Interface

| Method | Description |
|--------|-------------|
| `storeClient(client)` | Persist an OAuth client |
| `getClient(clientId)` | Retrieve a client by ID |
| `storeAuthCode(code)` | Store an authorization code |
| `getAuthCode(code)` | Retrieve an authorization code |
| `removeAuthCode(code)` | Delete an authorization code (after exchange) |
| `revokeToken(jti)` | Mark a token as revoked by its JTI |
| `isTokenRevoked(jti)` | Check if a token JTI has been revoked |
| `recordIssuedToken(rec)?` | *Optional.* Called whenever a token is minted |

### Token-Issuance Hook (`recordIssuedToken`)

When the store implements the optional `recordIssuedToken`, it is invoked for
**both** the access and the refresh token on every mint — the initial
authorization-code grant and each refresh grant. This lets host apps track
issued tokens and revoke whole refresh chains. Each call receives an
`IssuedTokenRecord`:

```typescript
{
  jti: string;                  // JWT ID of the minted token
  type: 'access' | 'refresh';
  clientId: string;
  userId?: string;
  scope?: string;
  expiresAt: number;            // unix epoch milliseconds
}
```

On the refresh path, the presented refresh token's `jti` is checked against
`isTokenRevoked` before it is honored, and is revoked once rotated — a stolen
older refresh token cannot be replayed.

## OAuthProviderAdapter

For integrating external identity providers (Auth0, Clerk, etc.), use `McpAuthModule.forProvider`:

```typescript
import type { OAuthProviderAdapter, OAuthProviderUser } from '@nest-mcp/server';

class Auth0Adapter implements OAuthProviderAdapter {
  readonly name = 'Auth0';

  async validateUser(req: unknown): Promise<OAuthProviderUser | null> {
    // Validate the request and return user info
    return { id: 'user-1', email: 'user@example.com' };
  }
}

McpAuthModule.forProvider(new Auth0Adapter(), {
  jwtSecret: '...',
  serverUrl: 'https://my-server.example.com',
});
```

### OAuthProviderAdapter Interface

| Method | Required | Description |
|--------|----------|-------------|
| `validateUser(req)` | Yes | Validate a request and extract user info |
| `exchangeToken(code, redirectUri)` | No | Exchange a provider token for user info |
| `getAuthorizationUrl(state, redirectUri)` | No | Return the provider's authorization URL |

## Auth Rate Limiting

The `AuthRateLimitGuard` is automatically applied to OAuth endpoints to prevent brute-force attacks:

```typescript
McpAuthModule.forRoot({
  jwtSecret: '...',
  authRateLimit: {
    max: 20,       // max requests per window (default: 20)
    window: '1m',  // time window (default: '1m')
  },
});
```

Rate limiting is per-IP. When exceeded, a `429 Too Many Requests` response is returned with a `retry_after` value.

## Audit Logging

The `AuthAuditService` logs authentication events as structured JSON:

- `token_issued` -- JWT token pair generated
- `token_revoked` -- Token revoked
- `client_registered` -- New OAuth client registered
- `authorization_granted` -- Authorization code issued
- `authorization_denied` -- Authorization request denied
- `rate_limited` -- Auth rate limit exceeded

Logs include timestamps, client IDs, user IDs, and IP addresses when available.

## See Also

- [Auth Decorators](./auth-decorators.md) -- Per-handler `@Public`, `@Scopes`, `@Roles`, `@Guards`
- [Execution Pipeline](./execution-pipeline.md) -- How auth fits in the request lifecycle
- [Module](./module.md) -- Global guard configuration
