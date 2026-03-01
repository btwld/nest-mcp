# OAuth

`@nest-mcp/client` re-exports OAuth utilities from the `@modelcontextprotocol/sdk` package for convenience. These are used when connecting to MCP servers that require OAuth-based authentication.

## Re-exported functions

| Export | From | Description |
|--------|------|-------------|
| `auth` | `@modelcontextprotocol/sdk/client/auth.js` | Main OAuth authentication flow function |
| `extractWWWAuthenticateParams` | `@modelcontextprotocol/sdk/client/auth.js` | Parses `WWW-Authenticate` response headers |
| `discoverAuthorizationServerMetadata` | `@modelcontextprotocol/sdk/client/auth.js` | Fetches OAuth authorization server metadata |
| `discoverOAuthProtectedResourceMetadata` | `@modelcontextprotocol/sdk/client/auth.js` | Fetches OAuth protected resource metadata |

## Re-exported types

| Type | From | Description |
|------|------|-------------|
| `OAuthClientProvider` | `@modelcontextprotocol/sdk/client/auth.js` | Interface for OAuth client provider implementations |
| `AuthResult` | `@modelcontextprotocol/sdk/client/auth.js` | Result of an authentication attempt |
| `OAuthClientMetadata` | `@modelcontextprotocol/sdk/shared/auth.js` | OAuth client metadata |
| `OAuthTokens` | `@modelcontextprotocol/sdk/shared/auth.js` | Token storage structure |
| `AuthorizationServerMetadata` | `@modelcontextprotocol/sdk/shared/auth.js` | Authorization server metadata |
| `OAuthProtectedResourceMetadata` | `@modelcontextprotocol/sdk/shared/auth.js` | Protected resource metadata |

## Using OAuth with a connection

To use OAuth, implement the `OAuthClientProvider` interface and pass it as the `authProvider` option on an HTTP-based connection:

```typescript
import { McpClientModule, OAuthClientProvider } from '@nest-mcp/client';

const myOAuthProvider: OAuthClientProvider = {
  get redirectUrl() { return 'http://localhost:3000/callback'; },
  get clientMetadata() {
    return {
      client_id: 'my-client-id',
      redirect_uris: ['http://localhost:3000/callback'],
    };
  },
  async tokens() {
    // Return stored tokens or undefined
    return loadTokensFromStorage();
  },
  async saveTokens(tokens) {
    // Persist tokens
    await saveTokensToStorage(tokens);
  },
  async redirectToAuthorization(url) {
    // Redirect user to authorization URL
  },
  async saveCodeVerifier(verifier) {
    await saveVerifierToStorage(verifier);
  },
  async codeVerifier() {
    return loadVerifierFromStorage();
  },
};

McpClientModule.forRoot({
  connections: [
    {
      name: 'oauth-server',
      transport: 'streamable-http',
      url: 'https://api.example.com/mcp',
      authProvider: myOAuthProvider,
    },
  ],
})
```

## Combining auth and authProvider

The `auth` (bearer token) and `authProvider` (OAuth) options can coexist on a connection. The `auth` option sets an `Authorization` header on the initial request, while `authProvider` handles the full OAuth flow including token refresh. The MCP SDK transport manages the interaction between these mechanisms.

## Discovery helpers

Use the discovery functions to find OAuth endpoints:

```typescript
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@nest-mcp/client';

// Discover the authorization server for an MCP server
const resourceMeta = await discoverOAuthProtectedResourceMetadata('https://api.example.com');
const authServerMeta = await discoverAuthorizationServerMetadata(resourceMeta.authorization_servers[0]);

console.log(authServerMeta.token_endpoint);
console.log(authServerMeta.authorization_endpoint);
```

## See Also

- [Connections](./connections.md) -- `authProvider` and `auth` options
- [Client API](./client-api.md) -- making authenticated requests
