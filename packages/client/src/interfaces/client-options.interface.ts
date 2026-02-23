import type { ModuleMetadata } from '@nestjs/common';

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
  useFactory: (...args: any[]) => McpClientModuleOptions | Promise<McpClientModuleOptions>;
  inject?: any[];
}
