import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import type { Icon } from '@nest-mcp/common';
import { drainAllPages } from '@nest-mcp/common';
import { Injectable, Logger } from '@nestjs/common';
import { UpstreamManagerService } from '../upstream/upstream-manager.service';
import { extractErrorMessage } from '../utils/error-utils';
import { collectFulfilled } from '../utils/settled-results';
import { RouterService } from './router.service';

type UpstreamClient = NonNullable<ReturnType<UpstreamManagerService['getClient']>>;

/** Resource annotations (`audience`, `priority`, `lastModified`) as reported by the upstream. */
export type AggregatedResourceAnnotations = Record<string, unknown>;

export interface AggregatedResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: Icon[];
  size?: number;
  annotations?: AggregatedResourceAnnotations;
  _meta?: Record<string, unknown>;
  upstreamName: string;
  originalUri: string;
}

@Injectable()
export class ResourceAggregatorService {
  private readonly logger = new Logger(ResourceAggregatorService.name);
  private cachedResources: AggregatedResource[] = [];

  constructor(
    private readonly upstreamManager: UpstreamManagerService,
    private readonly router: RouterService,
  ) {}

  async aggregateAll(): Promise<AggregatedResource[]> {
    const names = this.upstreamManager.getAllNames();
    const results = await Promise.allSettled(
      names.map((name) => this.fetchResourcesFromUpstream(name)),
    );
    const allResources = collectFulfilled(results);

    this.cachedResources = allResources;
    this.logger.log(`Aggregated ${allResources.length} resources from ${names.length} upstreams`);
    return allResources;
  }

  /**
   * Re-fetch the resources of a single upstream and replace its entries in
   * the cache. Returns the fresh resources, or `undefined` (cache untouched)
   * when the upstream is unavailable or the listing fails.
   */
  async refreshUpstream(upstreamName: string): Promise<AggregatedResource[] | undefined> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client || !this.upstreamManager.isHealthy(upstreamName)) return undefined;
    try {
      const resources = await this.loadResourcesFromUpstream(upstreamName, client);
      this.cachedResources = [
        ...this.cachedResources.filter((r) => r.upstreamName !== upstreamName),
        ...resources,
      ];
      return resources;
    } catch (error) {
      this.logger.error(
        `Failed to refresh resources from "${upstreamName}": ${extractErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async fetchResourcesFromUpstream(upstreamName: string): Promise<AggregatedResource[]> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client) return [];

    if (!this.upstreamManager.isHealthy(upstreamName)) {
      this.logger.warn(`Skipping unhealthy upstream "${upstreamName}" for resource aggregation`);
      return [];
    }

    try {
      return await this.loadResourcesFromUpstream(upstreamName, client);
    } catch (error) {
      this.logger.error(
        `Failed to fetch resources from "${upstreamName}": ${extractErrorMessage(error)}`,
      );
      return [];
    }
  }

  private async loadResourcesFromUpstream(
    upstreamName: string,
    client: UpstreamClient,
  ): Promise<AggregatedResource[]> {
    const prefix = this.router.getPrefixForUpstream(upstreamName);
    const allResources = await drainAllPages(async (cursor) => {
      const result = await client.listResources(cursor ? { cursor } : undefined);
      return { data: result.resources ?? [], nextCursor: result.nextCursor };
    });

    return allResources.map((resource) => toAggregatedResource(resource, upstreamName, prefix));
  }

  getCachedResources(): AggregatedResource[] {
    return this.cachedResources;
  }
}

function toAggregatedResource(
  resource: Resource,
  upstreamName: string,
  prefix?: string,
): AggregatedResource {
  return {
    uri: prefix ? `${prefix}://${resource.uri}` : resource.uri,
    name: resource.name ?? resource.uri,
    ...(resource.title !== undefined ? { title: resource.title } : {}),
    description: resource.description,
    mimeType: resource.mimeType,
    ...(resource.icons ? { icons: resource.icons as Icon[] } : {}),
    ...(resource.size !== undefined ? { size: resource.size } : {}),
    ...(resource.annotations
      ? { annotations: resource.annotations as AggregatedResourceAnnotations }
      : {}),
    ...(resource._meta ? { _meta: resource._meta as Record<string, unknown> } : {}),
    upstreamName,
    originalUri: resource.uri,
  };
}
