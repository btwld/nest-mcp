import { describe, expect, it } from 'vitest';
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  MCP_AUTHENTICATION_ERROR,
  MCP_AUTHORIZATION_ERROR,
  MCP_TIMEOUT_ERROR,
  MCP_TRANSPORT_ERROR,
  MCP_UPSTREAM_ERROR,
} from '../constants/error-codes';
import { AuthenticationError, AuthorizationError } from './auth.error';
import { McpError } from './mcp-error';
import { McpTimeoutError } from './timeout.error';
import { ToolExecutionError } from './tool-execution.error';
import { TransportError } from './transport.error';
import { McpUpstreamError } from './upstream.error';
import { ValidationError } from './validation.error';

describe('McpError', () => {
  it('should create an error with message and default code', () => {
    const error = new McpError('Something went wrong');
    expect(error.message).toBe('Something went wrong');
    expect(error.code).toBe(JSON_RPC_INTERNAL_ERROR);
    expect(error.data).toBeUndefined();
    expect(error.isRetriable).toBe(false);
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

describe('McpTimeoutError', () => {
  it('should format message with operation name and timeout', () => {
    const error = new McpTimeoutError('get-weather', 5000);
    expect(error.message).toBe("Operation 'get-weather' timed out after 5000ms");
    expect(error.operationName).toBe('get-weather');
    expect(error.timeoutMs).toBe(5000);
    expect(error.code).toBe(MCP_TIMEOUT_ERROR);
    expect(error.name).toBe('McpTimeoutError');
  });

  it('should be retriable', () => {
    const error = new McpTimeoutError('op', 1000);
    expect(error.isRetriable).toBe(true);
  });

  it('should store operation details in data', () => {
    const error = new McpTimeoutError('my-tool', 3000);
    expect(error.data).toEqual({ operationName: 'my-tool', timeoutMs: 3000 });
  });

  it('should be an instance of McpError', () => {
    const error = new McpTimeoutError('op', 1000);
    expect(error).toBeInstanceOf(McpError);
  });
});

describe('McpUpstreamError', () => {
  it('should format message with upstream name', () => {
    const error = new McpUpstreamError('weather-api', 'connection refused');
    expect(error.message).toBe("Upstream 'weather-api' error: connection refused");
    expect(error.upstreamName).toBe('weather-api');
    expect(error.code).toBe(MCP_UPSTREAM_ERROR);
    expect(error.name).toBe('McpUpstreamError');
  });

  it('should be retriable', () => {
    const error = new McpUpstreamError('api', 'fail');
    expect(error.isRetriable).toBe(true);
  });

  it('should store the original error', () => {
    const original = new Error('root cause');
    const error = new McpUpstreamError('api', 'fail', original);
    expect(error.originalError).toBe(original);
  });

  it('should be an instance of McpError', () => {
    const error = new McpUpstreamError('api', 'fail');
    expect(error).toBeInstanceOf(McpError);
  });
});

describe('isRetriable', () => {
  it('defaults to false for base McpError', () => {
    expect(new McpError('test').isRetriable).toBe(false);
  });

  it('can be set to true via constructor', () => {
    const error = new McpError('test', -32603, undefined, true);
    expect(error.isRetriable).toBe(true);
  });

  it('is false for AuthenticationError', () => {
    expect(new AuthenticationError().isRetriable).toBe(false);
  });

  it('is false for AuthorizationError', () => {
    expect(new AuthorizationError().isRetriable).toBe(false);
  });

  it('is true for McpTimeoutError', () => {
    expect(new McpTimeoutError('op', 1000).isRetriable).toBe(true);
  });

  it('is true for McpUpstreamError', () => {
    expect(new McpUpstreamError('api', 'fail').isRetriable).toBe(true);
  });
});
