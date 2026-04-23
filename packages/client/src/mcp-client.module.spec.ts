import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const MockClient = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn(),
    readResource: vi.fn(),
    listTools: vi.fn(),
    listResources: vi.fn(),
    getPrompt: vi.fn(),
    listPrompts: vi.fn(),
    ping: vi.fn(),
    getServerCapabilities: vi.fn(),
    getServerVersion: vi.fn(),
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

import 'reflect-metadata';
import { MCP_CLIENT_OPTIONS } from '@nest-mcp/common';
import type { ModulesContainer } from '@nestjs/core';
import { getMcpClientToken } from './decorators/inject-mcp-client.decorator';
import { MCP_NOTIFICATION_METADATA } from './decorators/on-notification.decorator';
import type {
  McpClientSseConnection,
  McpClientStdioConnection,
} from './interfaces/client-options.interface';
import { McpClientBootstrap, McpClientModule } from './mcp-client.module';
import type { McpClient } from './mcp-client.service';
import { McpClientsService } from './mcp-clients.service';

interface DynamicProvider {
  provide: unknown;
  useFactory?: (...args: unknown[]) => unknown;
  useValue?: unknown;
  inject?: unknown[];
}

describe('McpClientModule', () => {
  describe('forRoot', () => {
    it('includes McpClientBootstrap provider with ModulesContainer injection', () => {
      const mod = McpClientModule.forRoot({
        connections: [
          {
            name: 'server-a',
            transport: 'sse',
            url: 'http://localhost:3000/sse',
          } satisfies McpClientSseConnection,
        ],
      });

      const bootstrapProvider = (mod.providers as DynamicProvider[]).find(
        (p) => p.provide === McpClientBootstrap,
      );
      expect(bootstrapProvider).toBeDefined();
      expect(bootstrapProvider?.useFactory).toBeTypeOf('function');
      expect(bootstrapProvider?.inject).toContain('MCP_CLIENT_CONNECTIONS');
    });

    it('includes MCP_CLIENT_CONNECTIONS aggregate provider', () => {
      const mod = McpClientModule.forRoot({
        connections: [
          {
            name: 'server-a',
            transport: 'sse',
            url: 'http://localhost:3000/sse',
          } satisfies McpClientSseConnection,
        ],
      });

      const connectionsProvider = (mod.providers as DynamicProvider[]).find(
        (p) => p.provide === 'MCP_CLIENT_CONNECTIONS',
      );
      expect(connectionsProvider).toBeDefined();
    });

    it('creates per-connection providers', () => {
      const mod = McpClientModule.forRoot({
        connections: [
          {
            name: 'server-a',
            transport: 'sse',
            url: 'http://localhost:3000/sse',
          } satisfies McpClientSseConnection,
          {
            name: 'server-b',
            transport: 'stdio',
            command: 'node',
          } satisfies McpClientStdioConnection,
        ],
      });

      const tokenA = getMcpClientToken('server-a');
      const tokenB = getMcpClientToken('server-b');

      const providerA = (mod.providers as DynamicProvider[]).find((p) => p.provide === tokenA);
      const providerB = (mod.providers as DynamicProvider[]).find((p) => p.provide === tokenB);

      expect(providerA).toBeDefined();
      expect(providerB).toBeDefined();
    });

    it('includes McpClientsService in providers', () => {
      const mod = McpClientModule.forRoot({
        connections: [
          {
            name: 'server-a',
            transport: 'sse',
            url: 'http://localhost:3000/sse',
          } satisfies McpClientSseConnection,
        ],
      });

      const provider = (mod.providers as DynamicProvider[]).find(
        (p) => p === McpClientsService || p.provide === McpClientsService,
      );
      expect(provider).toBeDefined();
    });

    it('exports McpClientsService', () => {
      const mod = McpClientModule.forRoot({
        connections: [
          {
            name: 'server-a',
            transport: 'sse',
            url: 'http://localhost:3000/sse',
          } satisfies McpClientSseConnection,
        ],
      });

      expect(mod.exports).toContain(McpClientsService);
    });
  });

  describe('forRootAsync', () => {
    it('includes McpClientBootstrap provider', () => {
      const mod = McpClientModule.forRootAsync({
        useFactory: () => ({
          connections: [
            {
              name: 'server-a',
              transport: 'sse',
              url: 'http://localhost:3000/sse',
            } satisfies McpClientSseConnection,
          ],
        }),
      });

      const bootstrapProvider = (mod.providers as DynamicProvider[]).find(
        (p) => p.provide === McpClientBootstrap,
      );
      expect(bootstrapProvider).toBeDefined();
      expect(bootstrapProvider?.useFactory).toBeTypeOf('function');
      expect(bootstrapProvider?.inject).toContain('MCP_CLIENT_CONNECTIONS');
    });

    it('includes MCP_CLIENT_CONNECTIONS provider', () => {
      const mod = McpClientModule.forRootAsync({
        useFactory: () => ({
          connections: [
            {
              name: 'server-a',
              transport: 'sse',
              url: 'http://localhost:3000/sse',
            } satisfies McpClientSseConnection,
          ],
        }),
      });

      const connectionsProvider = (mod.providers as DynamicProvider[]).find(
        (p) => p.provide === 'MCP_CLIENT_CONNECTIONS',
      );
      expect(connectionsProvider).toBeDefined();
    });

    it('includes McpClientsService in providers', () => {
      const mod = McpClientModule.forRootAsync({
        useFactory: () => ({
          connections: [
            {
              name: 'server-a',
              transport: 'sse',
              url: 'http://localhost:3000/sse',
            } satisfies McpClientSseConnection,
          ],
        }),
      });

      const provider = (mod.providers as DynamicProvider[]).find(
        (p) => p === McpClientsService || p.provide === McpClientsService,
      );
      expect(provider).toBeDefined();
    });

    it('exports McpClientsService', () => {
      const mod = McpClientModule.forRootAsync({
        useFactory: () => ({
          connections: [
            {
              name: 'server-a',
              transport: 'sse',
              url: 'http://localhost:3000/sse',
            } satisfies McpClientSseConnection,
          ],
        }),
      });

      expect(mod.exports).toContain(McpClientsService);
    });

    it('creates named providers for connectionNames and includes McpClientsService', () => {
      const mod = McpClientModule.forRootAsync({
        connectionNames: ['server-a'],
        useFactory: () => ({
          connections: [
            {
              name: 'server-a',
              transport: 'sse',
              url: 'http://localhost:3000/sse',
            } satisfies McpClientSseConnection,
          ],
        }),
      });

      const namedProvider = (mod.providers as DynamicProvider[]).find(
        (p) => p.provide === getMcpClientToken('server-a'),
      );
      expect(namedProvider).toBeDefined();

      const clientsServiceProvider = (mod.providers as DynamicProvider[]).find(
        (p) => p === McpClientsService || p.provide === McpClientsService,
      );
      expect(clientsServiceProvider).toBeDefined();
      expect(mod.exports).toContain(McpClientsService);
    });
  });
});

