import type { IOAuthStore } from '../stores/oauth-store.interface';

export interface McpAuthModuleOptions {
  jwtSecret: string;
  issuer?: string;
  audience?: string;
  accessTokenExpiresIn?: string;
  refreshTokenExpiresIn?: string;
  serverUrl?: string;
  resourceUrl?: string;
  enableDynamicRegistration?: boolean;
  store?: IOAuthStore;
  scopes?: string[];
}
