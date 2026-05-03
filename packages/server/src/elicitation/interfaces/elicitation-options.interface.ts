import type { CanActivate, Type } from '@nestjs/common';
import type { IElicitationStore } from './elicitation-store.interface';

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
