import { MCP_TRANSPORT_ERROR } from '../constants/error-codes';
import { McpError } from './mcp-error';

export class TransportError extends McpError {
  readonly transportType: string;

  constructor(transportType: string, message: string) {
    super(`Transport error (${transportType}): ${message}`, MCP_TRANSPORT_ERROR);
    this.name = 'TransportError';
    this.transportType = transportType;
  }
}
