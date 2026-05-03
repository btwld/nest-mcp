import type { OAuthProviderUser } from '../interfaces/oauth-provider.interface';
import { OAuthCodeExchangeProvider } from './oauth-code-exchange.provider';

export interface AzureAdProviderConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Tenant identifier. Defaults to `common` (multi-tenant). Use a tenant
   * GUID or domain (e.g. `contoso.onmicrosoft.com`) to lock the issuer to
   * a single tenant.
   */
  tenant?: string;
  /** Override the default `openid profile email User.Read` scope. */
  scope?: string;
}

/**
 * Microsoft Entra ID (Azure AD) OAuth 2.0 v2.0 provider. Documented at
 * <https://learn.microsoft.com/azure/active-directory/develop/v2-oauth2-auth-code-flow>.
 *
 * Profile data comes from Microsoft Graph (`/me`); the access token issued
 * during the code exchange must include the `User.Read` scope (the default).
 */
export class AzureAdProvider extends OAuthCodeExchangeProvider {
  readonly name = 'azure-ad';
  protected readonly authorizationUrl: string;
  protected readonly tokenUrl: string;
  protected readonly userInfoUrl = 'https://graph.microsoft.com/v1.0/me';
  protected readonly scope: string;

  constructor(config: AzureAdProviderConfig) {
    super({ clientId: config.clientId, clientSecret: config.clientSecret });
    const tenant = encodeURIComponent(config.tenant ?? 'common');
    this.authorizationUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
    this.tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
    this.scope = config.scope ?? 'openid profile email User.Read';
  }

  protected mapProfile(raw: Record<string, unknown>): OAuthProviderUser {
    const id = raw.id ?? raw.oid;
    const email =
      (typeof raw.mail === 'string' && raw.mail) ||
      (typeof raw.userPrincipalName === 'string' && raw.userPrincipalName) ||
      undefined;
    return {
      id: typeof id === 'string' ? id : '',
      email: email || undefined,
      name: typeof raw.displayName === 'string' ? raw.displayName : undefined,
      tenantId: typeof raw.tenantId === 'string' ? raw.tenantId : undefined,
    };
  }
}
