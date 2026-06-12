import type {
  CircuitBreakerConfig,
  ClientContext,
  CompletionRequest,
  CompletionResult,
  McpExecutionContext,
  McpGuardContext,
  McpMiddleware,
  McpModuleOptions,
  PromptGetResult,
  ResourceReadResult,
  RetryConfig,
  ToolCallResult,
  ToolMetadata,
} from '@nest-mcp/common';
import {
  AuthorizationError,
  MCP_OPTIONS,
  MCP_REQUEST_CANCELLED,
  McpError,
  McpTimeoutError,
  ToolExecutionError,
  extractZodDescriptions,
  paginate,
} from '@nest-mcp/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ToolAuthGuardService } from '../auth/guards/tool-auth.guard';
import { McpRegistryService } from '../discovery/registry.service';
import { ExposureService } from '../exposure/exposure.service';
import { MiddlewareService } from '../middleware/middleware.service';
import { MetricsService } from '../observability/metrics.service';
import { CircuitBreakerService } from '../resilience/circuit-breaker.service';
import { RateLimiterService } from '../resilience/rate-limiter.service';
import { RetryService } from '../resilience/retry.service';
import { resolveGuard } from '../utils/resolve-guard.util';
import { McpExecutorService } from './executor.service';
import { McpRequestContextService } from './request-context.service';

/** Caller identity used to scope-filter list results. */
export interface ListAuthContext {
  scopes?: string[];
}

/**
 * Structural read of `requiredScopes` from a registry item. Resource and
 * prompt metadata don't declare auth fields in their interfaces (yet), but
 * the filter must honor them when present at runtime.
 */
function requiredScopesOf(item: object): string[] | undefined {
  return (item as { requiredScopes?: string[] }).requiredScopes;
}

@Injectable()
export class ExecutionPipelineService {
  private readonly logger = new Logger(ExecutionPipelineService.name);

  constructor(
    private readonly executor: McpExecutorService,
    private readonly registry: McpRegistryService,
    private readonly authGuard: ToolAuthGuardService,
    private readonly middlewareService: MiddlewareService,
    private readonly rateLimiter: RateLimiterService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly retry: RetryService,
    private readonly metrics: MetricsService,
    @Inject(MCP_OPTIONS) private readonly options: McpModuleOptions,
    private readonly moduleRef: ModuleRef,
    private readonly requestContext: McpRequestContextService,
    private readonly exposure: ExposureService,
  ) {}

  // ---- Tools ----

  async callTool(
    name: string,
    args: Record<string, unknown>,
    ctx: McpExecutionContext,
  ): Promise<ToolCallResult> {
    return this.requestContext.run(ctx, async () => {
      const tool = this.registry.getTool(name);
      if (!tool) {
        throw new ToolExecutionError(name, `Tool '${name}' not found`);
      }

      // Global guards (populate user from token, deny non-public items)
      await this.applyGlobalGuards(
        ctx,
        { toolName: name, arguments: args },
        tool.isPublic ?? false,
      );

      // Auth check
      if (!tool.isPublic) {
        const guardContext = this.buildGuardContext(ctx, { toolName: name, arguments: args });
        await this.authGuard.checkAuthorization(tool, guardContext);
      }

      // Collect middleware: global + tool-level
      const middleware: McpMiddleware[] = [
        ...(this.options.middleware ?? []),
        ...(tool.middleware ?? []),
      ];

      const startTime = Date.now();

      try {
        const result = await this.middlewareService.executeChain(
          middleware,
          ctx,
          args,
          async () => {
            // Rate limiting
            const rateLimitConfig = tool.rateLimit ?? this.options.resilience?.rateLimit;
            if (rateLimitConfig) {
              await this.rateLimiter.checkLimit(name, rateLimitConfig, ctx.user?.id);
            }

            // Resolve resilience configs
            const cbConfig = tool.circuitBreaker ?? this.options.resilience?.circuitBreaker;
            const retryConfig = tool.retry ?? this.options.resilience?.retry;

            // Build execution chain with resilience wrappers
            const baseFn = () => this.executor.callTool(name, args, ctx);
            const executionFn = this.buildExecutionChain(baseFn, name, {
              retry: retryConfig,
              circuitBreaker: cbConfig,
            });

            const timeoutMs = tool.timeout ?? this.options.resilience?.timeout;
            return timeoutMs
              ? this.withTimeout(executionFn(), name, timeoutMs, ctx.signal)
              : executionFn();
          },
        );

        const duration = Date.now() - startTime;
        this.metrics.recordCall(name, duration, true);
        return result as ToolCallResult;
      } catch (error) {
        const duration = Date.now() - startTime;
        this.metrics.recordCall(name, duration, false);
        throw error;
      }
    });
  }

