import type { ElicitRequest, ElicitResult } from './mcp-elicitation.interface';
import type { McpSamplingParams, McpSamplingResult } from './mcp-sampling.interface';
import type { ToolContent } from './mcp-tool.interface';
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
  /** Emit incremental content chunks during tool execution (FastMCP streaming extension). */
  streamContent?: (content: ToolContent | ToolContent[]) => Promise<void>;
  /** Ask the user for input during tool execution via the elicitation protocol. */
  elicit?: (params: ElicitRequest, options?: { signal?: AbortSignal }) => Promise<ElicitResult>;
  /**
   * Notify all clients that have subscribed to the given resource URI that
   * the resource has been updated. Sends `notifications/resources/updated`.
   * No-op when no clients are subscribed or when subscriptions are not enabled.
   */
  notifyResourceUpdated?: (uri: string) => Promise<void>;
  /**
   * Request LLM sampling from the connected downstream client.
   * Only available when the client declared the `sampling` capability.
   * Throws if the client does not support sampling.
   */
  createMessage?: (params: McpSamplingParams) => Promise<McpSamplingResult>;
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
