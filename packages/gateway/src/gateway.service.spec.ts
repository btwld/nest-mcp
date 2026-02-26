import type { ResponseCacheService } from './cache/response-cache.service';
import { GatewayService } from './gateway.service';
import type { PolicyEngineService } from './policies/policy-engine.service';
import type { PromptAggregatorService } from './routing/prompt-aggregator.service';
import type { ResourceAggregatorService } from './routing/resource-aggregator.service';
import type { ResourceTemplateAggregatorService } from './routing/resource-template-aggregator.service';
import type { RouterService } from './routing/router.service';
import type { ToolAggregatorService } from './routing/tool-aggregator.service';
import type { RequestTransformService } from './transform/request-transform.service';
import type { ResponseTransformService } from './transform/response-transform.service';
import type { UpstreamManagerService } from './upstream/upstream-manager.service';

describe('GatewayService', () => {
  let service: GatewayService;
  let router: Record<string, ReturnType<typeof vi.fn>>;
  let toolAggregator: Record<string, ReturnType<typeof vi.fn>>;
  let resourceAggregator: Record<string, ReturnType<typeof vi.fn>>;
  let promptAggregator: Record<string, ReturnType<typeof vi.fn>>;
  let resourceTemplateAggregator: Record<string, ReturnType<typeof vi.fn>>;
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

    resourceAggregator = {
      aggregateAll: vi.fn().mockResolvedValue([]),
      getCachedResources: vi.fn().mockReturnValue([]),
    };

    promptAggregator = {
      aggregateAll: vi.fn().mockResolvedValue([]),
      getCachedPrompts: vi.fn().mockReturnValue([]),
    };

    resourceTemplateAggregator = {
      aggregateAll: vi.fn().mockResolvedValue([]),
      getCachedTemplates: vi.fn().mockReturnValue([]),
    };

    upstreamManager = {
      getClient: vi.fn(),
      getConfig: vi.fn().mockReturnValue(undefined),
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
      resourceAggregator as unknown as ResourceAggregatorService,
      promptAggregator as unknown as PromptAggregatorService,
      resourceTemplateAggregator as unknown as ResourceTemplateAggregatorService,
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

      expect(policyEngine.evaluate).toHaveBeenCalledWith('gh_listRepos', undefined);
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

    it('should pass PolicyContext through to policyEngine.evaluate', async () => {
      policyEngine.evaluate.mockReturnValue({ effect: 'deny', reason: 'role denied' });
      const context = { userId: 'bot-ci', roles: ['bot'], scopes: ['deploy'] };

      await service.callTool('admin_deploy', {}, context);

      expect(policyEngine.evaluate).toHaveBeenCalledWith('admin_deploy', context);
    });
  });

  describe('listResources', () => {
    it('should delegate to resourceAggregator.aggregateAll', async () => {
      const expected = [
        {
          uri: 'fs://file:///readme.md',
          name: 'readme',
          description: 'Readme',
          upstreamName: 'files',
          originalUri: 'file:///readme.md',
        },
      ];
      resourceAggregator.aggregateAll.mockResolvedValue(expected);

      const result = await service.listResources();

      expect(result).toBe(expected);
      expect(resourceAggregator.aggregateAll).toHaveBeenCalled();
    });
  });

  describe('getCachedResources', () => {
    it('should delegate to resourceAggregator.getCachedResources', () => {
      const expected = [{ uri: 'file:///r', name: 'r' }];
      resourceAggregator.getCachedResources.mockReturnValue(expected);

      const result = service.getCachedResources();

      expect(result).toBe(expected);
    });
  });

  describe('readResource', () => {
    it('should return not-found when resource is not in cache', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([]);

      const result = await service.readResource('missing://uri');

      expect(result.contents[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining('not found') }),
      );
    });

    it('should return error when client is not connected', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([
        { uri: 'fs://file:///a', upstreamName: 'files', originalUri: 'file:///a' },
      ]);
      upstreamManager.getClient.mockReturnValue(undefined);

      const result = await service.readResource('fs://file:///a');

      expect(result.contents[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining('not connected') }),
      );
    });

    it('should return error when upstream is unhealthy', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([
        { uri: 'fs://file:///a', upstreamName: 'files', originalUri: 'file:///a' },
      ]);
      upstreamManager.getClient.mockReturnValue({});
      upstreamManager.isHealthy.mockReturnValue(false);

      const result = await service.readResource('fs://file:///a');

      expect(result.contents[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining('unhealthy') }),
      );
    });

    it('should delegate read to upstream client with originalUri', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([
        { uri: 'fs://file:///a', upstreamName: 'files', originalUri: 'file:///a' },
      ]);
      const mockClient = {
        readResource: vi.fn().mockResolvedValue({
          contents: [{ uri: 'file:///a', text: 'hello' }],
        }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      upstreamManager.isHealthy.mockReturnValue(true);

      const result = await service.readResource('fs://file:///a');

      expect(mockClient.readResource).toHaveBeenCalledWith({ uri: 'file:///a' });
      expect(result.contents).toEqual([{ uri: 'file:///a', text: 'hello' }]);
    });

    it('should return error when upstream call throws', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([
        { uri: 'fs://file:///a', upstreamName: 'files', originalUri: 'file:///a' },
      ]);
      upstreamManager.getClient.mockReturnValue({
        readResource: vi.fn().mockRejectedValue(new Error('read failed')),
      });
      upstreamManager.isHealthy.mockReturnValue(true);

      const result = await service.readResource('fs://file:///a');

      expect(result.contents[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining('read failed') }),
      );
    });
  });

  describe('listPrompts', () => {
    it('should delegate to promptAggregator.aggregateAll', async () => {
      const expected = [
        {
          name: 'ai_summarize',
          description: 'Summarize text',
          upstreamName: 'assistant',
          originalName: 'summarize',
        },
      ];
      promptAggregator.aggregateAll.mockResolvedValue(expected);

      const result = await service.listPrompts();

      expect(result).toBe(expected);
      expect(promptAggregator.aggregateAll).toHaveBeenCalled();
    });
  });

  describe('getCachedPrompts', () => {
    it('should delegate to promptAggregator.getCachedPrompts', () => {
      const expected = [{ name: 'p1' }];
      promptAggregator.getCachedPrompts.mockReturnValue(expected);

      const result = service.getCachedPrompts();

      expect(result).toBe(expected);
    });
  });

  describe('getPrompt', () => {
    it('should return not-found when prompt is not in cache', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([]);

      const result = await service.getPrompt('missing', {});

      expect(result.messages[0]).toEqual(
        expect.objectContaining({
          content: expect.objectContaining({ text: expect.stringContaining('not found') }),
        }),
      );
    });

    it('should return error when client is not connected', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([
        { name: 'ai_summarize', upstreamName: 'assistant', originalName: 'summarize' },
      ]);
      upstreamManager.getClient.mockReturnValue(undefined);

      const result = await service.getPrompt('ai_summarize', {});

      expect(result.messages[0]).toEqual(
        expect.objectContaining({
          content: expect.objectContaining({ text: expect.stringContaining('not connected') }),
        }),
      );
    });

    it('should return error when upstream is unhealthy', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([
        { name: 'ai_summarize', upstreamName: 'assistant', originalName: 'summarize' },
      ]);
      upstreamManager.getClient.mockReturnValue({});
      upstreamManager.isHealthy.mockReturnValue(false);

      const result = await service.getPrompt('ai_summarize', {});

      expect(result.messages[0]).toEqual(
        expect.objectContaining({
          content: expect.objectContaining({ text: expect.stringContaining('unhealthy') }),
        }),
      );
    });

    it('should delegate getPrompt to upstream with originalName and args', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([
        { name: 'ai_summarize', upstreamName: 'assistant', originalName: 'summarize' },
      ]);
      const mockClient = {
        getPrompt: vi.fn().mockResolvedValue({
          description: 'Summarize text',
          messages: [{ role: 'user', content: { type: 'text', text: 'summarized' } }],
        }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      upstreamManager.isHealthy.mockReturnValue(true);

      const result = await service.getPrompt('ai_summarize', { text: 'hello' });

      expect(mockClient.getPrompt).toHaveBeenCalledWith({
        name: 'summarize',
        arguments: { text: 'hello' },
      });
      expect(result.description).toBe('Summarize text');
      expect(result.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'summarized' } },
      ]);
    });

    it('should return error when upstream call throws', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([
        { name: 'ai_summarize', upstreamName: 'assistant', originalName: 'summarize' },
      ]);
      upstreamManager.getClient.mockReturnValue({
        getPrompt: vi.fn().mockRejectedValue(new Error('prompt failed')),
      });
      upstreamManager.isHealthy.mockReturnValue(true);

      const result = await service.getPrompt('ai_summarize', {});

      expect(result.messages[0]).toEqual(
        expect.objectContaining({
          content: expect.objectContaining({ text: expect.stringContaining('prompt failed') }),
        }),
      );
    });
  });

  describe('listResourceTemplates', () => {
    it('should delegate to resourceTemplateAggregator.aggregateAll', async () => {
      const expected = [
        {
          uriTemplate: 'fs://file:///{path}',
          name: 'file',
          upstreamName: 'files',
          originalUriTemplate: 'file:///{path}',
        },
      ];
      resourceTemplateAggregator.aggregateAll.mockResolvedValue(expected);

      const result = await service.listResourceTemplates();

      expect(result).toBe(expected);
      expect(resourceTemplateAggregator.aggregateAll).toHaveBeenCalled();
    });
  });

  describe('getCachedResourceTemplates', () => {
    it('should delegate to resourceTemplateAggregator.getCachedTemplates', () => {
      const expected = [{ uriTemplate: 'file:///{path}' }];
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue(expected);

      const result = service.getCachedResourceTemplates();

      expect(result).toBe(expected);
    });
  });

  describe('complete', () => {
    it('should route prompt completion to correct upstream', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([
        { name: 'ai_summarize', upstreamName: 'assistant', originalName: 'summarize' },
      ]);
      const mockClient = {
        complete: vi.fn().mockResolvedValue({
          completion: { values: ['short', 'medium', 'long'], hasMore: false, total: 3 },
        }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);

      const result = await service.complete(
        { type: 'ref/prompt', name: 'ai_summarize' },
        { name: 'style', value: 'sh' },
      );

      expect(mockClient.complete).toHaveBeenCalledWith({
        ref: { type: 'ref/prompt', name: 'summarize' },
        argument: { name: 'style', value: 'sh' },
      });
      expect(result).toEqual({ values: ['short', 'medium', 'long'], hasMore: false, total: 3 });
    });

    it('should route resource template completion to correct upstream', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([
        {
          uriTemplate: 'fs://file:///{path}',
          name: 'file',
          upstreamName: 'files',
          originalUriTemplate: 'file:///{path}',
        },
      ]);
      const mockClient = {
        complete: vi.fn().mockResolvedValue({
          completion: { values: ['readme.md', 'readme.txt'] },
        }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);

      const result = await service.complete(
        { type: 'ref/resource', uri: 'fs://file:///{path}' },
        { name: 'path', value: 'read' },
      );

      expect(mockClient.complete).toHaveBeenCalledWith({
        ref: { type: 'ref/resource', uri: 'file:///{path}' },
        argument: { name: 'path', value: 'read' },
      });
      expect(result.values).toEqual(['readme.md', 'readme.txt']);
    });

    it('should return empty values when prompt not found', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([]);

      const result = await service.complete(
        { type: 'ref/prompt', name: 'missing' },
        { name: 'arg', value: 'val' },
      );

      expect(result).toEqual({ values: [] });
    });

    it('should return empty values when resource template not found', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([]);

      const result = await service.complete(
        { type: 'ref/resource', uri: 'missing:///{path}' },
        { name: 'path', value: 'val' },
      );

      expect(result).toEqual({ values: [] });
    });

    it('should return empty values when client not available', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([
        { name: 'ai_summarize', upstreamName: 'assistant', originalName: 'summarize' },
      ]);
      upstreamManager.getClient.mockReturnValue(undefined);

      const result = await service.complete(
        { type: 'ref/prompt', name: 'ai_summarize' },
        { name: 'arg', value: 'val' },
      );

      expect(result).toEqual({ values: [] });
    });

    it('should return empty values on upstream error', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([
        { name: 'ai_summarize', upstreamName: 'assistant', originalName: 'summarize' },
      ]);
      upstreamManager.getClient.mockReturnValue({
        complete: vi.fn().mockRejectedValue(new Error('upstream error')),
      });

      const result = await service.complete(
        { type: 'ref/prompt', name: 'ai_summarize' },
        { name: 'arg', value: 'val' },
      );

      expect(result).toEqual({ values: [] });
    });

    it('should return empty values for unknown ref type', async () => {
      const result = await service.complete(
        { type: 'ref/unknown' },
        { name: 'arg', value: 'val' },
      );

      expect(result).toEqual({ values: [] });
    });
  });
});
