import type { McpTransportType } from './mcp-transport.interface';

export interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpExecutionContext {
  sessionId: string;
  transport: McpTransportType;
  reportProgress: (progress: McpProgress) => Promise<void>;
  log: McpContextLogger;
  request?: unknown;
  user?: McpAuthenticatedUser;
  metadata: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface McpContextLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface McpAuthenticatedUser {
  id: string;
  roles?: string[];
  scopes?: string[];
  [key: string]: unknown;
}
