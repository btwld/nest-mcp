import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
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
  connectTimeout?: number;
  reconnect?: McpClientReconnectOptions;
}

export interface McpClientHttpConnectionBase extends McpClientConnectionBase {
  url: string;
  auth?: McpClientAuthOptions;
  authProvider?: OAuthClientProvider;
  requestInit?: RequestInit;
}

export interface McpClientStreamableHttpConnection extends McpClientHttpConnectionBase {
  transport: 'streamable-http';
}

export interface McpClientSseConnection extends McpClientHttpConnectionBase {
  transport: 'sse';
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
  // biome-ignore lint/suspicious/noExplicitAny: NestJS useFactory requires `any[]` params — TypeScript contravariance prevents narrowing factory parameter types
  useFactory: (...args: any[]) => McpClientModuleOptions | Promise<McpClientModuleOptions>;
  inject?: InjectionToken[];
  /**
   * Declare connection names to enable @InjectMcpClient('name') with forRootAsync.
   * Each name listed here creates a named provider that extracts the matching
   * client from the connections array returned by useFactory.
   */
  connectionNames?: string[];
}
