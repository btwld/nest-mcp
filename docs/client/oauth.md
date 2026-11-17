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

To use OAuth, implement the `OAuthClientProvider` interface and pass it as the `authProvider` option on an HTTP-based connection.

`clientMetadata` describes the client for dynamic registration (redirect URIs, name, grant types); it has no `client_id`. The client ID (and secret, if any) comes from `clientInformation()`, which is required: return your pre-registered credentials, or `undefined` to let the SDK register the client dynamically and hand the result to `saveClientInformation()`.

```typescript
import { McpClientModule, type OAuthClientProvider } from '@nest-mcp/client';

const myOAuthProvider: OAuthClientProvider = {
  get redirectUrl() {
    return 'http://localhost:3000/callback';
  },
  get clientMetadata() {
    return {
      client_name: 'My NestJS app',
      redirect_uris: ['http://localhost:3000/callback'],
    };
  },
  async clientInformation() {
    // Pre-registered client, or undefined to use dynamic client registration
    return { client_id: 'my-client-id' };
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

`loadTokensFromStorage`, `saveTokensToStorage`, `saveVerifierToStorage` and `loadVerifierFromStorage` stand for your own persistence.

The wrapper connects with whatever the provider returns from `tokens()` and lets the SDK refresh them. It does not complete an interactive authorization-code flow for you: when the SDK calls `redirectToAuthorization()`, `connect()` fails with an `UnauthorizedError`. Finish the flow in your application (for example with `auth(provider, { serverUrl, authorizationCode })` once the redirect arrives), then connect again.

## Use either auth or authProvider

Set `auth` (static bearer token) or `authProvider` (OAuth) on a connection, not both. Both write the `Authorization` header, and the static header from `auth` is applied on top of the provider's access token on every request, so the OAuth token would never be sent.

## Discovery helpers

Use the discovery functions to find OAuth endpoints:

```typescript
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@nest-mcp/client';

// Discover the authorization server for an MCP server
const resourceMeta = await discoverOAuthProtectedResourceMetadata('https://api.example.com/mcp');
const issuer = resourceMeta.authorization_servers?.[0];
if (issuer) {
  const authServerMeta = await discoverAuthorizationServerMetadata(issuer);
  console.log(authServerMeta?.token_endpoint);
  console.log(authServerMeta?.authorization_endpoint);
}
```

## See Also

- [Connections](./connections.md) -- `authProvider` and `auth` options
- [Client API](./client-api.md) -- making authenticated requests
