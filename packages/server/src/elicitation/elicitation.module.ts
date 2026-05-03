import {
  type CanActivate,
  type DynamicModule,
  Module,
  type Provider,
  type Type,
} from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { ElicitationController } from './elicitation.controller';
import {
  type AsyncResolvedElicitationOptions,
  DEFAULT_ELICITATION_OPTIONS,
  ELICITATION_MODULE_OPTIONS,
  type ElicitationModuleOptions,
  type McpElicitationModuleAsyncOptions,
  type ResolvedElicitationOptions,
} from './interfaces/elicitation-options.interface';
import { ELICITATION_STORE_TOKEN } from './interfaces/elicitation-store.interface';
import { ElicitationGuardComposite } from './services/elicitation-guard.composite';
import {
  COMPLETION_NOTIFIER_REGISTRY,
  type CompletionNotifierRegistry,
  ElicitationService,
} from './services/elicitation.service';
import { MemoryElicitationStore } from './stores/memory-elicitation.store';

/** Internal token holding the raw options returned by the async `useFactory`. */
const RAW_ELICITATION_OPTIONS = Symbol('RAW_ELICITATION_OPTIONS');

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS dynamic-module convention
export class McpElicitationModule {
  static forRoot(options: ElicitationModuleOptions): DynamicModule {
    const resolved = resolveOptions(options);
    const providers = buildProviders({
      moduleOptionsProvider: { provide: ELICITATION_MODULE_OPTIONS, useValue: resolved },
      guards: options.guards,
    });

    return {
      module: McpElicitationModule,
      imports: [
        RouterModule.register([{ path: resolved.apiPrefix, module: McpElicitationModule }]),
      ],
      controllers: [ElicitationController],
      providers,
      exports: [ElicitationService, ELICITATION_STORE_TOKEN, ELICITATION_MODULE_OPTIONS],
    };
  }

  static forRootAsync(asyncOptions: McpElicitationModuleAsyncOptions): DynamicModule {
    const apiPrefix = asyncOptions.apiPrefix ?? DEFAULT_ELICITATION_OPTIONS.apiPrefix;
    const guards = asyncOptions.guards;

    const rawOptionsProvider: Provider = {
      provide: RAW_ELICITATION_OPTIONS,
      useFactory: asyncOptions.useFactory,
      inject: asyncOptions.inject ?? [],
    };

    const moduleOptionsProvider: Provider = {
      provide: ELICITATION_MODULE_OPTIONS,
      useFactory: (raw: AsyncResolvedElicitationOptions): ResolvedElicitationOptions =>
        resolveOptions({ ...raw, apiPrefix, guards }),
      inject: [RAW_ELICITATION_OPTIONS],
    };

    const providers = buildProviders({
      moduleOptionsProvider,
      guards,
      extraProviders: [rawOptionsProvider],
    });

    return {
      module: McpElicitationModule,
      imports: [
        ...(asyncOptions.imports ?? []),
        RouterModule.register([{ path: apiPrefix, module: McpElicitationModule }]),
      ],
      controllers: [ElicitationController],
      providers,
      exports: [ElicitationService, ELICITATION_STORE_TOKEN, ELICITATION_MODULE_OPTIONS],
    };
  }
}

interface BuildProvidersInput {
  /**
   * The provider that resolves to `ResolvedElicitationOptions`. Sync path
   * passes a `useValue`; async path passes a `useFactory` that depends on
   * the raw-options provider.
   */
  moduleOptionsProvider: Provider;
  guards: Type<CanActivate>[] | undefined;
  /** Additional providers (e.g. the async raw-options provider). */
  extraProviders?: Provider[];
}

/**
 * Build the providers array shared by `forRoot` and `forRootAsync`. The
 * store is dispatched through a `useFactory` so that both paths can pick
 * `custom` vs `memory` after the resolved options are known.
 */
function buildProviders(input: BuildProvidersInput): Provider[] {
  const notifierRegistry: CompletionNotifierRegistry = new Map();

  const storeProvider: Provider = {
    provide: ELICITATION_STORE_TOKEN,
    useFactory: (resolved: ResolvedElicitationOptions, memoryStore: MemoryElicitationStore) =>
      resolved.storeConfiguration.type === 'custom'
        ? resolved.storeConfiguration.store
        : memoryStore,
    inject: [ELICITATION_MODULE_OPTIONS, MemoryElicitationStore],
  };

  return [
    ...(input.extraProviders ?? []),
    input.moduleOptionsProvider,
    { provide: COMPLETION_NOTIFIER_REGISTRY, useValue: notifierRegistry },
    // User-supplied guard classes need to be in the provider list so
    // `ElicitationGuardComposite` can resolve them via `ModuleRef`.
    ...(input.guards ?? []),
    ElicitationGuardComposite,
    // Always register `MemoryElicitationStore` so the store factory can
    // pick it up even when the user supplies a custom store (which is the
    // path the factory takes via `storeConfiguration.type === 'custom'`).
    MemoryElicitationStore,
    storeProvider,
    ElicitationService,
  ];
}

function resolveOptions(options: ElicitationModuleOptions): ResolvedElicitationOptions {
  if (!options.serverUrl) {
    throw new Error('McpElicitationModule.forRoot: `serverUrl` is required');
  }
  return {
    serverUrl: options.serverUrl,
    apiPrefix: options.apiPrefix ?? DEFAULT_ELICITATION_OPTIONS.apiPrefix,
    elicitationTtlMs: options.elicitationTtlMs ?? DEFAULT_ELICITATION_OPTIONS.elicitationTtlMs,
    cleanupIntervalMs: options.cleanupIntervalMs ?? DEFAULT_ELICITATION_OPTIONS.cleanupIntervalMs,
    storeConfiguration:
      options.storeConfiguration ?? DEFAULT_ELICITATION_OPTIONS.storeConfiguration,
    guards: options.guards,
    templateOptions: {
      ...DEFAULT_ELICITATION_OPTIONS.templateOptions,
      ...(options.templateOptions ?? {}),
    },
  };
}
