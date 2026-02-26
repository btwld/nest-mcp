import type { McpExecutionContext } from '@btwld/mcp-common';
import { McpTransportType } from '@btwld/mcp-common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerHandlers } from './register-handlers';

describe('registerHandlers', () => {
  let mockInnerServer: Record<string, ReturnType<typeof vi.fn>>;
  let mockServer: Record<string, unknown>;
  let mockRegistry: Record<string, ReturnType<typeof vi.fn>>;
  let mockPipeline: Record<string, ReturnType<typeof vi.fn>>;
  let ctx: McpExecutionContext;

  beforeEach(() => {
    mockInnerServer = {
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn(),
    };

    mockServer = {
      tool: vi.fn(),
      registerTool: vi.fn(),
      resource: vi.fn(),
      registerResource: vi.fn(),
      prompt: vi.fn(),
      registerPrompt: vi.fn(),
      server: mockInnerServer,
    };

    mockRegistry = {
      getAllTools: vi.fn().mockReturnValue([]),
      getAllResources: vi.fn().mockReturnValue([]),
      getAllResourceTemplates: vi.fn().mockReturnValue([]),
      getAllPrompts: vi.fn().mockReturnValue([]),
    };

    mockPipeline = {
      callTool: vi.fn().mockResolvedValue({ content: [] }),
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
      getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
      listTools: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
      listResources: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
      listResourceTemplates: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
      listPrompts: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
    };

    ctx = {
      sessionId: 'test-session',
      transport: McpTransportType.SSE,
      reportProgress: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metadata: {},
    };
  });

  it('registers nothing when registry is empty', () => {
    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    expect((mockServer.registerTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((mockServer.resource as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((mockServer.registerResource as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((mockServer.registerPrompt as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('registers tools via registerTool with config object', () => {
    const schema = z.object({ city: z.string().describe('City name') });
    mockRegistry.getAllTools.mockReturnValue([
      {
        name: 'get_weather',
        description: 'Get weather',
        parameters: schema,
        annotations: { readOnlyHint: true },
      },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const registerTool = mockServer.registerTool as ReturnType<typeof vi.fn>;
    expect(registerTool).toHaveBeenCalledTimes(1);
    const [name, config, callback] = registerTool.mock.calls[0];
    expect(name).toBe('get_weather');
    expect(config.description).toBe('Get weather');
    expect(config.inputSchema).toBe(schema);
    expect(config.annotations).toEqual({ readOnlyHint: true });
    expect(typeof callback).toBe('function');
  });

  it('passes outputSchema to registerTool config when present', () => {
    const outputSchema = z.object({ result: z.string() });
    mockRegistry.getAllTools.mockReturnValue([
      {
        name: 'compute',
        description: 'Compute',
        parameters: null,
        outputSchema,
      },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const registerTool = mockServer.registerTool as ReturnType<typeof vi.fn>;
    const [, config] = registerTool.mock.calls[0];
    expect(config.outputSchema).toBe(outputSchema);
  });

  it('registers tools with passthrough schema when no parameters', () => {
    mockRegistry.getAllTools.mockReturnValue([
      { name: 'ping', description: 'Ping', parameters: null },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const registerTool = mockServer.registerTool as ReturnType<typeof vi.fn>;
    const [, config] = registerTool.mock.calls[0];
    // When no Zod schema is provided, a passthrough schema is used so the SDK
    // always passes arguments to the handler callback.
    expect(config.inputSchema).toBeDefined();
    expect(typeof config.inputSchema.safeParseAsync).toBe('function');
  });

  it('registers resources with name, uri, mimeType metadata, and callback', () => {
    mockRegistry.getAllResources.mockReturnValue([
      { name: 'config', uri: 'data://config', mimeType: 'application/json' },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const resource = mockServer.resource as ReturnType<typeof vi.fn>;
    expect(resource).toHaveBeenCalledTimes(1);
    const [name, uri, metadata, callback] = resource.mock.calls[0];
    expect(name).toBe('config');
    expect(uri).toBe('data://config');
    expect(metadata).toEqual({ mimeType: 'application/json' });
    expect(typeof callback).toBe('function');
  });

  it('registers resources with empty metadata when no mimeType', () => {
    mockRegistry.getAllResources.mockReturnValue([
      { name: 'data', uri: 'data://data', mimeType: undefined },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const resource = mockServer.resource as ReturnType<typeof vi.fn>;
    const [, , metadata] = resource.mock.calls[0];
    expect(metadata).toEqual({});
  });

  it('registers resource templates via registerResource with ResourceTemplate instance', () => {
    mockRegistry.getAllResourceTemplates.mockReturnValue([
      { name: 'user', uriTemplate: 'data://users/{id}', mimeType: 'application/json' },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const registerResource = mockServer.registerResource as ReturnType<typeof vi.fn>;
    expect(registerResource).toHaveBeenCalledTimes(1);
    const [name, templateInstance, metadata, callback] = registerResource.mock.calls[0];
    expect(name).toBe('user');
    // Should be a ResourceTemplate instance, not a plain string
    expect(templateInstance).toBeDefined();
    expect(typeof templateInstance).toBe('object');
    expect(templateInstance.uriTemplate).toBeDefined();
    expect(metadata).toEqual({ mimeType: 'application/json' });
    expect(typeof callback).toBe('function');
  });

  it('registers prompts via registerPrompt with Zod argsSchema', () => {
    const schema = z.object({
      code: z.string().describe('The code to review'),
      language: z.string().optional().describe('Programming language'),
    });
    mockRegistry.getAllPrompts.mockReturnValue([
      { name: 'code_review', description: 'Review code', parameters: schema },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const registerPrompt = mockServer.registerPrompt as ReturnType<typeof vi.fn>;
    expect(registerPrompt).toHaveBeenCalledTimes(1);
    const [name, config, callback] = registerPrompt.mock.calls[0];
    expect(name).toBe('code_review');
    expect(config.description).toBe('Review code');
    // argsSchema should be the raw Zod shape from ZodObject.shape
    expect(config.argsSchema).toBe(schema.shape);
    expect(config.argsSchema.code).toBeDefined();
    expect(config.argsSchema.language).toBeDefined();
    expect(typeof callback).toBe('function');
  });

  it('registers prompts with undefined argsSchema when no parameters', () => {
    mockRegistry.getAllPrompts.mockReturnValue([
      { name: 'greeting', description: 'Greet', parameters: null },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const registerPrompt = mockServer.registerPrompt as ReturnType<typeof vi.fn>;
    const [, config] = registerPrompt.mock.calls[0];
    expect(config.argsSchema).toBeUndefined();
  });

  it('tool callback delegates to pipeline.callTool with signal in context', async () => {
    mockRegistry.getAllTools.mockReturnValue([
      { name: 'echo', description: 'Echo', parameters: null },
    ]);
    mockPipeline.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'hi' }] });

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const registerTool = mockServer.registerTool as ReturnType<typeof vi.fn>;
    const callback = registerTool.mock.calls[0][2];
    const mockExtra = { signal: new AbortController().signal, requestId: 'req-1' };
    const result = await callback({ message: 'hi' }, mockExtra);

    expect(mockPipeline.callTool).toHaveBeenCalledWith(
      'echo',
      { message: 'hi' },
      expect.objectContaining({ sessionId: 'test-session', signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual({ content: [{ type: 'text', text: 'hi' }] });
  });

  it('resource callback delegates to pipeline.readResource', async () => {
    mockRegistry.getAllResources.mockReturnValue([
      { name: 'config', uri: 'data://config', mimeType: undefined },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const resource = mockServer.resource as ReturnType<typeof vi.fn>;
    const callback = resource.mock.calls[0][3];
    await callback(new URL('data://config'));
    expect(mockPipeline.readResource).toHaveBeenCalledWith('data://config', ctx);
  });

  it('prompt callback delegates to pipeline.getPrompt', async () => {
    mockRegistry.getAllPrompts.mockReturnValue([
      { name: 'greet', description: 'Greet', parameters: null },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const registerPrompt = mockServer.registerPrompt as ReturnType<typeof vi.fn>;
    const callback = registerPrompt.mock.calls[0][2];
    await callback({ name: 'Alice' });
    expect(mockPipeline.getPrompt).toHaveBeenCalledWith('greet', { name: 'Alice' }, ctx);
  });

  // --- Cancellation ---

  it('registers notifications/cancelled handler on inner server', () => {
    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    expect(mockInnerServer.setNotificationHandler).toHaveBeenCalledWith(
      expect.objectContaining({ shape: expect.any(Object) }),
      expect.any(Function),
    );
  });

  it('cancellation handler aborts in-flight request', async () => {
    mockRegistry.getAllTools.mockReturnValue([
      { name: 'slow', description: 'Slow', parameters: null },
    ]);

    // Make callTool block until we resolve it
    let resolveCall!: (value: unknown) => void;
    mockPipeline.callTool.mockImplementation(
      () => new Promise((resolve) => { resolveCall = resolve; }),
    );

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const registerTool = mockServer.registerTool as ReturnType<typeof vi.fn>;
    const callback = registerTool.mock.calls[0][2];
    const mockExtra = { signal: new AbortController().signal, requestId: 'req-42' };

    // Start the tool call (don't await)
    const callPromise = callback({}, mockExtra);

    // Get the signal passed to the pipeline
    const passedCtx = mockPipeline.callTool.mock.calls[0][2] as McpExecutionContext;
    expect(passedCtx.signal).toBeDefined();
    expect(passedCtx.signal!.aborted).toBe(false);

    // Invoke the cancellation handler
    const cancelHandler = mockInnerServer.setNotificationHandler.mock.calls[0][1];
    await cancelHandler({ method: 'notifications/cancelled', params: { requestId: 'req-42' } });

    // Signal should now be aborted
    expect(passedCtx.signal!.aborted).toBe(true);

    // Resolve the blocked call to clean up
    resolveCall({ content: [] });
    await callPromise;
  });

  // --- Pagination ---

  it('registers custom list request handlers on inner server', () => {
    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    // 4 list handlers + 1 notification handler
    expect(mockInnerServer.setRequestHandler).toHaveBeenCalledTimes(4);
  });

  it('list tools handler passes cursor and returns paginated result', async () => {
    mockPipeline.listTools.mockResolvedValue({
      items: [{ name: 'tool-a' }],
      nextCursor: 'abc123',
    });

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    // Find the ListToolsRequest handler
    const listToolsCall = mockInnerServer.setRequestHandler.mock.calls.find(
      (call: unknown[]) => (call[0] as { shape?: { method?: { value?: string } } })?.shape?.method?.value === 'tools/list',
    );
    expect(listToolsCall).toBeDefined();

    const handler = listToolsCall![1];
    const result = await handler({ method: 'tools/list', params: { cursor: 'abc123' } });

    expect(mockPipeline.listTools).toHaveBeenCalledWith('abc123');
    expect(result).toEqual({ tools: [{ name: 'tool-a' }], nextCursor: 'abc123' });
  });

  it('list tools handler omits nextCursor when undefined', async () => {
    mockPipeline.listTools.mockResolvedValue({
      items: [{ name: 'tool-a' }],
      nextCursor: undefined,
    });

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const listToolsCall = mockInnerServer.setRequestHandler.mock.calls.find(
      (call: unknown[]) => (call[0] as { shape?: { method?: { value?: string } } })?.shape?.method?.value === 'tools/list',
    );
    const handler = listToolsCall![1];
    const result = await handler({ method: 'tools/list', params: {} });

    expect(result).toEqual({ tools: [{ name: 'tool-a' }] });
    expect(result).not.toHaveProperty('nextCursor');
  });

  it('list resources handler passes cursor and returns paginated result', async () => {
    mockPipeline.listResources.mockResolvedValue({
      items: [{ uri: 'file:///a' }],
      nextCursor: 'next',
    });

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const listResourcesCall = mockInnerServer.setRequestHandler.mock.calls.find(
      (call: unknown[]) => (call[0] as { shape?: { method?: { value?: string } } })?.shape?.method?.value === 'resources/list',
    );
    const handler = listResourcesCall![1];
    const result = await handler({ method: 'resources/list', params: { cursor: 'next' } });

    expect(mockPipeline.listResources).toHaveBeenCalledWith('next');
    expect(result).toEqual({ resources: [{ uri: 'file:///a' }], nextCursor: 'next' });
  });

  it('list prompts handler passes cursor and returns paginated result', async () => {
    mockPipeline.listPrompts.mockResolvedValue({
      items: [{ name: 'greet' }],
      nextCursor: undefined,
    });

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const listPromptsCall = mockInnerServer.setRequestHandler.mock.calls.find(
      (call: unknown[]) => (call[0] as { shape?: { method?: { value?: string } } })?.shape?.method?.value === 'prompts/list',
    );
    const handler = listPromptsCall![1];
    const result = await handler({ method: 'prompts/list', params: {} });

    expect(mockPipeline.listPrompts).toHaveBeenCalledWith(undefined);
    expect(result).toEqual({ prompts: [{ name: 'greet' }] });
  });
});
