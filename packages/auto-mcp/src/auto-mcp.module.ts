import { MCP_AUTO_MCP_OPTIONS } from '@nest-mcp/common';
import {
  type DynamicModule,
  type FactoryProvider,
  Module,
  type Provider,
  type Type,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { RouteScannerService } from './discovery/route-scanner.service';
import { PipelineExecutorService } from './execution/pipeline-executor.service';
import type { AutoMcpOptions } from './interfaces/auto-mcp-options.interface';
import { RouteRegistrarService } from './registration/route-registrar.service';

export interface AutoMcpModuleAsyncOptions {
  imports?: Array<Type<unknown> | DynamicModule>;
  inject?: FactoryProvider['inject'];
  useFactory: (...args: unknown[]) => AutoMcpOptions | Promise<AutoMcpOptions>;
}

// `ExternalContextCreator` is registered globally by Nest's internal core module
// — no provider declaration needed here. We just inject it in `PipelineExecutorService`.
const sharedProviders: Provider[] = [
  RouteScannerService,
  PipelineExecutorService,
  RouteRegistrarService,
];

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS requires module classes
export class AutoMcpModule {
  static forRoot(options: AutoMcpOptions = {}): DynamicModule {
    return {
      module: AutoMcpModule,
      imports: [DiscoveryModule],
      providers: [{ provide: MCP_AUTO_MCP_OPTIONS, useValue: options }, ...sharedProviders],
      exports: [RouteRegistrarService],
      global: true,
    };
  }

  static forRootAsync(options: AutoMcpModuleAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: MCP_AUTO_MCP_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };
    return {
      module: AutoMcpModule,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: [optionsProvider, ...sharedProviders],
      exports: [RouteRegistrarService],
      global: true,
    };
  }
}
