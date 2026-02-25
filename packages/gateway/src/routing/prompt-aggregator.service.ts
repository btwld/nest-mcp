import { Injectable, Logger } from '@nestjs/common';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { UpstreamManagerService } from '../upstream/upstream-manager.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { RouterService } from './router.service';

export interface AggregatedPrompt {
  name: string;
  description?: string;
  upstreamName: string;
  originalName: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
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
    const allPrompts: AggregatedPrompt[] = [];

    const results = await Promise.allSettled(
      names.map((name) => this.fetchPromptsFromUpstream(name)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allPrompts.push(...result.value);
      }
    }

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
      const result = await client.listPrompts();
      const prefix = this.router.getPrefixForUpstream(upstreamName);

      return (result.prompts ?? []).map((prompt) => ({
        name: prefix ? this.router.buildPrefixedName(prefix, prompt.name) : prompt.name,
        description: prompt.description,
        upstreamName,
        originalName: prompt.name,
        arguments: prompt.arguments as
          | Array<{ name: string; description?: string; required?: boolean }>
          | undefined,
      }));
    } catch (error) {
      this.logger.error(
        `Failed to fetch prompts from "${upstreamName}": ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  getCachedPrompts(): AggregatedPrompt[] {
    return this.cachedPrompts;
  }
}
