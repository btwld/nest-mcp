import { Injectable, Logger } from '@nestjs/common';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { UpstreamManagerService } from '../upstream/upstream-manager.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { RouterService } from './router.service';

export interface AggregatedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
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
    const allTools: AggregatedTool[] = [];

    const results = await Promise.allSettled(
      names.map((name) => this.fetchToolsFromUpstream(name)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allTools.push(...result.value);
      }
    }

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
      const result = await client.listTools();
      const prefix = this.router.getPrefixForUpstream(upstreamName);

      return (result.tools ?? []).map((tool) => ({
        name: prefix ? this.router.buildPrefixedName(prefix, tool.name) : tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        upstreamName,
        originalName: tool.name,
      }));
    } catch (error) {
      this.logger.error(
        `Failed to fetch tools from "${upstreamName}": ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  getCachedTools(): AggregatedTool[] {
    return this.cachedTools;
  }
}
