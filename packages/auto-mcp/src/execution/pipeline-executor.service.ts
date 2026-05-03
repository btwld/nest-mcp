import { Injectable, Logger } from '@nestjs/common';
import { ContextIdFactory, ModuleRef, ModulesContainer } from '@nestjs/core';
import { ExternalContextCreator } from '@nestjs/core/helpers/external-context-creator';
import { RouteParamsFactory } from '@nestjs/core/router/route-params-factory';
import { ROUTE_ARGS_METADATA } from '../discovery/param-introspector';
import type { RouteDescriptor } from '../discovery/route-descriptor';
import type { AutoMcpOptions } from '../interfaces/auto-mcp-options.interface';
import { buildSyntheticRequest, buildSyntheticResponse } from './synthetic-request';

export interface InvokeContext {
  inboundHeaders?: Record<string, string>;
  principal?: unknown;
}

/**
 * Invokes a controller route through the standard NestJS pipeline:
 * guards → interceptors → pipes → handler.
 *
 * Every call is dispatched against a synthetic `ExecutionContext` of type
 * `'http'`. Request-scoped providers work because we generate a fresh
 * `ContextId` per call.
 *
 * Limitations (documented in the auto-mcp README):
 * - `req` is synthesized; guards reading `req.cookies`, `req.session`, or
 *   bespoke fields will see undefined values. Use the synthetic-request
 *   defaults (`req.ip`, `req.protocol`, `req.get(header)`) and the
 *   `mapPrincipalToRequestUser` option to populate the fields your guards need.
 *   Header forwarding from the inbound MCP request is not implemented in v1.
 * - The `res` mock supports `status/send/json/end/setHeader`; controllers that
 *   manually stream via `res.write` are not supported.
 */
@Injectable()
export class PipelineExecutorService {
  private readonly logger = new Logger(PipelineExecutorService.name);
  private readonly paramsFactory = new RouteParamsFactory();
  private cachedExternalContextCreator?: ExternalContextCreator;

  constructor(
    private readonly modulesContainer: ModulesContainer,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Lazily resolve ExternalContextCreator from the runtime container.
   * This avoids constructor-time DI for a service that's only registered by
   * `INTERNAL_CORE_MODULE` once the app is fully initialized.
   *
   * Also probes for `registerRequestProvider` since that method's signature
   * was added in @nestjs/core ~10.0; older versions are unsupported.
   */
  private getExternalContextCreator(): ExternalContextCreator {
    if (this.cachedExternalContextCreator) return this.cachedExternalContextCreator;
    let ecc: ExternalContextCreator;
    try {
      ecc = this.moduleRef.get(ExternalContextCreator, { strict: false });
    } catch {
      throw new Error(
        'auto-mcp: ExternalContextCreator could not be resolved from the running NestJS application context. Ensure @nestjs/core ^10 || ^11 is installed.',
      );
    }
    if (
      typeof (ecc as { registerRequestProvider?: unknown }).registerRequestProvider !== 'function'
    ) {
      throw new Error(
        'auto-mcp: detected an @nestjs/core version without ExternalContextCreator.registerRequestProvider. Upgrade to @nestjs/core >= 10.3.',
      );
    }
    this.cachedExternalContextCreator = ecc;
    return ecc;
  }

  async invoke(
    descriptor: RouteDescriptor,
    input: Record<string, unknown>,
    options: AutoMcpOptions,
    toolName: string,
    ctx: InvokeContext = {},
  ): Promise<unknown> {
    const instance = this.findControllerInstance(descriptor);
    if (!instance) {
      throw new Error(
        `auto-mcp: controller instance for ${descriptor.controllerName} not found in any module.`,
      );
    }

    const callback = (instance as Record<string, (...args: unknown[]) => unknown>)[
      descriptor.methodName
    ];
    if (typeof callback !== 'function') {
      throw new Error(
        `auto-mcp: ${descriptor.controllerName}.${descriptor.methodName} is not a function.`,
      );
    }

    const principal = options.mapPrincipalToRequestUser
      ? options.mapPrincipalToRequestUser(ctx.principal)
      : ctx.principal;

    const req = buildSyntheticRequest(
      input,
      descriptor.params,
      ctx.inboundHeaders ?? {},
      principal,
      toolName,
      descriptor.fullPath,
      descriptor.verb,
    );
    const res = buildSyntheticResponse();
    const next: () => void = () => undefined;

    const externalContextCreator = this.getExternalContextCreator();
    const contextId = ContextIdFactory.create();
    externalContextCreator.registerRequestProvider(req, contextId);

    const wrapped = externalContextCreator.create(
      instance as object,
      callback.bind(instance) as (...args: unknown[]) => unknown,
      descriptor.methodName,
      ROUTE_ARGS_METADATA,
      this.paramsFactory,
      contextId,
      undefined,
      { guards: true, interceptors: true, filters: true },
      'http',
    );

    try {
      const result = await wrapped(req, res, next);
      if (result === undefined && res.__body !== undefined) {
        return res.__body;
      }
      return result;
    } catch (err) {
      this.logger.error(
        `auto-mcp: ${descriptor.controllerName}.${descriptor.methodName} threw: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  private findControllerInstance(descriptor: RouteDescriptor): unknown | undefined {
    for (const moduleRef of this.modulesContainer.values()) {
      const wrapper = moduleRef.controllers.get(descriptor.controllerType);
      if (wrapper?.instance) return wrapper.instance;
    }
    // Fallback for controllers whose key in `controllers` map differs from the
    // metatype (rare). We let any DI error propagate so the caller sees a
    // real diagnostic instead of a generic "controller not found" message.
    return this.moduleRef.get(descriptor.controllerType, { strict: false });
  }
}
