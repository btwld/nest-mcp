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
      const result = { content: [{ type: 'text', text: 'hello' }] };
      mock.setCallToolResult(result);
      expect(await mock.callTool({ name: 'x' })).toEqual(result);
    });

    it('setListToolsResult should change listTools return value', async () => {
      const result = { tools: [{ name: 'tool-a', description: 'A tool' }] };
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
});
