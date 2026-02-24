import type { ResponseCacheService } from './cache/response-cache.service';
import { GatewayService } from './gateway.service';
import type { PolicyEngineService } from './policies/policy-engine.service';
import type { RouterService } from './routing/router.service';
import type { ToolAggregatorService } from './routing/tool-aggregator.service';
import type { RequestTransformService } from './transform/request-transform.service';
import type { ResponseTransformService } from './transform/response-transform.service';
import type { UpstreamManagerService } from './upstream/upstream-manager.service';

describe('GatewayService', () => {
  let service: GatewayService;
  let router: Record<string, ReturnType<typeof vi.fn>>;
  let toolAggregator: Record<string, ReturnType<typeof vi.fn>>;
  let upstreamManager: Record<string, ReturnType<typeof vi.fn>>;
  let policyEngine: Record<string, ReturnType<typeof vi.fn>>;
  let responseCache: Record<string, ReturnType<typeof vi.fn>>;
  let requestTransform: Record<string, ReturnType<typeof vi.fn>>;
  let responseTransform: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    router = {
      resolve: vi.fn(),
    };

    toolAggregator = {
      aggregateAll: vi.fn().mockResolvedValue([]),
      getCachedTools: vi.fn().mockReturnValue([]),
    };

    upstreamManager = {
      getClient: vi.fn(),
      isHealthy: vi.fn().mockReturnValue(true),
    };

    policyEngine = {
      evaluate: vi.fn().mockReturnValue({ effect: 'allow' }),
    };

    responseCache = {
      buildKey: vi.fn().mockReturnValue('cache-key'),
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
    };

    requestTransform = {
      apply: vi.fn().mockImplementation((req) => Promise.resolve(req)),
    };

    responseTransform = {
      apply: vi.fn().mockImplementation((res) => Promise.resolve(res)),
    };

    service = new GatewayService(
      router as unknown as RouterService,
      toolAggregator as unknown as ToolAggregatorService,
      upstreamManager as unknown as UpstreamManagerService,
      policyEngine as unknown as PolicyEngineService,
      responseCache as unknown as ResponseCacheService,
      requestTransform as unknown as RequestTransformService,
      responseTransform as unknown as ResponseTransformService,
    );
  });

  describe('listTools', () => {
    it('should delegate to toolAggregator.aggregateAll', async () => {
      const expected = [
        {
          name: 'gh_list',
          description: 'test',
          inputSchema: {},
          upstreamName: 'github',
          originalName: 'list',
        },
      ];
      toolAggregator.aggregateAll.mockResolvedValue(expected);

      const result = await service.listTools();

      expect(result).toBe(expected);
      expect(toolAggregator.aggregateAll).toHaveBeenCalled();
    });
  });

  describe('getCachedTools', () => {
    it('should delegate to toolAggregator.getCachedTools', () => {
      const expected = [{ name: 'tool1' }];
      toolAggregator.getCachedTools.mockReturnValue(expected);

      const result = service.getCachedTools();

      expect(result).toBe(expected);
    });
  });

  describe('callTool', () => {
    const setupSuccessfulCall = () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'result' }],
          isError: false,
        }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      return mockClient;
    };

    it('should return denied error when policy denies tool', async () => {
      policyEngine.evaluate.mockReturnValue({ effect: 'deny', reason: 'blocked' });

      const result = await service.callTool('gh_dangerous', {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('denied by policy');
    });

    it('should return require_approval error when policy requires approval', async () => {
      policyEngine.evaluate.mockReturnValue({ effect: 'require_approval', reason: 'needs review' });

      const result = await service.callTool('gh_risky', {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('requires approval');
    });

    it('should return error when no route is found', async () => {
      router.resolve.mockReturnValue(undefined);

      const result = await service.callTool('unknown', {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('No upstream found');
    });

    it('should return cached result on cache hit', async () => {
      setupSuccessfulCall();
      const cachedResult = { content: [{ type: 'text', text: 'cached' }], isError: false };
      responseCache.get.mockReturnValue(cachedResult);

      const result = await service.callTool('gh_listRepos', {});

      expect(result).toBe(cachedResult);
      expect(upstreamManager.getClient).not.toHaveBeenCalled();
    });

    it('should return error when client is not connected', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue(undefined);

      const result = await service.callTool('gh_listRepos', {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('not connected');
    });

    it('should return error when upstream is unhealthy', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue({});
      upstreamManager.isHealthy.mockReturnValue(false);

      const result = await service.callTool('gh_listRepos', {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('unhealthy');
    });

    it('should execute full call flow: policy -> route -> cache miss -> transform -> call -> transform -> cache set', async () => {
      const mockClient = setupSuccessfulCall();

      const result = await service.callTool('gh_listRepos', { org: 'acme' });

      expect(policyEngine.evaluate).toHaveBeenCalledWith('gh_listRepos');
      expect(router.resolve).toHaveBeenCalledWith('gh_listRepos');
      expect(responseCache.get).toHaveBeenCalledWith('cache-key');
      expect(requestTransform.apply).toHaveBeenCalled();
      expect(mockClient.callTool).toHaveBeenCalled();
      expect(responseTransform.apply).toHaveBeenCalled();
      expect(responseCache.set).toHaveBeenCalledWith(
        'cache-key',
        expect.any(Object),
        'gh_listRepos',
      );
      expect(result.isError).toBeFalsy();
    });

    it('should not cache error responses', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue({
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'error' }],
          isError: true,
        }),
      });

      await service.callTool('gh_listRepos', {});

      expect(responseCache.set).not.toHaveBeenCalled();
    });

    it('should return error when upstream call throws', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue({
        callTool: vi.fn().mockRejectedValue(new Error('network error')),
      });

      const result = await service.callTool('gh_listRepos', {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('network error');
    });
  });
});
