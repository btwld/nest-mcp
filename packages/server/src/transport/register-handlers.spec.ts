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

    expect(mockServer.tool).not.toHaveBeenCalled();
    expect(mockServer.resource).not.toHaveBeenCalled();
    expect(mockServer.prompt).not.toHaveBeenCalled();
  });

  it('registers tools with name, description, schema, and callback', () => {
    const schema = z.object({ city: z.string().describe('City name') });
    mockRegistry.getAllTools.mockReturnValue([
      { name: 'get_weather', description: 'Get weather', parameters: schema },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    expect(mockServer.tool).toHaveBeenCalledTimes(1);
    const [name, desc, inputSchema, callback] = mockServer.tool.mock.calls[0];
    expect(name).toBe('get_weather');
    expect(desc).toBe('Get weather');
    expect(inputSchema).toEqual({
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
      },
      required: ['city'],
    });
    expect(typeof callback).toBe('function');
  });

  it('registers tools with empty schema when no parameters', () => {
    mockRegistry.getAllTools.mockReturnValue([
      { name: 'ping', description: 'Ping', parameters: null },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const [, , inputSchema] = mockServer.tool.mock.calls[0];
    expect(inputSchema).toEqual({});
  });

  it('prefers pre-converted inputSchema over Zod parameters', () => {
    const preConverted = {
      type: 'object',
      properties: { query: { type: 'string' } },
    };
    const zodSchema = z.object({ name: z.string() });

    mockRegistry.getAllTools.mockReturnValue([
      { name: 'search', description: 'Search', parameters: zodSchema, inputSchema: preConverted },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const [, , inputSchema] = mockServer.tool.mock.calls[0];
    expect(inputSchema).toEqual(preConverted);
  });

  it('uses inputSchema when parameters is undefined', () => {
    const preConverted = {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    };

    mockRegistry.getAllTools.mockReturnValue([
      { name: 'weather', description: 'Weather', parameters: undefined, inputSchema: preConverted },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const [, , inputSchema] = mockServer.tool.mock.calls[0];
    expect(inputSchema).toEqual(preConverted);
  });

  it('falls back to empty schema when neither inputSchema nor parameters are set', () => {
    mockRegistry.getAllTools.mockReturnValue([
      { name: 'noop', description: 'No-op', parameters: undefined, inputSchema: undefined },
    ]);

    registerHandlers(mockServer, mockRegistry, mockPipeline, ctx);

    const [, , inputSchema] = mockServer.tool.mock.calls[0];
    expect(inputSchema).toEqual({});
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

    const callback = mockServer.tool.mock.calls[0][3];
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
