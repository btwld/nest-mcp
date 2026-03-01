import 'reflect-metadata';
import { McpTransportType } from '@nest-mcp/common';
import type { McpModuleOptions } from '@nest-mcp/common';
import { z } from 'zod';
import { McpRegistryService } from '../discovery/registry.service';
import { McpExecutorService } from '../execution/executor.service';
import { mockMcpContext } from '../testing/mock-context';
import { McpPromptBuilder } from './prompt-builder.service';
import { McpResourceBuilder } from './resource-builder.service';
import { McpToolBuilder } from './tool-builder.service';

const defaultOptions: McpModuleOptions = {
  name: 'test',
  version: '1.0.0',
  transport: McpTransportType.STDIO,
};

describe('Dynamic Builders', () => {
  let registry: McpRegistryService;

  beforeEach(() => {
    registry = new McpRegistryService();
  });

  describe('McpToolBuilder', () => {
    let builder: McpToolBuilder;

    beforeEach(() => {
      builder = new McpToolBuilder(registry);
    });

    it('register adds tool to registry', () => {
      builder.register({
        name: 'dynamic-tool',
        description: 'A dynamic tool',
        handler: async () => 'hello',
      });

      const tool = registry.getTool('dynamic-tool');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('dynamic-tool');
      expect(tool?.description).toBe('A dynamic tool');
    });

    it('unregister removes tool from registry', () => {
      builder.register({
        name: 'dynamic-tool',
        description: 'A dynamic tool',
        handler: async () => 'hello',
      });

      expect(registry.getTool('dynamic-tool')).toBeDefined();
      const result = builder.unregister('dynamic-tool');
      expect(result).toBe(true);
      expect(registry.getTool('dynamic-tool')).toBeUndefined();
    });

    it('unregister returns false for non-existent tool', () => {
      expect(builder.unregister('non-existent')).toBe(false);
    });

    it('handler wrapper correctly delegates to provided function', async () => {
      const handler = vi.fn().mockResolvedValue('tool-result');
      builder.register({
        name: 'delegated-tool',
        description: 'test',
        handler,
      });

      const tool = registry.getTool('delegated-tool');
      expect(tool).toBeDefined();
      const result = await tool?.instance[tool.methodName]({ key: 'val' }, mockMcpContext());
      expect(handler).toHaveBeenCalledWith({ key: 'val' }, expect.any(Object));
      expect(result).toBe('tool-result');
    });

    it('propagates optional fields: inputSchema, rawOutputSchema, annotations, scopes, roles, isPublic', () => {
      const inputSchema = { type: 'object', properties: { q: { type: 'string' } } };
      const rawOutputSchema = { type: 'object' };
      const annotations = { title: 'My Tool' };

      builder.register({
        name: 'full-tool',
        description: 'full',
        inputSchema,
        rawOutputSchema,
        annotations,
        scopes: ['read'],
        roles: ['admin'],
        isPublic: true,
        handler: async () => 'ok',
      });

      const tool = registry.getTool('full-tool');
      expect(tool?.inputSchema).toBe(inputSchema);
      expect(tool?.rawOutputSchema).toBe(rawOutputSchema);
      expect(tool?.annotations).toBe(annotations);
      expect(tool?.requiredScopes).toEqual(['read']);
      expect(tool?.requiredRoles).toEqual(['admin']);
      expect(tool?.isPublic).toBe(true);
    });

    it('emits tool.registered event on register', () => {
      const listener = vi.fn();
      registry.events.on('tool.registered', listener);

      builder.register({ name: 'evt-tool', description: 'test', handler: async () => 'ok' });

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: 'evt-tool' }));
    });

    it('emits tool.unregistered event on unregister', () => {
      const listener = vi.fn();
      builder.register({ name: 'evt-tool2', description: 'test', handler: async () => 'ok' });
      registry.events.on('tool.unregistered', listener);

      builder.unregister('evt-tool2');

      expect(listener).toHaveBeenCalledWith('evt-tool2');
    });

    it('does not emit tool.unregistered when tool does not exist', () => {
      const listener = vi.fn();
      registry.events.on('tool.unregistered', listener);

      builder.unregister('no-such-tool');

      expect(listener).not.toHaveBeenCalled();
    });

    it('propagates Zod parameters and outputSchema', () => {
      const parameters = z.object({ query: z.string() });
      const outputSchema = z.object({ result: z.string() });

      builder.register({
        name: 'zod-tool',
        description: 'Zod tool',
        parameters,
        outputSchema,
        handler: async () => 'ok',
      });

      const tool = registry.getTool('zod-tool');
      expect(tool?.parameters).toBe(parameters);
      expect(tool?.outputSchema).toBe(outputSchema);
    });
  });

  describe('McpResourceBuilder', () => {
    let builder: McpResourceBuilder;

    beforeEach(() => {
      builder = new McpResourceBuilder(registry);
    });

    it('register adds resource to registry', () => {
      builder.register({
        uri: 'file:///data.json',
        name: 'data-resource',
        description: 'A data resource',
        mimeType: 'application/json',
        handler: async () => '{}',
      });

      const resource = registry.getResource('file:///data.json');
      expect(resource).toBeDefined();
      expect(resource?.name).toBe('data-resource');
      expect(resource?.uri).toBe('file:///data.json');
      expect(resource?.mimeType).toBe('application/json');
    });

    it('unregister removes resource from registry', () => {
      builder.register({
        uri: 'file:///data.json',
        name: 'data-resource',
        handler: async () => '{}',
      });

      expect(registry.getResource('file:///data.json')).toBeDefined();
      const result = builder.unregister('file:///data.json');
      expect(result).toBe(true);
      expect(registry.getResource('file:///data.json')).toBeUndefined();
    });

    it('unregister returns false for non-existent resource', () => {
      expect(builder.unregister('file:///nope')).toBe(false);
    });

    it('handler wrapper correctly delegates to provided function', async () => {
      const handler = vi.fn().mockResolvedValue('resource-data');
      builder.register({
        uri: 'file:///test.txt',
        name: 'test-resource',
        handler,
      });

      const resource = registry.getResource('file:///test.txt');
      expect(resource).toBeDefined();
      const testUri = new URL('file:///test.txt');
      const result = await resource?.instance[resource.methodName](testUri, mockMcpContext());
      expect(handler).toHaveBeenCalledWith(testUri, expect.any(Object));
      expect(result).toBe('resource-data');
    });

    it('propagates optional description and mimeType', () => {
      builder.register({
        uri: 'file:///typed.json',
        name: 'typed',
        description: 'A typed resource',
        mimeType: 'application/json',
        handler: async () => '{}',
      });

      const resource = registry.getResource('file:///typed.json');
      expect(resource?.description).toBe('A typed resource');
      expect(resource?.mimeType).toBe('application/json');
    });

    it('emits resource.registered event on register', () => {
      const listener = vi.fn();
      registry.events.on('resource.registered', listener);

      builder.register({ uri: 'file:///evt.txt', name: 'evt-res', handler: async () => '' });

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ uri: 'file:///evt.txt' }));
    });

    it('emits resource.unregistered event on unregister', () => {
      const listener = vi.fn();
      builder.register({ uri: 'file:///del.txt', name: 'del-res', handler: async () => '' });
      registry.events.on('resource.unregistered', listener);

      builder.unregister('file:///del.txt');

      expect(listener).toHaveBeenCalledWith('file:///del.txt');
    });

    it('does not emit resource.unregistered when resource does not exist', () => {
      const listener = vi.fn();
      registry.events.on('resource.unregistered', listener);

      builder.unregister('file:///ghost.txt');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('McpPromptBuilder', () => {
    let builder: McpPromptBuilder;

    beforeEach(() => {
      builder = new McpPromptBuilder(registry);
    });

    it('register adds prompt to registry', () => {
      builder.register({
        name: 'dynamic-prompt',
        description: 'A dynamic prompt',
        handler: async () => ({
          messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'hi' } }],
        }),
      });

      const prompt = registry.getPrompt('dynamic-prompt');
      expect(prompt).toBeDefined();
      expect(prompt?.name).toBe('dynamic-prompt');
      expect(prompt?.description).toBe('A dynamic prompt');
    });

    it('unregister removes prompt from registry', () => {
      builder.register({
        name: 'dynamic-prompt',
        description: 'A dynamic prompt',
        handler: async () => ({
          messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'hi' } }],
        }),
      });

      expect(registry.getPrompt('dynamic-prompt')).toBeDefined();
      const result = builder.unregister('dynamic-prompt');
      expect(result).toBe(true);
      expect(registry.getPrompt('dynamic-prompt')).toBeUndefined();
    });

    it('unregister returns false for non-existent prompt', () => {
      expect(builder.unregister('non-existent')).toBe(false);
    });

    it('handler wrapper correctly delegates to provided function', async () => {
      const promptResult = {
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'hello' } }],
      };
      const handler = vi.fn().mockResolvedValue(promptResult);
      builder.register({
        name: 'test-prompt',
        description: 'test',
        handler,
      });

      const prompt = registry.getPrompt('test-prompt');
      expect(prompt).toBeDefined();
      const result = await prompt?.instance[prompt.methodName]({ arg: 'val' }, mockMcpContext());
      expect(handler).toHaveBeenCalledWith({ arg: 'val' }, expect.any(Object));
      expect(result).toEqual(promptResult);
    });

    it('emits prompt.registered event on register', () => {
      const listener = vi.fn();
      registry.events.on('prompt.registered', listener);

      builder.register({
        name: 'evt-prompt',
        description: 'test',
        handler: async () => ({ messages: [] }),
      });

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: 'evt-prompt' }));
    });

    it('emits prompt.unregistered event on unregister', () => {
      const listener = vi.fn();
      builder.register({
        name: 'del-prompt',
        description: 'test',
        handler: async () => ({ messages: [] }),
      });
      registry.events.on('prompt.unregistered', listener);

      builder.unregister('del-prompt');

      expect(listener).toHaveBeenCalledWith('del-prompt');
    });

    it('does not emit prompt.unregistered when prompt does not exist', () => {
      const listener = vi.fn();
      registry.events.on('prompt.unregistered', listener);

      builder.unregister('ghost-prompt');

      expect(listener).not.toHaveBeenCalled();
    });

    it('propagates Zod parameters', () => {
      const parameters = z.object({ topic: z.string() });

      builder.register({
        name: 'zod-prompt',
        description: 'Zod prompt',
        parameters,
        handler: async () => ({ messages: [] }),
      });

      const prompt = registry.getPrompt('zod-prompt');
      expect(prompt?.parameters).toBe(parameters);
    });
  });

  describe('Integration: builder -> executor', () => {
    it('callTool works with dynamically registered tool', async () => {
      const toolBuilder = new McpToolBuilder(registry);
      const executor = new McpExecutorService(registry, defaultOptions);
      const ctx = mockMcpContext();

      toolBuilder.register({
        name: 'greet',
        description: 'Greets a user',
        handler: async (args: Record<string, unknown>) => `Hello, ${args.name}!`,
      });

      const result = await executor.callTool('greet', { name: 'World' }, ctx);
      expect(result.content).toEqual([{ type: 'text', text: 'Hello, World!' }]);
    });

    it('readResource works with dynamically registered resource', async () => {
      const resourceBuilder = new McpResourceBuilder(registry);
      const executor = new McpExecutorService(registry, defaultOptions);
      const ctx = mockMcpContext();

      resourceBuilder.register({
        uri: 'file:///config.json',
        name: 'config',
        handler: async () => '{"key": "value"}',
      });

      const result = await executor.readResource('file:///config.json', ctx);
      expect(result.contents).toEqual([{ uri: 'file:///config.json', text: '{"key": "value"}' }]);
    });

    it('getPrompt works with dynamically registered prompt', async () => {
      const promptBuilder = new McpPromptBuilder(registry);
      const executor = new McpExecutorService(registry, defaultOptions);
      const ctx = mockMcpContext();

      promptBuilder.register({
        name: 'summarize',
        description: 'Summarize text',
        handler: async (args: Record<string, unknown>) => ({
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: `Summarize: ${args.text}` },
            },
          ],
        }),
      });

      const result = await executor.getPrompt('summarize', { text: 'long text' }, ctx);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toEqual({
        type: 'text',
        text: 'Summarize: long text',
      });
    });
  });
});
