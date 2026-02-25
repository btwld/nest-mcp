import type { InjectionToken, ModuleMetadata } from '@nestjs/common';

export type McpClientTransportType = 'streamable-http' | 'sse' | 'stdio';

export interface McpClientReconnectOptions {
  maxAttempts?: number;
  delay?: number;
}

export interface McpClientAuthOptions {
  type: 'bearer';
  token: string;
}

interface McpClientConnectionBase {
  name: string;
  reconnect?: McpClientReconnectOptions;
}

export interface McpClientStreamableHttpConnection extends McpClientConnectionBase {
  transport: 'streamable-http';
  url: string;
  auth?: McpClientAuthOptions;
  requestInit?: RequestInit;
}

export interface McpClientSseConnection extends McpClientConnectionBase {
  transport: 'sse';
  url: string;
  auth?: McpClientAuthOptions;
  requestInit?: RequestInit;
}

export interface McpClientStdioConnection extends McpClientConnectionBase {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type McpClientConnection =
  | McpClientStreamableHttpConnection
  | McpClientSseConnection
  | McpClientStdioConnection;

export interface McpClientModuleOptions {
  connections: McpClientConnection[];
}

export interface McpClientModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  // biome-ignore lint/suspicious/noExplicitAny: NestJS factory pattern requires broad parameter types
  useFactory: (...args: any[]) => McpClientModuleOptions | Promise<McpClientModuleOptions>;
  // biome-ignore lint/suspicious/noExplicitAny: NestJS injection tokens have broad types
  inject?: any[];
  /**
   * Declare connection names to enable @InjectMcpClient('name') with forRootAsync.
   * Each name listed here creates a named provider that extracts the matching
   * client from the connections array returned by useFactory.
   */
  connectionNames?: string[];
}
