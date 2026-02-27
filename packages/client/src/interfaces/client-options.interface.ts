import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
  ListRootsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { InjectionToken, ModuleMetadata } from '@nestjs/common';

export type McpClientTransportType = 'streamable-http' | 'sse' | 'stdio';

export type McpSamplingHandler = (
  request: CreateMessageRequest,
) => CreateMessageResult | Promise<CreateMessageResult>;

export type McpElicitationHandler = (
  params: ElicitRequestFormParams | ElicitRequestURLParams,
) => ElicitResult | Promise<ElicitResult>;

export type McpRootsHandler = () => ListRootsResult | Promise<ListRootsResult>;

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
  /**
   * Client capabilities to advertise during the MCP initialization handshake.
   * Merged with any capabilities implicitly declared by setSamplingHandler / setElicitationHandler / setRootsHandler.
   */
  capabilities?: ClientCapabilities;
  /**
   * Register a handler for server-to-client `sampling/createMessage` requests.
   * Setting this automatically declares the `sampling` client capability.
   * Must be a stable reference (module-level function or class method) when used in forRoot options.
   */
  samplingHandler?: McpSamplingHandler;
  /**
   * Register a handler for server-to-client `elicitation/create` requests.
   * Setting this automatically declares the `elicitation` client capability.
   */
  elicitationHandler?: McpElicitationHandler;
  /**
   * Register a handler for server-to-client `roots/list` requests.
   * Setting this automatically declares the `roots` client capability.
   */
  rootsHandler?: McpRootsHandler;
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
