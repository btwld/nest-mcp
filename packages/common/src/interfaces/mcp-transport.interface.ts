export enum McpTransportType {
  STREAMABLE_HTTP = 'streamable-http',
  SSE = 'sse',
  STDIO = 'stdio',
}

export interface StreamableHttpTransportOptions {
  endpoint?: string;
  stateless?: boolean;
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
