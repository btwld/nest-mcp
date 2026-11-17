import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  type ElicitRequest,
  type ElicitResult,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  McpError,
  type McpProgress,
  type McpSamplingParams,
  type McpSamplingResult,
  McpUpstreamError,
  type PromptMessage,
  type ResourceContent,
  type ToolContent,
  expandUriTemplate,
  matchUriTemplate,
} from '@nest-mcp/common';
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

/** MCP error code for `resources/read` on a URI the server does not know. */
export const MCP_RESOURCE_NOT_FOUND_CODE = -32002;

/** SDK error code raised when an upstream request exceeds its timeout. */
const SDK_REQUEST_TIMEOUT_CODE = -32001;

export interface GatewayCallToolResult {
  content: ToolContent[];
  isError?: boolean;
  /** Structured result returned by the upstream (required when the tool advertises an `outputSchema`). */
  structuredContent?: Record<string, unknown>;
  /** Upstream result metadata, passed through unchanged. */
  _meta?: Record<string, unknown>;
}

/** Optional per-call hooks for {@link GatewayService.callTool}. */
export interface GatewayCallToolOptions {
  /**
   * Receives upstream `notifications/progress` for this call. When set, the
   * gateway asks the upstream for progress and resets the upstream timeout
   * each time progress arrives.
   */
  onProgress?: (progress: McpProgress) => Promise<void> | void;
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

/** Completion context forwarded to the upstream (`context.arguments` holds already-resolved arguments). */
export interface GatewayCompleteContext {
  arguments?: Record<string, string>;
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'number' && Number.isSafeInteger(code) ? code : undefined;
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: routing through multiple upstream strategies with prefix handling requires branching
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    context?: PolicyContext,
    signal?: AbortSignal,
    createMessage?: (params: McpSamplingParams) => Promise<McpSamplingResult>,
    elicit?: (params: ElicitRequest, options?: { signal?: AbortSignal }) => Promise<ElicitResult>,
    options?: GatewayCallToolOptions,
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
      const result = await client.callTool(
        { name: request.toolName, arguments: request.arguments },
        undefined,
        this.buildRequestOptions(route.upstreamName, signal, options?.onProgress),
      );

