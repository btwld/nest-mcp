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
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Logger } from '@nestjs/common';
import type { McpClientConnection } from './interfaces/client-options.interface';
import { McpClient } from './mcp-client.service';
import { createClientTransport } from './transport/client-transport.factory';

const MockedClient = vi.mocked(Client);
const mockedCreateTransport = vi.mocked(createClientTransport);

// biome-ignore lint/suspicious/noExplicitAny: loose SDK client stand-in for the mocked constructor
function createMockSdkClient(): any {
  return {
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
  };
}

type MockTransport = {
  onclose: (() => Promise<void> | undefined) | null;
  onerror: ((err: Error) => Promise<void>) | null;
  close: ReturnType<typeof vi.fn>;
  terminateSession?: ReturnType<typeof vi.fn>;
};

/** Make every createClientTransport call return a fresh transport; returns the created list. */
function useFreshTransports(extra?: () => Partial<MockTransport>): MockTransport[] {
  const created: MockTransport[] = [];
  mockedCreateTransport.mockImplementation(() => {
    const transport: MockTransport = {
      onclose: null,
      onerror: null,
      close: vi.fn().mockResolvedValue(undefined),
      ...extra?.(),
    };
    created.push(transport);
    return transport as unknown as ReturnType<typeof createClientTransport>;
  });
  return created;
}

