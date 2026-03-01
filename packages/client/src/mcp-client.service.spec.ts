import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const MockClient = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    readResource: vi.fn().mockResolvedValue({ contents: [] }),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
    listResourceTemplates: vi.fn().mockResolvedValue({ resourceTemplates: [] }),
    getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    ping: vi.fn().mockResolvedValue({}),
    subscribeResource: vi.fn().mockResolvedValue({}),
    unsubscribeResource: vi.fn().mockResolvedValue({}),
    setLoggingLevel: vi.fn().mockResolvedValue({}),
    complete: vi.fn().mockResolvedValue({ completion: { values: [] } }),
    sendRootsListChanged: vi.fn().mockResolvedValue(undefined),
    getServerCapabilities: vi.fn().mockReturnValue({}),
    getServerVersion: vi.fn().mockReturnValue({ name: 'test', version: '1.0' }),
    getInstructions: vi.fn().mockReturnValue(undefined),
    registerCapabilities: vi.fn(),
    setRequestHandler: vi.fn(),
    _notificationHandlers: new Map(),
  }));
  return { Client: MockClient };
});

vi.mock('./transport/client-transport.factory', () => ({
  createClientTransport: vi.fn().mockReturnValue({
    onclose: null,
    onerror: null,
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpClientConnection } from './interfaces/client-options.interface';
import { McpClient } from './mcp-client.service';
import { createClientTransport } from './transport/client-transport.factory';

const MockedClient = vi.mocked(Client);
const mockedCreateTransport = vi.mocked(createClientTransport);

function createConnection(overrides?: Partial<McpClientConnection>): McpClientConnection {
  return {
    name: 'test-server',
    transport: 'sse',
    url: 'http://localhost:3000/sse',
    ...overrides,
  } as McpClientConnection;
}

describe('McpClient', () => {
  let mcpClient: McpClient;
  let connection: McpClientConnection;

  beforeEach(() => {
    vi.clearAllMocks();

    // Restore the full Client mock — the reconnect test overrides mockImplementation with a
    // sparse object, and vi.clearAllMocks() only clears call history, not the implementation.
    MockedClient.mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      listResources: vi.fn().mockResolvedValue({ resources: [] }),
      listResourceTemplates: vi.fn().mockResolvedValue({ resourceTemplates: [] }),
      getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
      listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
      ping: vi.fn().mockResolvedValue({}),
      subscribeResource: vi.fn().mockResolvedValue({}),
      unsubscribeResource: vi.fn().mockResolvedValue({}),
      setLoggingLevel: vi.fn().mockResolvedValue({}),
      complete: vi.fn().mockResolvedValue({ completion: { values: [] } }),
      sendRootsListChanged: vi.fn().mockResolvedValue(undefined),
      getServerCapabilities: vi.fn().mockReturnValue({}),
      getServerVersion: vi.fn().mockReturnValue({ name: 'test', version: '1.0' }),
      getInstructions: vi.fn().mockReturnValue(undefined),
      registerCapabilities: vi.fn(),
      setRequestHandler: vi.fn(),
      _notificationHandlers: new Map(),
    }));

    // Reset the transport mock to return a fresh object each call
    mockedCreateTransport.mockReturnValue({
      onclose: null,
      onerror: null,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof createClientTransport>);

    connection = createConnection();
    mcpClient = new McpClient('test-server', connection);
  });

  describe('connect', () => {
    it('should create transport and connect the SDK client', async () => {
      await mcpClient.connect();

      expect(mockedCreateTransport).toHaveBeenCalledWith(connection);
      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.connect).toHaveBeenCalled();
      expect(mcpClient.isConnected()).toBe(true);
    });

    it('should be a no-op if already connected', async () => {
      await mcpClient.connect();
      await mcpClient.connect();

      expect(mockedCreateTransport).toHaveBeenCalledTimes(1);
    });

    it('should throw and remain disconnected if client.connect fails', async () => {
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance.connect.mockRejectedValueOnce(new Error('connection refused'));

      await expect(mcpClient.connect()).rejects.toThrow('connection refused');
      expect(mcpClient.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('should close transport and set connected to false', async () => {
      await mcpClient.connect();
      const transport = mockedCreateTransport.mock.results[0].value;

      await mcpClient.disconnect();

      expect(transport.close).toHaveBeenCalled();
      expect(mcpClient.isConnected()).toBe(false);
    });

    it('should not throw if transport.close fails', async () => {
      await mcpClient.connect();
      const transport = mockedCreateTransport.mock.results[0].value;
      transport.close.mockRejectedValueOnce(new Error('close error'));

      await expect(mcpClient.disconnect()).resolves.toBeUndefined();
      expect(mcpClient.isConnected()).toBe(false);
    });

    it('should handle disconnect when not connected', async () => {
      await expect(mcpClient.disconnect()).resolves.toBeUndefined();
    });
  });

  describe('isConnected', () => {
    it('should return false initially', () => {
      expect(mcpClient.isConnected()).toBe(false);
    });

    it('should return true after connect', async () => {
      await mcpClient.connect();
      expect(mcpClient.isConnected()).toBe(true);
    });
  });

  describe('delegation methods', () => {
    beforeEach(async () => {
      await mcpClient.connect();
    });

    it('should delegate callTool to the SDK client', async () => {
      const params = { name: 'my-tool', arguments: {} };
      await mcpClient.callTool(params);

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.callTool).toHaveBeenCalledWith(params, undefined, undefined);
    });

    it('should delegate readResource to the SDK client', async () => {
      const params = { uri: 'file:///test' };
      await mcpClient.readResource(params);

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.readResource).toHaveBeenCalledWith(params, undefined);
    });

    it('should delegate listTools to the SDK client', async () => {
      await mcpClient.listTools();

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.listTools).toHaveBeenCalledWith(undefined, undefined);
    });

    it('should delegate listResources to the SDK client', async () => {
      await mcpClient.listResources();

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.listResources).toHaveBeenCalledWith(undefined, undefined);
    });

    it('should delegate listResourceTemplates to the SDK client', async () => {
      await mcpClient.listResourceTemplates();

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.listResourceTemplates).toHaveBeenCalledWith(undefined, undefined);
    });

    it('should delegate getPrompt to the SDK client', async () => {
      const params = { name: 'my-prompt' };
      await mcpClient.getPrompt(params);

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.getPrompt).toHaveBeenCalledWith(params, undefined);
    });

    it('should delegate listPrompts to the SDK client', async () => {
      await mcpClient.listPrompts();

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.listPrompts).toHaveBeenCalledWith(undefined, undefined);
    });

    it('should delegate ping to the SDK client', async () => {
      await mcpClient.ping();

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.ping).toHaveBeenCalledWith(undefined);
    });

    it('should delegate subscribeResource to the SDK client', async () => {
      const params = { uri: 'file:///test' };
      await mcpClient.subscribeResource(params);

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.subscribeResource).toHaveBeenCalledWith(params, undefined);
    });

    it('should delegate unsubscribeResource to the SDK client', async () => {
      const params = { uri: 'file:///test' };
      await mcpClient.unsubscribeResource(params);

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.unsubscribeResource).toHaveBeenCalledWith(params, undefined);
    });

    it('should delegate setLoggingLevel to the SDK client', async () => {
      await mcpClient.setLoggingLevel('info');

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.setLoggingLevel).toHaveBeenCalledWith('info', undefined);
    });

    it('should delegate complete to the SDK client', async () => {
      const params = {
        ref: { type: 'ref/prompt' as const, name: 'test' },
        argument: { name: 'arg', value: 'val' },
      };
      await mcpClient.complete(params);

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.complete).toHaveBeenCalledWith(params, undefined);
    });

    it('should delegate sendRootsListChanged to the SDK client', async () => {
      await mcpClient.sendRootsListChanged();

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.sendRootsListChanged).toHaveBeenCalled();
    });
  });

  describe('onNotification', () => {
    it('should register a notification handler on the internal map', async () => {
      await mcpClient.connect();

      const handler = vi.fn();
      mcpClient.onNotification('notifications/tools/list_changed', handler);

      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance._notificationHandlers.has('notifications/tools/list_changed')).toBe(
        true,
      );
    });

    it('should invoke the handler when the internal map handler is called', async () => {
      await mcpClient.connect();

      const handler = vi.fn();
      mcpClient.onNotification('notifications/resources/updated', handler);

      const clientInstance = MockedClient.mock.results[0].value;
      const internalHandler = clientInstance._notificationHandlers.get(
        'notifications/resources/updated',
      );

      const notification = { method: 'notifications/resources/updated', params: { uri: 'test' } };
      await internalHandler(notification);

      expect(handler).toHaveBeenCalledWith(notification);
    });

    it('onNotification registers handler without requiring connection', async () => {
      // Not connected yet
      expect(mcpClient.isConnected()).toBe(false);

      const handler = vi.fn();
      // Should not throw
      expect(() =>
        mcpClient.onNotification('notifications/tools/list_changed', handler),
      ).not.toThrow();

      // After connecting, the stored handler is applied to the client
      await mcpClient.connect();
      const clientInstance = MockedClient.mock.results[0].value;
      expect(
        clientInstance._notificationHandlers.has('notifications/tools/list_changed'),
      ).toBe(true);
    });

    it('onNotification handler survives reconnect (new Client instance)', async () => {
      const connWithReconnect = createConnection({ reconnect: { maxAttempts: 2, delay: 1 } });
      mcpClient = new McpClient('test-server', connWithReconnect);

      const handler = vi.fn();
      // Register BEFORE connecting
      mcpClient.onNotification('notifications/tools/list_changed', handler);

      await mcpClient.connect();

      // Capture the current client instance (created in the constructor above)
      // before reconnect swaps it out
      const initialClient = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      expect(
        initialClient._notificationHandlers.has('notifications/tools/list_changed'),
      ).toBe(true);

      // Trigger disconnect — reconnect creates a brand-new Client instance
      const transport = mockedCreateTransport.mock.results[0].value;
      await transport.onclose();

      expect(mcpClient.isConnected()).toBe(true);

      // The newly created Client instance should also have the handler
      const reconnectedClient = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      expect(
        reconnectedClient._notificationHandlers.has('notifications/tools/list_changed'),
      ).toBe(true);
    });
  });

  describe('throws when not connected', () => {
    it('should throw on callTool if not connected', async () => {
      await expect(mcpClient.callTool({ name: 'tool' })).rejects.toThrow(
        'McpClient "test-server" is not connected',
      );
    });

    it('should throw on readResource if not connected', async () => {
      await expect(mcpClient.readResource({ uri: 'file:///x' })).rejects.toThrow(
        'is not connected',
      );
    });

    it('should throw on ping if not connected', async () => {
      await expect(mcpClient.ping()).rejects.toThrow('is not connected');
    });
  });

  describe('handleDisconnect', () => {
    it('should set connected to false when transport closes', async () => {
      await mcpClient.connect();
      expect(mcpClient.isConnected()).toBe(true);

      // Trigger onclose callback
      const transport = mockedCreateTransport.mock.results[0].value;
      await transport.onclose();

      expect(mcpClient.isConnected()).toBe(false);
    });
  });

  describe('attemptReconnect', () => {
    it('should reconnect successfully after disconnect with reconnect options', async () => {
      const connWithReconnect = createConnection({
        reconnect: { maxAttempts: 2, delay: 1 },
      });
      mcpClient = new McpClient('test-server', connWithReconnect);

      await mcpClient.connect();
      expect(mcpClient.isConnected()).toBe(true);

      // Trigger disconnect via onclose
      const transport = mockedCreateTransport.mock.results[0].value;
      await transport.onclose();

      // After reconnect, should be connected again
      expect(mcpClient.isConnected()).toBe(true);
    });

    it('should fail reconnection after max attempts exhausted', async () => {
      const connWithReconnect = createConnection({
        reconnect: { maxAttempts: 2, delay: 1 },
      });
      mcpClient = new McpClient('test-server', connWithReconnect);

      await mcpClient.connect();

      // Make all future client.connect calls fail
      MockedClient.mockImplementation(
        () =>
          ({
            connect: vi.fn().mockRejectedValue(new Error('fail')),
            callTool: vi.fn(),
            readResource: vi.fn(),
            listTools: vi.fn(),
            listResources: vi.fn(),
            getPrompt: vi.fn(),
            listPrompts: vi.fn(),
            ping: vi.fn(),
            getServerCapabilities: vi.fn(),
            getServerVersion: vi.fn(),
          }) as unknown as InstanceType<typeof Client>,
      );

      // Trigger disconnect
      const transport = mockedCreateTransport.mock.results[0].value;
      await transport.onclose();

      expect(mcpClient.isConnected()).toBe(false);
    });
  });

  describe('getServerCapabilities / getServerVersion', () => {
    it('should delegate getServerCapabilities', () => {
      const result = mcpClient.getServerCapabilities();
      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.getServerCapabilities).toHaveBeenCalled();
    });

    it('should delegate getServerVersion', () => {
      const result = mcpClient.getServerVersion();
      const clientInstance = MockedClient.mock.results[0].value;
      expect(clientInstance.getServerVersion).toHaveBeenCalled();
    });
  });

  describe('getInstructions', () => {
    it('returns undefined when server has no instructions', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance.getInstructions.mockReturnValue(undefined);
      expect(mcpClient.getInstructions()).toBeUndefined();
    });

    it('returns instructions string from server', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance.getInstructions.mockReturnValue('This server helps with coding.');
      expect(mcpClient.getInstructions()).toBe('This server helps with coding.');
    });
  });

  describe('getClient', () => {
    it('returns the internal SDK Client instance', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      expect(mcpClient.getClient()).toBe(clientInstance);
    });
  });

  describe('setSamplingHandler', () => {
    it('registers sampling capability and setRequestHandler on the client', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      const handler = vi.fn().mockResolvedValue({});

      mcpClient.setSamplingHandler(handler);

      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({ sampling: {} });
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });
  });

  describe('setElicitationHandler', () => {
    it('registers elicitation capability and setRequestHandler on the client', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      const handler = vi.fn().mockResolvedValue({});

      mcpClient.setElicitationHandler(handler);

      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({ elicitation: {} });
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });
  });

  describe('setRootsHandler', () => {
    it('registers roots capability and setRequestHandler on the client', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      const handler = vi.fn().mockResolvedValue({ roots: [] } as { roots: [] });

      mcpClient.setRootsHandler(handler);

      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({
        roots: { listChanged: true },
      });
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });
  });

  describe('listAll methods', () => {
    beforeEach(async () => {
      await mcpClient.connect();
    });

    it('listAllTools drains pages and returns all tools', async () => {
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance.listTools
        .mockResolvedValueOnce({ tools: [{ name: 'tool1' }], nextCursor: 'c1' })
        .mockResolvedValueOnce({ tools: [{ name: 'tool2' }] });

      const tools = await mcpClient.listAllTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('tool1');
      expect(tools[1].name).toBe('tool2');
    });

    it('listAllResources drains pages and returns all resources', async () => {
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance.listResources
        .mockResolvedValueOnce({ resources: [{ uri: 'file:///a', name: 'a' }], nextCursor: 'c1' })
        .mockResolvedValueOnce({ resources: [{ uri: 'file:///b', name: 'b' }] });

      const resources = await mcpClient.listAllResources();

      expect(resources).toHaveLength(2);
    });

    it('listAllResourceTemplates drains pages and returns all templates', async () => {
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance.listResourceTemplates
        .mockResolvedValueOnce({
          resourceTemplates: [{ uriTemplate: 'file:///{id}', name: 'item' }],
          nextCursor: 'c1',
        })
        .mockResolvedValueOnce({ resourceTemplates: [] });

      const templates = await mcpClient.listAllResourceTemplates();

      expect(templates).toHaveLength(1);
    });

    it('listAllPrompts drains pages and returns all prompts', async () => {
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance.listPrompts
        .mockResolvedValueOnce({ prompts: [{ name: 'p1' }], nextCursor: 'c1' })
        .mockResolvedValueOnce({ prompts: [{ name: 'p2' }] });

      const prompts = await mcpClient.listAllPrompts();

      expect(prompts).toHaveLength(2);
    });
  });

  describe('throws when not connected (listAll)', () => {
    it('listAllTools throws when not connected', async () => {
      await expect(mcpClient.listAllTools()).rejects.toThrow('is not connected');
    });
  });
});
