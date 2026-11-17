import { McpError } from '@nest-mcp/common';
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
      activateSampling: vi.fn(),
      deactivateSampling: vi.fn(),
      activateElicitation: vi.fn(),
      deactivateElicitation: vi.fn(),
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

    it('should activate and deactivate sampling forwarder around the upstream call', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({ content: [], isError: false }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      const createMessage = vi.fn();

      await service.callTool('gh_listRepos', {}, undefined, undefined, createMessage);

      expect(upstreamManager.activateSampling).toHaveBeenCalledWith('github', createMessage);
      expect(upstreamManager.deactivateSampling).toHaveBeenCalledWith('github');
    });

    it('should deactivate sampling forwarder even when upstream call throws', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue({
        callTool: vi.fn().mockRejectedValue(new Error('network error')),
      });
      const createMessage = vi.fn();

      await service.callTool('gh_listRepos', {}, undefined, undefined, createMessage);

      expect(upstreamManager.deactivateSampling).toHaveBeenCalledWith('github');
    });

    it('should activate and deactivate elicitation forwarder around the upstream call', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({ content: [], isError: false }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      const elicit = vi.fn();

      await service.callTool('gh_listRepos', {}, undefined, undefined, undefined, elicit);

      expect(upstreamManager.activateElicitation).toHaveBeenCalledWith('github', elicit);
      expect(upstreamManager.deactivateElicitation).toHaveBeenCalledWith('github');
    });

    it('should deactivate elicitation forwarder even when upstream call throws', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue({
        callTool: vi.fn().mockRejectedValue(new Error('network error')),
      });
      const elicit = vi.fn();

      await service.callTool('gh_listRepos', {}, undefined, undefined, undefined, elicit);

      expect(upstreamManager.deactivateElicitation).toHaveBeenCalledWith('github');
    });

    it('should not activate sampling when createMessage is not provided', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue({
        callTool: vi.fn().mockResolvedValue({ content: [], isError: false }),
      });

      await service.callTool('gh_listRepos', {});

      expect(upstreamManager.activateSampling).not.toHaveBeenCalled();
      expect(upstreamManager.deactivateSampling).not.toHaveBeenCalled();
    });

    it('should pass signal to upstream client.callTool', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      const mockClient = {
        callTool: vi
          .fn()
          .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      const controller = new AbortController();

      await service.callTool('gh_listRepos', { org: 'acme' }, undefined, controller.signal);

      expect(mockClient.callTool).toHaveBeenCalledWith(expect.any(Object), undefined, {
        signal: controller.signal,
      });
    });

    it('passes structuredContent and _meta from the upstream through to the result', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue({
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '{"count":2}' }],
          structuredContent: { count: 2 },
          _meta: { traceId: 't-1' },
        }),
      });

      const result = await service.callTool('gh_listRepos', {});

      expect(result).toEqual({
        content: [{ type: 'text', text: '{"count":2}' }],
        isError: undefined,
        structuredContent: { count: 2 },
        _meta: { traceId: 't-1' },
      });
      expect(responseTransform.apply).toHaveBeenCalledWith(
        expect.objectContaining({ structuredContent: { count: 2 }, _meta: { traceId: 't-1' } }),
      );
    });

    it('lets response transforms rewrite structuredContent', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue({
        callTool: vi.fn().mockResolvedValue({ content: [], structuredContent: { a: 1 } }),
      });
      responseTransform.apply.mockImplementation((res) =>
        Promise.resolve({ ...res, structuredContent: { a: 2 } }),
      );

      const result = await service.callTool('gh_listRepos', {});

      expect(result.structuredContent).toEqual({ a: 2 });
    });

    it('omits structuredContent and _meta when the upstream returns none', async () => {
      setupSuccessfulCall();

      const result = await service.callTool('gh_listRepos', {});

      expect(result).not.toHaveProperty('structuredContent');
      expect(result).not.toHaveProperty('_meta');
    });

    it('caches structuredContent and _meta, and returns them on a cache hit', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue({
        callTool: vi.fn().mockResolvedValue({
          content: [],
          structuredContent: { n: 1 },
          _meta: { m: true },
        }),
      });
      const store = new Map<string, unknown>();
      responseCache.set.mockImplementation((key: string, value: unknown) => store.set(key, value));
      responseCache.get.mockImplementation((key: string) => store.get(key));

      await service.callTool('gh_listRepos', {});
      const cached = await service.callTool('gh_listRepos', {});

      expect(upstreamManager.getClient).toHaveBeenCalledTimes(1);
      expect(cached.structuredContent).toEqual({ n: 1 });
      expect(cached._meta).toEqual({ m: true });
    });

    it('forwards upstream progress to onProgress and resets the timeout on progress', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      const mockClient = {
        callTool: vi.fn().mockImplementation(async (_params, _schema, options) => {
          options.onprogress({ progress: 1, total: 4, message: 'step 1' });
          options.onprogress({ progress: 2 });
          return { content: [] };
        }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      upstreamManager.getConfig.mockReturnValue({ timeout: 5000 });
      const onProgress = vi.fn().mockResolvedValue(undefined);

      await service.callTool('gh_listRepos', {}, undefined, undefined, undefined, undefined, {
        onProgress,
      });
      await new Promise((resolve) => setImmediate(resolve));

      const options = mockClient.callTool.mock.calls[0][2];
      expect(options).toMatchObject({ timeout: 5000, resetTimeoutOnProgress: true });
      expect(onProgress).toHaveBeenNthCalledWith(1, { progress: 1, total: 4, message: 'step 1' });
      expect(onProgress).toHaveBeenNthCalledWith(2, { progress: 2 });
    });

    it('does not fail the call when forwarding progress fails', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue({
        callTool: vi.fn().mockImplementation(async (_params, _schema, options) => {
          options.onprogress({ progress: 1 });
          return { content: [{ type: 'text', text: 'ok' }] };
        }),
      });
      const onProgress = vi.fn().mockRejectedValue(new Error('session gone'));

      const result = await service.callTool(
        'gh_listRepos',
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        { onProgress },
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.isError).toBeFalsy();
      expect(onProgress).toHaveBeenCalled();
    });

    it('does not request progress when no onProgress is given', async () => {
      const mockClient = setupSuccessfulCall();

      await service.callTool('gh_listRepos', {});

      expect(mockClient.callTool).toHaveBeenCalledWith(expect.any(Object), undefined, undefined);
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
    const cachedResource = {
      uri: 'fs://file:///a',
      upstreamName: 'files',
      originalUri: 'file:///a',
    };

    it('throws -32002 with data.uri when the resource is not in the cache', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([]);

      const error = await service.readResource('missing://uri').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({ code: -32002, data: { uri: 'missing://uri' } });
    });

    it('throws -32603 when the client is not connected', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([cachedResource]);
      upstreamManager.getClient.mockReturnValue(undefined);

      await expect(service.readResource('fs://file:///a')).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('not connected'),
      });
    });

    it('throws -32603 when the upstream is unhealthy', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([cachedResource]);
      upstreamManager.getClient.mockReturnValue({});
      upstreamManager.isHealthy.mockReturnValue(false);

      await expect(service.readResource('fs://file:///a')).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('unhealthy'),
      });
    });

    it('reads the originalUri upstream and returns the gateway URI', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([cachedResource]);
      const mockClient = {
        readResource: vi.fn().mockResolvedValue({
          contents: [{ uri: 'file:///a', text: 'hello', mimeType: 'text/plain' }],
        }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      upstreamManager.isHealthy.mockReturnValue(true);

      const result = await service.readResource('fs://file:///a');

      expect(mockClient.readResource).toHaveBeenCalledWith({ uri: 'file:///a' }, undefined);
      expect(result.contents).toEqual([
        { uri: 'fs://file:///a', text: 'hello', mimeType: 'text/plain' },
      ]);
    });

    it('prefixes URIs of additional contents with the same gateway prefix', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([cachedResource]);
      upstreamManager.getClient.mockReturnValue({
        readResource: vi.fn().mockResolvedValue({
          contents: [
            { uri: 'file:///a', text: 'a' },
            { uri: 'file:///a/child', text: 'child' },
          ],
        }),
      });

      const result = await service.readResource('fs://file:///a');

      expect(result.contents.map((c) => c.uri)).toEqual(['fs://file:///a', 'fs://file:///a/child']);
    });

    it('maps an upstream -32002 to a gateway -32002 carrying the gateway URI', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([cachedResource]);
      upstreamManager.getClient.mockReturnValue({
        readResource: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('gone'), { code: -32002, data: { uri: 'x' } }),
          ),
      });

      await expect(service.readResource('fs://file:///a')).rejects.toMatchObject({
        code: -32002,
        data: { uri: 'fs://file:///a' },
      });
    });

    it('passes an upstream -32602 through as invalid params', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([cachedResource]);
      upstreamManager.getClient.mockReturnValue({
        readResource: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('bad uri'), { code: -32602 })),
      });

      await expect(service.readResource('fs://file:///a')).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining('bad uri'),
      });
    });

    it('throws -32603 with the upstream message when the upstream call throws', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([cachedResource]);
      upstreamManager.getClient.mockReturnValue({
        readResource: vi.fn().mockRejectedValue(new Error('read failed')),
      });
      upstreamManager.isHealthy.mockReturnValue(true);

      await expect(service.readResource('fs://file:///a')).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('read failed'),
        data: { uri: 'fs://file:///a', upstream: 'files' },
      });
    });

    it('should pass signal to upstream client.readResource', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([cachedResource]);
      const mockClient = {
        readResource: vi.fn().mockResolvedValue({ contents: [{ uri: 'file:///a', text: 'hi' }] }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      upstreamManager.isHealthy.mockReturnValue(true);
      const controller = new AbortController();

      await service.readResource('fs://file:///a', controller.signal);

      expect(mockClient.readResource).toHaveBeenCalledWith(
        { uri: 'file:///a' },
        { signal: controller.signal },
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
    const cachedPrompt = {
      name: 'ai_summarize',
      upstreamName: 'assistant',
      originalName: 'summarize',
    };

    it('throws -32602 when the prompt is not in the cache', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([]);

      const error = await service.getPrompt('missing', {}).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({ code: -32602, message: expect.stringContaining('not found') });
    });

    it('throws -32603 when the client is not connected', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([cachedPrompt]);
      upstreamManager.getClient.mockReturnValue(undefined);

      await expect(service.getPrompt('ai_summarize', {})).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('not connected'),
      });
    });

    it('throws -32603 when the upstream is unhealthy', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([cachedPrompt]);
      upstreamManager.getClient.mockReturnValue({});
      upstreamManager.isHealthy.mockReturnValue(false);

      await expect(service.getPrompt('ai_summarize', {})).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('unhealthy'),
      });
    });

    it('should delegate getPrompt to upstream with originalName and args', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([cachedPrompt]);
      const mockClient = {
        getPrompt: vi.fn().mockResolvedValue({
          description: 'Summarize text',
          messages: [{ role: 'user', content: { type: 'text', text: 'summarized' } }],
        }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      upstreamManager.isHealthy.mockReturnValue(true);

      const result = await service.getPrompt('ai_summarize', { text: 'hello', style: 'brief' });

      expect(mockClient.getPrompt).toHaveBeenCalledWith(
        { name: 'summarize', arguments: { text: 'hello', style: 'brief' } },
        undefined,
      );
      expect(result.description).toBe('Summarize text');
      expect(result.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'summarized' } },
      ]);
    });

    it('omits description when the upstream does not return one', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([cachedPrompt]);
      upstreamManager.getClient.mockReturnValue({
        getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
      });

      const result = await service.getPrompt('ai_summarize', {});

      expect(result).not.toHaveProperty('description');
    });

    it('throws -32603 with the upstream message when the upstream call throws', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([cachedPrompt]);
      upstreamManager.getClient.mockReturnValue({
        getPrompt: vi.fn().mockRejectedValue(new Error('prompt failed')),
      });
      upstreamManager.isHealthy.mockReturnValue(true);

      await expect(service.getPrompt('ai_summarize', {})).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('prompt failed'),
      });
    });

    it('passes an upstream -32602 (e.g. missing argument) through as invalid params', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([cachedPrompt]);
      upstreamManager.getClient.mockReturnValue({
        getPrompt: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('missing text'), { code: -32602 })),
      });

      await expect(service.getPrompt('ai_summarize', {})).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining('missing text'),
      });
    });

    it('should pass signal to upstream client.getPrompt', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([cachedPrompt]);
      const mockClient = {
        getPrompt: vi.fn().mockResolvedValue({
          messages: [{ role: 'user', content: { type: 'text', text: 'done' } }],
        }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      upstreamManager.isHealthy.mockReturnValue(true);
      const controller = new AbortController();

      await service.getPrompt('ai_summarize', { lang: 'en' }, controller.signal);

      expect(mockClient.getPrompt).toHaveBeenCalledWith(
        { name: 'summarize', arguments: { lang: 'en' } },
        { signal: controller.signal },
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

  describe('readResourceTemplate', () => {
    const usersTemplate = {
      uriTemplate: 'fs://file:///users/{id}',
      upstreamName: 'files',
      originalUriTemplate: 'file:///users/{id}',
    };

    it('should match template, expand original URI, and forward to upstream', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([
        {
          uriTemplate: 'fs://file:///users/{id}/profile',
          upstreamName: 'files',
          originalUriTemplate: 'file:///users/{id}/profile',
        },
      ]);
      const mockClient = {
        readResource: vi.fn().mockResolvedValue({
          contents: [{ uri: 'file:///users/42/profile', text: 'user data' }],
        }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      upstreamManager.isHealthy.mockReturnValue(true);

      const result = await service.readResourceTemplate('fs://file:///users/42/profile');

      expect(mockClient.readResource).toHaveBeenCalledWith(
        { uri: 'file:///users/42/profile' },
        undefined,
      );
      expect(result.contents).toEqual([
        { uri: 'fs://file:///users/42/profile', text: 'user data' },
      ]);
    });

    it('throws -32002 with data.uri when no template matches', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([]);

      await expect(service.readResourceTemplate('file:///unknown/path')).rejects.toMatchObject({
        code: -32002,
        data: { uri: 'file:///unknown/path' },
      });
    });

    it('throws -32603 when the upstream is not connected', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([usersTemplate]);
      upstreamManager.getClient.mockReturnValue(undefined);

      await expect(service.readResourceTemplate('fs://file:///users/42')).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('not connected'),
      });
    });

    it('throws -32603 when the upstream is unhealthy', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([usersTemplate]);
      upstreamManager.getClient.mockReturnValue({});
      upstreamManager.isHealthy.mockReturnValue(false);

      await expect(service.readResourceTemplate('fs://file:///users/42')).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('unhealthy'),
      });
    });

    it('should pass signal to upstream client', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([
        {
          uriTemplate: 'fs://file:///docs/{name}',
          upstreamName: 'docs',
          originalUriTemplate: 'file:///docs/{name}',
        },
      ]);
      const mockClient = {
        readResource: vi.fn().mockResolvedValue({ contents: [] }),
      };
      upstreamManager.getClient.mockReturnValue(mockClient);
      upstreamManager.isHealthy.mockReturnValue(true);
      const controller = new AbortController();

      await service.readResourceTemplate('fs://file:///docs/readme', controller.signal);

      expect(mockClient.readResource).toHaveBeenCalledWith(
        { uri: 'file:///docs/readme' },
        { signal: controller.signal },
      );
    });

    it('maps an upstream -32002 to a gateway -32002 for the requested URI', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([usersTemplate]);
      upstreamManager.getClient.mockReturnValue({
        readResource: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('no user'), { code: -32002 })),
      });

      await expect(service.readResourceTemplate('fs://file:///users/42')).rejects.toMatchObject({
        code: -32002,
        data: { uri: 'fs://file:///users/42' },
      });
    });

    it('throws -32603 with the upstream message when the upstream call throws', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([usersTemplate]);
      upstreamManager.getClient.mockReturnValue({
        readResource: vi.fn().mockRejectedValue(new Error('network error')),
      });
      upstreamManager.isHealthy.mockReturnValue(true);

      await expect(service.readResourceTemplate('fs://file:///users/42')).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('network error'),
      });
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

    it('should return empty values when client not available (prompt)', async () => {
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

    it('should return empty values when client not available (resource template)', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([
        {
          uriTemplate: 'fs://file:///{path}',
          name: 'file',
          upstreamName: 'files',
          originalUriTemplate: 'file:///{path}',
        },
      ]);
      upstreamManager.getClient.mockReturnValue(undefined);

      const result = await service.complete(
        { type: 'ref/resource', uri: 'fs://file:///{path}' },
        { name: 'path', value: 'val' },
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
      const result = await service.complete({ type: 'ref/unknown' }, { name: 'arg', value: 'val' });

      expect(result).toEqual({ values: [] });
    });

    it('forwards completion context.arguments to the upstream (prompt)', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([
        { name: 'ai_summarize', upstreamName: 'assistant', originalName: 'summarize' },
      ]);
      const complete = vi.fn().mockResolvedValue({ completion: { values: ['x'] } });
      upstreamManager.getClient.mockReturnValue({ complete });

      await service.complete(
        { type: 'ref/prompt', name: 'ai_summarize' },
        { name: 'style', value: 's' },
        { arguments: { language: 'en' } },
      );

      expect(complete).toHaveBeenCalledWith({
        ref: { type: 'ref/prompt', name: 'summarize' },
        argument: { name: 'style', value: 's' },
        context: { arguments: { language: 'en' } },
      });
    });

    it('forwards completion context.arguments to the upstream (resource template)', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([
        {
          uriTemplate: 'fs://file:///{dir}/{path}',
          name: 'file',
          upstreamName: 'files',
          originalUriTemplate: 'file:///{dir}/{path}',
        },
      ]);
      const complete = vi.fn().mockResolvedValue({ completion: { values: [] } });
      upstreamManager.getClient.mockReturnValue({ complete });

      await service.complete(
        { type: 'ref/resource', uri: 'fs://file:///{dir}/{path}' },
        { name: 'path', value: 'r' },
        { arguments: { dir: 'docs' } },
      );

      expect(complete).toHaveBeenCalledWith({
        ref: { type: 'ref/resource', uri: 'file:///{dir}/{path}' },
        argument: { name: 'path', value: 'r' },
        context: { arguments: { dir: 'docs' } },
      });
    });
  });

  describe('upstream timeouts and cancellation', () => {
    const timeoutError = () =>
      Object.assign(new Error('MCP error -32001: Request timed out'), { code: -32001 });

    it('passes the configured timeout to the upstream callTool (no 60 s cap)', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      const mockClient = { callTool: vi.fn().mockResolvedValue({ content: [] }) };
      upstreamManager.getClient.mockReturnValue(mockClient);
      upstreamManager.getConfig.mockReturnValue({ timeout: 120000 });
      const controller = new AbortController();

      await service.callTool('gh_listRepos', {}, undefined, controller.signal);

      expect(mockClient.callTool).toHaveBeenCalledWith(expect.any(Object), undefined, {
        signal: controller.signal,
        timeout: 120000,
      });
    });

    it('returns an isError result naming the timeout when the upstream times out', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      upstreamManager.getClient.mockReturnValue({
        callTool: vi.fn().mockRejectedValue(timeoutError()),
      });
      upstreamManager.getConfig.mockReturnValue({ timeout: 100 });

      const result = await service.callTool('gh_listRepos', {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toBe(
        'Error forwarding to upstream: request timed out after 100ms',
      );
    });

    it('passes the configured timeout to readResource and maps a timeout to -32603', async () => {
      resourceAggregator.getCachedResources.mockReturnValue([
        { uri: 'fs://file:///a', upstreamName: 'files', originalUri: 'file:///a' },
      ]);
      const readResource = vi.fn().mockRejectedValue(timeoutError());
      upstreamManager.getClient.mockReturnValue({ readResource });
      upstreamManager.getConfig.mockReturnValue({ timeout: 100 });

      await expect(service.readResource('fs://file:///a')).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('timed out after 100ms'),
      });
      expect(readResource).toHaveBeenCalledWith({ uri: 'file:///a' }, { timeout: 100 });
    });

    it('passes the configured timeout to getPrompt', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([
        { name: 'ai_summarize', upstreamName: 'assistant', originalName: 'summarize' },
      ]);
      const getPrompt = vi.fn().mockRejectedValue(timeoutError());
      upstreamManager.getClient.mockReturnValue({ getPrompt });
      upstreamManager.getConfig.mockReturnValue({ timeout: 100 });

      await expect(service.getPrompt('ai_summarize', {})).rejects.toMatchObject({
        code: -32603,
        message: expect.stringContaining('timed out'),
      });
      expect(getPrompt).toHaveBeenCalledWith(
        { name: 'summarize', arguments: {} },
        { timeout: 100 },
      );
    });

    it('passes the configured timeout to readResourceTemplate', async () => {
      resourceTemplateAggregator.getCachedTemplates.mockReturnValue([
        {
          uriTemplate: 'fs://file:///docs/{name}',
          upstreamName: 'docs',
          originalUriTemplate: 'file:///docs/{name}',
        },
      ]);
      const readResource = vi.fn().mockResolvedValue({ contents: [] });
      upstreamManager.getClient.mockReturnValue({ readResource });
      upstreamManager.getConfig.mockReturnValue({ timeout: 100 });

      await service.readResourceTemplate('fs://file:///docs/readme');

      expect(readResource).toHaveBeenCalledWith({ uri: 'file:///docs/readme' }, { timeout: 100 });
    });

    it('passes the configured timeout to complete', async () => {
      promptAggregator.getCachedPrompts.mockReturnValue([
        { name: 'ai_summarize', upstreamName: 'assistant', originalName: 'summarize' },
      ]);
      const complete = vi.fn().mockResolvedValue({ completion: { values: [] } });
      upstreamManager.getClient.mockReturnValue({ complete });
      upstreamManager.getConfig.mockReturnValue({ timeout: 100 });

      await service.complete(
        { type: 'ref/prompt', name: 'ai_summarize' },
        { name: 'a', value: '' },
      );

      expect(complete).toHaveBeenCalledWith(expect.any(Object), { timeout: 100 });
    });

    it('ignores a non-positive timeout and leaves the SDK default in place', async () => {
      router.resolve.mockReturnValue({ upstreamName: 'github', originalToolName: 'listRepos' });
      const mockClient = { callTool: vi.fn().mockResolvedValue({ content: [] }) };
      upstreamManager.getClient.mockReturnValue(mockClient);
      upstreamManager.getConfig.mockReturnValue({ timeout: 0 });

      await service.callTool('gh_listRepos', {});

      expect(mockClient.callTool).toHaveBeenCalledWith(expect.any(Object), undefined, undefined);
    });
  });
});
