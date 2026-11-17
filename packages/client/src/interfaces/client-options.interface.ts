import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StreamableHTTPReconnectionOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  ClientCapabilities,
  ClientNotification,
  ClientRequest,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
  Implementation,
  ListRootsResult,
  Notification as McpNotification,
  Request as McpRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { InjectionToken, ModuleMetadata } from '@nestjs/common';

export type McpClientTransportType = 'streamable-http' | 'sse' | 'stdio';

/**
 * Per-request context the SDK passes to server-to-client request handlers: the abort `signal`
 * (fired when the server cancels the request), `requestId`, `_meta`, and `sendNotification` /
 * `sendRequest` for messages related to the request being handled.
 */
export type McpClientRequestHandlerExtra = RequestHandlerExtra<
  ClientRequest | McpRequest,
  ClientNotification | McpNotification
>;

export type McpSamplingHandler = (
  request: CreateMessageRequest,
  extra?: McpClientRequestHandlerExtra,
) => CreateMessageResult | Promise<CreateMessageResult>;

export type McpElicitationHandler = (
  params: ElicitRequestFormParams | ElicitRequestURLParams,
  extra?: McpClientRequestHandlerExtra,
) => ElicitResult | Promise<ElicitResult>;

export type McpRootsHandler = (
  extra?: McpClientRequestHandlerExtra,
) => ListRootsResult | Promise<ListRootsResult>;

/** Elicitation modes a client can declare support for. */
export type McpElicitationMode = 'form' | 'url';

export interface McpElicitationHandlerOptions {
  /**
   * Elicitation modes to advertise in the `elicitation` capability.
   * Omitted or empty: form mode only (declared as `elicitation: {}`, the backward-compatible form).
   * `['form', 'url']` declares `{ form: {}, url: {} }`; `['url']` declares URL mode only.
   */
  modes?: McpElicitationMode[];
}

/**
 * `clientInfo` sent in the `initialize` request. Every field is optional; `name` defaults to
 * `nestjs-mcp-client-<connection name>` and `version` to `1.0.0`.
 */
export type McpClientInfo = Partial<Implementation>;

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
  /**
   * Timeout in milliseconds for the `initialize` handshake performed by `connect()` and by each
   * reconnection attempt. Defaults to the SDK request timeout (60 seconds).
   */
  connectTimeout?: number;
  reconnect?: McpClientReconnectOptions;
  /**
   * Identity sent as `clientInfo` in the `initialize` request.
   * Defaults to `{ name: 'nestjs-mcp-client-<connection name>', version: '1.0.0' }`.
   */
  clientInfo?: McpClientInfo;
  /**
   * Client capabilities to advertise during the MCP initialization handshake.
   * Merged per key with the capabilities implicitly declared by setSamplingHandler /
   * setElicitationHandler / setRootsHandler; values set here win over those defaults.
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
   * Elicitation modes declared for `elicitationHandler`. Defaults to form mode only.
   * Include `'url'` to accept URL-mode elicitation requests.
   */
  elicitationModes?: McpElicitationMode[];
  /**
   * Register a handler for server-to-client `roots/list` requests.
   * Setting this automatically declares the `roots` client capability.
   */
  rootsHandler?: McpRootsHandler;
}

export interface McpClientHttpConnectionBase extends McpClientConnectionBase {
  url: string;
  /**
   * Static bearer token sent as the `Authorization` header on every request.
   * Do not combine with `authProvider`: this header overrides the OAuth access token.
   */
  auth?: McpClientAuthOptions;
  authProvider?: OAuthClientProvider;
  requestInit?: RequestInit;
  /** Custom `fetch` implementation the transport uses for its HTTP requests. */
  fetch?: FetchLike;
}

export interface McpClientStreamableHttpConnection extends McpClientHttpConnectionBase {
  transport: 'streamable-http';
  /**
   * How the transport itself re-opens dropped SSE streams (the GET stream and resumable request
   * streams). Independent of the client-level `reconnect` option.
   */
  reconnectionOptions?: StreamableHTTPReconnectionOptions;
  /**
   * Resume an existing session instead of starting a new one. When set, the SDK skips the
   * `initialize` handshake on the first connect, so server capabilities, server version and
   * instructions are not available. Only used for the first connect; reconnections always
   * start a new session.
   */
  sessionId?: string;
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
  /**
   * How the child process's stderr is handled. The SDK default is `'inherit'`. Use `'pipe'` to
   * read it from the transport's `stderr` stream, or `'ignore'` to discard it.
   */
  stderr?: StdioServerParameters['stderr'];
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
