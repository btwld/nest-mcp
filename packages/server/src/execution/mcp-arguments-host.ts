import { AsyncLocalStorage } from 'node:async_hooks';
import { McpError, type McpExecutionContext } from '@nest-mcp/common';
import type { ArgumentsHost, ContextType } from '@nestjs/common';

/**
 * Value returned by `context.getType()` when a NestJS enhancer (guard,
 * interceptor, pipe or exception filter) runs for an MCP capability call.
 */
export const MCP_CONTEXT_TYPE = 'mcp';

/**
 * Context-type union for `context.getType<McpContextType>()`, so comparing the
 * result with `'mcp'` type-checks alongside Nest's built-in context types.
 */
export type McpContextType = ContextType | typeof MCP_CONTEXT_TYPE;

/** The kind of capability being executed. Resource templates report `'resource'`. */
export type McpCapabilityKind = 'tool' | 'resource' | 'prompt';

/** Identity of the capability call currently running through the enhancer pipeline. */
export interface McpCapabilityCall {
  kind: McpCapabilityKind;
  /** Tool or prompt name; for resources, the requested URI. */
  name: string;
}

const activeCall = new AsyncLocalStorage<McpCapabilityCall>();

/**
 * Run `fn` with `call` as the active capability call, so enhancers invoked
 * underneath can read it through {@link McpArgumentsHost}.
 *
 * @internal
 */
export function runMcpCapabilityCall<T>(call: McpCapabilityCall, fn: () => T): T {
  return activeCall.run(call, fn);
}

/**
 * Typed view over the Nest `ExecutionContext` / `ArgumentsHost` of an MCP
 * capability call. Use it inside guards, interceptors and exception filters
 * instead of indexing into `context.getArgs()`:
 *
 * ```typescript
 * canActivate(context: ExecutionContext) {
 *   if (context.getType<McpContextType>() !== 'mcp') return true;
 *   const mcp = McpArgumentsHost.create(context);
 *   return mcp.getKind() !== 'tool' || mcp.getContext().user?.roles?.includes('admin') === true;
 * }
 * ```
 */
export class McpArgumentsHost {
  constructor(
    private readonly call: McpCapabilityCall,
    private readonly handlerArgs: readonly unknown[],
  ) {}

  /**
   * Build the MCP view for `host`. Throws when `host` is not an MCP context —
   * check `host.getType<McpContextType>() === 'mcp'` first in enhancers shared
   * with HTTP or other transports.
   */
  static create(host: ArgumentsHost): McpArgumentsHost {
    const type = host.getType<string>();
    if (type !== MCP_CONTEXT_TYPE) {
      throw new McpError(
        `McpArgumentsHost.create() requires an '${MCP_CONTEXT_TYPE}' context but received '${type}'`,
      );
    }
    const call = activeCall.getStore();
    if (!call) {
      throw new McpError('McpArgumentsHost.create() was called outside of an MCP capability call');
    }
    return new McpArgumentsHost(call, host.getArgs());
  }

  /** `'tool'`, `'resource'` (including resource templates) or `'prompt'`. */
  getKind(): McpCapabilityKind {
    return this.call.kind;
  }

  /** Tool or prompt name; for resources, the requested URI. */
  getName(): string {
    return this.call.name;
  }

  /**
   * Input of the call: the validated arguments of a tool or prompt, or the URI
   * template variables of a resource (empty for fixed-URI resources).
   */
  getArgs<T = Record<string, unknown>>(): T {
    if (this.call.kind !== 'resource') return this.handlerArgs[0] as T;
    // Resource handlers are `(uri, ctx)`; template handlers `(uri, params, ctx)`.
    return (this.handlerArgs.length > 2 ? this.handlerArgs[1] : {}) as T;
  }

  /** The per-call execution context — the same object the handler receives. */
  getContext(): McpExecutionContext {
    return this.handlerArgs[this.handlerArgs.length - 1] as McpExecutionContext;
  }
}
