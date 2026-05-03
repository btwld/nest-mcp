import { MCP_OPENAPI_MCP_OPTIONS } from '@nest-mcp/common';
import { McpRegistryService } from '@nest-mcp/server';
import {
  type DynamicModule,
  type FactoryProvider,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type Provider,
  type Type,
} from '@nestjs/common';
import {
  type OpenApiMcpOptions,
  type SourceConfig,
  isMultiSource,
} from '../interfaces/openapi-mcp-options.interface';
import { OpenApiSourceService } from './openapi-source.service';

export interface OpenApiMcpModuleAsyncOptions {
  imports?: Array<Type<unknown> | DynamicModule>;
  inject?: FactoryProvider['inject'];
  useFactory: (...args: unknown[]) => OpenApiMcpOptions | Promise<OpenApiMcpOptions>;
}

/**
 * Public service for diagnostics. Owns the source services for the lifetime
 * of the application. v1 has no runtime refresh API; v2 will add `refreshAll`.
 */
@Injectable()
export class OpenApiMcpService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OpenApiMcpService.name);
  private readonly sourceServices: OpenApiSourceService[];

  constructor(
    @Inject(MCP_OPENAPI_MCP_OPTIONS) options: OpenApiMcpOptions,
    @Inject(McpRegistryService) registry: McpRegistryService,
  ) {
    const sources = isMultiSource(options) ? options.sources : [options];
    this.sourceServices = sources.map((s) => new OpenApiSourceService(s, registry));
  }

  async onApplicationBootstrap(): Promise<void> {
    // Validate config here (rather than in the constructor) so `forRootAsync`
    // factories that resolve late still surface a clear error before any
    // source registration is attempted.
    if (this.sourceServices.length > 1) {
      const unnamed = this.sourceServices.filter((s) => !s.config.name).length;
      if (unnamed > 0) {
        throw new Error(
          'OpenApiMcpModule: every source must have a `name` when more than one is registered.',
        );
      }
    }

    for (const service of this.sourceServices) {
      try {
        await service.registerAll();
      } catch (err) {
        this.logger.error(
          `Failed to register OpenAPI source: ${(err as Error).message}`,
          (err as Error).stack,
        );
        throw err;
      }
    }
  }

  getSourceCount(): number {
    return this.sourceServices.length;
  }
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS requires module classes
export class OpenApiMcpModule {
  static forRoot(options: OpenApiMcpOptions): DynamicModule {
    return {
      module: OpenApiMcpModule,
      providers: [{ provide: MCP_OPENAPI_MCP_OPTIONS, useValue: options }, OpenApiMcpService],
      exports: [OpenApiMcpService],
      global: true,
    };
  }

  static forRootAsync(options: OpenApiMcpModuleAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: MCP_OPENAPI_MCP_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };
    return {
      module: OpenApiMcpModule,
      imports: options.imports ?? [],
      providers: [optionsProvider, OpenApiMcpService],
      exports: [OpenApiMcpService],
      global: true,
    };
  }
}

export type { SourceConfig };
