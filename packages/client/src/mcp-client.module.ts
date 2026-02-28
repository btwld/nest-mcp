import { MCP_CLIENT_OPTIONS } from '@btwld/mcp-common';
import {
  type DynamicModule,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import {
  MCP_NOTIFICATION_METADATA,
  type McpNotificationMetadata,
} from './decorators/on-notification.decorator';
import { getMcpClientToken } from './decorators/inject-mcp-client.decorator';
import type {
  McpClientModuleAsyncOptions,
  McpClientModuleOptions,
} from './interfaces/client-options.interface';
import { McpClient } from './mcp-client.service';

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS requires module classes for DI
export class McpClientModule {
  private static readonly logger = new Logger('McpClientModule');

  static forRoot(options: McpClientModuleOptions): DynamicModule {
    const connectionProviders = McpClientModule.createConnectionProviders(options);

    const connectionsAggregateProvider = {
      provide: 'MCP_CLIENT_CONNECTIONS',
      useFactory: (...clients: McpClient[]) => clients,
      inject: connectionProviders.map((p) => p.provide),
    };

    const bootstrapProvider = {
      provide: McpClientBootstrap,
      useFactory: (clients: McpClient[], modulesContainer: ModulesContainer) =>
        new McpClientBootstrap(clients, modulesContainer),
      inject: ['MCP_CLIENT_CONNECTIONS', ModulesContainer],
    };

    return {
      module: McpClientModule,
      global: true,
      providers: [
        { provide: MCP_CLIENT_OPTIONS, useValue: options },
        ...connectionProviders,
        connectionsAggregateProvider,
        bootstrapProvider,
      ],
      exports: [MCP_CLIENT_OPTIONS, ...connectionProviders.map((p) => p.provide)],
    };
  }

  static forRootAsync(options: McpClientModuleAsyncOptions): DynamicModule {
    const asyncOptionsProvider = {
      provide: MCP_CLIENT_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };

    const connectionsProvider = {
      provide: 'MCP_CLIENT_CONNECTIONS',
      useFactory: async (opts: McpClientModuleOptions) => {
        const clients: McpClient[] = [];
        for (const conn of opts.connections) {
          const client = new McpClient(conn.name, conn);
          clients.push(client);
        }
        return clients;
      },
      inject: [MCP_CLIENT_OPTIONS],
    };

    const bootstrapProvider = {
      provide: McpClientBootstrap,
      useFactory: (clients: McpClient[], modulesContainer: ModulesContainer) =>
        new McpClientBootstrap(clients, modulesContainer),
      inject: ['MCP_CLIENT_CONNECTIONS', ModulesContainer],
    };

    // When using forRootAsync, connection names are resolved at runtime.
    // Use @Inject('MCP_CLIENT_CONNECTIONS') and find clients by name,
    // or use the connectionNames option to enable @InjectMcpClient('name').
    const namedProviders = (options.connectionNames ?? []).map((name) => ({
      provide: getMcpClientToken(name),
      useFactory: (clients: McpClient[]) => {
        const client = clients.find((c) => c.name === name);
        if (!client) {
          throw new Error(
            `McpClientModule: No connection named "${name}" found. Ensure the name matches a connection in the factory options.`,
          );
        }
        return client;
      },
      inject: ['MCP_CLIENT_CONNECTIONS'],
    }));

    return {
      module: McpClientModule,
      global: true,
      imports: options.imports ?? [],
      providers: [asyncOptionsProvider, connectionsProvider, ...namedProviders, bootstrapProvider],
      exports: [
        MCP_CLIENT_OPTIONS,
        connectionsProvider.provide,
        ...namedProviders.map((p) => p.provide),
      ],
    };
  }

  private static createConnectionProviders(options: McpClientModuleOptions) {
    return options.connections.map((connection) => ({
      provide: getMcpClientToken(connection.name),
      useFactory: () => new McpClient(connection.name, connection),
    }));
  }
}

export class McpClientBootstrap implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('McpClientBootstrap');
  private readonly clients: McpClient[] = [];

  constructor(
    clients: McpClient[],
    private readonly modulesContainer?: ModulesContainer,
  ) {
    this.clients = clients;
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const client of this.clients) {
      try {
        await client.connect();
      } catch (err: unknown) {
        this.logger.error(
          `Failed to connect client "${client.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.wireNotificationHandlers();
  }

  async onApplicationShutdown(): Promise<void> {
    for (const client of this.clients) {
      try {
        await client.disconnect();
      } catch (err: unknown) {
        this.logger.error(
          `Failed to disconnect client "${client.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private wireNotificationHandlers(): void {
    if (!this.modulesContainer) return;

    let wiredCount = 0;

    for (const [, moduleRef] of this.modulesContainer) {
      for (const [, wrapper] of moduleRef.providers) {
        const instance = wrapper?.instance;
        if (!instance || !instance.constructor) continue;

        const prototype = Object.getPrototypeOf(instance);
        const methodNames = Object.getOwnPropertyNames(prototype).filter(
          (name) => name !== 'constructor',
        );

        for (const methodName of methodNames) {
          // NestJS SetMetadata stores metadata on the descriptor.value (the method
          // function itself), so we read from prototype[methodName] rather than
          // using the (target, propertyKey) overload.
          const metadata: McpNotificationMetadata | undefined =
            Reflect.getMetadata(MCP_NOTIFICATION_METADATA, prototype[methodName]);

          if (!metadata) continue;

          const client = this.clients.find((c) => c.name === metadata.connectionName);
          if (!client) {
            this.logger.warn(
              `@OnMcpNotification on ${instance.constructor.name}.${methodName}: ` +
                `no client named "${metadata.connectionName}" found, skipping`,
            );
            continue;
          }

          const boundHandler = (instance as Record<string, Function>)[methodName].bind(instance);
          client.onNotification(metadata.method, boundHandler);
          wiredCount++;
        }
      }
    }

    if (wiredCount > 0) {
      this.logger.log(`Wired ${wiredCount} @OnMcpNotification handler(s)`);
    }
  }
}
