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
| GET | `/.well-known/oauth-authorization-server` | OAuth server metadata |

The base path is derived from `serverUrl`. For example, if `serverUrl` is `https://example.com/api`, endpoints are at `/api/authorize`, `/api/token`, etc.

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

## Custom OAuth Store

By default, tokens and clients are stored in memory. For production, implement the `IOAuthStore` interface:

```typescript
import type { IOAuthStore } from '@nest-mcp/server';

class PostgresOAuthStore implements IOAuthStore {
  async storeClient(client) { /* ... */ }
  async getClient(clientId) { /* ... */ }
  async storeAuthCode(code) { /* ... */ }
  async getAuthCode(code) { /* ... */ }
  async removeAuthCode(code) { /* ... */ }
  async revokeToken(jti) { /* ... */ }
  async isTokenRevoked(jti) { /* ... */ }
}

McpAuthModule.forRoot({
  jwtSecret: '...',
  store: new PostgresOAuthStore(),
  // ...
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
