import type { UpstreamManagerService } from '../upstream/upstream-manager.service';
import { ResourceTemplateAggregatorService } from './resource-template-aggregator.service';
import type { RouterService } from './router.service';

describe('ResourceTemplateAggregatorService', () => {
  let service: ResourceTemplateAggregatorService;
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

    service = new ResourceTemplateAggregatorService(
      upstreamManager as unknown as UpstreamManagerService,
      router as unknown as RouterService,
    );
  });

  describe('aggregateAll', () => {
    it('should return empty array when no upstreams exist', async () => {
      const templates = await service.aggregateAll();
      expect(templates).toEqual([]);
    });

    it('should collect and prefix resource templates from upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['files']);
      upstreamManager.getClient.mockReturnValue({
        listResourceTemplates: vi.fn().mockResolvedValue({
          resourceTemplates: [
            {
              uriTemplate: 'file:///{path}',
              name: 'file',
              description: 'A file resource',
              mimeType: 'application/octet-stream',
            },
          ],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue('fs');

      const templates = await service.aggregateAll();

      expect(templates).toHaveLength(1);
      expect(templates[0]).toEqual({
        uriTemplate: 'fs://file:///{path}',
        name: 'file',
        description: 'A file resource',
        mimeType: 'application/octet-stream',
        upstreamName: 'files',
        originalUriTemplate: 'file:///{path}',
      });
    });

    it('should use raw uriTemplate when no prefix exists', async () => {
      upstreamManager.getAllNames.mockReturnValue(['files']);
      upstreamManager.getClient.mockReturnValue({
        listResourceTemplates: vi.fn().mockResolvedValue({
          resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file' }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const templates = await service.aggregateAll();

      expect(templates[0].uriTemplate).toBe('file:///{path}');
    });

    it('should aggregate templates from multiple upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['files', 'db']);
      upstreamManager.getClient
        .mockReturnValueOnce({
          listResourceTemplates: vi.fn().mockResolvedValue({
            resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file' }],
          }),
        })
        .mockReturnValueOnce({
          listResourceTemplates: vi.fn().mockResolvedValue({
            resourceTemplates: [{ uriTemplate: 'db:///{table}', name: 'table' }],
          }),
        });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValueOnce('fs').mockReturnValueOnce('data');

      const templates = await service.aggregateAll();

      expect(templates).toHaveLength(2);
      expect(templates[0].upstreamName).toBe('files');
      expect(templates[1].upstreamName).toBe('db');
    });

    it('should handle rejected promises gracefully', async () => {
      upstreamManager.getAllNames.mockReturnValue(['failing', 'working']);
      upstreamManager.getClient
        .mockReturnValueOnce({
          listResourceTemplates: vi.fn().mockRejectedValue(new Error('connection lost')),
        })
        .mockReturnValueOnce({
          listResourceTemplates: vi.fn().mockResolvedValue({
            resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file' }],
          }),
        });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const templates = await service.aggregateAll();

      expect(templates).toHaveLength(1);
      expect(templates[0].originalUriTemplate).toBe('file:///{path}');
    });

    it('should skip unhealthy upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['unhealthy']);
      upstreamManager.getClient.mockReturnValue({
        listResourceTemplates: vi.fn().mockResolvedValue({
          resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file' }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(false);

      const templates = await service.aggregateAll();

      expect(templates).toEqual([]);
    });

    it('should return empty when getClient returns undefined', async () => {
      upstreamManager.getAllNames.mockReturnValue(['missing']);
      upstreamManager.getClient.mockReturnValue(undefined);

      const templates = await service.aggregateAll();

      expect(templates).toEqual([]);
    });

    it('should update cached templates after aggregation', async () => {
      upstreamManager.getAllNames.mockReturnValue(['up']);
      upstreamManager.getClient.mockReturnValue({
        listResourceTemplates: vi.fn().mockResolvedValue({
          resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file' }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      await service.aggregateAll();

      expect(service.getCachedTemplates()).toHaveLength(1);
    });

    it('should collect multiple templates from a single upstream', async () => {
      upstreamManager.getAllNames.mockReturnValue(['files']);
      upstreamManager.getClient.mockReturnValue({
        listResourceTemplates: vi.fn().mockResolvedValue({
          resourceTemplates: [
            { uriTemplate: 'file:///{path}', name: 'file' },
            { uriTemplate: 'file:///logs/{name}', name: 'log' },
          ],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const templates = await service.aggregateAll();

      expect(templates).toHaveLength(2);
      expect(templates[0].originalUriTemplate).toBe('file:///{path}');
      expect(templates[1].originalUriTemplate).toBe('file:///logs/{name}');
    });

    it('should paginate through all templates when nextCursor is present', async () => {
      const listResourceTemplates = vi
        .fn()
        .mockResolvedValueOnce({
          resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file' }],
          nextCursor: 'page2',
        })
        .mockResolvedValueOnce({
          resourceTemplates: [{ uriTemplate: 'db:///{table}', name: 'table' }],
        });

      upstreamManager.getAllNames.mockReturnValue(['store']);
      upstreamManager.getClient.mockReturnValue({ listResourceTemplates });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const templates = await service.aggregateAll();

      expect(templates).toHaveLength(2);
      expect(listResourceTemplates).toHaveBeenCalledTimes(2);
    });
  });

  describe('getCachedTemplates', () => {
    it('should return empty array before first aggregation', () => {
      expect(service.getCachedTemplates()).toEqual([]);
    });
  });

  describe('name fallback', () => {
    it('falls back to uriTemplate when name is absent', async () => {
      upstreamManager.getAllNames.mockReturnValue(['store']);
      upstreamManager.getClient.mockReturnValue({
        listResourceTemplates: vi.fn().mockResolvedValue({
          resourceTemplates: [{ uriTemplate: 'db:///{table}' }], // no name field
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const templates = await service.aggregateAll();

      expect(templates[0].name).toBe('db:///{table}');
    });
  });
});
