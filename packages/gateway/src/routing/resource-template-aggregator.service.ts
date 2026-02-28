import { drainAllPages } from '@btwld/mcp-common';
import { Injectable, Logger } from '@nestjs/common';
import { UpstreamManagerService } from '../upstream/upstream-manager.service';
import { extractErrorMessage } from '../utils/error-utils';
import { collectFulfilled } from '../utils/settled-results';
import { RouterService } from './router.service';

export interface AggregatedResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
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
      const prefix = this.router.getPrefixForUpstream(upstreamName);
      const allTemplates = await drainAllPages(async (cursor) => {
        const result = await client.listResourceTemplates(cursor ? { cursor } : undefined);
        return { data: result.resourceTemplates ?? [], nextCursor: result.nextCursor };
      });

      return allTemplates.map((template) => ({
        uriTemplate: prefix ? `${prefix}://${template.uriTemplate}` : template.uriTemplate,
        name: template.name ?? template.uriTemplate,
        description: template.description,
        mimeType: template.mimeType,
        upstreamName,
        originalUriTemplate: template.uriTemplate,
      }));
    } catch (error) {
      this.logger.error(
        `Failed to fetch resource templates from "${upstreamName}": ${extractErrorMessage(error)}`,
      );
      return [];
    }
  }

  getCachedTemplates(): AggregatedResourceTemplate[] {
    return this.cachedTemplates;
  }
}
