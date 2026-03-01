import type { McpExecutionContext, McpModuleOptions } from '@btwld/mcp-common';
import { McpTransportType } from '@btwld/mcp-common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  registerHandlers,
  registerPromptOnServer,
  registerResourceOnServer,
  registerResourceTemplateOnServer,
  registerToolOnServer,
} from './register-handlers';

describe('registerHandlers', () => {
  let mockInnerServer: Record<string, ReturnType<typeof vi.fn>>;
  let mockServer: Record<string, unknown>;
  let mockRegistry: Record<string, ReturnType<typeof vi.fn> | boolean | undefined | Record<string, ReturnType<typeof vi.fn>>>;
  let mockPipeline: Record<string, ReturnType<typeof vi.fn>>;
  let mockOptions: McpModuleOptions;
  let ctx: McpExecutionContext;

  beforeEach(() => {
    mockInnerServer = {
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn(),
    };

    mockServer = {
      tool: vi.fn(),
      registerTool: vi.fn().mockReturnValue({ remove: vi.fn() }),
      resource: vi.fn().mockReturnValue({ remove: vi.fn() }),
      registerResource: vi.fn().mockReturnValue({ remove: vi.fn() }),
      prompt: vi.fn(),
      registerPrompt: vi.fn().mockReturnValue({ remove: vi.fn() }),
      server: mockInnerServer,
    };

    mockRegistry = {
      getAllTools: vi.fn().mockReturnValue([]),
      getAllResources: vi.fn().mockReturnValue([]),
      getAllResourceTemplates: vi.fn().mockReturnValue([]),
      getAllPrompts: vi.fn().mockReturnValue([]),
      hasTools: true,
      hasResources: true,
      hasResourceTemplates: true,
      hasPrompts: true,
      taskHandlerConfig: undefined,
    };

    mockOptions = {
      name: 'test-server',
      version: '1.0.0',
      transport: McpTransportType.STDIO,
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
      },
    } as McpModuleOptions;

    mockPipeline = {
      callTool: vi.fn().mockResolvedValue({ content: [] }),
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
      getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
      listTools: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
      listResources: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
      listResourceTemplates: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
      listPrompts: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
      complete: vi.fn().mockResolvedValue({ values: [] }),
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
    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const registerTool = mockServer.registerTool as ReturnType<typeof vi.fn>;
    const [, config] = registerTool.mock.calls[0];
    expect(config.outputSchema).toBe(outputSchema);
  });

  it('registers tools with passthrough schema when no parameters', () => {
    mockRegistry.getAllTools.mockReturnValue([
      { name: 'ping', description: 'Ping', parameters: null },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const resource = mockServer.resource as ReturnType<typeof vi.fn>;
    const [, , metadata] = resource.mock.calls[0];
    expect(metadata).toEqual({});
  });

  it('registers resource templates via registerResource with ResourceTemplate instance', () => {
    mockRegistry.getAllResourceTemplates.mockReturnValue([
      { name: 'user', uriTemplate: 'data://users/{id}', mimeType: 'application/json' },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const registerPrompt = mockServer.registerPrompt as ReturnType<typeof vi.fn>;
    const [, config] = registerPrompt.mock.calls[0];
    expect(config.argsSchema).toBeUndefined();
  });

  it('tool callback delegates to pipeline.callTool with signal in context', async () => {
    mockRegistry.getAllTools.mockReturnValue([
      { name: 'echo', description: 'Echo', parameters: null },
    ]);
    mockPipeline.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'hi' }] });

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const resource = mockServer.resource as ReturnType<typeof vi.fn>;
    const callback = resource.mock.calls[0][3];
    const mockExtra = { signal: new AbortController().signal, requestId: 'req-r1' };
    await callback(new URL('data://config'), mockExtra);
    expect(mockPipeline.readResource).toHaveBeenCalledWith(
      'data://config',
      expect.objectContaining({ sessionId: 'test-session', signal: expect.any(AbortSignal) }),
    );
  });

  it('prompt callback delegates to pipeline.getPrompt', async () => {
    mockRegistry.getAllPrompts.mockReturnValue([
      { name: 'greet', description: 'Greet', parameters: null },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const registerPrompt = mockServer.registerPrompt as ReturnType<typeof vi.fn>;
    const callback = registerPrompt.mock.calls[0][2];
    const mockExtra = { signal: new AbortController().signal, requestId: 'req-p1' };
    await callback({ name: 'Alice' }, mockExtra);
    expect(mockPipeline.getPrompt).toHaveBeenCalledWith(
      'greet',
      { name: 'Alice' },
      expect.objectContaining({ sessionId: 'test-session', signal: expect.any(AbortSignal) }),
    );
  });

  // --- Cancellation ---

  it('registers notifications/cancelled handler on inner server', () => {
    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

  it('resource callback passes signal through context', async () => {
    mockRegistry.getAllResources.mockReturnValue([
      { name: 'config', uri: 'data://config', mimeType: undefined },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const resource = mockServer.resource as ReturnType<typeof vi.fn>;
    const callback = resource.mock.calls[0][3];
    const mockExtra = { signal: new AbortController().signal, requestId: 'req-r2' };
    await callback(new URL('data://config'), mockExtra);

    const passedCtx = mockPipeline.readResource.mock.calls[0][1] as McpExecutionContext;
    expect(passedCtx.signal).toBeDefined();
    expect(passedCtx.signal!.aborted).toBe(false);
  });

  it('resource cancellation aborts in-flight call', async () => {
    mockRegistry.getAllResources.mockReturnValue([
      { name: 'slow', uri: 'data://slow', mimeType: undefined },
    ]);

    let resolveCall!: (value: unknown) => void;
    mockPipeline.readResource.mockImplementation(
      () => new Promise((resolve) => { resolveCall = resolve; }),
    );

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const resource = mockServer.resource as ReturnType<typeof vi.fn>;
    const callback = resource.mock.calls[0][3];
    const mockExtra = { signal: new AbortController().signal, requestId: 'req-r3' };

    const callPromise = callback(new URL('data://slow'), mockExtra);

    const passedCtx = mockPipeline.readResource.mock.calls[0][1] as McpExecutionContext;
    expect(passedCtx.signal!.aborted).toBe(false);

    const cancelHandler = mockInnerServer.setNotificationHandler.mock.calls[0][1];
    await cancelHandler({ method: 'notifications/cancelled', params: { requestId: 'req-r3' } });

    expect(passedCtx.signal!.aborted).toBe(true);

    resolveCall({ contents: [] });
    await callPromise;
  });

  it('prompt callback passes signal through context', async () => {
    mockRegistry.getAllPrompts.mockReturnValue([
      { name: 'greet', description: 'Greet', parameters: null },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const registerPrompt = mockServer.registerPrompt as ReturnType<typeof vi.fn>;
    const callback = registerPrompt.mock.calls[0][2];
    const mockExtra = { signal: new AbortController().signal, requestId: 'req-q1' };
    await callback({ name: 'Alice' }, mockExtra);

    const passedCtx = mockPipeline.getPrompt.mock.calls[0][2] as McpExecutionContext;
    expect(passedCtx.signal).toBeDefined();
    expect(passedCtx.signal!.aborted).toBe(false);
  });

  // --- Pagination ---

  it('registers custom list request handlers on inner server', () => {
    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    // 4 list handlers + 1 completion handler + 1 notification handler
    expect(mockInnerServer.setRequestHandler).toHaveBeenCalledTimes(5);
  });

  it('list tools handler passes cursor and returns paginated result', async () => {
    mockPipeline.listTools.mockResolvedValue({
      items: [{ name: 'tool-a' }],
      nextCursor: 'abc123',
    });

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

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

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const listPromptsCall = mockInnerServer.setRequestHandler.mock.calls.find(
      (call: unknown[]) => (call[0] as { shape?: { method?: { value?: string } } })?.shape?.method?.value === 'prompts/list',
    );
    const handler = listPromptsCall![1];
    const result = await handler({ method: 'prompts/list', params: {} });

    expect(mockPipeline.listPrompts).toHaveBeenCalledWith(undefined);
    expect(result).toEqual({ prompts: [{ name: 'greet' }] });
  });

  // --- Completion ---

  it('completion handler delegates to pipeline.complete and returns formatted result', async () => {
    mockPipeline.complete.mockResolvedValue({
      values: ['alpha', 'alpine'],
      hasMore: true,
      total: 10,
    });

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const completeCall = mockInnerServer.setRequestHandler.mock.calls.find(
      (call: unknown[]) => (call[0] as { shape?: { method?: { value?: string } } })?.shape?.method?.value === 'completion/complete',
    );
    expect(completeCall).toBeDefined();

    const handler = completeCall![1];
    const result = await handler({
      method: 'completion/complete',
      params: {
        ref: { type: 'ref/prompt', name: 'greet' },
        argument: { name: 'language', value: 'en' },
      },
    });

    expect(mockPipeline.complete).toHaveBeenCalledWith({
      ref: { type: 'ref/prompt', name: 'greet' },
      argument: { name: 'language', value: 'en' },
      context: undefined,
    });
    expect(result).toEqual({
      completion: {
        values: ['alpha', 'alpine'],
        hasMore: true,
        total: 10,
      },
    });
  });

  it('completion handler omits hasMore and total when not provided', async () => {
    mockPipeline.complete.mockResolvedValue({ values: ['hello'] });

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const completeCall = mockInnerServer.setRequestHandler.mock.calls.find(
      (call: unknown[]) => (call[0] as { shape?: { method?: { value?: string } } })?.shape?.method?.value === 'completion/complete',
    );
    const handler = completeCall![1];
    const result = await handler({
      method: 'completion/complete',
      params: {
        ref: { type: 'ref/resource', uri: 'file:///a' },
        argument: { name: 'path', value: '/tmp' },
      },
    });

    expect(result).toEqual({ completion: { values: ['hello'] } });
    expect(result.completion).not.toHaveProperty('hasMore');
    expect(result.completion).not.toHaveProperty('total');
  });
  // --- Task proxy handlers ---

  it('registers task proxy handlers when taskHandlerConfig is set and tasks capability enabled', () => {
    mockRegistry.taskHandlerConfig = {
      listTasks: vi.fn().mockResolvedValue({ tasks: [] }),
      getTask: vi.fn(),
      cancelTask: vi.fn(),
      getTaskPayload: vi.fn(),
    };
    mockOptions.capabilities = { ...mockOptions.capabilities, tasks: { enabled: true } };

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    // 4 list + 1 completion + 4 task proxy = 9 total setRequestHandler calls
    expect(mockInnerServer.setRequestHandler).toHaveBeenCalledTimes(9);
  });

  it('does not register task proxy handlers when taskHandlerConfig is undefined', () => {
    mockOptions.capabilities = { ...mockOptions.capabilities, tasks: { enabled: true } };

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    // 4 list + 1 completion = 5 (no task proxy handlers)
    expect(mockInnerServer.setRequestHandler).toHaveBeenCalledTimes(5);
  });

  it('does not register task proxy handlers when tasks capability is not enabled', () => {
    mockRegistry.taskHandlerConfig = {
      listTasks: vi.fn(),
      getTask: vi.fn(),
      cancelTask: vi.fn(),
      getTaskPayload: vi.fn(),
    };
    // mockOptions.capabilities has no tasks.enabled

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    // 4 list + 1 completion = 5 (no task proxy handlers)
    expect(mockInnerServer.setRequestHandler).toHaveBeenCalledTimes(5);
  });

  it('task proxy listTasks handler forwards cursor and returns tasks', async () => {
    const tasks = [{ taskId: 'upstream::t1', status: 'working', ttl: null, createdAt: '', lastUpdatedAt: '' }];
    mockRegistry.taskHandlerConfig = {
      listTasks: vi.fn().mockResolvedValue({ tasks, nextCursor: 'next' }),
      getTask: vi.fn(),
      cancelTask: vi.fn(),
      getTaskPayload: vi.fn(),
    };
    mockOptions.capabilities = { ...mockOptions.capabilities, tasks: { enabled: true } };

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const listTasksCall = mockInnerServer.setRequestHandler.mock.calls.find(
      (call: unknown[]) => (call[0] as { shape?: { method?: { value?: string } } })?.shape?.method?.value === 'tasks/list',
    );
    expect(listTasksCall).toBeDefined();

    const handler = listTasksCall![1];
    const result = await handler({ method: 'tasks/list', params: { cursor: 'cur' } });

    const config = mockRegistry.taskHandlerConfig as Record<string, ReturnType<typeof vi.fn>>;
    expect(config.listTasks).toHaveBeenCalledWith('cur');
    expect(result).toEqual({ tasks, nextCursor: 'next' });
  });

  it('task proxy getTask handler throws when task not found', async () => {
    mockRegistry.taskHandlerConfig = {
      listTasks: vi.fn(),
      getTask: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn(),
      getTaskPayload: vi.fn(),
    };
    mockOptions.capabilities = { ...mockOptions.capabilities, tasks: { enabled: true } };

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx, mockOptions);

    const getTaskCall = mockInnerServer.setRequestHandler.mock.calls.find(
      (call: unknown[]) => (call[0] as { shape?: { method?: { value?: string } } })?.shape?.method?.value === 'tasks/get',
    );
    expect(getTaskCall).toBeDefined();

    const handler = getTaskCall![1];
    await expect(handler({ method: 'tasks/get', params: { taskId: 'missing-task' } })).rejects.toThrow(
      'Task "missing-task" not found',
    );
  });
});

// --- Per-item helper tests ---

describe('registerToolOnServer', () => {
  let mockServer: Record<string, unknown>;
  let mockPipeline: Record<string, ReturnType<typeof vi.fn>>;
  let ctx: McpExecutionContext;
  const removeFn = vi.fn();

  beforeEach(() => {
    mockServer = {
      registerTool: vi.fn().mockReturnValue({ remove: removeFn }),
      server: { setNotificationHandler: vi.fn(), setRequestHandler: vi.fn() },
    };
    mockPipeline = {
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    ctx = {
      sessionId: 'test',
      transport: McpTransportType.SSE,
      reportProgress: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metadata: {},
    };
  });

  it('returns an SDK handle with remove()', () => {
    const tool = { name: 'dyn', description: 'Dynamic', parameters: null };
    const handle = registerToolOnServer(mockServer as never, tool as never, mockPipeline as never, ctx);

    expect(handle).toBeDefined();
    expect(typeof handle.remove).toBe('function');
  });

  it('calls server.registerTool with the correct name and config', () => {
    const schema = z.object({ x: z.number() });
    const tool = { name: 'calc', description: 'Calc', parameters: schema, annotations: { readOnlyHint: true } };

    registerToolOnServer(mockServer as never, tool as never, mockPipeline as never, ctx);

    const registerTool = mockServer.registerTool as ReturnType<typeof vi.fn>;
    expect(registerTool).toHaveBeenCalledTimes(1);
    const [name, config] = registerTool.mock.calls[0];
    expect(name).toBe('calc');
    expect(config.description).toBe('Calc');
    expect(config.inputSchema).toBe(schema);
    expect(config.annotations).toEqual({ readOnlyHint: true });
  });

  // --- Progress notifications ---

  it('tool callback wires reportProgress from extra._meta.progressToken', async () => {
    const tool = { name: 'upload', description: 'Upload', parameters: null };
    registerToolOnServer(mockServer as never, tool as never, mockPipeline as never, ctx);

    const registerTool = mockServer.registerTool as ReturnType<typeof vi.fn>;
    const callback = registerTool.mock.calls[0][2];
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const mockExtra = {
      signal: new AbortController().signal,
      requestId: 'req-p1',
      _meta: { progressToken: 'tok-1' },
      sendNotification,
    };

    await callback({}, mockExtra);

    const passedCtx = mockPipeline.callTool.mock.calls[0][2] as McpExecutionContext;
    expect(passedCtx.reportProgress).not.toBe(ctx.reportProgress);

    await passedCtx.reportProgress({ progress: 50, total: 100, message: 'halfway' });
    expect(sendNotification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 'tok-1', progress: 50, total: 100, message: 'halfway' },
    });
  });

  it('tool callback uses session reportProgress when no progressToken', async () => {
    const tool = { name: 'ping', description: 'Ping', parameters: null };
    registerToolOnServer(mockServer as never, tool as never, mockPipeline as never, ctx);

    const registerTool = mockServer.registerTool as ReturnType<typeof vi.fn>;
    const callback = registerTool.mock.calls[0][2];
    const mockExtra = { signal: new AbortController().signal, requestId: 'req-p2' };

    await callback({}, mockExtra);

    const passedCtx = mockPipeline.callTool.mock.calls[0][2] as McpExecutionContext;
    expect(passedCtx.reportProgress).toBe(ctx.reportProgress);
  });

  it('reportProgress omits total and message when not provided', async () => {
    const tool = { name: 'scan', description: 'Scan', parameters: null };
    registerToolOnServer(mockServer as never, tool as never, mockPipeline as never, ctx);

    const registerTool = mockServer.registerTool as ReturnType<typeof vi.fn>;
    const callback = registerTool.mock.calls[0][2];
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const mockExtra = {
      signal: new AbortController().signal,
      requestId: 'req-p3',
      _meta: { progressToken: 42 },
      sendNotification,
    };

    await callback({}, mockExtra);

    const passedCtx = mockPipeline.callTool.mock.calls[0][2] as McpExecutionContext;
    await passedCtx.reportProgress({ progress: 10 });

    expect(sendNotification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 42, progress: 10 },
    });
    // Verify total and message keys are not present
    const sentParams = sendNotification.mock.calls[0][0].params;
    expect(sentParams).not.toHaveProperty('total');
    expect(sentParams).not.toHaveProperty('message');
  });

  // --- streamContent ---

  it('tool callback wires streamContent when sendNotification is available', async () => {
    const tool = { name: 'stream-tool', description: 'Streaming', parameters: null };
    registerToolOnServer(mockServer as never, tool as never, mockPipeline as never, ctx);

    const callback = (mockServer.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][2];
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    await callback({}, { signal: new AbortController().signal, requestId: 'req-s1', sendNotification });

    const passedCtx = mockPipeline.callTool.mock.calls[0][2] as McpExecutionContext;
    expect(passedCtx.streamContent).toBeDefined();

    await passedCtx.streamContent!({ type: 'text', text: 'chunk' });
    expect(sendNotification).toHaveBeenCalledWith({
      method: 'notifications/tool/streamContent',
      params: { toolName: 'stream-tool', content: [{ type: 'text', text: 'chunk' }] },
    });
  });

  it('tool callback arrays streamContent content unchanged', async () => {
    const tool = { name: 'stream-arr', description: 'Array streaming', parameters: null };
    registerToolOnServer(mockServer as never, tool as never, mockPipeline as never, ctx);

    const callback = (mockServer.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][2];
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    await callback({}, { signal: new AbortController().signal, requestId: 'req-s2', sendNotification });

    const passedCtx = mockPipeline.callTool.mock.calls[0][2] as McpExecutionContext;
    const chunks = [{ type: 'text' as const, text: 'a' }, { type: 'text' as const, text: 'b' }];
    await passedCtx.streamContent!(chunks);

    const sentParams = sendNotification.mock.calls[0][0].params;
    expect(sentParams.content).toEqual(chunks);
  });

  it('tool callback does not wire streamContent when sendNotification is absent', async () => {
    const tool = { name: 'no-stream', description: 'No stream', parameters: null };
    registerToolOnServer(mockServer as never, tool as never, mockPipeline as never, ctx);

    const callback = (mockServer.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][2];
    await callback({}, { signal: new AbortController().signal, requestId: 'req-s3' });

    const passedCtx = mockPipeline.callTool.mock.calls[0][2] as McpExecutionContext;
    expect(passedCtx.streamContent).toBeUndefined();
  });

  // --- createSignalContext: already-aborted signal ---

  it('propagates already-aborted signal to internal controller', async () => {
    const tool = { name: 'abort-tool', description: 'Abort', parameters: null };
    registerToolOnServer(mockServer as never, tool as never, mockPipeline as never, ctx);

    const callback = (mockServer.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][2];
    const controller = new AbortController();
    controller.abort();

    await callback({}, { signal: controller.signal, requestId: 'req-a1' });

    const passedCtx = mockPipeline.callTool.mock.calls[0][2] as McpExecutionContext;
    expect(passedCtx.signal!.aborted).toBe(true);
  });
});

describe('registerResourceOnServer', () => {
  let mockServer: Record<string, unknown>;
  let mockPipeline: Record<string, ReturnType<typeof vi.fn>>;
  let ctx: McpExecutionContext;

  beforeEach(() => {
    mockServer = {
      resource: vi.fn().mockReturnValue({ remove: vi.fn() }),
      server: { setNotificationHandler: vi.fn(), setRequestHandler: vi.fn() },
    };
    mockPipeline = {
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
    };
    ctx = {
      sessionId: 'test',
      transport: McpTransportType.SSE,
      reportProgress: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metadata: {},
    };
  });

  it('returns an SDK handle with remove()', () => {
    const resource = { name: 'data', uri: 'data://data', mimeType: 'text/plain' };
    const handle = registerResourceOnServer(mockServer as never, resource as never, mockPipeline as never, ctx);

    expect(handle).toBeDefined();
    expect(typeof handle.remove).toBe('function');
  });

  it('passes mimeType metadata when present', () => {
    const resource = { name: 'config', uri: 'data://config', mimeType: 'application/json' };
    registerResourceOnServer(mockServer as never, resource as never, mockPipeline as never, ctx);

    const resourceFn = mockServer.resource as ReturnType<typeof vi.fn>;
    const [, , metadata] = resourceFn.mock.calls[0];
    expect(metadata).toEqual({ mimeType: 'application/json' });
  });
});

describe('registerResourceTemplateOnServer', () => {
  let mockServer: Record<string, unknown>;
  let mockPipeline: Record<string, ReturnType<typeof vi.fn>>;
  let ctx: McpExecutionContext;

  beforeEach(() => {
    mockServer = {
      registerResource: vi.fn().mockReturnValue({ remove: vi.fn() }),
      server: { setNotificationHandler: vi.fn(), setRequestHandler: vi.fn() },
    };
    mockPipeline = {
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
    };
    ctx = {
      sessionId: 'test',
      transport: McpTransportType.SSE,
      reportProgress: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metadata: {},
    };
  });

  it('returns an SDK handle with remove()', () => {
    const template = { name: 'user', uriTemplate: 'data://users/{id}', mimeType: 'application/json' };
    const handle = registerResourceTemplateOnServer(mockServer as never, template as never, mockPipeline as never, ctx);

    expect(handle).toBeDefined();
    expect(typeof handle.remove).toBe('function');
  });

  it('resource template callback passes signal through context', async () => {
    const template = { name: 'user', uriTemplate: 'data://users/{id}', mimeType: 'application/json' };
    registerResourceTemplateOnServer(mockServer as never, template as never, mockPipeline as never, ctx);

    const registerResource = mockServer.registerResource as ReturnType<typeof vi.fn>;
    const callback = registerResource.mock.calls[0][3];
    const mockExtra = { signal: new AbortController().signal, requestId: 'req-t1' };
    await callback(new URL('data://users/1'), {}, mockExtra);

    const passedCtx = mockPipeline.readResource.mock.calls[0][1] as McpExecutionContext;
    expect(passedCtx.signal).toBeDefined();
    expect(passedCtx.signal!.aborted).toBe(false);
  });
});

describe('registerPromptOnServer', () => {
  let mockServer: Record<string, unknown>;
  let mockPipeline: Record<string, ReturnType<typeof vi.fn>>;
  let ctx: McpExecutionContext;

  beforeEach(() => {
    mockServer = {
      registerPrompt: vi.fn().mockReturnValue({ remove: vi.fn() }),
      server: { setNotificationHandler: vi.fn(), setRequestHandler: vi.fn() },
    };
    mockPipeline = {
      getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
    };
    ctx = {
      sessionId: 'test',
      transport: McpTransportType.SSE,
      reportProgress: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metadata: {},
    };
  });

  it('returns an SDK handle with remove()', () => {
    const prompt = { name: 'greet', description: 'Greet', parameters: null };
    const handle = registerPromptOnServer(mockServer as never, prompt as never, mockPipeline as never, ctx);

    expect(handle).toBeDefined();
    expect(typeof handle.remove).toBe('function');
  });

  it('passes description and argsSchema', () => {
    const schema = z.object({ name: z.string() });
    const prompt = { name: 'greet', description: 'Greet', parameters: schema };
    registerPromptOnServer(mockServer as never, prompt as never, mockPipeline as never, ctx);

    const registerPrompt = mockServer.registerPrompt as ReturnType<typeof vi.fn>;
    const [name, config] = registerPrompt.mock.calls[0];
    expect(name).toBe('greet');
    expect(config.description).toBe('Greet');
    expect(config.argsSchema).toBe(schema.shape);
  });
});
