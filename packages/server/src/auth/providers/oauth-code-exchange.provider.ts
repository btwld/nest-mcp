import { asString } from '../../utils/coerce';
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
 * Type guard for the request shape we read from. Replaces an `as`
 * assertion with a structural check — `validateUser`'s input is genuinely
 * `unknown` (handed to us by Express/Fastify), so the runtime check is
 * the right level of paranoia.
 */
function isRequestWithQuery(value: unknown): value is RequestWithQuery {
  return typeof value === 'object' && value !== null && 'query' in value;
}

/**
 * Standard OAuth 2.0 token-endpoint response (RFC 6749 §5.1). Subclasses
 * can extend with provider-specific fields (e.g. Azure's `id_token`).
 */
export interface OAuthTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Base class for "Authorization Code" OAuth 2.0 providers. Subclasses declare
 * the provider-specific endpoints, scope, and profile mapping; this class
 * implements the redirect URL build and the `code → access_token → profile`
 * exchange against those endpoints with `globalThis.fetch` (Node 20+).
 *
 * `TProfile` lets each subclass type the userinfo JSON it expects (e.g.
 * `GitHubUser`, `AzureAdUser`) so `mapProfile` can rely on declared fields
 * instead of guarding `unknown` values one by one. The `as TProfile` cast in
 * `fetchProfile` is the single trust boundary — change it to a Zod parse if
 * a target API ever drifts.
 *
 * Subclasses are not Nest providers themselves — they are plain classes
 * intended to be instantiated in the application's bootstrap and passed to
 * `McpAuthModule.forProvider()`.
 */
export abstract class OAuthCodeExchangeProvider<TProfile = Record<string, unknown>>
  implements OAuthProviderAdapter
{
  abstract readonly name: string;
  protected abstract readonly authorizationUrl: string;
  protected abstract readonly tokenUrl: string;
  protected abstract readonly userInfoUrl: string;
  protected abstract readonly scope: string;

  /** Map provider-specific user payload to the common `OAuthProviderUser` shape. */
  protected abstract mapProfile(raw: TProfile): OAuthProviderUser;

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
    // `URLSearchParams` as the body has fetch set the
    // `application/x-www-form-urlencoded` Content-Type automatically.
    const tokenRes = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return null;

    const tokenPayload = (await tokenRes.json()) as OAuthTokenResponse;
    if (!tokenPayload.access_token) return null;

    return this.fetchProfile(tokenPayload.access_token);
  }

  async validateUser(req: unknown): Promise<OAuthProviderUser | null> {
    if (!isRequestWithQuery(req)) return null;
    const code = asString(req.query?.code);
    const redirectUri = asString(req.query?.redirect_uri);
    if (!code || !redirectUri) return null;
    return this.exchangeToken(code, redirectUri);
  }

  protected async fetchProfile(accessToken: string): Promise<OAuthProviderUser | null> {
    const res = await fetch(this.userInfoUrl, { headers: this.userInfoHeaders(accessToken) });
    if (!res.ok) return null;
    return this.mapProfile((await res.json()) as TProfile);
  }
}