  // ---- Resources ----

  async readResource(uri: string, ctx: McpExecutionContext): Promise<ResourceReadResult> {
    return this.requestContext.run(ctx, async () => {
      // Try to find resource for auth check
      const resource = this.registry.getResource(uri);

      // Global guards (populate user from token)
      await this.applyGlobalGuards(ctx, { resourceUri: uri });

      if (resource) {
        const guardContext = this.buildGuardContext(ctx, { resourceUri: uri });
        await this.authGuard.checkAuthorization(
          { ...resource, name: resource.uri, isPublic: false },
          guardContext,
        );
      }

      // Collect middleware: global only (resources don't have per-item middleware)
      const middleware: McpMiddleware[] = [...(this.options.middleware ?? [])];

      const timeoutMs = this.options.resilience?.timeout;
      return this.middlewareService.executeChain(middleware, ctx, { uri }, () => {
        const promise = this.executor.readResource(uri, ctx);
        return timeoutMs
          ? this.withTimeout(promise, `resource:${uri}`, timeoutMs, ctx.signal)
          : promise;
      }) as Promise<ResourceReadResult>;
    });
  }

  // ---- Prompts ----

  async getPrompt(
    name: string,
    args: Record<string, unknown>,
    ctx: McpExecutionContext,
  ): Promise<PromptGetResult> {
    return this.requestContext.run(ctx, async () => {
      // Try to find prompt for auth check
      const prompt = this.registry.getPrompt(name);

      // Global guards (populate user from token)
      await this.applyGlobalGuards(ctx, { promptName: name, arguments: args });

      if (prompt) {
        const guardContext = this.buildGuardContext(ctx, { promptName: name, arguments: args });
        await this.authGuard.checkAuthorization({ ...prompt, isPublic: false }, guardContext);
      }

      // Collect middleware: global only (prompts don't have per-item middleware)
      const middleware: McpMiddleware[] = [...(this.options.middleware ?? [])];

      const promptTimeoutMs = this.options.resilience?.timeout;
      return this.middlewareService.executeChain(middleware, ctx, args, () => {
        const promise = this.executor.getPrompt(name, args, ctx);
        return promptTimeoutMs
          ? this.withTimeout(promise, `prompt:${name}`, promptTimeoutMs, ctx.signal)
          : promise;
      }) as Promise<PromptGetResult>;
    });
  }

  // ---- List methods (delegate directly) ----

  async listTools(cursor?: string, ctx?: ClientContext, auth?: ListAuthContext) {
    const filterByScopes = this.options.filterListsByScopes === true;
    if (!ctx && !filterByScopes) {
      return this.executor.listTools(cursor);
    }
    // When a client context is supplied, apply the exposure strategy before
    // paginating so filtered strategies (e.g. `lazy`) produce even page sizes.
    const entries = this.executor.buildToolEntries();
    const metaMap = new Map<string, ToolMetadata>(
      this.registry.getAllTools().map((t) => [t.name, t]),
    );
    const shaped = ctx ? this.exposure.applyStrategy(entries, metaMap, ctx) : entries;
    // Meta-tools injected by exposure strategies have no registry meta (and
    // thus no requiredScopes), so they survive the scope filter.
    const visible = filterByScopes
      ? shaped.filter((entry) =>
          this.hasRequiredScopes(metaMap.get(entry.name)?.requiredScopes, auth?.scopes),
        )
      : shaped;
    return paginate(visible, cursor, this.options.pagination?.defaultPageSize);
  }

  async listResources(cursor?: string, auth?: ListAuthContext) {
    if (!this.options.filterListsByScopes) {
      return this.executor.listResources(cursor);
    }
    // Mirrors McpExecutorService.listResources, with scope filtering applied
    // before pagination so pages stay evenly sized.
    const entries = this.registry
      .getAllResources()
      .filter((r) => this.hasRequiredScopes(requiredScopesOf(r), auth?.scopes))
      .map((r) => ({
        uri: r.uri,
        name: r.name,
        ...(r.title != null ? { title: r.title } : {}),
        ...(r.description ? { description: r.description } : {}),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        ...(r.icons ? { icons: r.icons } : {}),
        ...(r._meta ? { _meta: r._meta } : {}),
      }));
    return paginate(entries, cursor, this.options.pagination?.defaultPageSize);
  }

