import type { IOAuthStore } from '../stores/oauth-store.interface';

export interface McpAuthModuleAsyncOptions {
  /** Modules whose exported providers the factory may inject. */
  // biome-ignore lint/suspicious/noExplicitAny: NestJS DynamicModule requires broad module types
  imports?: any[];
  /**
   * Static base URL used to derive the OAuth controllers' base path.
   * Controllers are created at module-definition time — before `useFactory`
   * runs — so this cannot come from the factory. All runtime options
   * (including `serverUrl` for metadata/issuer purposes) flow through
   * `MCP_AUTH_OPTIONS` as resolved by `useFactory`.
   */
  serverUrl?: string;
  // biome-ignore lint/suspicious/noExplicitAny: NestJS factory pattern requires broad parameter types
  useFactory: (...args: any[]) => McpAuthModuleOptions | Promise<McpAuthModuleOptions>;
  // biome-ignore lint/suspicious/noExplicitAny: NestJS injection tokens have broad types
  inject?: any[];
}

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
  validateUser?: (req: unknown) => Promise<{ id: string; [key: string]: unknown } | null>;
  authCodeExpiresIn?: number; // seconds, default 300 (5 min)
  authRateLimit?: { max: number; window: string };
}
