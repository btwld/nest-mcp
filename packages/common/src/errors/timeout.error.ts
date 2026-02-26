import { MCP_TIMEOUT_ERROR } from '../constants/error-codes';
import { McpError } from './mcp-error';

export class McpTimeoutError extends McpError {
  readonly operationName: string;
  readonly timeoutMs: number;

  constructor(operationName: string, timeoutMs: number) {
    super(
      `Operation '${operationName}' timed out after ${timeoutMs}ms`,
      MCP_TIMEOUT_ERROR,
      { operationName, timeoutMs },
      true,
    );
    this.name = 'McpTimeoutError';
    this.operationName = operationName;
    this.timeoutMs = timeoutMs;
  }
}
