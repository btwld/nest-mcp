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

export interface StdioTransportOptions {
  // stdio doesn't need additional config for server-side
}

export interface TransportOptions {
  streamableHttp?: StreamableHttpTransportOptions;
  sse?: SseTransportOptions;
  stdio?: StdioTransportOptions;
}
