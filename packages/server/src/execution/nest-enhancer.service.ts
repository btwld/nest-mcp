import {
  AuthenticationError,
  AuthorizationError,
  MCP_OPTIONS,
  McpError,
  type McpModuleOptions,
  ValidationError,
} from '@nest-mcp/common';
import {
  BadRequestException,
  ForbiddenException,
  type HttpException,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  PIPES_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ApplicationConfig, type ContextId, ExternalContextCreator } from '@nestjs/core';
import type { ParamsFactory } from '@nestjs/core/helpers/external-context-creator';
import {
  MCP_CONTEXT_TYPE,
  type McpCapabilityCall,
  runMcpCapabilityCall,
} from './mcp-arguments-host';

/** Handler signature of a capability, which decides how its parameters are described to pipes. */
export type McpHandlerLayout = 'tool' | 'prompt' | 'resource' | 'resource-template';

/** A capability handler to run through the NestJS enhancer pipeline. */
export interface McpEnhancedTarget {
  layout: McpHandlerLayout;
  /**
   * Registry entry of the capability. Its identity keys the invoker cache, so
   * re-registering a capability builds a fresh invoker.
   */
  capability: { methodName: string };
  /** Provider object the handler is called on. */
  instance: Record<string, unknown>;
  /**
   * Context id the provider was resolved with. Set for request-scoped
   * providers, whose invoker is rebuilt per call so that scoped enhancers
   * resolve against the same context.
   */
  contextId?: ContextId;
}

type EnhancedHandler = (...args: unknown[]) => Promise<unknown>;

interface HandlerParam {
  index: number;
  data: undefined;
  pipes: never[];
}

/**
 * Metadata key the handler parameter layout is stored under. Private to this
 * service: it only exists so the enhancer pipeline can hand each parameter to
 * pipes.
 */
const MCP_HANDLER_PARAMS_METADATA = 'mcp:handler-params';

/**
 * Parameter types at or above this value are positional pass-throughs
 * (`type - base` is the argument index). Pipes see them as `'custom'`.
 */
const POSITIONAL_PARAMTYPE_BASE = 100;

const positional = (index: number): number => POSITIONAL_PARAMTYPE_BASE + index;

/** Same `"<type>:<index>"` shape Nest uses for route argument metadata. */
function describeParams(...types: number[]): Record<string, HandlerParam> {
  return Object.fromEntries(
    types.map((type, index) => [`${type}:${index}`, { index, data: undefined, pipes: [] }]),
  );
}

/**
 * How each handler signature is presented to pipes: tool and prompt arguments
 * as `'body'`, URI template variables as `'param'`, and the URI and execution
 * context as `'custom'`.
 */
const HANDLER_PARAMS: Record<McpHandlerLayout, Record<string, HandlerParam>> = {
  tool: describeParams(RouteParamtypes.BODY, positional(1)),
  prompt: describeParams(RouteParamtypes.BODY, positional(1)),
  resource: describeParams(positional(0), positional(1)),
  'resource-template': describeParams(positional(0), RouteParamtypes.PARAM, positional(2)),
};

/** Metadata keys `@UseGuards`, `@UseInterceptors`, `@UsePipes` and `@UseFilters` write to. */
const ENHANCER_METADATA_KEYS = [
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  PIPES_METADATA,
  EXCEPTION_FILTERS_METADATA,
];

const handlerParamsFactory: ParamsFactory = {
  exchangeKeyForValue(type: number, _data: unknown, args: unknown[]): unknown {
    if (type === RouteParamtypes.BODY) return args[0];
    if (type === RouteParamtypes.PARAM) return args[1];
    return args[type - POSITIONAL_PARAMTYPE_BASE];
  },
};

/** Client-facing message of a Nest HTTP exception, keeping per-field validation messages. */
export function describeHttpException(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  return typeof message === 'string' ? message : exception.message;
}

/**
 * Translate the NestJS exceptions enhancers conventionally throw into the MCP
 * error model, so a denial from a Nest guard is reported exactly like one from
 * the built-in authorization checks. Anything else is returned untouched.
 */
export function mapEnhancerException(error: unknown): unknown {
  if (error instanceof UnauthorizedException) {
    return new AuthenticationError(describeHttpException(error));
  }
  if (error instanceof ForbiddenException) {
    return new AuthorizationError(describeHttpException(error));
  }
  if (error instanceof BadRequestException) {
    return new ValidationError(describeHttpException(error));
  }
  return error;
}

/**
 * Runs capability handlers through the NestJS enhancer pipeline (guards,
 * interceptors, pipes and exception filters) when the `nestEnhancers` module
 * option is on. Enhancers are resolved by Nest itself, so method-, class- and
 * app-level registrations all apply and receive their injected dependencies.
 */
@Injectable()
export class McpNestEnhancerService implements OnApplicationBootstrap {
  readonly enabled: boolean;
  private readonly invokers = new WeakMap<object, EnhancedHandler>();

