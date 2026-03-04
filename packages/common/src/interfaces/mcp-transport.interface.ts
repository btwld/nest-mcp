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
}

export interface SseTransportOptions {
  endpoint?: string;
  messagesEndpoint?: string;
  pingInterval?: number;
}

// biome-ignore lint/complexity/noBannedTypes: empty options interface for future extensibility
export type StdioTransportOptions = {};

export interface TransportOptions {
  streamableHttp?: StreamableHttpTransportOptions;
  sse?: SseTransportOptions;
  stdio?: StdioTransportOptions;
}
