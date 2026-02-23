import { describe, it, expect } from 'vitest';
import { McpError } from './mcp-error';
import { ToolExecutionError } from './tool-execution.error';
import { ValidationError } from './validation.error';
import { TransportError } from './transport.error';
import { AuthenticationError, AuthorizationError } from './auth.error';
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  MCP_TRANSPORT_ERROR,
  MCP_AUTHENTICATION_ERROR,
  MCP_AUTHORIZATION_ERROR,
} from '../constants/error-codes';

describe('McpError', () => {
  it('should create an error with message and default code', () => {
    const error = new McpError('Something went wrong');
    expect(error.message).toBe('Something went wrong');
    expect(error.code).toBe(JSON_RPC_INTERNAL_ERROR);
    expect(error.data).toBeUndefined();
    expect(error.name).toBe('McpError');
  });

  it('should create an error with custom code and data', () => {
    const error = new McpError('Bad request', -32600, { detail: 'missing field' });
    expect(error.code).toBe(-32600);
    expect(error.data).toEqual({ detail: 'missing field' });
  });

  it('should be an instance of Error', () => {
    const error = new McpError('test');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(McpError);
  });

  it('should convert to JSON-RPC error format without data', () => {
    const error = new McpError('fail', -32603);
    expect(error.toJsonRpcError()).toEqual({
      code: -32603,
      message: 'fail',
    });
  });

  it('should convert to JSON-RPC error format with data', () => {
    const error = new McpError('fail', -32603, { key: 'value' });
    expect(error.toJsonRpcError()).toEqual({
      code: -32603,
      message: 'fail',
      data: { key: 'value' },
    });
  });
});

describe('ToolExecutionError', () => {
  it('should format message with tool name', () => {
    const error = new ToolExecutionError('myTool', 'timeout');
    expect(error.message).toBe("Tool 'myTool' execution failed: timeout");
    expect(error.toolName).toBe('myTool');
    expect(error.code).toBe(JSON_RPC_INTERNAL_ERROR);
    expect(error.name).toBe('ToolExecutionError');
  });

  it('should store the original error', () => {
    const original = new Error('root cause');
    const error = new ToolExecutionError('myTool', 'failed', original);
    expect(error.originalError).toBe(original);
  });

  it('should be an instance of McpError', () => {
    const error = new ToolExecutionError('t', 'm');
    expect(error).toBeInstanceOf(McpError);
  });
});

describe('ValidationError', () => {
  it('should create with message and default empty errors', () => {
    const error = new ValidationError('Invalid input');
    expect(error.message).toBe('Invalid input');
    expect(error.code).toBe(JSON_RPC_INVALID_PARAMS);
    expect(error.validationErrors).toEqual([]);
    expect(error.name).toBe('ValidationError');
  });

  it('should store validation details', () => {
    const details = [{ path: 'name', message: 'required' }];
    const error = new ValidationError('Validation failed', details);
    expect(error.validationErrors).toEqual(details);
    expect(error.data).toEqual({ errors: details });
  });

  it('should be an instance of McpError', () => {
    const error = new ValidationError('test');
    expect(error).toBeInstanceOf(McpError);
  });
});

describe('TransportError', () => {
  it('should format message with transport type', () => {
    const error = new TransportError('sse', 'connection lost');
    expect(error.message).toBe('Transport error (sse): connection lost');
    expect(error.transportType).toBe('sse');
    expect(error.code).toBe(MCP_TRANSPORT_ERROR);
    expect(error.name).toBe('TransportError');
  });

  it('should be an instance of McpError', () => {
    const error = new TransportError('ws', 'fail');
    expect(error).toBeInstanceOf(McpError);
  });
});

describe('AuthenticationError', () => {
  it('should use default message', () => {
    const error = new AuthenticationError();
    expect(error.message).toBe('Authentication required');
    expect(error.code).toBe(MCP_AUTHENTICATION_ERROR);
    expect(error.name).toBe('AuthenticationError');
  });

  it('should accept custom message', () => {
    const error = new AuthenticationError('Token expired');
    expect(error.message).toBe('Token expired');
  });

  it('should be an instance of McpError', () => {
    const error = new AuthenticationError();
    expect(error).toBeInstanceOf(McpError);
  });
});

describe('AuthorizationError', () => {
  it('should use default message', () => {
    const error = new AuthorizationError();
    expect(error.message).toBe('Insufficient permissions');
    expect(error.code).toBe(MCP_AUTHORIZATION_ERROR);
    expect(error.name).toBe('AuthorizationError');
  });

  it('should accept custom message', () => {
    const error = new AuthorizationError('Admin only');
    expect(error.message).toBe('Admin only');
  });

  it('should be an instance of McpError', () => {
    const error = new AuthorizationError();
    expect(error).toBeInstanceOf(McpError);
  });
});
