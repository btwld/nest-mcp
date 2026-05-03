import type { CanActivate, Type } from '@nestjs/common';
import type { IElicitationStore } from './elicitation-store.interface';

/**
 * Subset of {@link ElicitationModuleOptions} resolved by an async factory.
 * `apiPrefix` and `guards` stay on the sync wrapper because Nest needs them
 * at module-definition time — `RouterModule.register` and the providers
 * array are built before any factory runs.
 */
export type AsyncResolvedElicitationOptions = Omit<
  ElicitationModuleOptions,
  'apiPrefix' | 'guards'
>;

/** Lightweight branding for the rendered HTML pages. */
export interface ElicitationTemplateOptions {
  /** Inlined into the `<style>` block. */
  customCss?: string;
  logoUrl?: string;
  /** Default `MCP Server` */
  appName?: string;
  /** CSS color value. Default `#007bff` */
  primaryColor?: string;
}

export type ElicitationStoreConfiguration =
  | { type: 'memory' }
  | { type: 'custom'; store: IElicitationStore };

export interface ElicitationModuleOptions {
  /** Origin used to build user-facing URLs (e.g. `https://api.example.com`). */
  serverUrl: string;
  /** Path prefix mounted via `RouterModule`. Default `elicitation`. */
  apiPrefix?: string;
  /** Default 1 hour. */
  elicitationTtlMs?: number;
  /** Default 10 minutes. */
  cleanupIntervalMs?: number;
  /** Default in-memory. */
  storeConfiguration?: ElicitationStoreConfiguration;
  /**
   * Nest guards applied to every elicitation HTTP route via the composite
   * guard. Registered as providers in `forRoot` so they participate in DI.
   */
  guards?: Type<CanActivate>[];
  templateOptions?: ElicitationTemplateOptions;
}

export interface ResolvedElicitationOptions {
  serverUrl: string;
  apiPrefix: string;
  elicitationTtlMs: number;
  cleanupIntervalMs: number;
  storeConfiguration: ElicitationStoreConfiguration;
  guards?: Type<CanActivate>[];
  templateOptions: ElicitationTemplateOptions;
}

export const DEFAULT_ELICITATION_OPTIONS: Omit<ResolvedElicitationOptions, 'serverUrl'> = {
  apiPrefix: 'elicitation',
  elicitationTtlMs: 60 * 60 * 1000,
  cleanupIntervalMs: 10 * 60 * 1000,
  storeConfiguration: { type: 'memory' },
  templateOptions: {
    appName: 'MCP Server',
    primaryColor: '#007bff',
  },
};

export const ELICITATION_MODULE_OPTIONS = Symbol('ELICITATION_MODULE_OPTIONS');

/**
 * Async equivalent of {@link ElicitationModuleOptions}. `apiPrefix` and
 * `guards` stay on the sync wrapper (see {@link AsyncResolvedElicitationOptions});
 * everything else flows through the user's `useFactory`.
 */
export interface McpElicitationModuleAsyncOptions {
  // biome-ignore lint/suspicious/noExplicitAny: NestJS DynamicModule requires broad module types
  imports?: any[];
  /**
   * Path prefix mounted via `RouterModule`. Default `elicitation`.
   * Resolved synchronously because `RouterModule.register` runs at module
   * definition time, before any provider factory.
   */
  apiPrefix?: string;
  /**
   * Nest guards applied to every elicitation HTTP route via the composite
   * guard. Registered as providers on the module so they participate in DI;
   * resolved synchronously for the same reason as `apiPrefix`.
   */
  guards?: Type<CanActivate>[];
  useFactory: (
    // biome-ignore lint/suspicious/noExplicitAny: NestJS factory pattern requires broad parameter types
    ...args: any[]
  ) => AsyncResolvedElicitationOptions | Promise<AsyncResolvedElicitationOptions>;
  // biome-ignore lint/suspicious/noExplicitAny: NestJS injection tokens have broad types
  inject?: any[];
}
