import { MCP_AUTHENTICATION_ERROR, MCP_AUTHORIZATION_ERROR } from '../constants/error-codes';
import { McpError } from './mcp-error';

export class AuthenticationError extends McpError {
  constructor(message = 'Authentication required') {
    super(message, MCP_AUTHENTICATION_ERROR);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends McpError {
  constructor(message = 'Insufficient permissions') {
    super(message, MCP_AUTHORIZATION_ERROR);
    this.name = 'AuthorizationError';
  }
}
