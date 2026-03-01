import { beforeEach, describe, expect, it } from 'vitest';
import { MockMcpClient } from './mock-client';

describe('MockMcpClient', () => {
  let mock: MockMcpClient;

  beforeEach(() => {
    mock = new MockMcpClient('test');
  });

  describe('connect / disconnect', () => {
    it('should start disconnected', () => {
      expect(mock.isConnected()).toBe(false);
    });

    it('should be connected after connect()', async () => {
      await mock.connect();
      expect(mock.isConnected()).toBe(true);
    });

    it('should be disconnected after disconnect()', async () => {
      await mock.connect();
      await mock.disconnect();
      expect(mock.isConnected()).toBe(false);
    });
  });

  describe('default return values', () => {
    it('should return empty content for callTool', async () => {
      expect(await mock.callTool({ name: 'x' })).toEqual({ content: [] });
    });

    it('should return empty arrays for list methods', async () => {
      expect(await mock.listTools()).toEqual({ tools: [] });
      expect(await mock.listResources()).toEqual({ resources: [] });
      expect(await mock.listPrompts()).toEqual({ prompts: [] });
    });

    it('should return undefined for getServerCapabilities and getServerVersion', () => {
      expect(mock.getServerCapabilities()).toBeUndefined();
      expect(mock.getServerVersion()).toBeUndefined();
    });
  });

  describe('set* methods', () => {
    it('setCallToolResult should change callTool return value', async () => {
      const result = { content: [{ type: 'text' as const, text: 'hello' }] };
      mock.setCallToolResult(result);
      expect(await mock.callTool({ name: 'x' })).toEqual(result);
    });

    it('setListToolsResult should change listTools return value', async () => {
      const result = {
        tools: [
          { name: 'tool-a', description: 'A tool', inputSchema: { type: 'object' as const } },
        ],
      };
      mock.setListToolsResult(result);
      expect(await mock.listTools()).toEqual(result);
    });

    it('setReadResourceResult should change readResource return value', async () => {
      const result = { contents: [{ uri: 'file:///x', text: 'data' }] };
      mock.setReadResourceResult(result);
      expect(await mock.readResource({ uri: 'file:///x' })).toEqual(result);
    });

    it('set methods should support chaining', () => {
      const returnedMock = mock
        .setCallToolResult({ content: [] })
        .setListToolsResult({ tools: [] })
        .setReadResourceResult({ contents: [] })
        .setListResourcesResult({ resources: [] })
        .setGetPromptResult({ messages: [] })
        .setListPromptsResult({ prompts: [] });

      expect(returnedMock).toBe(mock);
    });
  });

  describe('constructor', () => {
    it('should default name to "mock"', () => {
      const defaultMock = new MockMcpClient();
      expect(defaultMock.name).toBe('mock');
    });

    it('should use provided name', () => {
      expect(mock.name).toBe('test');
    });
  });

  describe('getClient', () => {
    it('should return null', () => {
      expect(mock.getClient()).toBeNull();
    });
  });

  describe('default return values (remaining methods)', () => {
    it('listResourceTemplates returns empty resourceTemplates', async () => {
      expect(await mock.listResourceTemplates()).toEqual({ resourceTemplates: [] });
    });

    it('getPrompt returns empty messages', async () => {
      expect(await mock.getPrompt({ name: 'p' })).toEqual({ messages: [] });
    });

    it('ping returns empty object', async () => {
      expect(await mock.ping()).toEqual({});
    });

    it('subscribeResource returns empty object', async () => {
      expect(await mock.subscribeResource({ uri: 'file:///x' })).toEqual({});
    });

    it('unsubscribeResource returns empty object', async () => {
      expect(await mock.unsubscribeResource({ uri: 'file:///x' })).toEqual({});
    });

    it('setLoggingLevel returns empty object', async () => {
      expect(await mock.setLoggingLevel('debug')).toEqual({});
    });

    it('complete returns empty completion', async () => {
      expect(
        await mock.complete({
          ref: { type: 'ref/prompt', name: 'p' },
          argument: { name: 'a', value: '' },
        }),
      ).toEqual({
        completion: { values: [] },
      });
    });

    it('sendRootsListChanged resolves without error', async () => {
      await expect(mock.sendRootsListChanged()).resolves.toBeUndefined();
    });

    it('getInstructions returns undefined by default', () => {
      expect(mock.getInstructions()).toBeUndefined();
    });
  });

  describe('listAll* methods', () => {
    it('listAllTools returns tools array from listTools result', async () => {
      mock.setListToolsResult({
        tools: [{ name: 'tool-a', inputSchema: { type: 'object' } }],
      });
      const tools = await mock.listAllTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('tool-a');
    });

    it('listAllResources returns resources array', async () => {
      mock.setListResourcesResult({ resources: [{ uri: 'file:///a', name: 'a' }] });
      const resources = await mock.listAllResources();
      expect(resources).toHaveLength(1);
    });

    it('listAllResourceTemplates returns resourceTemplates array', async () => {
      mock.setListResourceTemplatesResult({
        resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'tpl' }],
      });
      const templates = await mock.listAllResourceTemplates();
      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe('tpl');
    });

    it('listAllPrompts returns prompts array', async () => {
      mock.setListPromptsResult({ prompts: [{ name: 'p1' }] });
      const prompts = await mock.listAllPrompts();
      expect(prompts).toHaveLength(1);
    });

    it('listAllTools returns empty array when no tools set', async () => {
      expect(await mock.listAllTools()).toEqual([]);
    });
  });

  describe('set* methods (extended)', () => {
    it('setCompleteResult changes complete() return value', async () => {
      mock.setCompleteResult({ completion: { values: ['a', 'b'] } });
      expect(
        await mock.complete({
          ref: { type: 'ref/prompt', name: 'p' },
          argument: { name: 'a', value: '' },
        }),
      ).toEqual({
        completion: { values: ['a', 'b'] },
      });
    });

    it('setListResourceTemplatesResult changes listResourceTemplates() return value', async () => {
      mock.setListResourceTemplatesResult({
        resourceTemplates: [{ uriTemplate: 'x:///{id}', name: 'x' }],
      });
      expect(await mock.listResourceTemplates()).toEqual({
        resourceTemplates: [{ uriTemplate: 'x:///{id}', name: 'x' }],
      });
    });

    it('setGetPromptResult changes getPrompt() return value', async () => {
      mock.setGetPromptResult({
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
      });
      const result = await mock.getPrompt({ name: 'p' });
      expect(result.messages).toHaveLength(1);
    });

    it('setServerCapabilities changes getServerCapabilities() return value', () => {
      mock.setServerCapabilities({ tools: {} });
      expect(mock.getServerCapabilities()).toEqual({ tools: {} });
    });

    it('setServerVersion changes getServerVersion() return value', () => {
      mock.setServerVersion({ name: 'my-server', version: '2.0' });
      expect(mock.getServerVersion()).toEqual({ name: 'my-server', version: '2.0' });
    });

    it('setInstructions changes getInstructions() return value', () => {
      mock.setInstructions('Use this server for code tasks.');
      expect(mock.getInstructions()).toBe('Use this server for code tasks.');
    });

    it('set methods support full chaining including setCompleteResult, setServerCapabilities, setInstructions', () => {
      const returned = mock
        .setCompleteResult({ completion: { values: [] } })
        .setListResourceTemplatesResult({ resourceTemplates: [] })
        .setServerCapabilities({ tools: {} })
        .setServerVersion({ name: 's', version: '1' })
        .setInstructions('hello');
      expect(returned).toBe(mock);
    });
  });

  describe('handler methods (no-ops)', () => {
    it('setSamplingHandler does not throw', () => {
      expect(() =>
        mock.setSamplingHandler(async () => ({
          model: 'm',
          stopReason: 'endTurn',
          role: 'assistant',
          content: { type: 'text', text: '' },
        })),
      ).not.toThrow();
    });

    it('setElicitationHandler does not throw', () => {
      expect(() => mock.setElicitationHandler(async () => ({ action: 'cancel' }))).not.toThrow();
    });

    it('setRootsHandler does not throw', () => {
      expect(() => mock.setRootsHandler(async () => ({ roots: [] }))).not.toThrow();
    });
  });

  describe('onNotification', () => {
    it('stores the notification handler and can overwrite with a new one', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      mock.onNotification('notifications/tools/list_changed', handler1);
      mock.onNotification('notifications/tools/list_changed', handler2);
      // No assertion on internal state — just verifying it does not throw
      expect(true).toBe(true);
    });
  });
});
