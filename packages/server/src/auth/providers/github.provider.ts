import { asString } from '../../utils/coerce';
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
 * GitHub OAuth 2.0 provider. Uses the standard authorization-code flow
 * documented at <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>.
 */
export class GitHubProvider extends OAuthCodeExchangeProvider {
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

  protected mapProfile(raw: Record<string, unknown>): OAuthProviderUser {
    const id = raw.id;
    return {
      id: typeof id === 'number' || typeof id === 'string' ? String(id) : '',
      email: asString(raw.email),
      name: asString(raw.name) ?? asString(raw.login),
      login: asString(raw.login),
      avatarUrl: asString(raw.avatar_url),
    };
  }
}
