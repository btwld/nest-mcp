import 'reflect-metadata';
import { McpTransportType, ToolExecutionError, ValidationError } from '@btwld/mcp-common';
import type { McpModuleOptions } from '@btwld/mcp-common';
import { z } from 'zod';
import { McpRegistryService } from '../discovery/registry.service';
import type {
  RegisteredPrompt,
  RegisteredResource,
  RegisteredResourceTemplate,
  RegisteredTool,
} from '../discovery/registry.service';
import { mockMcpContext } from '../testing/mock-context';
import { McpExecutorService } from './executor.service';

const defaultOptions: McpModuleOptions = {
  name: 'test',
  version: '1.0.0',
  transport: McpTransportType.STDIO,
};

describe('McpExecutorService', () => {
  let registry: McpRegistryService;
  let executor: McpExecutorService;
  let ctx: ReturnType<typeof mockMcpContext>;

  beforeEach(() => {
    registry = new McpRegistryService();
    executor = new McpExecutorService(registry, defaultOptions);
    ctx = mockMcpContext();
  });

  // --- listTools ---

  describe('listTools', () => {
    it('formats tools with inputSchema from zodToJsonSchema', async () => {
      const schema = z.object({ name: z.string() });
      registry.registerTool({
        name: 'greet',
        description: 'Greet someone',
        methodName: 'greet',
        target: Object,
        instance: { greet: vi.fn() },
        parameters: schema,
      } as RegisteredTool);

      const result = await executor.listTools();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('greet');
      expect(result.items[0].description).toBe('Greet someone');
      expect(result.items[0].inputSchema).toEqual(
        expect.objectContaining({ type: 'object', properties: expect.any(Object) }),
      );
    });

    it('defaults to { type: "object" } when no parameters or inputSchema', async () => {
      registry.registerTool({
        name: 'noop',
        description: 'No params',
        methodName: 'noop',
        target: Object,
        instance: { noop: vi.fn() },
      } as RegisteredTool);

      const result = await executor.listTools();
      expect(result.items[0].inputSchema).toEqual({ type: 'object' });
    });

    it('uses raw inputSchema when no Zod parameters are present', async () => {
      const rawInput = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
      registry.registerTool({
        name: 'proxied',
        description: 'Gateway proxied tool',
        methodName: 'proxied',
        target: Object,
        instance: { proxied: vi.fn() },
        inputSchema: rawInput,
      } as unknown as RegisteredTool);

      const result = await executor.listTools();
      expect(result.items[0].inputSchema).toEqual(rawInput);
    });

    it('includes outputSchema when present', async () => {
      const outputSchema = z.object({ result: z.string() });
      registry.registerTool({
        name: 'typed',
        description: 'Typed output',
        methodName: 'typed',
        target: Object,
        instance: { typed: vi.fn() },
        outputSchema,
      } as RegisteredTool);

      const result = await executor.listTools();
      expect(result.items[0].outputSchema).toBeDefined();
    });

    it('includes rawOutputSchema when no Zod outputSchema is present', async () => {
      const rawOutput = {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      };
      registry.registerTool({
        name: 'proxied-output',
        description: 'Gateway proxied with output schema',
        methodName: 'proxied-output',
        target: Object,
        instance: { 'proxied-output': vi.fn() },
        rawOutputSchema: rawOutput,
      } as unknown as RegisteredTool);

      const result = await executor.listTools();
      expect(result.items[0].outputSchema).toEqual(rawOutput);
    });

    it('includes annotations when present', async () => {
      registry.registerTool({
        name: 'annotated',
        description: 'Has annotations',
        methodName: 'annotated',
        target: Object,
        instance: { annotated: vi.fn() },
        annotations: { readOnlyHint: true },
      } as RegisteredTool);

      const result = await executor.listTools();
      expect(result.items[0].annotations).toEqual({ readOnlyHint: true });
    });

    it('omits outputSchema and annotations when not present', async () => {
      registry.registerTool({
        name: 'plain',
        description: 'Plain tool',
        methodName: 'plain',
        target: Object,
        instance: { plain: vi.fn() },
      } as RegisteredTool);

      const result = await executor.listTools();
      expect(result.items[0]).not.toHaveProperty('outputSchema');
      expect(result.items[0]).not.toHaveProperty('annotations');
    });

    it('returns PaginatedResult with no nextCursor for small lists', async () => {
      registry.registerTool({
        name: 'a',
        description: 'A',
        methodName: 'a',
        target: Object,
        instance: { a: vi.fn() },
      } as RegisteredTool);

      const result = await executor.listTools();
      expect(result.nextCursor).toBeUndefined();
    });
  });

  // --- callTool ---

  describe('callTool', () => {
    it('calls handler with validated args and ctx', async () => {
      const handler = vi.fn().mockResolvedValue('hello');
      const schema = z.object({ name: z.string() });
      registry.registerTool({
        name: 'greet',
        description: 'Greet',
        methodName: 'greet',
        target: Object,
        instance: { greet: handler },
        parameters: schema,
      } as RegisteredTool);

      const result = await executor.callTool('greet', { name: 'world' }, ctx);
      expect(handler).toHaveBeenCalledWith({ name: 'world' }, ctx);
      expect(result).toEqual({ content: [{ type: 'text', text: 'hello' }] });
    });

    it('throws ToolExecutionError when tool not found', async () => {
      await expect(executor.callTool('missing', {}, ctx)).rejects.toThrow(ToolExecutionError);
      await expect(executor.callTool('missing', {}, ctx)).rejects.toThrow(
        "Tool 'missing' not found",
      );
    });

    it('throws ValidationError on bad input', async () => {
      const schema = z.object({ count: z.number() });
      registry.registerTool({
        name: 'count',
        description: 'Count',
        methodName: 'count',
        target: Object,
        instance: { count: vi.fn() },
        parameters: schema,
      } as RegisteredTool);

      await expect(executor.callTool('count', { count: 'not-a-number' }, ctx)).rejects.toThrow(
        ValidationError,
      );
    });

    it('passes parsed/coerced args to handler', async () => {
      const handler = vi.fn().mockResolvedValue('ok');
      const schema = z.object({ name: z.string().default('anon') });
      registry.registerTool({
        name: 'test',
        description: 'Test',
        methodName: 'test',
        target: Object,
        instance: { test: handler },
        parameters: schema,
      } as RegisteredTool);

      await executor.callTool('test', {}, ctx);
      expect(handler).toHaveBeenCalledWith({ name: 'anon' }, ctx);
    });

    it('wraps generic errors in ToolExecutionError', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('boom'));
      registry.registerTool({
        name: 'fail',
        description: 'Fail',
        methodName: 'fail',
        target: Object,
        instance: { fail: handler },
      } as RegisteredTool);

      await expect(executor.callTool('fail', {}, ctx)).rejects.toThrow(ToolExecutionError);
      await expect(executor.callTool('fail', {}, ctx)).rejects.toThrow('boom');
    });

    it('re-throws ToolExecutionError without wrapping', async () => {
      const original = new ToolExecutionError('fail', 'already wrapped');
      const handler = vi.fn().mockRejectedValue(original);
      registry.registerTool({
        name: 'fail',
        description: 'Fail',
        methodName: 'fail',
        target: Object,
        instance: { fail: handler },
      } as RegisteredTool);

      await expect(executor.callTool('fail', {}, ctx)).rejects.toBe(original);
    });

    it('re-throws ValidationError without wrapping', async () => {
      const original = new ValidationError('bad input', []);
      const handler = vi.fn().mockRejectedValue(original);
      registry.registerTool({
        name: 'fail',
        description: 'Fail',
        methodName: 'fail',
        target: Object,
        instance: { fail: handler },
      } as RegisteredTool);

      await expect(executor.callTool('fail', {}, ctx)).rejects.toBe(original);
    });

    it('wraps non-Error throws in ToolExecutionError', async () => {
      const handler = vi.fn().mockRejectedValue('string error');
      registry.registerTool({
        name: 'fail',
        description: 'Fail',
        methodName: 'fail',
        target: Object,
        instance: { fail: handler },
      } as RegisteredTool);

      await expect(executor.callTool('fail', {}, ctx)).rejects.toThrow(ToolExecutionError);
    });
  });

  // --- normalizeToolResult (via callTool) ---

  describe('normalizeToolResult', () => {
    function registerSimpleTool(returnValue: unknown) {
      const handler = vi.fn().mockResolvedValue(returnValue);
      registry.registerTool({
        name: 'test',
        description: 'Test',
        methodName: 'test',
        target: Object,
        instance: { test: handler },
      } as RegisteredTool);
    }

    it('returns empty text for null', async () => {
      registerSimpleTool(null);
      const result = await executor.callTool('test', {}, ctx);
      expect(result).toEqual({ content: [{ type: 'text', text: '' }] });
    });

    it('returns empty text for undefined', async () => {
      registerSimpleTool(undefined);
      const result = await executor.callTool('test', {}, ctx);
      expect(result).toEqual({ content: [{ type: 'text', text: '' }] });
    });

    it('wraps string in text content', async () => {
      registerSimpleTool('hello');
      const result = await executor.callTool('test', {}, ctx);
      expect(result).toEqual({ content: [{ type: 'text', text: 'hello' }] });
    });

    it('passes through object with content property', async () => {
      const toolResult = { content: [{ type: 'text', text: 'direct' }] };
      registerSimpleTool(toolResult);
      const result = await executor.callTool('test', {}, ctx);
      expect(result).toBe(toolResult);
    });

    it('serializes plain objects to JSON text', async () => {
      registerSimpleTool({ foo: 'bar' });
      const result = await executor.callTool('test', {}, ctx);
      expect(result).toEqual({ content: [{ type: 'text', text: '{"foo":"bar"}' }] });
    });
  });

  // --- readResource ---

  describe('readResource', () => {
    it('reads an exact-match resource', async () => {
      const handler = vi.fn().mockResolvedValue('config data');
      registry.registerResource({
        uri: 'file:///config.json',
        name: 'config',
        methodName: 'getConfig',
        target: Object,
        instance: { getConfig: handler },
      } as RegisteredResource);

      const result = await executor.readResource('file:///config.json', ctx);
      expect(handler).toHaveBeenCalledWith(expect.any(URL), ctx);
      expect(result).toEqual({ contents: [{ uri: 'file:///config.json', text: 'config data' }] });
    });

    it('reads a template-match resource', async () => {
      const handler = vi.fn().mockResolvedValue('user data');
      registry.resourceTemplates.set('file:///users/{userId}', {
        uriTemplate: 'file:///users/{userId}',
        name: 'user',
        methodName: 'getUser',
        target: Object,
        instance: { getUser: handler },
      } as RegisteredResourceTemplate);

      const result = await executor.readResource('file:///users/42', ctx);
      expect(handler).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ userId: '42' }),
        ctx,
      );
      expect(result).toEqual({ contents: [{ uri: 'file:///users/42', text: 'user data' }] });
    });

    it('throws on resource not found', async () => {
      await expect(executor.readResource('file:///missing', ctx)).rejects.toThrow(
        ToolExecutionError,
      );
      await expect(executor.readResource('file:///missing', ctx)).rejects.toThrow(
        'Resource not found',
      );
    });

    it('passes through result with contents property', async () => {
      const directResult = { contents: [{ uri: 'file:///x', text: 'raw' }] };
      const handler = vi.fn().mockResolvedValue(directResult);
      registry.registerResource({
        uri: 'file:///x',
        name: 'x',
        methodName: 'getX',
        target: Object,
        instance: { getX: handler },
      } as RegisteredResource);

      const result = await executor.readResource('file:///x', ctx);
      expect(result).toBe(directResult);
    });

    it('serializes non-string/non-contents results to JSON', async () => {
      const handler = vi.fn().mockResolvedValue({ key: 'value' });
      registry.registerResource({
        uri: 'file:///data',
        name: 'data',
        methodName: 'getData',
        target: Object,
        instance: { getData: handler },
      } as RegisteredResource);

      const result = await executor.readResource('file:///data', ctx);
      expect(result).toEqual({
        contents: [{ uri: 'file:///data', text: '{"key":"value"}' }],
      });
    });
  });

  // --- listPrompts ---

  describe('listPrompts', () => {
    it('formats prompts with arguments from extractZodDescriptions', async () => {
      const schema = z.object({
        name: z.string().describe('The name'),
      });
      registry.registerPrompt({
        name: 'greet',
        description: 'Greeting prompt',
        methodName: 'greet',
        target: Object,
        instance: { greet: vi.fn() },
        parameters: schema,
      } as RegisteredPrompt);

      const result = await executor.listPrompts();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('greet');
      expect(result.items[0].description).toBe('Greeting prompt');
      expect(result.items[0].arguments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'name', description: 'The name', required: true }),
        ]),
      );
    });

    it('omits arguments when no parameters', async () => {
      registry.registerPrompt({
        name: 'simple',
        description: 'Simple',
        methodName: 'simple',
        target: Object,
        instance: { simple: vi.fn() },
      } as RegisteredPrompt);

      const result = await executor.listPrompts();
      expect(result.items[0]).not.toHaveProperty('arguments');
    });
  });

  // --- getPrompt ---

  describe('getPrompt', () => {
    it('calls handler and returns result with messages', async () => {
      const messages = [{ role: 'user', content: { type: 'text', text: 'Hi' } }];
      const handler = vi.fn().mockResolvedValue({ messages });
      registry.registerPrompt({
        name: 'greet',
        description: 'Greeting',
        methodName: 'greet',
        target: Object,
        instance: { greet: handler },
      } as RegisteredPrompt);

      const result = await executor.getPrompt('greet', {}, ctx);
      expect(handler).toHaveBeenCalledWith({}, ctx);
      expect(result).toEqual({ messages });
    });

    it('validates args when parameters schema exists', async () => {
      const schema = z.object({ name: z.string() });
      registry.registerPrompt({
        name: 'greet',
        description: 'Greeting',
        methodName: 'greet',
        target: Object,
        instance: { greet: vi.fn() },
        parameters: schema,
      } as RegisteredPrompt);

      // biome-ignore lint/suspicious/noExplicitAny: intentionally passing wrong type for validation test
      await expect(executor.getPrompt('greet', { name: 123 as any }, ctx)).rejects.toThrow(
        ValidationError,
      );
    });

    it('throws when prompt not found', async () => {
      await expect(executor.getPrompt('missing', {}, ctx)).rejects.toThrow(ToolExecutionError);
      await expect(executor.getPrompt('missing', {}, ctx)).rejects.toThrow(
        "Prompt 'missing' not found",
      );
    });

    it('throws when handler does not return messages', async () => {
      const handler = vi.fn().mockResolvedValue({ text: 'no messages' });
      registry.registerPrompt({
        name: 'bad',
        description: 'Bad prompt',
        methodName: 'bad',
        target: Object,
        instance: { bad: handler },
      } as RegisteredPrompt);

      await expect(executor.getPrompt('bad', {}, ctx)).rejects.toThrow(
        'Prompt handler must return { messages: [...] }',
      );
    });
  });

  // --- complete ---

  describe('complete', () => {
    it('calls custom handler when one is registered', async () => {
      const handler = vi.fn().mockResolvedValue({ values: ['ts', 'js'] });
      // Manually set up a completion handler via private map
      (registry as unknown as { completionHandlers: Map<string, unknown> }).completionHandlers.set(
        'prompt::code_review',
        {
          refType: 'ref/prompt',
          refName: 'code_review',
          methodName: 'complete',
          instance: { complete: handler },
        },
      );

      const result = await executor.complete({
        ref: { type: 'ref/prompt', name: 'code_review' },
        argument: { name: 'language', value: 'ty' },
      });

      expect(handler).toHaveBeenCalledWith('language', 'ty', undefined);
      expect(result.values).toEqual(['ts', 'js']);
    });

    it('falls back to default prompt completion with enum values', async () => {
      const schema = z.object({
        language: z.enum(['typescript', 'javascript', 'python', 'ruby']),
      });
      registry.registerPrompt({
        name: 'review',
        description: 'Review',
        methodName: 'review',
        target: Object,
        instance: { review: vi.fn() },
        parameters: schema,
      } as RegisteredPrompt);

      const result = await executor.complete({
        ref: { type: 'ref/prompt', name: 'review' },
        argument: { name: 'language', value: 'type' },
      });

      expect(result.values).toEqual(['typescript']);
    });

    it('returns empty for non-enum prompt fields', async () => {
      const schema = z.object({ name: z.string() });
      registry.registerPrompt({
        name: 'greet',
        description: 'Greet',
        methodName: 'greet',
        target: Object,
        instance: { greet: vi.fn() },
        parameters: schema,
      } as RegisteredPrompt);

      const result = await executor.complete({
        ref: { type: 'ref/prompt', name: 'greet' },
        argument: { name: 'name', value: 'Jo' },
      });

      expect(result.values).toEqual([]);
    });

    it('returns empty for unknown prompt', async () => {
      const result = await executor.complete({
        ref: { type: 'ref/prompt', name: 'nonexistent' },
        argument: { name: 'arg', value: 'val' },
      });

      expect(result.values).toEqual([]);
    });

    it('returns empty for resource completion without custom handler', async () => {
      const result = await executor.complete({
        ref: { type: 'ref/resource', uri: 'file:///{path}' },
        argument: { name: 'path', value: '/sr' },
      });

      expect(result.values).toEqual([]);
    });

    it('caps values at 100 and sets hasMore', async () => {
      const manyValues = Array.from({ length: 150 }, (_, i) => `val${i}`);
      const handler = vi.fn().mockResolvedValue({ values: manyValues });
      (registry as unknown as { completionHandlers: Map<string, unknown> }).completionHandlers.set(
        'prompt::big',
        {
          refType: 'ref/prompt',
          refName: 'big',
          methodName: 'complete',
          instance: { complete: handler },
        },
      );

      const result = await executor.complete({
        ref: { type: 'ref/prompt', name: 'big' },
        argument: { name: 'arg', value: '' },
      });

      expect(result.values).toHaveLength(100);
      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(150);
    });

    it('normalizes non-object result to empty', async () => {
      const handler = vi.fn().mockResolvedValue('bad');
      (registry as unknown as { completionHandlers: Map<string, unknown> }).completionHandlers.set(
        'prompt::bad',
        {
          refType: 'ref/prompt',
          refName: 'bad',
          methodName: 'complete',
          instance: { complete: handler },
        },
      );

      const result = await executor.complete({
        ref: { type: 'ref/prompt', name: 'bad' },
        argument: { name: 'arg', value: '' },
      });

      expect(result.values).toEqual([]);
    });
  });

  // --- configurable page size ---

  describe('pagination configuration', () => {
    it('uses custom page size from options', async () => {
      const customRegistry = new McpRegistryService();
      const customExecutor = new McpExecutorService(customRegistry, {
        ...defaultOptions,
        pagination: { defaultPageSize: 2 },
      });

      for (let i = 0; i < 5; i++) {
        customRegistry.registerTool({
          name: `tool${i}`,
          description: `Tool ${i}`,
          methodName: `tool${i}`,
          target: Object,
          instance: { [`tool${i}`]: vi.fn() },
        } as RegisteredTool);
      }

      const first = await customExecutor.listTools();
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeDefined();

      const second = await customExecutor.listTools(first.nextCursor);
      expect(second.items).toHaveLength(2);
      expect(second.nextCursor).toBeDefined();

      const third = await customExecutor.listTools(second.nextCursor);
      expect(third.items).toHaveLength(1);
      expect(third.nextCursor).toBeUndefined();
    });
  });
});
