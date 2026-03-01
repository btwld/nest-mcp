import type { ToolAnnotations } from '@nest-mcp/common';
import { drainAllPages } from '@nest-mcp/common';
import { Injectable, Logger } from '@nestjs/common';
import { UpstreamManagerService } from '../upstream/upstream-manager.service';
import { extractErrorMessage } from '../utils/error-utils';
import { collectFulfilled } from '../utils/settled-results';
import { RouterService } from './router.service';

export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface AggregatedTool {
  name: string;
  description?: string;
  inputSchema: ToolInputSchema;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  upstreamName: string;
  originalName: string;
}

@Injectable()
export class ToolAggregatorService {
  private readonly logger = new Logger(ToolAggregatorService.name);
  private cachedTools: AggregatedTool[] = [];

  constructor(
    private readonly upstreamManager: UpstreamManagerService,
    private readonly router: RouterService,
  ) {}

  async aggregateAll(): Promise<AggregatedTool[]> {
    const names = this.upstreamManager.getAllNames();
    const results = await Promise.allSettled(
      names.map((name) => this.fetchToolsFromUpstream(name)),
    );
    const allTools = collectFulfilled(results);

    this.cachedTools = allTools;
    this.logger.log(`Aggregated ${allTools.length} tools from ${names.length} upstreams`);
    return allTools;
  }

  private async fetchToolsFromUpstream(upstreamName: string): Promise<AggregatedTool[]> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client) return [];

    if (!this.upstreamManager.isHealthy(upstreamName)) {
      this.logger.warn(`Skipping unhealthy upstream "${upstreamName}" for tool aggregation`);
      return [];
    }

    try {
      const prefix = this.router.getPrefixForUpstream(upstreamName);
      const allTools = await drainAllPages(async (cursor) => {
        const result = await client.listTools(cursor ? { cursor } : undefined);
        return { data: result.tools ?? [], nextCursor: result.nextCursor };
      });

      return allTools.map((tool) => ({
        name: prefix ? this.router.buildPrefixedName(prefix, tool.name) : tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as ToolInputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
        ...(tool.annotations ? { annotations: tool.annotations as ToolAnnotations } : {}),
        upstreamName,
        originalName: tool.name,
      }));
    } catch (error) {
      this.logger.error(
        `Failed to fetch tools from "${upstreamName}": ${extractErrorMessage(error)}`,
      );
      return [];
    }
  }

  getCachedTools(): AggregatedTool[] {
    return this.cachedTools;
  }
}
