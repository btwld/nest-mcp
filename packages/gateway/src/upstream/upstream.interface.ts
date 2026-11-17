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
  /**
   * Automatic reconnection when the upstream connection closes, the initial
   * connection fails, or a health check fails. Disabled unless `enabled` is
   * `true`.
   */
  reconnect?: {
    enabled?: boolean;
    /** Attempts per reconnect cycle (default 5). */
    maxRetries?: number;
    /** Delay before the first attempt; doubles per attempt, capped at 30 s (default 1000). */
    delayMs?: number;
  };
}

/** Upstream list that can change at runtime. `resources` covers resource templates too. */
export type UpstreamListKind = 'tools' | 'resources' | 'prompts';

/** Emitted by `UpstreamManagerService.onUpstreamChange`. */
export interface UpstreamChangeEvent {
  upstreamName: string;
  /** Lists that may have changed (all of them after a reconnect). */
  kinds: UpstreamListKind[];
  /** `list_changed`: the upstream sent `notifications/<kind>/list_changed`; `reconnected`: the connection was re-established. */
  reason: 'list_changed' | 'reconnected';
}

export type UpstreamChangeListener = (event: UpstreamChangeEvent) => void;

export interface UpstreamStatus {
  name: string;
  connected: boolean;
  healthy: boolean;
  lastHealthCheck?: Date;
  toolCount: number;
  error?: string;
}
