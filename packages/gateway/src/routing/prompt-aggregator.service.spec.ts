import type { UpstreamManagerService } from '../upstream/upstream-manager.service';
import { PromptAggregatorService } from './prompt-aggregator.service';
import type { RouterService } from './router.service';

describe('PromptAggregatorService', () => {
  let service: PromptAggregatorService;
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

    service = new PromptAggregatorService(
      upstreamManager as unknown as UpstreamManagerService,
      router as unknown as RouterService,
    );
  });

  describe('aggregateAll', () => {
    it('should return empty array when no upstreams exist', async () => {
      const prompts = await service.aggregateAll();
      expect(prompts).toEqual([]);
    });

    it('should collect and prefix prompts from upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['assistant']);
      upstreamManager.getClient.mockReturnValue({
        listPrompts: vi.fn().mockResolvedValue({
          prompts: [
            {
              name: 'summarize',
              description: 'Summarize text',
              arguments: [{ name: 'text', description: 'Text to summarize', required: true }],
            },
          ],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue('ai');

      const prompts = await service.aggregateAll();

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toEqual({
        name: 'ai_summarize',
        description: 'Summarize text',
        upstreamName: 'assistant',
        originalName: 'summarize',
        arguments: [{ name: 'text', description: 'Text to summarize', required: true }],
      });
    });

    it('should use raw prompt name when no prefix exists', async () => {
      upstreamManager.getAllNames.mockReturnValue(['assistant']);
      upstreamManager.getClient.mockReturnValue({
        listPrompts: vi.fn().mockResolvedValue({
          prompts: [{ name: 'summarize' }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const prompts = await service.aggregateAll();

      expect(prompts[0].name).toBe('summarize');
    });

    it('should handle rejected promises gracefully', async () => {
      upstreamManager.getAllNames.mockReturnValue(['failing', 'working']);
      upstreamManager.getClient
        .mockReturnValueOnce({
          listPrompts: vi.fn().mockRejectedValue(new Error('connection lost')),
        })
        .mockReturnValueOnce({
          listPrompts: vi.fn().mockResolvedValue({
            prompts: [{ name: 'greet', arguments: [{ name: 'name', required: true }] }],
          }),
        });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      const prompts = await service.aggregateAll();

      expect(prompts).toHaveLength(1);
      expect(prompts[0].originalName).toBe('greet');
    });

    it('should skip unhealthy upstreams', async () => {
      upstreamManager.getAllNames.mockReturnValue(['unhealthy']);
      upstreamManager.getClient.mockReturnValue({
        listPrompts: vi.fn().mockResolvedValue({
          prompts: [{ name: 'p' }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(false);

      const prompts = await service.aggregateAll();

      expect(prompts).toEqual([]);
    });

    it('should return empty when getClient returns undefined', async () => {
      upstreamManager.getAllNames.mockReturnValue(['missing']);
      upstreamManager.getClient.mockReturnValue(undefined);

      const prompts = await service.aggregateAll();

      expect(prompts).toEqual([]);
    });

    it('should update cached prompts after aggregation', async () => {
      upstreamManager.getAllNames.mockReturnValue(['up']);
      upstreamManager.getClient.mockReturnValue({
        listPrompts: vi.fn().mockResolvedValue({
          prompts: [{ name: 'x' }],
        }),
      });
      upstreamManager.isHealthy.mockReturnValue(true);
      router.getPrefixForUpstream.mockReturnValue(undefined);

      await service.aggregateAll();

      expect(service.getCachedPrompts()).toHaveLength(1);
    });
  });

  describe('getCachedPrompts', () => {
    it('should return empty array before first aggregation', () => {
      expect(service.getCachedPrompts()).toEqual([]);
    });
  });
});
