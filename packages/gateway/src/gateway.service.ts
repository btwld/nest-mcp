import { McpTimeoutError, McpUpstreamError } from '@btwld/mcp-common';
import { Injectable, Logger } from '@nestjs/common';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { ResponseCacheService } from './cache/response-cache.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { PolicyEngineService } from './policies/policy-engine.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { PromptAggregatorService } from './routing/prompt-aggregator.service';
import type { AggregatedPrompt } from './routing/prompt-aggregator.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { ResourceAggregatorService } from './routing/resource-aggregator.service';
import type { AggregatedResource } from './routing/resource-aggregator.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { RouterService } from './routing/router.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { ToolAggregatorService } from './routing/tool-aggregator.service';
import type { AggregatedTool } from './routing/tool-aggregator.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { RequestTransformService } from './transform/request-transform.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { ResponseTransformService } from './transform/response-transform.service';
import type { ToolCallResponse } from './transform/response-transform.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { UpstreamManagerService } from './upstream/upstream-manager.service';

export interface GatewayCallToolResult {
  content: unknown[];
  isError?: boolean;
}

export interface GatewayReadResourceResult {
  contents: unknown[];
}

export interface GatewayGetPromptResult {
  description?: string;
  messages: unknown[];
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private readonly router: RouterService,
    private readonly toolAggregator: ToolAggregatorService,
    private readonly resourceAggregator: ResourceAggregatorService,
    private readonly promptAggregator: PromptAggregatorService,
    private readonly upstreamManager: UpstreamManagerService,
    private readonly policyEngine: PolicyEngineService,
    private readonly responseCache: ResponseCacheService,
    private readonly requestTransform: RequestTransformService,
    private readonly responseTransform: ResponseTransformService,
  ) {}

  async listTools(): Promise<AggregatedTool[]> {
    return this.toolAggregator.aggregateAll();
  }

  getCachedTools(): AggregatedTool[] {
    return this.toolAggregator.getCachedTools();
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<GatewayCallToolResult> {
    // Evaluate policy
    const policy = this.policyEngine.evaluate(toolName);

    if (policy.effect === 'deny') {
      return {
        content: [
          {
            type: 'text',
            text: `Tool "${toolName}" is denied by policy: ${policy.reason ?? 'access denied'}`,
          },
        ],
        isError: true,
      };
    }

    if (policy.effect === 'require_approval') {
      return {
        content: [
          {
            type: 'text',
            text: `Tool "${toolName}" requires approval: ${policy.reason ?? 'approval required'}`,
          },
        ],
        isError: true,
      };
    }

    // Resolve routing
    const route = this.router.resolve(toolName);
    if (!route) {
      return {
        content: [{ type: 'text', text: `No upstream found for tool "${toolName}"` }],
        isError: true,
      };
    }

    // Check cache
    const cacheKey = this.responseCache.buildKey(toolName, args);
    const cached = this.responseCache.get<GatewayCallToolResult>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for "${toolName}"`);
      return cached;
    }

    // Apply request transforms
    const request = await this.requestTransform.apply({
      toolName: route.originalToolName,
      arguments: args,
      upstreamName: route.upstreamName,
    });

    // Get the upstream client
    const client = this.upstreamManager.getClient(route.upstreamName);
    if (!client) {
      return {
        content: [
          {
            type: 'text',
            text: `Upstream "${route.upstreamName}" is not connected`,
          },
        ],
        isError: true,
      };
    }

    if (!this.upstreamManager.isHealthy(route.upstreamName)) {
      return {
        content: [
          {
            type: 'text',
            text: `Upstream "${route.upstreamName}" is unhealthy`,
          },
        ],
        isError: true,
      };
    }

    try {
      // Forward the call to the upstream
      const timeoutMs = this.upstreamManager.getConfig(route.upstreamName)?.timeout;
      const callPromise = client.callTool({
        name: request.toolName,
        arguments: request.arguments,
      });
      const result = await (timeoutMs
        ? this.withTimeout(callPromise, `callTool:${toolName}`, timeoutMs)
        : callPromise);

      // Apply response transforms
      const transformed: ToolCallResponse = await this.responseTransform.apply({
        toolName,
        upstreamName: route.upstreamName,
        content: result.content as unknown[],
        isError: result.isError as boolean | undefined,
      });

      const response: GatewayCallToolResult = {
        content: transformed.content,
        isError: transformed.isError,
      };

      // Cache the result
      if (!response.isError) {
        this.responseCache.set(cacheKey, response, toolName);
      }

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const upstreamError = new McpUpstreamError(
        route.upstreamName,
        message,
        error instanceof Error ? error : undefined,
      );
      this.logger.error(upstreamError.message);

      return {
        content: [{ type: 'text', text: `Error forwarding to upstream: ${message}` }],
        isError: true,
      };
    }
  }

  async listResources(): Promise<AggregatedResource[]> {
    return this.resourceAggregator.aggregateAll();
  }

  getCachedResources(): AggregatedResource[] {
    return this.resourceAggregator.getCachedResources();
  }

  async readResource(uri: string): Promise<GatewayReadResourceResult> {
    // Find the aggregated resource to determine the upstream
    const cached = this.resourceAggregator.getCachedResources();
    const resource = cached.find((r) => r.uri === uri);

    if (!resource) {
      return { contents: [{ uri, text: `Resource "${uri}" not found` }] };
    }

    const client = this.upstreamManager.getClient(resource.upstreamName);
    if (!client) {
      return { contents: [{ uri, text: `Upstream "${resource.upstreamName}" is not connected` }] };
    }

    if (!this.upstreamManager.isHealthy(resource.upstreamName)) {
      return { contents: [{ uri, text: `Upstream "${resource.upstreamName}" is unhealthy` }] };
    }

    try {
      const readTimeoutMs = this.upstreamManager.getConfig(resource.upstreamName)?.timeout;
      const readPromise = client.readResource({ uri: resource.originalUri });
      const result = await (readTimeoutMs
        ? this.withTimeout(readPromise, `readResource:${uri}`, readTimeoutMs)
        : readPromise);
      return { contents: result.contents as unknown[] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const upstreamError = new McpUpstreamError(
        resource.upstreamName,
        message,
        error instanceof Error ? error : undefined,
      );
      this.logger.error(upstreamError.message);
      return { contents: [{ uri, text: `Error reading resource: ${message}` }] };
    }
  }

  async listPrompts(): Promise<AggregatedPrompt[]> {
    return this.promptAggregator.aggregateAll();
  }

  getCachedPrompts(): AggregatedPrompt[] {
    return this.promptAggregator.getCachedPrompts();
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<GatewayGetPromptResult> {
    // Find the aggregated prompt to determine the upstream
    const cached = this.promptAggregator.getCachedPrompts();
    const prompt = cached.find((p) => p.name === name);

    if (!prompt) {
      return {
        messages: [
          { role: 'assistant', content: { type: 'text', text: `Prompt "${name}" not found` } },
        ],
      };
    }

    const client = this.upstreamManager.getClient(prompt.upstreamName);
    if (!client) {
      return {
        messages: [
          {
            role: 'assistant',
            content: { type: 'text', text: `Upstream "${prompt.upstreamName}" is not connected` },
          },
        ],
      };
    }

    if (!this.upstreamManager.isHealthy(prompt.upstreamName)) {
      return {
        messages: [
          {
            role: 'assistant',
            content: { type: 'text', text: `Upstream "${prompt.upstreamName}" is unhealthy` },
          },
        ],
      };
    }

    try {
      const promptTimeoutMs = this.upstreamManager.getConfig(prompt.upstreamName)?.timeout;
      const promptPromise = client.getPrompt({ name: prompt.originalName, arguments: args });
      const result = await (promptTimeoutMs
        ? this.withTimeout(promptPromise, `getPrompt:${name}`, promptTimeoutMs)
        : promptPromise);
      return {
        description: result.description,
        messages: result.messages as unknown[],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const upstreamError = new McpUpstreamError(
        prompt.upstreamName,
        message,
        error instanceof Error ? error : undefined,
      );
      this.logger.error(upstreamError.message);
      return {
        messages: [
          {
            role: 'assistant',
            content: { type: 'text', text: `Error getting prompt: ${message}` },
          },
        ],
      };
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
}
