import type {
  McpExecutionContext,
  McpGuardContext,
  McpMiddleware,
  PromptGetResult,
  ResourceReadResult,
  ToolCallResult,
} from '@btwld/mcp-common';
import { MCP_OPTIONS, McpTimeoutError, ToolExecutionError } from '@btwld/mcp-common';
import type { McpModuleOptions } from '@btwld/mcp-common';
import { Inject, Injectable, Logger } from '@nestjs/common';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { ModuleRef } from '@nestjs/core';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { ToolAuthGuardService } from '../auth/guards/tool-auth.guard';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { McpRegistryService } from '../discovery/registry.service';
import type { RegisteredTool } from '../discovery/registry.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { MiddlewareService } from '../middleware/middleware.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { MetricsService } from '../observability/metrics.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { CircuitBreakerService } from '../resilience/circuit-breaker.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { RateLimiterService } from '../resilience/rate-limiter.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { RetryService } from '../resilience/retry.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { McpExecutorService } from './executor.service';

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
  ) {}

  // ---- Tools ----

  async callTool(
    name: string,
    args: Record<string, unknown>,
    ctx: McpExecutionContext,
  ): Promise<ToolCallResult> {
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
    let success = true;

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

        // Build execution function
        let executionFn = () => this.executor.callTool(name, args, ctx);

        // Wrap with retry if configured
        if (retryConfig) {
          const innerFn = executionFn;
          executionFn = () => this.retry.execute(name, retryConfig, innerFn);
        }

        // Wrap with circuit breaker if configured
        if (cbConfig) {
          const innerFn = executionFn;
          executionFn = () => this.circuitBreaker.execute(name, cbConfig, innerFn);
        }

        const timeoutMs = tool.timeout ?? this.options.resilience?.timeout;
        return timeoutMs ? this.withTimeout(executionFn(), name, timeoutMs) : executionFn();
      });

      return result as ToolCallResult;
    } catch (error) {
      success = false;
      throw error;
    } finally {
      const duration = Date.now() - startTime;
      this.metrics.recordCall(name, duration, success);
    }
  }

  // ---- Resources ----

  async readResource(uri: string, ctx: McpExecutionContext): Promise<ResourceReadResult> {
    // Try to find resource for auth check
    const resource = this.registry.getResource(uri);

    // Global guards (populate user from token)
    await this.applyGlobalGuards(ctx, { resourceUri: uri });

    if (resource) {
      const guardContext = this.buildGuardContext(ctx, { resourceUri: uri });
      // Resources use the same auth guard with a tool-like shape
      await this.authGuard.checkAuthorization(
        { ...resource, name: resource.uri, isPublic: false } as unknown as RegisteredTool,
        guardContext,
      );
    }

    // Collect middleware: global only (resources don't have per-item middleware)
    const middleware: McpMiddleware[] = [...(this.options.middleware ?? [])];

    const timeoutMs = this.options.resilience?.timeout;
    return this.middlewareService.executeChain(middleware, ctx, { uri }, () => {
      const promise = this.executor.readResource(uri, ctx);
      return timeoutMs ? this.withTimeout(promise, `resource:${uri}`, timeoutMs) : promise;
    }) as Promise<ResourceReadResult>;
  }

  // ---- Prompts ----

  async getPrompt(
    name: string,
    args: Record<string, unknown>,
    ctx: McpExecutionContext,
  ): Promise<PromptGetResult> {
    // Try to find prompt for auth check
    const prompt = this.registry.getPrompt(name);

    // Global guards (populate user from token)
    await this.applyGlobalGuards(ctx, { promptName: name });

    if (prompt) {
      const guardContext = this.buildGuardContext(ctx, { promptName: name });
      await this.authGuard.checkAuthorization(
        { ...prompt, isPublic: false } as unknown as RegisteredTool,
        guardContext,
      );
    }

    // Collect middleware: global only (prompts don't have per-item middleware)
    const middleware: McpMiddleware[] = [...(this.options.middleware ?? [])];

    const promptTimeoutMs = this.options.resilience?.timeout;
    return this.middlewareService.executeChain(middleware, ctx, args, () => {
      const promise = this.executor.getPrompt(name, args, ctx);
      return promptTimeoutMs
        ? this.withTimeout(promise, `prompt:${name}`, promptTimeoutMs)
        : promise;
    }) as Promise<PromptGetResult>;
  }

  // ---- List methods (delegate directly) ----

  async listTools() {
    return this.executor.listTools();
  }

  async listResources() {
    return this.executor.listResources();
  }

  async listResourceTemplates() {
    return this.executor.listResourceTemplates();
  }

  async listPrompts() {
    return this.executor.listPrompts();
  }

  // ---- Helpers ----

  private async applyGlobalGuards(
    ctx: McpExecutionContext,
    extra: { toolName?: string; resourceUri?: string; promptName?: string },
  ): Promise<void> {
    if (!this.options.guards?.length) return;

    const guardContext = this.buildGuardContext(ctx, extra);

    for (const GuardClass of this.options.guards) {
      // biome-ignore lint/suspicious/noExplicitAny: Guard classes have varying constructor signatures
      let guard: any;
      try {
        guard = this.moduleRef.get(GuardClass, { strict: false });
      } catch {
        // Guard not in DI — instantiate directly (for simple guards)
        // biome-ignore lint/suspicious/noExplicitAny: Guard classes have varying constructor signatures
        guard = new (GuardClass as any)();
      }

      if (typeof guard.canActivate === 'function') {
        await guard.canActivate(guardContext);
      }
    }

    // Sync user back to execution context after guards may have populated it
    if (guardContext.user) {
      ctx.user = guardContext.user;
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    operationName: string,
    timeoutMs: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new McpTimeoutError(operationName, timeoutMs)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
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
