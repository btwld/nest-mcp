import {
  McpTimeoutError,
  McpUpstreamError,
  type ElicitRequest,
  type ElicitResult,
  type McpSamplingParams,
  type McpSamplingResult,
  type PromptMessage,
  type ResourceContent,
  type ToolContent,
  expandUriTemplate,
  matchUriTemplate,
} from '@btwld/mcp-common';
import { Injectable, Logger } from '@nestjs/common';
import { ResponseCacheService } from './cache/response-cache.service';
import { PolicyEngineService } from './policies/policy-engine.service';
import type { PolicyContext, PolicyEffect } from './policies/policy.interface';
import { PromptAggregatorService } from './routing/prompt-aggregator.service';
import type { AggregatedPrompt } from './routing/prompt-aggregator.service';
import { ResourceAggregatorService } from './routing/resource-aggregator.service';
import type { AggregatedResource } from './routing/resource-aggregator.service';
import { ResourceTemplateAggregatorService } from './routing/resource-template-aggregator.service';
import type { AggregatedResourceTemplate } from './routing/resource-template-aggregator.service';
import { RouterService } from './routing/router.service';
import { ToolAggregatorService } from './routing/tool-aggregator.service';
import type { AggregatedTool } from './routing/tool-aggregator.service';
import { RequestTransformService } from './transform/request-transform.service';
import { ResponseTransformService } from './transform/response-transform.service';
import type { ToolCallResponse } from './transform/response-transform.service';
import { UpstreamManagerService } from './upstream/upstream-manager.service';
import { extractErrorMessage } from './utils/error-utils';

export interface GatewayCallToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface GatewayReadResourceResult {
  contents: ResourceContent[];
}

export interface GatewayGetPromptResult {
  description?: string;
  messages: PromptMessage[];
}

export interface GatewayCompleteResult {
  values: string[];
  hasMore?: boolean;
  total?: number;
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  private static readonly policyDenialHandlers = new Map<
    PolicyEffect,
    (toolName: string, reason?: string) => GatewayCallToolResult | undefined
  >([
    [
      'deny',
      (toolName, reason) => ({
        content: [
          {
            type: 'text' as const,
            text: `Tool "${toolName}" is denied by policy: ${reason ?? 'access denied'}`,
          },
        ],
        isError: true,
      }),
    ],
    [
      'require_approval',
      (toolName, reason) => ({
        content: [
          {
            type: 'text' as const,
            text: `Tool "${toolName}" requires approval: ${reason ?? 'approval required'}`,
          },
        ],
        isError: true,
      }),
    ],
  ]);

