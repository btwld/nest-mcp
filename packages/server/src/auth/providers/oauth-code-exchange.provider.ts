import type {
  OAuthProviderAdapter,
  OAuthProviderUser,
} from '../interfaces/oauth-provider.interface';

/**
 * Subset of an HTTP request our `validateUser` can read. Both Express
 * (`Request.query`) and Fastify (`FastifyRequest.query`) match this shape
 * after parsing the query string.
 */
interface RequestWithQuery {
  query?: Record<string, unknown>;
}

/**
 * Base class for "Authorization Code" OAuth 2.0 providers. Subclasses declare
 * the provider-specific endpoints, scope, and profile mapping; this class
 * implements the redirect URL build and the `code → access_token → profile`
 * exchange against those endpoints with `globalThis.fetch` (Node 20+).
 *
 * Subclasses are not Nest providers themselves — they are plain classes
 * intended to be instantiated in the application's bootstrap and passed to
 * `McpAuthModule.forProvider()`.
 */
export abstract class OAuthCodeExchangeProvider implements OAuthProviderAdapter {
  abstract readonly name: string;
  protected abstract readonly authorizationUrl: string;
  protected abstract readonly tokenUrl: string;
  protected abstract readonly userInfoUrl: string;
  protected abstract readonly scope: string;

  /** Map provider-specific user payload to the common `OAuthProviderUser` shape. */
  protected abstract mapProfile(raw: Record<string, unknown>): OAuthProviderUser;

  /**
   * Headers sent to the userinfo endpoint. Most providers accept the default
   * `Authorization: Bearer <token>`; override for providers that require
   * something more (e.g. GitHub recommends a `User-Agent`).
   */
  protected userInfoHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
  }

  constructor(
    protected readonly config: { clientId: string; clientSecret: string },
  ) {}

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      scope: this.scope,
      state,
      response_type: 'code',
    });
    return `${this.authorizationUrl}?${params.toString()}`;
  }

  async exchangeToken(code: string, redirectUri: string): Promise<OAuthProviderUser | null> {
    const tokenRes = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes.ok) return null;

    const tokenPayload = (await tokenRes.json()) as { access_token?: string };
    if (!tokenPayload.access_token) return null;

    return this.fetchProfile(tokenPayload.access_token);
  }

  async validateUser(req: unknown): Promise<OAuthProviderUser | null> {
    const query = (req as RequestWithQuery)?.query;
    const code = typeof query?.code === 'string' ? query.code : undefined;
    const redirectUri =
      typeof query?.redirect_uri === 'string' ? query.redirect_uri : undefined;
    if (!code || !redirectUri) return null;
    return this.exchangeToken(code, redirectUri);
  }

  protected async fetchProfile(accessToken: string): Promise<OAuthProviderUser | null> {
    const res = await fetch(this.userInfoUrl, { headers: this.userInfoHeaders(accessToken) });
    if (!res.ok) return null;
    return this.mapProfile((await res.json()) as Record<string, unknown>);
  }
}