describe('McpClientBootstrap', () => {
  let bootstrap: McpClientBootstrap;
  let mockClients: McpClient[];

  beforeEach(() => {
    mockClients = [
      {
        name: 'a',
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      } as unknown as McpClient,
      {
        name: 'b',
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      } as unknown as McpClient,
    ];
    bootstrap = new McpClientBootstrap(mockClients);
  });

  it('connects all clients on application bootstrap', async () => {
    await bootstrap.onApplicationBootstrap();

    expect(mockClients[0].connect).toHaveBeenCalled();
    expect(mockClients[1].connect).toHaveBeenCalled();
  });

  it('disconnects all clients on application shutdown', async () => {
    await bootstrap.onApplicationShutdown();

    expect(mockClients[0].disconnect).toHaveBeenCalled();
    expect(mockClients[1].disconnect).toHaveBeenCalled();
  });

  it('continues connecting remaining clients if one fails', async () => {
    vi.mocked(mockClients[0].connect).mockRejectedValue(new Error('fail'));

    await bootstrap.onApplicationBootstrap();

    expect(mockClients[0].connect).toHaveBeenCalled();
    expect(mockClients[1].connect).toHaveBeenCalled();
  });

  it('continues disconnecting remaining clients if one fails', async () => {
    vi.mocked(mockClients[0].disconnect).mockRejectedValue(new Error('fail'));

    await bootstrap.onApplicationShutdown();

    expect(mockClients[0].disconnect).toHaveBeenCalled();
    expect(mockClients[1].disconnect).toHaveBeenCalled();
  });

  it('works without modulesContainer (backward compat)', async () => {
    const clients = [
      {
        name: 'a',
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      } as unknown as McpClient,
    ];
    const boot = new McpClientBootstrap(clients);

    await expect(boot.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(clients[0].connect).toHaveBeenCalled();
  });
});

describe('McpClientBootstrap notification wiring', () => {
  function createMockModulesContainer(providers: Array<{ instance: unknown }>): ModulesContainer {
    const moduleProviders = new Map(providers.map((p, i) => [String(i), { instance: p.instance }]));
    const moduleRef = { providers: moduleProviders };
    return new Map([['testModule', moduleRef]]) as unknown as ModulesContainer;
  }

  it('wires @OnMcpNotification handlers to the correct client', async () => {
    const onNotificationFn = vi.fn();
    const clientA = {
      name: 'server-a',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      onNotification: onNotificationFn,
    } as unknown as McpClient;

    class TestHandler {
      handleToolsChanged() {}
    }
    const handlerInstance = new TestHandler();
    Reflect.defineMetadata(
      MCP_NOTIFICATION_METADATA,
      { connectionName: 'server-a', method: 'notifications/tools/list_changed' },
      TestHandler.prototype.handleToolsChanged,
    );

    const modulesContainer = createMockModulesContainer([{ instance: handlerInstance }]);

    const boot = new McpClientBootstrap([clientA], modulesContainer);
    await boot.onApplicationBootstrap();

    expect(onNotificationFn).toHaveBeenCalledWith(
      'notifications/tools/list_changed',
      expect.any(Function),
    );
  });

  it('skips handlers when no matching client name', async () => {
    const onNotificationFn = vi.fn();
    const clientA = {
      name: 'server-a',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      onNotification: onNotificationFn,
    } as unknown as McpClient;

    class TestHandler {
      handleNotification() {}
    }
    const handlerInstance = new TestHandler();
    Reflect.defineMetadata(
      MCP_NOTIFICATION_METADATA,
      { connectionName: 'unknown-server', method: 'notifications/tools/list_changed' },
      TestHandler.prototype.handleNotification,
    );

    const modulesContainer = createMockModulesContainer([{ instance: handlerInstance }]);

    const boot = new McpClientBootstrap([clientA], modulesContainer);
    await boot.onApplicationBootstrap();

    expect(onNotificationFn).not.toHaveBeenCalled();
  });

  it('registers @OnMcpNotification handlers even when client is not connected', async () => {
    const onNotificationFn = vi.fn();
    const clientA = {
      name: 'server-a',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      onNotification: onNotificationFn,
    } as unknown as McpClient;

    class TestHandler {
      handleNotification() {}
    }
    const handlerInstance = new TestHandler();
    Reflect.defineMetadata(
      MCP_NOTIFICATION_METADATA,
      { connectionName: 'server-a', method: 'notifications/tools/list_changed' },
      TestHandler.prototype.handleNotification,
    );

    const modulesContainer = createMockModulesContainer([{ instance: handlerInstance }]);

    const boot = new McpClientBootstrap([clientA], modulesContainer);
    await boot.onApplicationBootstrap();

    expect(onNotificationFn).toHaveBeenCalledWith(
      'notifications/tools/list_changed',
      expect.any(Function),
    );
  });

  it('binds the handler to the correct instance', async () => {
    let capturedHandler: ((...args: unknown[]) => unknown) | undefined;
    const clientA = {
      name: 'server-a',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      onNotification: vi
        .fn()
        .mockImplementation((_method: string, handler: (...args: unknown[]) => unknown) => {
          capturedHandler = handler;
        }),
    } as unknown as McpClient;

    class TestHandler {
      value = 'bound-correctly';
      handleNotification() {
        return this.value;
      }
    }
    const handlerInstance = new TestHandler();
    Reflect.defineMetadata(
      MCP_NOTIFICATION_METADATA,
      { connectionName: 'server-a', method: 'notifications/resources/updated' },
      TestHandler.prototype.handleNotification,
    );

    const modulesContainer = createMockModulesContainer([{ instance: handlerInstance }]);

    const boot = new McpClientBootstrap([clientA], modulesContainer);
    await boot.onApplicationBootstrap();

    expect(capturedHandler).toBeDefined();
    const result = capturedHandler?.({});
    expect(result).toBe('bound-correctly');
  });

  it('ignores providers without notification metadata', async () => {
    const onNotificationFn = vi.fn();
    const clientA = {
      name: 'server-a',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      onNotification: onNotificationFn,
    } as unknown as McpClient;

    class PlainService {
      doSomething() {}
    }
    const plainInstance = new PlainService();

    const modulesContainer = createMockModulesContainer([{ instance: plainInstance }]);

    const boot = new McpClientBootstrap([clientA], modulesContainer);
    await boot.onApplicationBootstrap();

    expect(onNotificationFn).not.toHaveBeenCalled();
  });

  it('skips non-function prototype own properties without throwing', async () => {
    const onNotificationFn = vi.fn();
    const clientA = {
      name: 'server-a',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      onNotification: onNotificationFn,
    } as unknown as McpClient;

    // Simulates providers registered with `useValue: {}` (plain object) or
    // classes whose prototype exposes non-function own properties via
    // accessors — `Reflect.getMetadata` throws TypeError on non-object targets.
    class HandlerWithAccessor {
      handleNotification() {}
    }
    Object.defineProperty(HandlerWithAccessor.prototype, 'nonFunctionProp', {
      get() {
        return null;
      },
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(HandlerWithAccessor.prototype, 'primitiveProp', {
      value: 42,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const handlerInstance = new HandlerWithAccessor();
    Reflect.defineMetadata(
      MCP_NOTIFICATION_METADATA,
      { connectionName: 'server-a', method: 'notifications/tools/list_changed' },
      HandlerWithAccessor.prototype.handleNotification,
    );

    const plainValueProvider = {};

    const modulesContainer = createMockModulesContainer([
      { instance: plainValueProvider },
      { instance: handlerInstance },
    ]);

    const boot = new McpClientBootstrap([clientA], modulesContainer);
    await expect(boot.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(onNotificationFn).toHaveBeenCalledWith(
      'notifications/tools/list_changed',
      expect.any(Function),
    );
  });
});
