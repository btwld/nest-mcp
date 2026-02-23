import { JSON_RPC_INTERNAL_ERROR } from '../constants/error-codes';
import { McpError } from './mcp-error';

export class ToolExecutionError extends McpError {
  readonly toolName: string;
  readonly originalError?: Error;

  constructor(toolName: string, message: string, originalError?: Error) {
    super(`Tool '${toolName}' execution failed: ${message}`, JSON_RPC_INTERNAL_ERROR);
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
    this.originalError = originalError;
  }
}