  constructor(
    private readonly router: RouterService,
    private readonly toolAggregator: ToolAggregatorService,
    private readonly resourceAggregator: ResourceAggregatorService,
    private readonly promptAggregator: PromptAggregatorService,
    private readonly resourceTemplateAggregator: ResourceTemplateAggregatorService,
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

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    context?: PolicyContext,
    signal?: AbortSignal,
    createMessage?: (params: McpSamplingParams) => Promise<McpSamplingResult>,
    elicit?: (params: ElicitRequest, options?: { signal?: AbortSignal }) => Promise<ElicitResult>,
  ): Promise<GatewayCallToolResult> {
    // Evaluate policy
    const policy = this.policyEngine.evaluate(toolName, context);
    const denial = GatewayService.policyDenialHandlers.get(policy.effect)?.(
      toolName,
      policy.reason,
    );
    if (denial) return denial;

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

    if (createMessage) {
      this.upstreamManager.activateSampling(route.upstreamName, createMessage);
    }
    if (elicit) {
      this.upstreamManager.activateElicitation(route.upstreamName, elicit);
    }

    try {
      // Forward the call to the upstream
      const timeoutMs = this.upstreamManager.getConfig(route.upstreamName)?.timeout;
      const callPromise = client.callTool(
        { name: request.toolName, arguments: request.arguments },
        undefined,
        signal ? { signal } : undefined,
      );
      const result = await (timeoutMs
        ? this.withTimeout(callPromise, `callTool:${toolName}`, timeoutMs)
        : callPromise);

      // Apply response transforms
      const transformed: ToolCallResponse = await this.responseTransform.apply({
        toolName,
        upstreamName: route.upstreamName,
        content: result.content as ToolContent[],
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
      const message = extractErrorMessage(error);
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
    } finally {
      if (createMessage) {
        this.upstreamManager.deactivateSampling(route.upstreamName);
      }
      if (elicit) {
        this.upstreamManager.deactivateElicitation(route.upstreamName);
      }
    }
  }

  async listResources(): Promise<AggregatedResource[]> {
    return this.resourceAggregator.aggregateAll();
  }

  getCachedResources(): AggregatedResource[] {
    return this.resourceAggregator.getCachedResources();
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<GatewayReadResourceResult> {
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
      const readPromise = client.readResource(
        { uri: resource.originalUri },
        signal ? { signal } : undefined,
      );
      const result = await (readTimeoutMs
        ? this.withTimeout(readPromise, `readResource:${uri}`, readTimeoutMs)
        : readPromise);
      return { contents: result.contents as ResourceContent[] };
    } catch (error) {
      const message = extractErrorMessage(error);
      const upstreamError = new McpUpstreamError(
        resource.upstreamName,
        message,
        error instanceof Error ? error : undefined,
      );
      this.logger.error(upstreamError.message);
      return { contents: [{ uri, text: `Error reading resource: ${message}` }] };
    }
  }

  /**
   * Read a resource template URI by matching against cached templates and
   * forwarding to the appropriate upstream, stripping any gateway-added prefix
   * by re-expanding with the original upstream URI template.
   */
  async readResourceTemplate(uri: string, signal?: AbortSignal): Promise<GatewayReadResourceResult> {
    const templates = this.resourceTemplateAggregator.getCachedTemplates();

    for (const template of templates) {
      const match = matchUriTemplate(template.uriTemplate, uri);
      if (!match) continue;

      const client = this.upstreamManager.getClient(template.upstreamName);
      if (!client) {
        return { contents: [{ uri, text: `Upstream "${template.upstreamName}" is not connected` }] };
      }

      if (!this.upstreamManager.isHealthy(template.upstreamName)) {
        return { contents: [{ uri, text: `Upstream "${template.upstreamName}" is unhealthy` }] };
      }

      try {
        const originalUri = expandUriTemplate(template.originalUriTemplate, match.params);
        const timeoutMs = this.upstreamManager.getConfig(template.upstreamName)?.timeout;
        const readPromise = client.readResource(
          { uri: originalUri },
          signal ? { signal } : undefined,
        );
        const result = await (timeoutMs
          ? this.withTimeout(readPromise, `readResourceTemplate:${uri}`, timeoutMs)
          : readPromise);
        return { contents: result.contents as ResourceContent[] };
      } catch (error) {
        const message = extractErrorMessage(error);
        const upstreamError = new McpUpstreamError(
          template.upstreamName,
          message,
          error instanceof Error ? error : undefined,
        );
        this.logger.error(upstreamError.message);
        return { contents: [{ uri, text: `Error reading resource template: ${message}` }] };
      }
    }

    return { contents: [{ uri, text: `No resource template matched URI: ${uri}` }] };
  }

  async listPrompts(): Promise<AggregatedPrompt[]> {
    return this.promptAggregator.aggregateAll();
  }

  getCachedPrompts(): AggregatedPrompt[] {
    return this.promptAggregator.getCachedPrompts();
  }

  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<GatewayGetPromptResult> {
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
      const promptPromise = client.getPrompt(
        { name: prompt.originalName, arguments: args },
        signal ? { signal } : undefined,
      );
      const result = await (promptTimeoutMs
        ? this.withTimeout(promptPromise, `getPrompt:${name}`, promptTimeoutMs)
        : promptPromise);
      return {
        description: result.description,
        messages: result.messages as PromptMessage[],
      };
    } catch (error) {
      const message = extractErrorMessage(error);
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

  async listResourceTemplates(): Promise<AggregatedResourceTemplate[]> {
    return this.resourceTemplateAggregator.aggregateAll();
  }

  getCachedResourceTemplates(): AggregatedResourceTemplate[] {
    return this.resourceTemplateAggregator.getCachedTemplates();
  }

  async complete(
    ref: { type: string; name?: string; uri?: string },
    argument: { name: string; value: string },
  ): Promise<GatewayCompleteResult> {
    try {
      if (ref.type === 'ref/prompt' && ref.name) {
        return await this.completePrompt(ref.name, argument);
      }

      if (ref.type === 'ref/resource' && ref.uri) {
        return await this.completeResourceTemplate(ref.uri, argument);
      }

      return { values: [] };
    } catch (error) {
      this.logger.error(`Completion error: ${extractErrorMessage(error)}`);
      return { values: [] };
    }
  }

  private async completePrompt(
    name: string,
    argument: { name: string; value: string },
  ): Promise<GatewayCompleteResult> {
    const cached = this.promptAggregator.getCachedPrompts();
    const prompt = cached.find((p) => p.name === name);
    if (!prompt) return { values: [] };

    const client = this.upstreamManager.getClient(prompt.upstreamName);
    if (!client) return { values: [] };

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: prompt.originalName },
      argument,
    });

    return {
      values: result.completion.values,
      hasMore: result.completion.hasMore,
      total: result.completion.total,
    };
  }

  private async completeResourceTemplate(
    uri: string,
    argument: { name: string; value: string },
  ): Promise<GatewayCompleteResult> {
    const cached = this.resourceTemplateAggregator.getCachedTemplates();
    const template = cached.find((t) => t.uriTemplate === uri);
    if (!template) return { values: [] };

    const client = this.upstreamManager.getClient(template.upstreamName);
    if (!client) return { values: [] };

    const result = await client.complete({
      ref: { type: 'ref/resource', uri: template.originalUriTemplate },
      argument,
    });

    return {
      values: result.completion.values,
      hasMore: result.completion.hasMore,
      total: result.completion.total,
    };
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
