import { drainAllPages } from '@nest-mcp/common';
import type { PromptArgument } from '@nest-mcp/common';
import { Injectable, Logger } from '@nestjs/common';
import { UpstreamManagerService } from '../upstream/upstream-manager.service';
import { extractErrorMessage } from '../utils/error-utils';
import { collectFulfilled } from '../utils/settled-results';
import { RouterService } from './router.service';

export interface AggregatedPrompt {
  name: string;
  description?: string;
  upstreamName: string;
  originalName: string;
  arguments?: PromptArgument[];
}

@Injectable()
export class PromptAggregatorService {
  private readonly logger = new Logger(PromptAggregatorService.name);
  private cachedPrompts: AggregatedPrompt[] = [];

  constructor(
    private readonly upstreamManager: UpstreamManagerService,
    private readonly router: RouterService,
  ) {}

  async aggregateAll(): Promise<AggregatedPrompt[]> {
    const names = this.upstreamManager.getAllNames();
    const results = await Promise.allSettled(
      names.map((name) => this.fetchPromptsFromUpstream(name)),
    );
    const allPrompts = collectFulfilled(results);

    this.cachedPrompts = allPrompts;
    this.logger.log(`Aggregated ${allPrompts.length} prompts from ${names.length} upstreams`);
    return allPrompts;
  }

  private async fetchPromptsFromUpstream(upstreamName: string): Promise<AggregatedPrompt[]> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client) return [];

    if (!this.upstreamManager.isHealthy(upstreamName)) {
      this.logger.warn(`Skipping unhealthy upstream "${upstreamName}" for prompt aggregation`);
      return [];
    }

    try {
      const prefix = this.router.getPrefixForUpstream(upstreamName);
      const allPrompts = await drainAllPages(async (cursor) => {
        const result = await client.listPrompts(cursor ? { cursor } : undefined);
        return { data: result.prompts ?? [], nextCursor: result.nextCursor };
      });

      return allPrompts.map((prompt) => ({
        name: prefix ? this.router.buildPrefixedName(prefix, prompt.name) : prompt.name,
        description: prompt.description,
        upstreamName,
        originalName: prompt.name,
        arguments: prompt.arguments as PromptArgument[] | undefined,
      }));
    } catch (error) {
      this.logger.error(
        `Failed to fetch prompts from "${upstreamName}": ${extractErrorMessage(error)}`,
      );
      return [];
    }
  }

  getCachedPrompts(): AggregatedPrompt[] {
    return this.cachedPrompts;
  }
}
