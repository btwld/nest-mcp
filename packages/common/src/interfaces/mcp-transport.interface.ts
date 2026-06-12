export enum McpTransportType {
  STREAMABLE_HTTP = 'streamable-http',
  SSE = 'sse',
  STDIO = 'stdio',
}

/**
 * Structural mirror of the MCP SDK `EventStore` for resumability support.
 *
 * `@nest-mcp/common` does not depend on `@modelcontextprotocol/sdk`, so we
 * declare a structurally-compatible interface here. TypeScript structural
 * typing ensures the SDK's concrete `EventStore` is assignable to this type.
 *
 * If you need the original SDK type, import `EventStore` directly from
 * `@modelcontextprotocol/sdk/server/streamableHttp.js` or from `@nest-mcp/server`.
 */
export interface McpEventStore {
  storeEvent(streamId: string, message: unknown): Promise<string>;
  getStreamIdForEventId?(eventId: string): Promise<string | undefined>;
  replayEventsAfter(
    lastEventId: string,
    opts: { send: (eventId: string, message: unknown) => Promise<void> },
  ): Promise<string>;
}

export interface StreamableHttpTransportOptions {
  endpoint?: string;
  stateless?: boolean;
  /** Custom session-ID generator. Ignored when `stateless` is true. */
  sessionIdGenerator?: () => string;
  /** When true, the server responds with JSON instead of SSE streams. */
  enableJsonResponse?: boolean;
  /** Event store for resumability support (reconnection after disconnect). */
  eventStore?: McpEventStore;
  /** Called when a new session is initialized. */
  onsessioninitialized?: (sessionId: string) => void | Promise<void>;
  /** Called when a session is closed. */
  onsessionclosed?: (sessionId: string) => void | Promise<void>;
  /** Retry interval in milliseconds for SSE streams. */
  retryInterval?: number;
  /** Hostnames allowed by the SDK transport's DNS-rebinding protection. */
  allowedHosts?: string[];
  /** Origins allowed by the SDK transport's DNS-rebinding protection. */
  allowedOrigins?: string[];
  /** Enable the SDK transport's DNS-rebinding protection (requires `allowedHosts` and/or `allowedOrigins`). */
  enableDnsRebindingProtection?: boolean;
  /**
   * Bearer-token gate for the streamable HTTP endpoint (applies
   * `McpBearerGuard` to the generated controller). Inactive unless `enabled`
   * is true, so existing deployments are unaffected. Verifier, challenge
   * metadata, and the optional-auth mode are configured on
   * `McpAuthModule.forRoot(...)`.
   */
  oauth?: {
    enabled: boolean;
    /** Bind each session to the principal that initialized it. Default true. */
    bindSessionToUser?: boolean;
  };
  /** NestJS guards applied to the generated streamable HTTP controller. */
  controllerGuards?: unknown[];
  /** Class decorators applied to the generated streamable HTTP controller. */
  controllerDecorators?: ClassDecorator[];
}

export interface SseTransportOptions {
  endpoint?: string;
  messagesEndpoint?: string;
  pingInterval?: number;
  /**
   * Bearer-token gate for the SSE endpoints (applies `McpBearerGuard` to the
   * generated controllers). Configuration lives on `McpAuthModule.forRoot(...)`.
   */
  oauth?: {
    enabled: boolean;
  };
}

// biome-ignore lint/complexity/noBannedTypes: empty options interface for future extensibility
export type StdioTransportOptions = {};

export interface TransportOptions {
  streamableHttp?: StreamableHttpTransportOptions;
  sse?: SseTransportOptions;
  stdio?: StdioTransportOptions;
}
