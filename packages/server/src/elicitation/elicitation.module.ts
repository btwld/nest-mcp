import { type DynamicModule, Logger, Module, type Provider, type Type } from '@nestjs/common';
import { createElicitationController } from './elicitation.controller';
import {
  DEFAULT_ELICITATION_OPTIONS,
  ELICITATION_MODULE_OPTIONS,
  type ElicitationModuleOptions,
  type ResolvedElicitationOptions,
} from './interfaces/elicitation-options.interface';
import {
  ELICITATION_STORE_TOKEN,
  type IElicitationStore,
} from './interfaces/elicitation-store.interface';
import {
  COMPLETION_NOTIFIER_REGISTRY,
  type CompletionNotifierRegistry,
  ElicitationService,
} from './services/elicitation.service';
import { MemoryElicitationStore } from './stores/memory-elicitation.store';

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS dynamic-module convention
export class McpElicitationModule {
  private static readonly logger = new Logger('McpElicitationModule');

  static forRoot(options: ElicitationModuleOptions): DynamicModule {
    const resolved = resolveOptions(options);
    const ElicitationController = createElicitationController(resolved);
    const notifierRegistry: CompletionNotifierRegistry = new Map();

    const storeProvider: Provider =
      resolved.storeConfiguration.type === 'custom'
        ? { provide: ELICITATION_STORE_TOKEN, useValue: resolved.storeConfiguration.store }
        : { provide: ELICITATION_STORE_TOKEN, useClass: MemoryElicitationStore };

    const providers: Provider[] = [
      { provide: ELICITATION_MODULE_OPTIONS, useValue: resolved },
      { provide: COMPLETION_NOTIFIER_REGISTRY, useValue: notifierRegistry },
      storeProvider,
      ElicitationService,
    ];

    if (resolved.storeConfiguration.type === 'memory') {
      providers.push(MemoryElicitationStore);
    }

    return {
      module: McpElicitationModule,
      controllers: [ElicitationController as Type<unknown>],
      providers,
      exports: [ElicitationService, ELICITATION_STORE_TOKEN, ELICITATION_MODULE_OPTIONS],
    };
  }
}

function resolveOptions(options: ElicitationModuleOptions): ResolvedElicitationOptions {
  if (!options.serverUrl) {
    throw new Error('McpElicitationModule.forRoot: `serverUrl` is required');
  }
  return {
    serverUrl: options.serverUrl,
    apiPrefix: options.apiPrefix ?? DEFAULT_ELICITATION_OPTIONS.apiPrefix,
    elicitationTtlMs: options.elicitationTtlMs ?? DEFAULT_ELICITATION_OPTIONS.elicitationTtlMs,
    cleanupIntervalMs:
      options.cleanupIntervalMs ?? DEFAULT_ELICITATION_OPTIONS.cleanupIntervalMs,
    storeConfiguration:
      options.storeConfiguration ?? DEFAULT_ELICITATION_OPTIONS.storeConfiguration,
    endpoints: { ...DEFAULT_ELICITATION_OPTIONS.endpoints, ...(options.endpoints ?? {}) },
    guards: options.guards,
    templateOptions: {
      ...DEFAULT_ELICITATION_OPTIONS.templateOptions,
      ...(options.templateOptions ?? {}),
    },
  };
}
