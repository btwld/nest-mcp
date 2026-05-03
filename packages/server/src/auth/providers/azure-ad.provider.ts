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
 * Subset of the Microsoft Graph `/me` response we read. See
 * <https://learn.microsoft.com/graph/api/user-get>. `oid` is not part of
 * `/me` but is kept here as a fallback so subclasses pointing at a different
 * Azure endpoint (e.g. id-token claims) still type-check.
 */
export interface AzureAdUser {
  id?: string;
  oid?: string;
  mail?: string | null;
  userPrincipalName?: string;
  displayName?: string;
  tenantId?: string;
}

/**
 * Microsoft Entra ID (Azure AD) OAuth 2.0 v2.0 provider. Documented at
 * <https://learn.microsoft.com/azure/active-directory/develop/v2-oauth2-auth-code-flow>.
 *
 * Profile data comes from Microsoft Graph (`/me`); the access token issued
 * during the code exchange must include the `User.Read` scope (the default).
 */
export class AzureAdProvider extends OAuthCodeExchangeProvider<AzureAdUser> {
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

  protected mapProfile(raw: AzureAdUser): OAuthProviderUser {
    return {
      id: raw.id ?? raw.oid ?? '',
      email: raw.mail ?? raw.userPrincipalName,
      name: raw.displayName,
      tenantId: raw.tenantId,
    };
  }
}
