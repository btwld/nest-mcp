import type { McpExecutionContext } from '@btwld/mcp-common';
import { McpTransportType } from '@btwld/mcp-common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerHandlers } from './register-handlers';

describe('registerHandlers', () => {
  let mockServer: Record<string, ReturnType<typeof vi.fn>>;
  let mockRegistry: Record<string, ReturnType<typeof vi.fn>>;
  let mockPipeline: Record<string, ReturnType<typeof vi.fn>>;
  let ctx: McpExecutionContext;

  beforeEach(() => {
    mockServer = {
      tool: vi.fn(),
      registerTool: vi.fn(),
      resource: vi.fn(),
      prompt: vi.fn(),
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

    expect(mockServer.registerTool).not.toHaveBeenCalled();
    expect(mockServer.resource).not.toHaveBeenCalled();
    expect(mockServer.prompt).not.toHaveBeenCalled();
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

    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
    const [name, config, callback] = mockServer.registerTool.mock.calls[0];
    expect(name).toBe('get_weather');
    expect(config.description).toBe('Get weather');
    expect(config.inputSchema).toBe(schema);
    expect(config.annotations).toEqual({ readOnlyHint: true });
    expect(typeof callback).toBe('function');
  });

  it('registers tools with undefined inputSchema when no parameters', () => {
    mockRegistry.getAllTools.mockReturnValue([
      { name: 'ping', description: 'Ping', parameters: null },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const [, config] = mockServer.registerTool.mock.calls[0];
    expect(config.inputSchema).toBeNull();
  });

  it('registers resources with name, uri, mimeType metadata, and callback', () => {
    mockRegistry.getAllResources.mockReturnValue([
      { name: 'config', uri: 'data://config', mimeType: 'application/json' },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    expect(mockServer.resource).toHaveBeenCalledTimes(1);
    const [name, uri, metadata, callback] = mockServer.resource.mock.calls[0];
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

    const [, , metadata] = mockServer.resource.mock.calls[0];
    expect(metadata).toEqual({});
  });

  it('registers resource templates with mimeType metadata', () => {
    mockRegistry.getAllResourceTemplates.mockReturnValue([
      { name: 'user', uriTemplate: 'data://users/{id}', mimeType: 'application/json' },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const [name, uriTemplate, metadata] = mockServer.resource.mock.calls[0];
    expect(name).toBe('user');
    expect(uriTemplate).toBe('data://users/{id}');
    expect(metadata).toEqual({ mimeType: 'application/json' });
  });

  it('registers prompts with name, description, args, and callback', () => {
    const schema = z.object({
      code: z.string().describe('The code to review'),
      language: z.string().optional().describe('Programming language'),
    });
    mockRegistry.getAllPrompts.mockReturnValue([
      { name: 'code_review', description: 'Review code', parameters: schema },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    expect(mockServer.prompt).toHaveBeenCalledTimes(1);
    const [name, desc, args, callback] = mockServer.prompt.mock.calls[0];
    expect(name).toBe('code_review');
    expect(desc).toBe('Review code');
    expect(args).toEqual({
      code: { description: 'The code to review', required: true },
      language: { description: 'Programming language', required: false },
    });
    expect(typeof callback).toBe('function');
  });

  it('registers prompts with empty args when no parameters', () => {
    mockRegistry.getAllPrompts.mockReturnValue([
      { name: 'greeting', description: 'Greet', parameters: null },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const [, , args] = mockServer.prompt.mock.calls[0];
    expect(args).toEqual({});
  });

  it('tool callback delegates to pipeline.callTool', async () => {
    mockRegistry.getAllTools.mockReturnValue([
      { name: 'echo', description: 'Echo', parameters: null },
    ]);
    mockPipeline.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'hi' }] });

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const callback = mockServer.registerTool.mock.calls[0][2];
    const result = await callback({ message: 'hi' });
    expect(mockPipeline.callTool).toHaveBeenCalledWith('echo', { message: 'hi' }, ctx);
    expect(result).toEqual({ content: [{ type: 'text', text: 'hi' }] });
  });

  it('resource callback delegates to pipeline.readResource', async () => {
    mockRegistry.getAllResources.mockReturnValue([
      { name: 'config', uri: 'data://config', mimeType: undefined },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const callback = mockServer.resource.mock.calls[0][3];
    await callback(new URL('data://config'));
    expect(mockPipeline.readResource).toHaveBeenCalledWith('data://config', ctx);
  });

  it('prompt callback delegates to pipeline.getPrompt', async () => {
    mockRegistry.getAllPrompts.mockReturnValue([
      { name: 'greet', description: 'Greet', parameters: null },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const callback = mockServer.prompt.mock.calls[0][3];
    await callback({ name: 'Alice' });
    expect(mockPipeline.getPrompt).toHaveBeenCalledWith('greet', { name: 'Alice' }, ctx);
  });
});
