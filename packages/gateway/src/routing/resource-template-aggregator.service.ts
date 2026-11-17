import type { ResourceTemplate } from '@modelcontextprotocol/sdk/types.js';
import type { Icon } from '@nest-mcp/common';
import { drainAllPages } from '@nest-mcp/common';
import { Injectable, Logger } from '@nestjs/common';
import { UpstreamManagerService } from '../upstream/upstream-manager.service';
import { extractErrorMessage } from '../utils/error-utils';
import { collectFulfilled } from '../utils/settled-results';
import type { AggregatedResourceAnnotations } from './resource-aggregator.service';
import { RouterService } from './router.service';

type UpstreamClient = NonNullable<ReturnType<UpstreamManagerService['getClient']>>;

export interface AggregatedResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: Icon[];
  annotations?: AggregatedResourceAnnotations;
  _meta?: Record<string, unknown>;
  upstreamName: string;
  originalUriTemplate: string;
}

@Injectable()
export class ResourceTemplateAggregatorService {
  private readonly logger = new Logger(ResourceTemplateAggregatorService.name);
  private cachedTemplates: AggregatedResourceTemplate[] = [];

  constructor(
    private readonly upstreamManager: UpstreamManagerService,
    private readonly router: RouterService,
  ) {}

  async aggregateAll(): Promise<AggregatedResourceTemplate[]> {
    const names = this.upstreamManager.getAllNames();
    const results = await Promise.allSettled(
      names.map((name) => this.fetchTemplatesFromUpstream(name)),
    );
    const allTemplates = collectFulfilled(results);

    this.cachedTemplates = allTemplates;
    this.logger.log(
      `Aggregated ${allTemplates.length} resource templates from ${names.length} upstreams`,
    );
    return allTemplates;
  }

  /**
   * Re-fetch the resource templates of a single upstream and replace its
   * entries in the cache. Returns the fresh templates, or `undefined` (cache
   * untouched) when the upstream is unavailable or the listing fails.
   */
  async refreshUpstream(upstreamName: string): Promise<AggregatedResourceTemplate[] | undefined> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client || !this.upstreamManager.isHealthy(upstreamName)) return undefined;
    try {
      const templates = await this.loadTemplatesFromUpstream(upstreamName, client);
      this.cachedTemplates = [
        ...this.cachedTemplates.filter((t) => t.upstreamName !== upstreamName),
        ...templates,
      ];
      return templates;
    } catch (error) {
      this.logger.error(
        `Failed to refresh resource templates from "${upstreamName}": ${extractErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async fetchTemplatesFromUpstream(
    upstreamName: string,
  ): Promise<AggregatedResourceTemplate[]> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client) return [];

    if (!this.upstreamManager.isHealthy(upstreamName)) {
      this.logger.warn(
        `Skipping unhealthy upstream "${upstreamName}" for resource template aggregation`,
      );
      return [];
    }

    try {
      return await this.loadTemplatesFromUpstream(upstreamName, client);
    } catch (error) {
      this.logger.error(
        `Failed to fetch resource templates from "${upstreamName}": ${extractErrorMessage(error)}`,
      );
      return [];
    }
  }

  private async loadTemplatesFromUpstream(
    upstreamName: string,
    client: UpstreamClient,
  ): Promise<AggregatedResourceTemplate[]> {
    const prefix = this.router.getPrefixForUpstream(upstreamName);
    const allTemplates = await drainAllPages(async (cursor) => {
      const result = await client.listResourceTemplates(cursor ? { cursor } : undefined);
      return { data: result.resourceTemplates ?? [], nextCursor: result.nextCursor };
    });

    return allTemplates.map((template) => toAggregatedTemplate(template, upstreamName, prefix));
  }

  getCachedTemplates(): AggregatedResourceTemplate[] {
    return this.cachedTemplates;
  }
}

function toAggregatedTemplate(
  template: ResourceTemplate,
  upstreamName: string,
  prefix?: string,
): AggregatedResourceTemplate {
  return {
    uriTemplate: prefix ? `${prefix}://${template.uriTemplate}` : template.uriTemplate,
    name: template.name ?? template.uriTemplate,
    ...(template.title !== undefined ? { title: template.title } : {}),
    description: template.description,
    mimeType: template.mimeType,
    ...(template.icons ? { icons: template.icons as Icon[] } : {}),
    ...(template.annotations
      ? { annotations: template.annotations as AggregatedResourceAnnotations }
      : {}),
    ...(template._meta ? { _meta: template._meta as Record<string, unknown> } : {}),
    upstreamName,
    originalUriTemplate: template.uriTemplate,
  };
}