      // Apply response transforms
      const transformed: ToolCallResponse = await this.responseTransform.apply({
        toolName,
        upstreamName: route.upstreamName,
        content: result.content as ToolContent[],
        isError: result.isError as boolean | undefined,
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent as Record<string, unknown> }
          : {}),
        ...(result._meta !== undefined ? { _meta: result._meta as Record<string, unknown> } : {}),
      });

      const response: GatewayCallToolResult = {
        content: transformed.content,
        isError: transformed.isError,
        ...(transformed.structuredContent !== undefined
          ? { structuredContent: transformed.structuredContent }
          : {}),
        ...(transformed._meta !== undefined ? { _meta: transformed._meta } : {}),
      };

      // Cache the result
      if (!response.isError) {
        this.responseCache.set(cacheKey, response, toolName);
      }

      return response;
    } catch (error) {
      const message = this.describeUpstreamFailure(route.upstreamName, error);
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

  /**
   * Read a gateway resource URI from its upstream.
   *
   * Throws an {@link McpError} on failure: code `-32002` (with `data.uri`)
   * when the resource is unknown to the gateway or the upstream reports it as
   * not found, the upstream's `-32602` when it rejects the request, and
   * `-32603` for every other upstream failure (disconnected, unhealthy,
   * timed out, errored).
   */
  async readResource(uri: string, signal?: AbortSignal): Promise<GatewayReadResourceResult> {
    // Find the aggregated resource to determine the upstream
    const cached = this.resourceAggregator.getCachedResources();
    const resource = cached.find((r) => r.uri === uri);

    if (!resource) {
      throw this.resourceNotFound(uri);
    }

    return this.readFromUpstream(resource.upstreamName, uri, resource.originalUri, signal);
  }

  /**
   * Read a resource template URI by matching against cached templates and
   * forwarding to the appropriate upstream, stripping any gateway-added prefix
   * by re-expanding with the original upstream URI template.
   *
   * Errors follow the same contract as {@link readResource}.
   */
  async readResourceTemplate(
    uri: string,
    signal?: AbortSignal,
  ): Promise<GatewayReadResourceResult> {
    const templates = this.resourceTemplateAggregator.getCachedTemplates();

    for (const template of templates) {
      const match = matchUriTemplate(template.uriTemplate, uri);
      if (!match) continue;

      const originalUri = expandUriTemplate(template.originalUriTemplate, match.params);
      return this.readFromUpstream(template.upstreamName, uri, originalUri, signal);
    }

    throw this.resourceNotFound(uri);
  }

  private async readFromUpstream(
    upstreamName: string,
    uri: string,
    originalUri: string,
    signal?: AbortSignal,
  ): Promise<GatewayReadResourceResult> {
    const client = this.requireUsableClient(upstreamName);

    let result: Awaited<ReturnType<typeof client.readResource>>;
    try {
      result = await client.readResource(
        { uri: originalUri },
        this.buildRequestOptions(upstreamName, signal),
      );
    } catch (error) {
      const code = errorCode(error);
      if (code === MCP_RESOURCE_NOT_FOUND_CODE) {
        throw this.resourceNotFound(uri);
      }
      const message = this.describeUpstreamFailure(upstreamName, error);
      this.logger.error(`Upstream '${upstreamName}' error reading "${uri}": ${message}`);
      throw new McpError(
        `Upstream "${upstreamName}" failed to read resource "${uri}": ${message}`,
        code === JSON_RPC_INVALID_PARAMS ? JSON_RPC_INVALID_PARAMS : JSON_RPC_INTERNAL_ERROR,
        { uri, upstream: upstreamName },
      );
    }

    // Rewrite upstream URIs back into the gateway's (prefixed) URI space so
    // clients can correlate contents with the URI they requested.
    const prefix = uri.endsWith(originalUri) ? uri.slice(0, uri.length - originalUri.length) : '';
    const contents = (result.contents as ResourceContent[]).map((content) => ({
      ...content,
      uri: content.uri === originalUri ? uri : `${prefix}${content.uri}`,
    }));
    return { contents };
  }

  async listPrompts(): Promise<AggregatedPrompt[]> {
    return this.promptAggregator.aggregateAll();
  }

  getCachedPrompts(): AggregatedPrompt[] {
    return this.promptAggregator.getCachedPrompts();
  }

  /**
   * Fetch a prompt from its upstream, forwarding `args` unchanged.
   *
   * Throws an {@link McpError} on failure: `-32602` when the prompt is
   * unknown or the upstream rejects the arguments, `-32603` for every other
   * upstream failure.
   */
  async getPrompt(
    name: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GatewayGetPromptResult> {
    // Find the aggregated prompt to determine the upstream
    const cached = this.promptAggregator.getCachedPrompts();
    const prompt = cached.find((p) => p.name === name);

    if (!prompt) {
      throw new McpError(`Prompt "${name}" not found`, JSON_RPC_INVALID_PARAMS, { name });
    }

    const client = this.requireUsableClient(prompt.upstreamName);

    try {
      const result = await client.getPrompt(
        { name: prompt.originalName, arguments: args },
        this.buildRequestOptions(prompt.upstreamName, signal),
      );
      return {
        ...(result.description !== undefined ? { description: result.description } : {}),
        messages: result.messages as PromptMessage[],
      };
    } catch (error) {
      const message = this.describeUpstreamFailure(prompt.upstreamName, error);
      this.logger.error(`Upstream '${prompt.upstreamName}' error getting "${name}": ${message}`);
      throw new McpError(
        `Upstream "${prompt.upstreamName}" failed to get prompt "${name}": ${message}`,
        errorCode(error) === JSON_RPC_INVALID_PARAMS
          ? JSON_RPC_INVALID_PARAMS
          : JSON_RPC_INTERNAL_ERROR,
        { name, upstream: prompt.upstreamName },
      );
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
    context?: GatewayCompleteContext,
  ): Promise<GatewayCompleteResult> {
    try {
      if (ref.type === 'ref/prompt' && ref.name) {
        return await this.completePrompt(ref.name, argument, context);
      }

      if (ref.type === 'ref/resource' && ref.uri) {
        return await this.completeResourceTemplate(ref.uri, argument, context);
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
    context?: GatewayCompleteContext,
  ): Promise<GatewayCompleteResult> {
    const cached = this.promptAggregator.getCachedPrompts();
    const prompt = cached.find((p) => p.name === name);
    if (!prompt) return { values: [] };

    return this.completeOnUpstream(
      prompt.upstreamName,
      { type: 'ref/prompt', name: prompt.originalName },
      argument,
      context,
    );
  }

  private async completeResourceTemplate(
    uri: string,
    argument: { name: string; value: string },
    context?: GatewayCompleteContext,
  ): Promise<GatewayCompleteResult> {
    const cached = this.resourceTemplateAggregator.getCachedTemplates();
    const template = cached.find((t) => t.uriTemplate === uri);
    if (!template) return { values: [] };

    return this.completeOnUpstream(
      template.upstreamName,
      { type: 'ref/resource', uri: template.originalUriTemplate },
      argument,
      context,
    );
  }

  private async completeOnUpstream(
    upstreamName: string,
    ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string },
    argument: { name: string; value: string },
    context?: GatewayCompleteContext,
  ): Promise<GatewayCompleteResult> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client) return { values: [] };

    const requestOptions = this.buildRequestOptions(upstreamName);
    const params = {
      ref,
      argument,
      ...(context?.arguments ? { context: { arguments: context.arguments } } : {}),
    };
    const result = requestOptions
      ? await client.complete(params, requestOptions)
      : await client.complete(params);

    return {
      values: result.completion.values,
      hasMore: result.completion.hasMore,
      total: result.completion.total,
    };
  }

  /**
   * SDK request options for an upstream call: the downstream cancellation
   * signal (aborting it sends `notifications/cancelled` upstream), the
   * configured upstream `timeout` (the SDK cancels the upstream request when
   * it elapses; without it the SDK default of 60 s applies) and, when the
   * caller wants progress, an `onprogress` hook that also resets the timeout
   * whenever the upstream reports progress.
   */
  private buildRequestOptions(
    upstreamName: string,
    signal?: AbortSignal,
    onProgress?: (progress: McpProgress) => Promise<void> | void,
  ): RequestOptions | undefined {
    const timeout = this.upstreamManager.getConfig(upstreamName)?.timeout;
    const options: RequestOptions = {};
    if (signal) options.signal = signal;
    if (timeout && timeout > 0) options.timeout = timeout;
    if (onProgress) {
      options.onprogress = (progress) => {
        const forwarded: McpProgress = {
          progress: progress.progress,
          ...(progress.total !== undefined ? { total: progress.total } : {}),
          ...(progress.message !== undefined ? { message: progress.message } : {}),
        };
        Promise.resolve()
          .then(() => onProgress(forwarded))
          .catch((error: unknown) =>
            this.logger.warn(
              `Failed to forward progress from upstream "${upstreamName}": ${extractErrorMessage(error)}`,
            ),
          );
      };
      options.resetTimeoutOnProgress = true;
    }
    return Object.keys(options).length > 0 ? options : undefined;
  }

  /** Returns the upstream client or throws a `-32603` error when it cannot serve requests. */
  private requireUsableClient(
    upstreamName: string,
  ): NonNullable<ReturnType<UpstreamManagerService['getClient']>> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client) {
      throw new McpError(`Upstream "${upstreamName}" is not connected`, JSON_RPC_INTERNAL_ERROR, {
        upstream: upstreamName,
      });
    }
    if (!this.upstreamManager.isHealthy(upstreamName)) {
      throw new McpError(`Upstream "${upstreamName}" is unhealthy`, JSON_RPC_INTERNAL_ERROR, {
        upstream: upstreamName,
      });
    }
    return client;
  }

  private resourceNotFound(uri: string): McpError {
    return new McpError(`Resource not found: ${uri}`, MCP_RESOURCE_NOT_FOUND_CODE, { uri });
  }

  private describeUpstreamFailure(upstreamName: string, error: unknown): string {
    if (errorCode(error) === SDK_REQUEST_TIMEOUT_CODE) {
      const timeout = this.upstreamManager.getConfig(upstreamName)?.timeout;
      return timeout
        ? `request timed out after ${timeout}ms`
        : `request timed out (${extractErrorMessage(error)})`;
    }
    return extractErrorMessage(error);
  }
}
