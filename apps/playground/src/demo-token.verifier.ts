import type { BearerTokenVerifier, McpAuthInfo } from '@nest-mcp/server';

export const DEMO_TOKEN = process.env.PLAYGROUND_DEMO_TOKEN ?? 'playground-demo-token';
export const DEMO_SCOPES = ['tools:read', 'admin:read', 'analytics:read'];

/**
 * Custom-verifier recipe: any object implementing `BearerTokenVerifier` can
 * be passed as `verifier` to `McpAuthModule.forRoot`. Real deployments verify
 * against their authorization server (see the `jwks` and `introspection`
 * built-ins); the playground accepts a single static token so it works
 * offline.
 */
export class DemoTokenVerifier implements BearerTokenVerifier {
  async verify(token: string): Promise<McpAuthInfo | null> {
    if (token !== DEMO_TOKEN) return null;
    return {
      token,
      clientId: 'playground-client',
      scopes: DEMO_SCOPES,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { sub: 'demo-user' },
    };
  }
}
