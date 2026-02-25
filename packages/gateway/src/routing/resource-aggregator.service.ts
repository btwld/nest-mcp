import { Injectable, Logger } from '@nestjs/common';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { UpstreamManagerService } from '../upstream/upstream-manager.service';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { RouterService } from './router.service';

export interface AggregatedResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
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
    const allResources: AggregatedResource[] = [];

    const results = await Promise.allSettled(
      names.map((name) => this.fetchResourcesFromUpstream(name)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allResources.push(...result.value);
      }
    }

    this.cachedResources = allResources;
    this.logger.log(`Aggregated ${allResources.length} resources from ${names.length} upstreams`);
    return allResources;
  }

  private async fetchResourcesFromUpstream(upstreamName: string): Promise<AggregatedResource[]> {
    const client = this.upstreamManager.getClient(upstreamName);
    if (!client) return [];

    if (!this.upstreamManager.isHealthy(upstreamName)) {
      this.logger.warn(`Skipping unhealthy upstream "${upstreamName}" for resource aggregation`);
      return [];
    }

    try {
      const result = await client.listResources();
      const prefix = this.router.getPrefixForUpstream(upstreamName);

      return (result.resources ?? []).map((resource) => ({
        uri: prefix ? `${prefix}://${resource.uri}` : resource.uri,
        name: resource.name ?? resource.uri,
        description: resource.description,
        mimeType: resource.mimeType,
        upstreamName,
        originalUri: resource.uri,
      }));
    } catch (error) {
      this.logger.error(
        `Failed to fetch resources from "${upstreamName}": ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  getCachedResources(): AggregatedResource[] {
    return this.cachedResources;
  }
}
