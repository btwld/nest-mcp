import type { OAuthProviderUser } from '../interfaces/oauth-provider.interface';
import { OAuthCodeExchangeProvider } from './oauth-code-exchange.provider';

export interface GitHubProviderConfig {
  clientId: string;
  clientSecret: string;
  /** Override the default `read:user user:email` scope. */
  scope?: string;
  /** Sent in the `User-Agent` header on the userinfo request. GitHub requires it. */
  userAgent?: string;
}

/**
 * Subset of the GitHub `/user` response we read. See
 * <https://docs.github.com/en/rest/users/users#get-the-authenticated-user>.
 * `email` and `name` may be `null` when the user hasn't set them publicly;
 * the rest are best-effort optional to stay forward-compatible.
 */
export interface GitHubUser {
  id?: number;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
}

/**
 * GitHub OAuth 2.0 provider. Uses the standard authorization-code flow
 * documented at <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>.
 */
export class GitHubProvider extends OAuthCodeExchangeProvider<GitHubUser> {
  readonly name = 'github';
  protected readonly authorizationUrl = 'https://github.com/login/oauth/authorize';
  protected readonly tokenUrl = 'https://github.com/login/oauth/access_token';
  protected readonly userInfoUrl = 'https://api.github.com/user';
  protected readonly scope: string;

  constructor(private readonly githubConfig: GitHubProviderConfig) {
    super({ clientId: githubConfig.clientId, clientSecret: githubConfig.clientSecret });
    this.scope = githubConfig.scope ?? 'read:user user:email';
  }

  protected userInfoHeaders(accessToken: string): Record<string, string> {
    return {
      ...super.userInfoHeaders(accessToken),
      'User-Agent': this.githubConfig.userAgent ?? '@nest-mcp/server',
    };
  }

  protected mapProfile(raw: GitHubUser): OAuthProviderUser {
    return {
      id: raw.id != null ? String(raw.id) : '',
      email: raw.email ?? undefined,
      name: raw.name ?? raw.login,
      login: raw.login,
      avatarUrl: raw.avatar_url,
    };
  }
}
