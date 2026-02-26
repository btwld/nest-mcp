export type UpstreamTransportType = 'streamable-http' | 'sse' | 'stdio';

export interface UpstreamConfig {
  name: string;
  transport: UpstreamTransportType;
  url?: string; // required for 'sse' | 'streamable-http'
  command?: string; // required for 'stdio'
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  toolPrefix?: string;
  timeout?: number;
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
