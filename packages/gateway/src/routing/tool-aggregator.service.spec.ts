import type { UpstreamManagerService } from '../upstream/upstream-manager.service';
import type { RouterService } from './router.service';
import { ToolAggregatorService } from './tool-aggregator.service';

describe('ToolAggregatorService', () => {
  let service: ToolAggregatorService;
  let upstreamManager: {
    getAllNames: ReturnType<typeof vi.fn>;
    getClient: ReturnType<typeof vi.fn>;
    isHealthy: ReturnType<typeof vi.fn>;
  };
  let router: {
    getPrefixForUpstream: ReturnType<typeof vi.fn>;
    buildPrefixedName: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    upstreamManager = {
      getAllNames: vi.fn().mockReturnValue([]),
      getClient: vi.fn(),
      isHealthy: vi.fn().mockReturnValue(true),
    };

    router = {
      getPrefixForUpstream: vi.fn(),
      buildPrefixedName: vi.fn((prefix: string, name: string) => `${prefix}_${name}`),
    };

    service = new ToolAggregatorService(
      upstreamManager as unknown as UpstreamManagerService,
      router as unknown as RouterService,
    );
  });

  describe('aggregateAll', () => {
    it('should return empty array when no upstreams exist', async () => {
      const tools = await service.aggregateAll();
      expect(tools).toEqual([]);
    });

    it('should collect and prefix tools from upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['github']);
      upstreamManager.getClient.mockReturnValue({
        listTools: vi.fn().mockResolvedValue({
          tools: [
            { name: 'listRepos', description: 'List repos', inputSchema: { type: 'object' } },
          ],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue('gh');

      const tools = await service.aggregateAll();

      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        name: 'gh_listRepos',
        description: 'List repos',
        inputSchema: { type: 'object' },
        upstreamName: 'github',
        originalName: 'listRepos',
      });
    });

    it('should preserve outputSchema and annotations from upstream tools', async () => {
      const outputSchema = {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      };
      const annotations = { readOnlyHint: true, idempotentHint: true };

      upstreamManager.getAllNames.mockReturnValue(['api']);
      upstreamManager.getClient.mockReturnValue({
        listTools: vi.fn().mockResolvedValue({
          tools: [
            {
              name: 'getCount',
              description: 'Get count',
              inputSchema: { type: 'object' },
              outputSchema,
              annotations,
            },
          ],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const tools = await service.aggregateAll();

      expect(tools[0].outputSchema).toEqual(outputSchema);
      expect(tools[0].annotations).toEqual(annotations);
    });

    it('should omit outputSchema and annotations when not present in upstream tool', async () => {
      upstreamManager.getAllNames.mockReturnValue(['api']);
      upstreamManager.getClient.mockReturnValue({
        listTools: vi.fn().mockResolvedValue({
          tools: [{ name: 'simple', inputSchema: { type: 'object' } }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const tools = await service.aggregateAll();

      expect(tools[0]).not.toHaveProperty('outputSchema');
      expect(tools[0]).not.toHaveProperty('annotations');
    });

    it('should use raw tool name when no prefix exists', async () => {
      upstreamManager.getAllNames.mockReturnValue(['github']);
      upstreamManager.getClient.mockReturnValue({
        listTools: vi.fn().mockResolvedValue({
          tools: [{ name: 'listRepos', inputSchema: { type: 'object' } }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const tools = await service.aggregateAll();

      expect(tools[0].name).toBe('listRepos');
    });

    it('should handle rejected promises gracefully', async () => {
      upstreamManager.getAllNames.mockReturnValue(['failing', 'working']);
      upstreamManager.getClient
        .mockReturnValueOnce({
          listTools: vi.fn().mockRejectedValue(new Error('connection lost')),
        })
        .mockReturnValueOnce({
          listTools: vi.fn().mockResolvedValue({
            tools: [{ name: 'tool1', inputSchema: {} }],
          }),
        });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const tools = await service.aggregateAll();

      expect(tools).toHaveLength(1);
      expect(tools[0].originalName).toBe('tool1');
    });

    it('should skip unhealthy upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['unhealthy']);
      upstreamManager.getClient.mockReturnValue({
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: 't', inputSchema: {} }] }),
      });
      upstreamManager.isHealthy.mockReturnValue(false);

      const tools = await service.aggregateAll();

      expect(tools).toEqual([]);
    });

    it('should return empty when getClient returns undefined', async () => {
      upstreamManager.getAllNames.mockReturnValue(['missing']);
      upstreamManager.getClient.mockReturnValue(undefined);

      const tools = await service.aggregateAll();

      expect(tools).toEqual([]);
    });

    it('should update cached tools after aggregation', async () => {
      upstreamManager.getAllNames.mockReturnValue(['up']);
      upstreamManager.getClient.mockReturnValue({
        listTools: vi.fn().mockResolvedValue({
          tools: [{ name: 'x', inputSchema: {} }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      await service.aggregateAll();

      expect(service.getCachedTools()).toHaveLength(1);
    });
  });

  describe('getCachedTools', () => {
    it('should return empty array before first aggregation', () => {
      expect(service.getCachedTools()).toEqual([]);
    });
  });
});
