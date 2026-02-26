import { MCP_UPSTREAM_ERROR } from '../constants/error-codes';
import { McpError } from './mcp-error';

export class McpUpstreamError extends McpError {
  readonly upstreamName: string;
  readonly originalError?: Error;

  constructor(upstreamName: string, message: string, originalError?: Error) {
    super(
      `Upstream '${upstreamName}' error: ${message}`,
      MCP_UPSTREAM_ERROR,
      { upstreamName },
      true,
    );
    this.name = 'McpUpstreamError';
    this.upstreamName = upstreamName;
    this.originalError = originalError;
  }
}
