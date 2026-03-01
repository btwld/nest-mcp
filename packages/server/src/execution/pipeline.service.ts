import type {
  CircuitBreakerConfig,
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
} from '@nest-mcp/common';
import type { McpGuard, McpGuardClass } from '@nest-mcp/common';
import { MCP_OPTIONS, MCP_REQUEST_CANCELLED, McpError, McpTimeoutError, ToolExecutionError } from '@nest-mcp/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ToolAuthGuardService } from '../auth/guards/tool-auth.guard';
import { McpRegistryService } from '../discovery/registry.service';
import { MiddlewareService } from '../middleware/middleware.service';
import { MetricsService } from '../observability/metrics.service';
import { CircuitBreakerService } from '../resilience/circuit-breaker.service';
import { RateLimiterService } from '../resilience/rate-limiter.service';
import { RetryService } from '../resilience/retry.service';
import { McpExecutorService } from './executor.service';
import { McpRequestContextService } from './request-context.service';

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

      // Global guards (populate user from token)
      await this.applyGlobalGuards(ctx, { toolName: name });

      // Auth check
      if (!tool.isPublic) {
        const guardContext = this.buildGuardContext(ctx, { toolName: name });
        await this.authGuard.checkAuthorization(tool, guardContext);
      }

      // Collect middleware: global + tool-level
      const middleware: McpMiddleware[] = [
        ...(this.options.middleware ?? []),
        ...(tool.middleware ?? []),
      ];

      const startTime = Date.now();

      try {
        const result = await this.middlewareService.executeChain(middleware, ctx, args, async () => {
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
        });

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
      await this.applyGlobalGuards(ctx, { promptName: name });

      if (prompt) {
        const guardContext = this.buildGuardContext(ctx, { promptName: name });
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

  async listTools(cursor?: string) {
    return this.executor.listTools(cursor);
  }

  async listResources(cursor?: string) {
    return this.executor.listResources(cursor);
  }

  async listResourceTemplates(cursor?: string) {
    return this.executor.listResourceTemplates(cursor);
  }

  async listPrompts(cursor?: string) {
    return this.executor.listPrompts(cursor);
  }

  // ---- Completions ----

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return this.executor.complete(request);
  }

  // ---- Helpers ----

  private async applyGlobalGuards(
    ctx: McpExecutionContext,
    extra: { toolName?: string; resourceUri?: string; promptName?: string },
  ): Promise<void> {
    if (!this.options.guards?.length) return;

    const guardContext = this.buildGuardContext(ctx, extra);

    for (const GuardClass of this.options.guards) {
      const guard = this.resolveGuard(GuardClass);

      if (typeof guard.canActivate === 'function') {
        await guard.canActivate(guardContext);
      }
    }

    // Sync user back to execution context after guards may have populated it
    if (guardContext.user) {
      ctx.user = guardContext.user;
    }
  }

  private resolveGuard(GuardClass: McpGuardClass): McpGuard {
    try {
      return this.moduleRef.get(GuardClass, { strict: false });
    } catch {
      // Guard not in DI — instantiate directly (for simple guards)
      return new (GuardClass as new () => McpGuard)();
    }
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
      return Promise.reject(
        new McpError('Request cancelled', MCP_REQUEST_CANCELLED),
      );
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
    extra: { toolName?: string; resourceUri?: string; promptName?: string },
  ): McpGuardContext {
    return {
      sessionId: ctx.sessionId,
      user: ctx.user,
      metadata: ctx.metadata,
      request: ctx.request,
      ...extra,
    };
  }
}