  constructor(
    @Inject(MCP_OPTIONS) options: McpModuleOptions,
    private readonly externalContextCreator: ExternalContextCreator,
    private readonly applicationConfig: ApplicationConfig,
  ) {
    this.enabled = options.nestEnhancers === true;
  }

  /**
   * App-level enhancers declared request- or transient-scoped are only
   * instantiated by Nest for controllers, so they would be skipped for MCP
   * calls. A silently skipped guard is worse than a failed bootstrap.
   */
  onApplicationBootstrap(): void {
    if (!this.enabled) return;

    const scoped = [
      ['APP_GUARD', this.applicationConfig.getGlobalRequestGuards()],
      ['APP_INTERCEPTOR', this.applicationConfig.getGlobalRequestInterceptors()],
      ['APP_PIPE', this.applicationConfig.getGlobalRequestPipes()],
      ['APP_FILTER', this.applicationConfig.getGlobalRequestFilters()],
    ] as const;
    const found = scoped.filter(([, wrappers]) => wrappers.length > 0).map(([token]) => token);
    if (found.length === 0) return;

    throw new McpError(
      `McpModule: 'nestEnhancers' cannot apply request- or transient-scoped app-level enhancers (${found.join(', ')}) to MCP calls. Register them with the default scope, or leave 'nestEnhancers' off.`,
    );
  }

  /**
   * Call the handler described by `target` with `args`, inside the enhancer
   * pipeline. `call` identifies the capability to enhancers through
   * `McpArgumentsHost`.
   */
  invoke(target: McpEnhancedTarget, call: McpCapabilityCall, args: unknown[]): Promise<unknown> {
    const invoker = this.invokerFor(target);
    return runMcpCapabilityCall(call, () => invoker(...args));
  }

  private invokerFor(target: McpEnhancedTarget): EnhancedHandler {
    if (target.contextId) return this.createInvoker(target);

    let invoker = this.invokers.get(target.capability);
    if (!invoker) {
      invoker = this.createInvoker(target);
      this.invokers.set(target.capability, invoker);
    }
    return invoker;
  }

  private createInvoker(target: McpEnhancedTarget): EnhancedHandler {
    const { instance, contextId } = target;
    const { methodName } = target.capability;
    const callback = instance[methodName];
    if (typeof callback !== 'function') {
      throw new McpError(`Capability handler '${methodName}' is not a function`);
    }

    this.assertEnhancersResolvable(instance, callback, methodName);
    const paramsKey = this.defineHandlerParams(target.layout, instance, methodName);
    return this.externalContextCreator.create(
      instance,
      callback as (...args: unknown[]) => unknown,
      methodName,
      paramsKey,
      paramsKey ? handlerParamsFactory : undefined,
      contextId,
      undefined,
      { guards: true, interceptors: true, filters: true },
      MCP_CONTEXT_TYPE,
    );
  }

  /**
   * Nest resolves enhancers referenced by class from the module that lists the
   * handler's class in its `providers`. When no module does — the provider was
   * registered under a custom token — Nest drops those enhancers without a
   * word. A dropped guard is an open door, so refuse the call instead.
   */
  private assertEnhancersResolvable(
    instance: Record<string, unknown>,
    callback: object,
    methodName: string,
  ): void {
    const providerClass = instance.constructor;
    if (typeof providerClass !== 'function') return;
    if (this.externalContextCreator.getContextModuleKey(providerClass)) return;

    const unresolvable = ENHANCER_METADATA_KEYS.flatMap((key): unknown[] => [
      ...(Reflect.getMetadata(key, providerClass) ?? []),
      ...(Reflect.getMetadata(key, callback) ?? []),
    ]).filter((enhancer): enhancer is { name: string } => typeof enhancer === 'function');
    if (unresolvable.length === 0) return;

    const owner = providerClass.name;
    const names = unresolvable.map((enhancer) => enhancer.name).join(', ');
    throw new McpError(
      `Cannot resolve the NestJS enhancers of '${owner}.${methodName}' (${names}): '${owner}' is not listed by class in any module's providers. List the class itself as a provider, or pass enhancer instances to the decorators.`,
    );
  }

  /**
   * Describe the handler's parameters on its class so pipes run for them.
   * Handlers registered through the dynamic builders live on plain objects —
   * there is no class to describe, so their arguments are passed through
   * without pipes.
   */
  private defineHandlerParams(
    layout: McpHandlerLayout,
    instance: Record<string, unknown>,
    methodName: string,
  ): string | undefined {
    const providerClass = instance.constructor;
    if (typeof providerClass !== 'function' || providerClass === Object) return undefined;

    Reflect.defineMetadata(
      MCP_HANDLER_PARAMS_METADATA,
      HANDLER_PARAMS[layout],
      providerClass,
      methodName,
    );
    return MCP_HANDLER_PARAMS_METADATA;
  }
}
