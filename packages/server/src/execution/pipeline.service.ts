import type {
  McpExecutionContext,
  McpGuardContext,
  McpMiddleware,
  PromptGetResult,
  ResourceReadResult,
  ToolCallResult,
} from '@btwld/mcp-common';
import { MCP_OPTIONS, ToolExecutionError } from '@btwld/mcp-common';
import type { McpModuleOptions } from '@btwld/mcp-common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ToolAuthGuardService } from '../auth/guards/tool-auth.guard';
import { McpRegistryService } from '../discovery/registry.service';
import type { RegisteredTool } from '../discovery/registry.service';
import { MiddlewareService } from '../middleware/middleware.service';
import { MetricsService } from '../observability/metrics.service';
import { CircuitBreakerService } from '../resilience/circuit-breaker.service';
import { RateLimiterService } from '../resilience/rate-limiter.service';
import { RetryService } from '../resilience/retry.service';
import { McpExecutorService } from './executor.service';

@Injectable()
export class ExecutionPipelineService {
  private readonly logger = new Logger(ExecutionPipelineService.name);

  constructor(
    @Inject(McpExecutorService) private readonly executor: McpExecutorService,
    @Inject(McpRegistryService) private readonly registry: McpRegistryService,
    @Inject(ToolAuthGuardService) private readonly authGuard: ToolAuthGuardService,
    @Inject(MiddlewareService) private readonly middlewareService: MiddlewareService,
    @Inject(RateLimiterService) private readonly rateLimiter: RateLimiterService,
    @Inject(CircuitBreakerService) private readonly circuitBreaker: CircuitBreakerService,
    @Inject(RetryService) private readonly retry: RetryService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(MCP_OPTIONS) private readonly options: McpModuleOptions,
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

        return executionFn();
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

    return this.middlewareService.executeChain(middleware, ctx, { uri }, () =>
      this.executor.readResource(uri, ctx),
    ) as Promise<ResourceReadResult>;
  }

  // ---- Prompts ----

  async getPrompt(
    name: string,
    args: Record<string, unknown>,
    ctx: McpExecutionContext,
  ): Promise<PromptGetResult> {
    // Try to find prompt for auth check
    const prompt = this.registry.getPrompt(name);

    if (prompt) {
      const guardContext = this.buildGuardContext(ctx, { promptName: name });
      await this.authGuard.checkAuthorization(
        { ...prompt, isPublic: false } as unknown as RegisteredTool,
        guardContext,
      );
    }

    // Collect middleware: global only (prompts don't have per-item middleware)
    const middleware: McpMiddleware[] = [...(this.options.middleware ?? [])];

    return this.middlewareService.executeChain(middleware, ctx, args, () =>
      this.executor.getPrompt(name, args, ctx),
    ) as Promise<PromptGetResult>;
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
