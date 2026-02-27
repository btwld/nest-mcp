import type { McpTransportType } from './mcp-transport.interface';
import type { ToolContent } from './mcp-tool.interface';
import type { ElicitRequest, ElicitResult } from './mcp-elicitation.interface';

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
  /** Emit incremental content chunks during tool execution (FastMCP streaming extension). */
  streamContent?: (content: ToolContent | ToolContent[]) => Promise<void>;
  /** Ask the user for input during tool execution via the elicitation protocol. */
  elicit?: (params: ElicitRequest, options?: { signal?: AbortSignal }) => Promise<ElicitResult>;
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