function lastClient() {
  return MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
    MockedClient.mockImplementation(createMockSdkClient);

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
      expect(clientInstance._notificationHandlers.has('notifications/tools/list_changed')).toBe(
        true,
      );
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
      expect(initialClient._notificationHandlers.has('notifications/tools/list_changed')).toBe(
        true,
      );

      // Trigger disconnect — reconnect creates a brand-new Client instance
      const transport = mockedCreateTransport.mock.results[0].value;
      await transport.onclose();

      expect(mcpClient.isConnected()).toBe(true);

      // The newly created Client instance should also have the handler
      const reconnectedClient =
        MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      expect(reconnectedClient._notificationHandlers.has('notifications/tools/list_changed')).toBe(
        true,
      );
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

    it('is a no-op when transport fires onclose while already disconnected', async () => {
      await mcpClient.connect();
      const transport = mockedCreateTransport.mock.results[0].value;

      // First close: sets connected = false
      await transport.onclose();
      expect(mcpClient.isConnected()).toBe(false);

      // Second close: guard exits early — no throw, state unchanged
      await expect(transport.onclose()).resolves.toBeUndefined();
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

    it('re-applies sampling handler to new Client instance on reconnect', async () => {
      const connWithReconnect = createConnection({ reconnect: { maxAttempts: 2, delay: 1 } });
      mcpClient = new McpClient('test-server', connWithReconnect);

      mcpClient.setSamplingHandler(
        vi.fn().mockResolvedValue({
          model: 'm',
          stopReason: 'endTurn',
          role: 'assistant',
          content: { type: 'text', text: '' },
        }),
      );

      await mcpClient.connect();

      // Trigger disconnect to initiate reconnect
      const transport = mockedCreateTransport.mock.results[0].value;
      await transport.onclose();

      // Reconnect should have created a second Client instance
      expect(MockedClient.mock.results.length).toBeGreaterThan(1);
      const reconnectedClient =
        MockedClient.mock.results[MockedClient.mock.results.length - 1].value;

      // _reapplyRequestHandlers wires up setRequestHandler on the new client
      expect(reconnectedClient.setRequestHandler).toHaveBeenCalled();
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
    it('registers sampling capability and setRequestHandler when called before connect', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      const handler = vi.fn().mockResolvedValue({});

      mcpClient.setSamplingHandler(handler);

      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({ sampling: {} });
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });

    it('does not call registerCapabilities when already connected (capabilities sent at handshake)', async () => {
      await mcpClient.connect();
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance.registerCapabilities.mockClear();

      mcpClient.setSamplingHandler(vi.fn().mockResolvedValue({}));

      // Capability registration is skipped post-connect; handler is still wired up
      expect(clientInstance.registerCapabilities).not.toHaveBeenCalled();
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });
  });

  describe('setElicitationHandler', () => {
    it('registers elicitation capability and setRequestHandler when called before connect', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      const handler = vi.fn().mockResolvedValue({});

      mcpClient.setElicitationHandler(handler);

      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({ elicitation: {} });
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });

    it('does not call registerCapabilities when already connected', async () => {
      await mcpClient.connect();
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance.registerCapabilities.mockClear();

      mcpClient.setElicitationHandler(vi.fn().mockResolvedValue({ action: 'cancel' }));

      expect(clientInstance.registerCapabilities).not.toHaveBeenCalled();
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });
  });

  describe('setRootsHandler', () => {
    it('registers roots capability and setRequestHandler when called before connect', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      const handler = vi.fn().mockResolvedValue({ roots: [] } as { roots: [] });

      mcpClient.setRootsHandler(handler);

      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({
        roots: { listChanged: true },
      });
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });

    it('does not call registerCapabilities when already connected', async () => {
      await mcpClient.connect();
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance.registerCapabilities.mockClear();

      mcpClient.setRootsHandler(vi.fn().mockResolvedValue({ roots: [] }));

      expect(clientInstance.registerCapabilities).not.toHaveBeenCalled();
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });
  });

  describe('constructor handler routing', () => {
    it('calls setSamplingHandler when connection.samplingHandler is provided', () => {
      const samplingHandler = vi.fn().mockResolvedValue({
        model: 'm',
        stopReason: 'endTurn',
        role: 'assistant',
        content: { type: 'text', text: '' },
      });
      const conn = createConnection({ samplingHandler });
      const client = new McpClient('test', conn);

      const clientInstance = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({ sampling: {} });
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });

    it('calls setElicitationHandler when connection.elicitationHandler is provided', () => {
      const elicitationHandler = vi.fn().mockResolvedValue({ action: 'cancel' });
      const conn = createConnection({ elicitationHandler });
      const client = new McpClient('test', conn);

      const clientInstance = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({ elicitation: {} });
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });

    it('calls setRootsHandler when connection.rootsHandler is provided', () => {
      const rootsHandler = vi.fn().mockResolvedValue({ roots: [] });
      const conn = createConnection({ rootsHandler });
      const client = new McpClient('test', conn);

      const clientInstance = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({
        roots: { listChanged: true },
      });
      expect(clientInstance.setRequestHandler).toHaveBeenCalled();
    });

    it('inherits connection.capabilities as declared capabilities', () => {
      const conn = createConnection({ capabilities: { sampling: {} } });
      const client = new McpClient('test', conn);

      // The Client constructor should have been called with the provided capabilities
      const lastCall = MockedClient.mock.calls[MockedClient.mock.calls.length - 1];
      expect(lastCall[1]).toMatchObject({ capabilities: { sampling: {} } });
    });
  });

  describe('reconnect re-applies handlers (_reapplyRequestHandlers)', () => {
    it('re-applies elicitationHandler to new Client instance on reconnect', async () => {
      const connWithReconnect = createConnection({ reconnect: { maxAttempts: 2, delay: 1 } });
      mcpClient = new McpClient('test-server', connWithReconnect);

      mcpClient.setElicitationHandler(vi.fn().mockResolvedValue({ action: 'cancel' }));

      await mcpClient.connect();

      const transport = mockedCreateTransport.mock.results[0].value;
      await transport.onclose();

      expect(mcpClient.isConnected()).toBe(true);

      const reconnectedClient =
        MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      expect(reconnectedClient.setRequestHandler).toHaveBeenCalled();
    });

    it('re-applies rootsHandler to new Client instance on reconnect', async () => {
      const connWithReconnect = createConnection({ reconnect: { maxAttempts: 2, delay: 1 } });
      mcpClient = new McpClient('test-server', connWithReconnect);

      mcpClient.setRootsHandler(vi.fn().mockResolvedValue({ roots: [] }));

      await mcpClient.connect();

      const transport = mockedCreateTransport.mock.results[0].value;
      await transport.onclose();

      expect(mcpClient.isConnected()).toBe(true);

      const reconnectedClient =
        MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      expect(reconnectedClient.setRequestHandler).toHaveBeenCalled();
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

    it('listAllResources throws when not connected', async () => {
      await expect(mcpClient.listAllResources()).rejects.toThrow('is not connected');
    });

    it('listAllResourceTemplates throws when not connected', async () => {
      await expect(mcpClient.listAllResourceTemplates()).rejects.toThrow('is not connected');
    });

    it('listAllPrompts throws when not connected', async () => {
      await expect(mcpClient.listAllPrompts()).rejects.toThrow('is not connected');
    });
  });

  describe('listAll truncation', () => {
    it('logs a warning when the 100-page cap cuts the listing short', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await mcpClient.connect();
        const clientInstance = MockedClient.mock.results[0].value;
        clientInstance.listTools.mockResolvedValue({ tools: [{ name: 't' }], nextCursor: 'more' });

        const tools = await mcpClient.listAllTools();

        expect(tools).toHaveLength(100);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('stopped after 100 pages'));
      } finally {
        warn.mockRestore();
      }
    });

    it('does not warn when the listing completes', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await mcpClient.connect();
        await mcpClient.listAllPrompts();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('expired session (HTTP 404)', () => {
    it('closes the transport and re-initializes with a new client when reconnect is enabled', async () => {
      const transports = useFreshTransports();
      mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 1 } }));
      await mcpClient.connect();
      const clientsBefore = MockedClient.mock.results.length;

      await transports[0].onerror?.(new StreamableHTTPError(404, 'Session not found'));

      expect(transports[0].close).toHaveBeenCalled();
      expect(transports).toHaveLength(2);
      expect(MockedClient.mock.results.length).toBe(clientsBefore + 1);
      expect(lastClient().connect).toHaveBeenCalledWith(transports[1], undefined);
      expect(mcpClient.isConnected()).toBe(true);
    });

    it('marks the client disconnected when reconnect is disabled', async () => {
      const transports = useFreshTransports();
      await mcpClient.connect();

      await transports[0].onerror?.(new StreamableHTTPError(404, 'Session not found'));

      expect(transports[0].close).toHaveBeenCalled();
      expect(mcpClient.isConnected()).toBe(false);
      await expect(mcpClient.ping()).rejects.toThrow('is not connected');
    });

    it('does not react to the onclose fired by closing the expired transport', async () => {
      const transports = useFreshTransports(() => ({}));
      mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 1 } }));
      await mcpClient.connect();
      // Simulate the SDK: close() fires onclose synchronously.
      transports[0].close.mockImplementation(async () => {
        transports[0].onclose?.();
      });

      await transports[0].onerror?.(new StreamableHTTPError(404, 'Session not found'));

      // Exactly one reconnect: one new transport, not two.
      expect(transports).toHaveLength(2);
      expect(mcpClient.isConnected()).toBe(true);
    });

    it('ignores other HTTP errors', async () => {
      const transports = useFreshTransports();
      await mcpClient.connect();

      await transports[0].onerror?.(new StreamableHTTPError(500, 'boom'));
      await transports[0].onerror?.(new Error('network down'));

      expect(transports[0].close).not.toHaveBeenCalled();
      expect(mcpClient.isConnected()).toBe(true);
    });

    it('ignores a 404 that arrives before the client is connected', async () => {
      const transports = useFreshTransports();
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance.connect.mockImplementationOnce(async () => {
        await transports[0].onerror?.(new StreamableHTTPError(404, 'Not Found'));
        throw new Error('Not Found');
      });

      await expect(mcpClient.connect()).rejects.toThrow('Not Found');
      expect(transports[0].close).not.toHaveBeenCalled();
      expect(transports).toHaveLength(1);
    });

    it('does not start a new session during disconnect', async () => {
      const transports = useFreshTransports(() => ({
        terminateSession: vi.fn().mockResolvedValue(undefined),
      }));
      mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 1 } }));
      await mcpClient.connect();
      transports[0].terminateSession?.mockImplementation(async () => {
        await transports[0].onerror?.(new StreamableHTTPError(404, 'gone'));
      });

      await mcpClient.disconnect();

      expect(transports).toHaveLength(1);
      expect(mcpClient.isConnected()).toBe(false);
    });
  });

  describe('disconnect ends the HTTP session', () => {
    it('calls terminateSession before closing the transport', async () => {
      const order: string[] = [];
      const transports = useFreshTransports(() => ({
        terminateSession: vi.fn(async () => {
          order.push('terminate');
        }),
        close: vi.fn(async () => {
          order.push('close');
        }),
      }));
      await mcpClient.connect();

      await mcpClient.disconnect();

      expect(transports[0].terminateSession).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['terminate', 'close']);
    });

    it('ignores terminateSession failures (e.g. 405)', async () => {
      const transports = useFreshTransports(() => ({
        terminateSession: vi.fn().mockRejectedValue(new StreamableHTTPError(405, 'Not Allowed')),
      }));
      await mcpClient.connect();

      await expect(mcpClient.disconnect()).resolves.toBeUndefined();
      expect(transports[0].close).toHaveBeenCalled();
      expect(mcpClient.isConnected()).toBe(false);
    });

    it('does not wait forever for a terminateSession that never settles', async () => {
      vi.useFakeTimers();
      try {
        const transports = useFreshTransports(() => ({
          terminateSession: vi.fn(() => new Promise<void>(() => undefined)),
        }));
        await mcpClient.connect();

        const done = mcpClient.disconnect();
        await vi.advanceTimersByTimeAsync(5000);
        await done;

        expect(transports[0].close).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('just closes transports without terminateSession (SSE, stdio)', async () => {
      const transports = useFreshTransports();
      await mcpClient.connect();

      await mcpClient.disconnect();

      expect(transports[0].close).toHaveBeenCalled();
    });
  });

  describe('onNotification dispatch', () => {
    it('keeps the handler the SDK already installed for the method and calls it first', async () => {
      const clientInstance = MockedClient.mock.results[0].value;
      const calls: string[] = [];
      const sdkProgress = vi.fn(async () => {
        calls.push('sdk');
      });
      clientInstance._notificationHandlers.set('notifications/progress', sdkProgress);

      mcpClient.onNotification('notifications/progress', () => {
        calls.push('user');
      });
      const notification = { method: 'notifications/progress', params: { progress: 1 } };
      await clientInstance._notificationHandlers.get('notifications/progress')(notification);

      expect(sdkProgress).toHaveBeenCalledWith(notification);
      expect(calls).toEqual(['sdk', 'user']);
    });

    it('calls every handler registered for the same method, in order', async () => {
      await mcpClient.connect();
      const clientInstance = MockedClient.mock.results[0].value;
      const calls: string[] = [];
      mcpClient.onNotification('notifications/message', () => {
        calls.push('first');
      });
      mcpClient.onNotification('notifications/message', async () => {
        calls.push('second');
      });

      await clientInstance._notificationHandlers.get('notifications/message')({
        method: 'notifications/message',
      });

      expect(calls).toEqual(['first', 'second']);
    });

    it('isolates errors so one failing handler does not stop the others', async () => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const clientInstance = MockedClient.mock.results[0].value;
        const second = vi.fn();
        mcpClient.onNotification('notifications/message', () => {
          throw new Error('handler blew up');
        });
        mcpClient.onNotification('notifications/message', second);

        await expect(
          clientInstance._notificationHandlers.get('notifications/message')({
            method: 'notifications/message',
          }),
        ).resolves.toBeUndefined();

        expect(second).toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('handler blew up'));
      } finally {
        error.mockRestore();
      }
    });

    it('still runs user handlers when the SDK handler throws, then rethrows its error', async () => {
      const clientInstance = MockedClient.mock.results[0].value;
      clientInstance._notificationHandlers.set('notifications/progress', async () => {
        throw new Error('invalid progress');
      });
      const user = vi.fn();
      mcpClient.onNotification('notifications/progress', user);

      await expect(
        clientInstance._notificationHandlers.get('notifications/progress')({
          method: 'notifications/progress',
        }),
      ).rejects.toThrow('invalid progress');
      expect(user).toHaveBeenCalled();
    });

    it('does not wrap its own dispatcher again on repeated registration or connect', async () => {
      const clientInstance = MockedClient.mock.results[0].value;
      const sdkProgress = vi.fn().mockResolvedValue(undefined);
      clientInstance._notificationHandlers.set('notifications/progress', sdkProgress);

      mcpClient.onNotification('notifications/progress', vi.fn());
      const dispatcher = clientInstance._notificationHandlers.get('notifications/progress');
      mcpClient.onNotification('notifications/progress', vi.fn());
      await mcpClient.connect();

      expect(clientInstance._notificationHandlers.get('notifications/progress')).toBe(dispatcher);
      await dispatcher({ method: 'notifications/progress' });
      expect(sdkProgress).toHaveBeenCalledTimes(1);
    });

    it('installs the dispatcher on the new SDK client after reconnect, keeping its SDK handlers', async () => {
      const transports = useFreshTransports();
      mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 1 } }));
      const user = vi.fn();
      mcpClient.onNotification('notifications/progress', user);
      await mcpClient.connect();

      const sdkProgress = vi.fn().mockResolvedValue(undefined);
      MockedClient.mockImplementationOnce(() => ({
        ...createMockSdkClient(),
        connect: vi.fn().mockResolvedValue(undefined),
        setRequestHandler: vi.fn(),
        registerCapabilities: vi.fn(),
        _notificationHandlers: new Map([['notifications/progress', sdkProgress]]),
      }));
      await transports[0].onclose?.();

      const reconnected = lastClient();
      await reconnected._notificationHandlers.get('notifications/progress')({
        method: 'notifications/progress',
      });
      expect(sdkProgress).toHaveBeenCalledTimes(1);
      expect(user).toHaveBeenCalledTimes(1);
    });
  });

  describe('capability merging', () => {
    it('keeps nested user capabilities when handlers are registered', () => {
      mcpClient = new McpClient(
        'test-server',
        createConnection({
          capabilities: {
            sampling: { tools: {} },
            elicitation: { form: { applyDefaults: true } },
          },
        }),
      );
      const clientInstance = lastClient();

      mcpClient.setSamplingHandler(vi.fn());
      mcpClient.setElicitationHandler(vi.fn(), { modes: ['form', 'url'] });

      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({ sampling: { tools: {} } });
      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({
        elicitation: { form: { applyDefaults: true }, url: {} },
      });
    });

    it('lets explicit user values win over handler defaults', () => {
      mcpClient = new McpClient(
        'test-server',
        createConnection({ capabilities: { roots: { listChanged: false } } }),
      );
      const clientInstance = lastClient();

      mcpClient.setRootsHandler(vi.fn());

      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({
        roots: { listChanged: false },
      });
    });

    it('passes the merged capabilities to the client rebuilt on reconnect', async () => {
      const transports = useFreshTransports();
      mcpClient = new McpClient(
        'test-server',
        createConnection({
          reconnect: { delay: 1 },
          capabilities: { sampling: { tools: {} }, experimental: { feature: {} } },
          elicitationHandler: vi.fn(),
          elicitationModes: ['url'],
          rootsHandler: vi.fn(),
        }),
      );
      mcpClient.setSamplingHandler(vi.fn());
      await mcpClient.connect();

      await transports[0].onclose?.();

      const lastCall = MockedClient.mock.calls[MockedClient.mock.calls.length - 1];
      expect(lastCall[1]).toEqual({
        capabilities: {
          sampling: { tools: {} },
          elicitation: { url: {} },
          roots: { listChanged: true },
          experimental: { feature: {} },
        },
      });
    });
  });

  describe('URL-mode elicitation', () => {
    it('declares form mode only by default', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      mcpClient.setElicitationHandler(vi.fn());
      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({ elicitation: {} });
    });

    it('declares form and url modes when requested', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      mcpClient.setElicitationHandler(vi.fn(), { modes: ['form', 'url'] });
      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({
        elicitation: { form: {}, url: {} },
      });
    });

    it('declares url mode only when requested', () => {
      const clientInstance = MockedClient.mock.results[0].value;
      mcpClient.setElicitationHandler(vi.fn(), { modes: ['url'] });
      expect(clientInstance.registerCapabilities).toHaveBeenCalledWith({
        elicitation: { url: {} },
      });
    });

    it('reads elicitationModes from the connection options', () => {
      new McpClient(
        'test-server',
        createConnection({ elicitationHandler: vi.fn(), elicitationModes: ['form', 'url'] }),
      );
      expect(lastClient().registerCapabilities).toHaveBeenCalledWith({
        elicitation: { form: {}, url: {} },
      });
    });
  });

  describe('request handler extra', () => {
    function registeredHandler(clientInstance: { setRequestHandler: ReturnType<typeof vi.fn> }) {
      const calls = clientInstance.setRequestHandler.mock.calls;
      return calls[calls.length - 1][1] as (req: unknown, extra: unknown) => unknown;
    }

    const extra = { signal: new AbortController().signal, requestId: 7, _meta: { a: 1 } };

    it('passes the SDK extra to the sampling handler', async () => {
      const handler = vi.fn().mockResolvedValue({});
      mcpClient.setSamplingHandler(handler);
      const request = { method: 'sampling/createMessage', params: {} };

      await registeredHandler(MockedClient.mock.results[0].value)(request, extra);

      expect(handler).toHaveBeenCalledWith(request, extra);
    });

    it('passes the params and SDK extra to the elicitation handler', async () => {
      const handler = vi.fn().mockResolvedValue({ action: 'cancel' });
      mcpClient.setElicitationHandler(handler);
      const params = { mode: 'url', message: 'm', url: 'https://x', elicitationId: 'e' };

      await registeredHandler(MockedClient.mock.results[0].value)(
        { method: 'elicitation/create', params },
        extra,
      );

      expect(handler).toHaveBeenCalledWith(params, extra);
    });

    it('passes the SDK extra to the roots handler', async () => {
      const handler = vi.fn().mockResolvedValue({ roots: [] });
      mcpClient.setRootsHandler(handler);

      await registeredHandler(MockedClient.mock.results[0].value)({ method: 'roots/list' }, extra);

      expect(handler).toHaveBeenCalledWith(extra);
    });

    it('passes the SDK extra after reconnect too', async () => {
      const transports = useFreshTransports();
      mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 1 } }));
      const handler = vi.fn().mockResolvedValue({});
      mcpClient.setSamplingHandler(handler);
      await mcpClient.connect();
      await transports[0].onclose?.();

      await registeredHandler(lastClient())({ method: 'sampling/createMessage' }, extra);

      expect(handler).toHaveBeenCalledWith({ method: 'sampling/createMessage' }, extra);
    });
  });

  describe('reconnect after a user-initiated close', () => {
    it('does not reconnect when disconnect() runs during the backoff sleep', async () => {
      const transports = useFreshTransports();
      mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 30 } }));
      await mcpClient.connect();
      const clientsBefore = MockedClient.mock.results.length;

      const reconnecting = transports[0].onclose?.();
      await mcpClient.disconnect();
      await reconnecting;

      expect(MockedClient.mock.results.length).toBe(clientsBefore);
      expect(transports).toHaveLength(1);
      expect(mcpClient.isConnected()).toBe(false);
    });

    it('closes the fresh connection when disconnect() runs during the handshake', async () => {
      const transports = useFreshTransports();
      mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 1 } }));
      await mcpClient.connect();

      const handshake = deferred();
      MockedClient.mockImplementationOnce(() => ({
        ...createMockSdkClient(),
        connect: vi.fn(() => handshake.promise),
        setRequestHandler: vi.fn(),
        registerCapabilities: vi.fn(),
        _notificationHandlers: new Map(),
      }));

      const reconnecting = transports[0].onclose?.();
      await vi.waitFor(() => expect(transports).toHaveLength(2));
      await mcpClient.disconnect();
      handshake.resolve();
      await reconnecting;

      expect(transports[1].close).toHaveBeenCalled();
      expect(mcpClient.isConnected()).toBe(false);
    });

    it('does not reconnect after removal through disconnect() when onclose fires later', async () => {
      const transports = useFreshTransports();
      mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 1 } }));
      await mcpClient.connect();

      await mcpClient.disconnect();
      await transports[0].onclose?.();

      expect(transports).toHaveLength(1);
      expect(mcpClient.isConnected()).toBe(false);
    });

    it('reconnects normally again after an explicit connect()', async () => {
      const transports = useFreshTransports();
      mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 1 } }));
      await mcpClient.connect();
      await mcpClient.disconnect();
      await mcpClient.connect();

      await transports[1].onclose?.();

      expect(transports).toHaveLength(3);
      expect(mcpClient.isConnected()).toBe(true);
    });
  });

  describe('resource subscriptions across reconnects', () => {
    it('re-subscribes tracked URIs after a reconnect', async () => {
      const transports = useFreshTransports();
      mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 1 } }));
      await mcpClient.connect();
      await mcpClient.subscribeResource({ uri: 'file:///a' });
      await mcpClient.subscribeResource({ uri: 'file:///b' });
      await mcpClient.unsubscribeResource({ uri: 'file:///b' });

      await transports[0].onclose?.();

      const reconnected = lastClient();
      expect(reconnected.subscribeResource).toHaveBeenCalledTimes(1);
      expect(reconnected.subscribeResource).toHaveBeenCalledWith({ uri: 'file:///a' });
    });

    it('does not track a subscription that failed', async () => {
      const transports = useFreshTransports();
      mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 1 } }));
      await mcpClient.connect();
      lastClient().subscribeResource.mockRejectedValueOnce(new Error('nope'));
      await expect(mcpClient.subscribeResource({ uri: 'file:///a' })).rejects.toThrow('nope');

      await transports[0].onclose?.();

      expect(lastClient().subscribeResource).not.toHaveBeenCalled();
    });

    it('logs and continues when a re-subscribe fails', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const transports = useFreshTransports();
        mcpClient = new McpClient('test-server', createConnection({ reconnect: { delay: 1 } }));
        await mcpClient.connect();
        await mcpClient.subscribeResource({ uri: 'file:///a' });
        await mcpClient.subscribeResource({ uri: 'file:///b' });

        const subscribe = vi
          .fn()
          .mockRejectedValueOnce(new Error('gone'))
          .mockResolvedValueOnce({});
        MockedClient.mockImplementationOnce(() => ({
          ...createMockSdkClient(),
          connect: vi.fn().mockResolvedValue(undefined),
          setRequestHandler: vi.fn(),
          registerCapabilities: vi.fn(),
          subscribeResource: subscribe,
          _notificationHandlers: new Map(),
        }));

        await expect(transports[0].onclose?.()).resolves.toBeUndefined();

        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('file:///a'));
        expect(mcpClient.isConnected()).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it('forgets subscriptions on disconnect()', async () => {
      await mcpClient.connect();
      await mcpClient.subscribeResource({ uri: 'file:///a' });
      await mcpClient.disconnect();

      await mcpClient.connect();

      expect(MockedClient.mock.results[0].value.subscribeResource).toHaveBeenCalledTimes(1);
    });
  });

  describe('clientInfo', () => {
    it('defaults to nestjs-mcp-client-<name> / 1.0.0', () => {
      expect(MockedClient.mock.calls[0][0]).toEqual({
        name: 'nestjs-mcp-client-test-server',
        version: '1.0.0',
      });
    });

    it('uses the configured clientInfo, filling in missing name/version', () => {
      new McpClient(
        'svc',
        createConnection({
          clientInfo: {
            title: 'My App',
            description: 'desc',
            websiteUrl: 'https://example.com',
            icons: [{ src: 'https://example.com/icon.png' }],
          },
        }),
      );
      expect(MockedClient.mock.calls[MockedClient.mock.calls.length - 1][0]).toEqual({
        name: 'nestjs-mcp-client-svc',
        version: '1.0.0',
        title: 'My App',
        description: 'desc',
        websiteUrl: 'https://example.com',
        icons: [{ src: 'https://example.com/icon.png' }],
      });
    });

    it('uses a configured name and version', () => {
      new McpClient('svc', createConnection({ clientInfo: { name: 'my-app', version: '2.3.4' } }));
      expect(MockedClient.mock.calls[MockedClient.mock.calls.length - 1][0]).toEqual({
        name: 'my-app',
        version: '2.3.4',
      });
    });
  });

  describe('connectTimeout', () => {
    it('is passed as the request timeout of the initialize handshake', async () => {
      mcpClient = new McpClient('test-server', createConnection({ connectTimeout: 1234 }));
      await mcpClient.connect();

      expect(lastClient().connect).toHaveBeenCalledWith(expect.anything(), { timeout: 1234 });
    });

    it('is applied to reconnection attempts', async () => {
      const transports = useFreshTransports();
      mcpClient = new McpClient(
        'test-server',
        createConnection({ connectTimeout: 500, reconnect: { delay: 1 } }),
      );
      await mcpClient.connect();
      await transports[0].onclose?.();

      expect(lastClient().connect).toHaveBeenCalledWith(transports[1], { timeout: 500 });
    });
  });

  describe('sessionId', () => {
    it('is used for the first connect only; reconnects start a new session', async () => {
      useFreshTransports();
      const conn = {
        name: 'test-server',
        transport: 'streamable-http',
        url: 'http://localhost:3000/mcp',
        sessionId: 'resume-me',
        reconnect: { delay: 1 },
      } as McpClientConnection;
      mcpClient = new McpClient('test-server', conn);
      await mcpClient.connect();
      const firstTransport = mockedCreateTransport.mock.results[0].value as MockTransport;

      await firstTransport.onclose?.();

      expect(mockedCreateTransport.mock.calls[0][0]).toMatchObject({ sessionId: 'resume-me' });
      expect(mockedCreateTransport.mock.calls[1][0]).toMatchObject({
        url: 'http://localhost:3000/mcp',
        sessionId: undefined,
      });
    });
  });
});
