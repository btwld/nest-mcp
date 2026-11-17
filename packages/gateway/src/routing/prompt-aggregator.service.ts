import type { Prompt } from '@modelcontextprotocol/sdk/types.js';
import { drainAllPages } from '@nest-mcp/common';
import type { Icon, PromptArgument } from '@nest-mcp/common';
import { Injectable, Logger } from '@nestjs/common';
import { UpstreamManagerService } from '../upstream/upstream-manager.service';
import { extractErrorMessage } from '../utils/error-utils';
import { collectFulfilled } from '../utils/settled-results';
import { RouterService } from './router.service';

type UpstreamClient = NonNullable<ReturnType<UpstreamManagerService['getClient']>>;

/** A prompt argument as advertised by the upstream (including its optional display `title`). */
export interface AggregatedPromptArgument extends PromptArgument {
  title?: string;
}

export interface AggregatedPrompt {
  name: string;
  title?: string;
  description?: string;
  upstreamName: string;
  originalName: string;
  arguments?: AggregatedPromptArgument[];
  icons?: Icon[];
  _meta?: Record<string, unknown>;
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

  /**
   * Re-fetch the prompts of a single upstream and replace its entries in the
   * cache. Returns the fresh prompts, or `undefined` (cache untouched) when
   * the upstream is unavailable or the listing fails.
   */
  async refreshUpstream(upstreamName: string): Promise<AggregatedPrompt[] | undefined> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client || !this.upstreamManager.isHealthy(upstreamName)) return undefined;
    try {
      const prompts = await this.loadPromptsFromUpstream(upstreamName, client);
      this.cachedPrompts = [
        ...this.cachedPrompts.filter((p) => p.upstreamName !== upstreamName),
        ...prompts,
      ];
      return prompts;
    } catch (error) {
      this.logger.error(
        `Failed to refresh prompts from "${upstreamName}": ${extractErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async fetchPromptsFromUpstream(upstreamName: string): Promise<AggregatedPrompt[]> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client) return [];

    if (!this.upstreamManager.isHealthy(upstreamName)) {
      this.logger.warn(`Skipping unhealthy upstream "${upstreamName}" for prompt aggregation`);
      return [];
    }

    try {
      return await this.loadPromptsFromUpstream(upstreamName, client);
    } catch (error) {
      this.logger.error(
        `Failed to fetch prompts from "${upstreamName}": ${extractErrorMessage(error)}`,
      );
      return [];
    }
  }

  private async loadPromptsFromUpstream(
    upstreamName: string,
    client: UpstreamClient,
  ): Promise<AggregatedPrompt[]> {
    const prefix = this.router.getPrefixForUpstream(upstreamName);
    const allPrompts = await drainAllPages(async (cursor) => {
      const result = await client.listPrompts(cursor ? { cursor } : undefined);
      return { data: result.prompts ?? [], nextCursor: result.nextCursor };
    });

    return allPrompts.map((prompt) => this.toAggregated(prompt, upstreamName, prefix));
  }

  private toAggregated(prompt: Prompt, upstreamName: string, prefix?: string): AggregatedPrompt {
    return {
      name: prefix ? this.router.buildPrefixedName(prefix, prompt.name) : prompt.name,
      ...(prompt.title !== undefined ? { title: prompt.title } : {}),
      description: prompt.description,
      upstreamName,
      originalName: prompt.name,
      arguments: prompt.arguments as AggregatedPromptArgument[] | undefined,
      ...(prompt.icons ? { icons: prompt.icons as Icon[] } : {}),
      ...(prompt._meta ? { _meta: prompt._meta as Record<string, unknown> } : {}),
    };
  }

  getCachedPrompts(): AggregatedPrompt[] {
    return this.cachedPrompts;
  }
}
