import { Injectable, Logger } from '@nestjs/common';
import { RouterService } from './routing/router.service';
import { ToolAggregatorService } from './routing/tool-aggregator.service';
import { UpstreamManagerService } from './upstream/upstream-manager.service';
import { PolicyEngineService } from './policies/policy-engine.service';
import { ResponseCacheService } from './cache/response-cache.service';
import { RequestTransformService } from './transform/request-transform.service';
import { ResponseTransformService } from './transform/response-transform.service';
import type { AggregatedTool } from './routing/tool-aggregator.service';
import type { ToolCallResponse } from './transform/response-transform.service';

export interface GatewayCallToolResult {
  content: unknown[];
  isError?: boolean;
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private readonly router: RouterService,
    private readonly toolAggregator: ToolAggregatorService,
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
  ): Promise<GatewayCallToolResult> {
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
        content: [
          { type: 'text', text: `No upstream found for tool "${toolName}"` },
        ],
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
    let request = await this.requestTransform.apply({
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
      const result = await client.callTool({
        name: request.toolName,
        arguments: request.arguments,
      });

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
      this.logger.error(`Error calling tool "${toolName}" on "${route.upstreamName}": ${message}`);

      return {
        content: [
          { type: 'text', text: `Error forwarding to upstream: ${message}` },
        ],
        isError: true,
      };
    }
  }
}
