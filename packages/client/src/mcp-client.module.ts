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
import { formatErrorMessage } from './utils/format-error-message';

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS dynamic modules require a class for @Module() decorator and module self-reference
export class McpClientModule {
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
      useFactory: (opts: McpClientModuleOptions) =>
        opts.connections.map((conn) => new McpClient(conn.name, conn)),
      inject: [MCP_CLIENT_OPTIONS],
    };

    const bootstrapProvider = {
      provide: McpClientBootstrap,
      useFactory: (clients: McpClient[]) => new McpClientBootstrap(clients),
      inject: ['MCP_CLIENT_CONNECTIONS'],
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

  constructor(private readonly clients: McpClient[]) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const client of this.clients) {
      try {
        await client.connect();
      } catch (err: unknown) {
        this.logger.error(`Failed to connect client "${client.name}": ${formatErrorMessage(err)}`);
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    for (const client of this.clients) {
      try {
        await client.disconnect();
      } catch (err: unknown) {
        this.logger.error(
          `Failed to disconnect client "${client.name}": ${formatErrorMessage(err)}`,
        );
      }
    }
  }
}