  async listResourceTemplates(cursor?: string, auth?: ListAuthContext) {
    if (!this.options.filterListsByScopes) {
      return this.executor.listResourceTemplates(cursor);
    }
    // Mirrors McpExecutorService.listResourceTemplates with scope filtering.
    const entries = this.registry
      .getAllResourceTemplates()
      .filter((t) => this.hasRequiredScopes(requiredScopesOf(t), auth?.scopes))
      .map((t) => ({
        uriTemplate: t.uriTemplate,
        name: t.name,
        ...(t.title != null ? { title: t.title } : {}),
        ...(t.description ? { description: t.description } : {}),
        ...(t.mimeType ? { mimeType: t.mimeType } : {}),
        ...(t.icons ? { icons: t.icons } : {}),
        ...(t._meta ? { _meta: t._meta } : {}),
      }));
    return paginate(entries, cursor, this.options.pagination?.defaultPageSize);
  }

  async listPrompts(cursor?: string, auth?: ListAuthContext) {
    if (!this.options.filterListsByScopes) {
      return this.executor.listPrompts(cursor);
    }
    // Mirrors McpExecutorService.listPrompts with scope filtering.
    const entries = this.registry
      .getAllPrompts()
      .filter((p) => this.hasRequiredScopes(requiredScopesOf(p), auth?.scopes))
      .map((p) => ({
        name: p.name,
        ...(p.title != null ? { title: p.title } : {}),
        description: p.description,
        ...(p.parameters
          ? {
              arguments: extractZodDescriptions(p.parameters).map((arg) => ({
                name: arg.name,
                description: arg.description,
                required: arg.required,
              })),
            }
          : {}),
        ...(p.icons ? { icons: p.icons } : {}),
        ...(p._meta ? { _meta: p._meta } : {}),
      }));
    return paginate(entries, cursor, this.options.pagination?.defaultPageSize);
  }

  // ---- Completions ----

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return this.executor.complete(request);
  }

  // ---- Helpers ----

  /**
   * Runs the module-level guards. Guards always execute (they may enrich the
   * context, e.g. populate `user`), but a `false` result only denies
   * non-public items — `@Public` capabilities stay reachable anonymously.
   */
  private async applyGlobalGuards(
    ctx: McpExecutionContext,
    extra: {
      toolName?: string;
      resourceUri?: string;
      promptName?: string;
      arguments?: Record<string, unknown>;
    },
    itemIsPublic = false,
  ): Promise<void> {
    if (!this.options.guards?.length) return;

    const guardContext = this.buildGuardContext(ctx, extra);

    for (const GuardClass of this.options.guards) {
      const guard = resolveGuard(this.moduleRef, GuardClass);

      if (typeof guard.canActivate === 'function') {
        const allowed = await guard.canActivate(guardContext);
        if (allowed === false && !itemIsPublic) {
          throw new AuthorizationError(`Access denied by guard: ${GuardClass.name || 'anonymous'}`);
        }
      }
    }

    // Sync user back to execution context after guards may have populated it
    if (guardContext.user) {
      ctx.user = guardContext.user;
    }
  }

  /**
   * True when the caller's granted scopes cover the item's required scopes.
   * Items without required scopes are visible to everyone, including
   * unauthenticated callers.
   */
  private hasRequiredScopes(
    requiredScopes: string[] | undefined,
    grantedScopes: string[] | undefined,
  ): boolean {
    if (!requiredScopes?.length) return true;
    const granted = grantedScopes ?? [];
    return requiredScopes.every((scope) => granted.includes(scope));
  }

  private buildExecutionChain(
    baseFn: () => Promise<ToolCallResult>,
    name: string,
    config: { retry?: RetryConfig; circuitBreaker?: CircuitBreakerConfig },
  ): () => Promise<ToolCallResult> {
    const { retry, circuitBreaker } = config;
    const withRetry = retry ? () => this.retry.execute(name, retry, baseFn) : baseFn;
    const withCircuitBreaker = circuitBreaker
      ? () => this.circuitBreaker.execute(name, circuitBreaker, withRetry)
      : withRetry;

    return withCircuitBreaker;
  }

  private withTimeout<T>(
    promise: Promise<T>,
    operationName: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    // If already aborted, reject immediately
    if (signal?.aborted) {
      return Promise.reject(new McpError('Request cancelled', MCP_REQUEST_CANCELLED));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new McpTimeoutError(operationName, timeoutMs)),
        timeoutMs,
      );

      // Listen for cancellation signal
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new McpError('Request cancelled', MCP_REQUEST_CANCELLED));
        },
        { once: true },
      );

      promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  private buildGuardContext(
    ctx: McpExecutionContext,
    extra: {
      toolName?: string;
      resourceUri?: string;
      promptName?: string;
      arguments?: Record<string, unknown>;
    },
  ): McpGuardContext {
    return {
      sessionId: ctx.sessionId,
      user: ctx.user,
      metadata: ctx.metadata,
      request: ctx.request,
      authInfo: ctx.authInfo,
      ...extra,
    };
  }
}
