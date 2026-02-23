import 'reflect-metadata';
import { McpRegistryService } from '../discovery/registry.service';
import { McpExecutorService } from '../execution/executor.service';
import { McpToolBuilder } from './tool-builder.service';
import { McpResourceBuilder } from './resource-builder.service';
import { McpPromptBuilder } from './prompt-builder.service';
import { mockMcpContext } from '../testing/mock-context';

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
      expect(tool!.name).toBe('dynamic-tool');
      expect(tool!.description).toBe('A dynamic tool');
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

      const tool = registry.getTool('delegated-tool')!;
      const result = await tool.instance[tool.methodName]({ key: 'val' }, mockMcpContext());
      expect(handler).toHaveBeenCalledWith({ key: 'val' }, expect.any(Object));
      expect(result).toBe('tool-result');
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
      expect(resource!.name).toBe('data-resource');
      expect(resource!.uri).toBe('file:///data.json');
      expect(resource!.mimeType).toBe('application/json');
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

      const resource = registry.getResource('file:///test.txt')!;
      const testUri = new URL('file:///test.txt');
      const result = await resource.instance[resource.methodName](testUri, mockMcpContext());
      expect(handler).toHaveBeenCalledWith(testUri, expect.any(Object));
      expect(result).toBe('resource-data');
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
      expect(prompt!.name).toBe('dynamic-prompt');
      expect(prompt!.description).toBe('A dynamic prompt');
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

      const prompt = registry.getPrompt('test-prompt')!;
      const result = await prompt.instance[prompt.methodName]({ arg: 'val' }, mockMcpContext());
      expect(handler).toHaveBeenCalledWith({ arg: 'val' }, expect.any(Object));
      expect(result).toEqual(promptResult);
    });
  });

  describe('Integration: builder -> executor', () => {
    it('callTool works with dynamically registered tool', async () => {
      const toolBuilder = new McpToolBuilder(registry);
      const executor = new McpExecutorService(registry);
      const ctx = mockMcpContext();

      toolBuilder.register({
        name: 'greet',
        description: 'Greets a user',
        handler: async (args: any) => `Hello, ${args.name}!`,
      });

      const result = await executor.callTool('greet', { name: 'World' }, ctx);
      expect(result.content).toEqual([{ type: 'text', text: 'Hello, World!' }]);
    });

    it('readResource works with dynamically registered resource', async () => {
      const resourceBuilder = new McpResourceBuilder(registry);
      const executor = new McpExecutorService(registry);
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
      const executor = new McpExecutorService(registry);
      const ctx = mockMcpContext();

      promptBuilder.register({
        name: 'summarize',
        description: 'Summarize text',
        handler: async (args: any) => ({
          messages: [
            { role: 'user' as const, content: { type: 'text' as const, text: `Summarize: ${args.text}` } },
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
