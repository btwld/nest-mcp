export type UpstreamTransportType = 'streamable-http' | 'sse' | 'stdio';

export interface UpstreamConfig {
  name: string;
  url: string;
  transport: UpstreamTransportType;
  toolPrefix?: string;
  enabled?: boolean;
  healthCheck?: {
    enabled?: boolean;
    intervalMs?: number;
    timeoutMs?: number;
  };
  reconnect?: {
    enabled?: boolean;
    maxRetries?: number;
    delayMs?: number;
  };
}

export interface UpstreamStatus {
  name: string;
  connected: boolean;
  healthy: boolean;
  lastHealthCheck?: Date;
  toolCount: number;
  error?: string;
}
