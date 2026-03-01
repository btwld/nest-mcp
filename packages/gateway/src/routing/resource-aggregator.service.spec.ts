import type { UpstreamManagerService } from '../upstream/upstream-manager.service';
import { ResourceAggregatorService } from './resource-aggregator.service';
import type { RouterService } from './router.service';

describe('ResourceAggregatorService', () => {
  let service: ResourceAggregatorService;
  let upstreamManager: {
    getAllNames: ReturnType<typeof vi.fn>;
    getClient: ReturnType<typeof vi.fn>;
    isHealthy: ReturnType<typeof vi.fn>;
  };
  let router: {
    getPrefixForUpstream: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    upstreamManager = {
      getAllNames: vi.fn().mockReturnValue([]),
      getClient: vi.fn(),
      isHealthy: vi.fn().mockReturnValue(true),
    };

    router = {
      getPrefixForUpstream: vi.fn(),
    };

    service = new ResourceAggregatorService(
      upstreamManager as unknown as UpstreamManagerService,
      router as unknown as RouterService,
    );
  });

  describe('aggregateAll', () => {
    it('should return empty array when no upstreams exist', async () => {
      const resources = await service.aggregateAll();
      expect(resources).toEqual([]);
    });

    it('should collect and prefix resources from upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['files']);
      upstreamManager.getClient.mockReturnValue({
        listResources: vi.fn().mockResolvedValue({
          resources: [
            {
              uri: 'file:///docs/readme.md',
              name: 'readme',
              description: 'Readme file',
              mimeType: 'text/markdown',
            },
          ],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue('fs');

      const resources = await service.aggregateAll();

      expect(resources).toHaveLength(1);
      expect(resources[0]).toEqual({
        uri: 'fs://file:///docs/readme.md',
        name: 'readme',
        description: 'Readme file',
        mimeType: 'text/markdown',
        upstreamName: 'files',
        originalUri: 'file:///docs/readme.md',
      });
    });

    it('should use raw URI when no prefix exists', async () => {
      upstreamManager.getAllNames.mockReturnValue(['files']);
      upstreamManager.getClient.mockReturnValue({
        listResources: vi.fn().mockResolvedValue({
          resources: [{ uri: 'file:///data.json', name: 'data' }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const resources = await service.aggregateAll();

      expect(resources[0].uri).toBe('file:///data.json');
    });

    it('should handle rejected promises gracefully', async () => {
      upstreamManager.getAllNames.mockReturnValue(['failing', 'working']);
      upstreamManager.getClient
        .mockReturnValueOnce({
          listResources: vi.fn().mockRejectedValue(new Error('connection lost')),
        })
        .mockReturnValueOnce({
          listResources: vi.fn().mockResolvedValue({
            resources: [{ uri: 'file:///ok.txt', name: 'ok' }],
          }),
        });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const resources = await service.aggregateAll();

      expect(resources).toHaveLength(1);
      expect(resources[0].originalUri).toBe('file:///ok.txt');
    });

    it('should skip unhealthy upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['unhealthy']);
      upstreamManager.getClient.mockReturnValue({
        listResources: vi.fn().mockResolvedValue({
          resources: [{ uri: 'file:///r', name: 'r' }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(false);

      const resources = await service.aggregateAll();

      expect(resources).toEqual([]);
    });

    it('should return empty when getClient returns undefined', async () => {
      upstreamManager.getAllNames.mockReturnValue(['missing']);
      upstreamManager.getClient.mockReturnValue(undefined);

      const resources = await service.aggregateAll();

      expect(resources).toEqual([]);
    });

    it('should collect multiple resources from a single upstream', async () => {
      upstreamManager.getAllNames.mockReturnValue(['files']);
      upstreamManager.getClient.mockReturnValue({
        listResources: vi.fn().mockResolvedValue({
          resources: [
            { uri: 'file:///a.txt', name: 'a' },
            { uri: 'file:///b.txt', name: 'b' },
          ],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const resources = await service.aggregateAll();

      expect(resources).toHaveLength(2);
      expect(resources.map((r) => r.originalUri)).toEqual(['file:///a.txt', 'file:///b.txt']);
    });

    it('should combine resources from multiple upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['fs', 'db']);
      upstreamManager.getClient
        .mockReturnValueOnce({
          listResources: vi.fn().mockResolvedValue({
            resources: [{ uri: 'file:///doc.txt', name: 'doc' }],
          }),
        })
        .mockReturnValueOnce({
          listResources: vi.fn().mockResolvedValue({
            resources: [{ uri: 'db:///users', name: 'users' }],
          }),
        });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const resources = await service.aggregateAll();

      expect(resources).toHaveLength(2);
      expect(resources[0].upstreamName).toBe('fs');
      expect(resources[1].upstreamName).toBe('db');
    });

    it('should update cached resources after aggregation', async () => {
      upstreamManager.getAllNames.mockReturnValue(['up']);
      upstreamManager.getClient.mockReturnValue({
        listResources: vi.fn().mockResolvedValue({
          resources: [{ uri: 'file:///x', name: 'x' }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      await service.aggregateAll();

      expect(service.getCachedResources()).toHaveLength(1);
    });

    it('should paginate through all resources when nextCursor is present', async () => {
      const listResources = vi
        .fn()
        .mockResolvedValueOnce({
          resources: [{ uri: 'file:///page1.txt', name: 'page1' }],
          nextCursor: 'page2',
        })
        .mockResolvedValueOnce({
          resources: [{ uri: 'file:///page2.txt', name: 'page2' }],
        });

      upstreamManager.getAllNames.mockReturnValue(['store']);
      upstreamManager.getClient.mockReturnValue({ listResources });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const resources = await service.aggregateAll();

      expect(resources).toHaveLength(2);
      expect(listResources).toHaveBeenCalledTimes(2);
    });
  });

  describe('getCachedResources', () => {
    it('should return empty array before first aggregation', () => {
      expect(service.getCachedResources()).toEqual([]);
    });
  });

  describe('name fallback', () => {
    it('falls back to resource.uri when name is absent', async () => {
      upstreamManager.getAllNames.mockReturnValue(['files']);
      upstreamManager.getClient.mockReturnValue({
        listResources: vi.fn().mockResolvedValue({
          resources: [{ uri: 'file:///nameless.txt' }], // no name field
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const resources = await service.aggregateAll();

      expect(resources[0].name).toBe('file:///nameless.txt');
    });
  });
});
