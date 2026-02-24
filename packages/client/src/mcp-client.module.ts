import { MCP_CLIENT_OPTIONS } from '@btwld/mcp-common';
import {
  type DynamicModule,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
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
      useFactory: (clients: McpClient[]) => new McpClientBootstrap(clients),
      inject: ['MCP_CLIENT_CONNECTIONS'],
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
      useFactory: (clients: McpClient[]) => new McpClientBootstrap(clients),
      inject: ['MCP_CLIENT_CONNECTIONS'],
    };

    return {
      module: McpClientModule,
      global: true,
      imports: options.imports ?? [],
      providers: [asyncOptionsProvider, connectionsProvider, bootstrapProvider],
      exports: [MCP_CLIENT_OPTIONS, connectionsProvider.provide],
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

  constructor(clients: McpClient[]) {
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
}
