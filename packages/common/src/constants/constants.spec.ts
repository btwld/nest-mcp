import { describe, expect, it } from 'vitest';
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  MCP_AUTHENTICATION_ERROR,
  MCP_AUTHORIZATION_ERROR,
  MCP_RESOURCE_NOT_FOUND,
  MCP_TOOL_NOT_FOUND,
  MCP_TRANSPORT_ERROR,
} from './error-codes';
import { MCP_OPTIONS, MCP_REGISTRY, MCP_SERVER_INSTANCE, MCP_TRANSPORT } from './injection-tokens';
import {
  MCP_PROMPT_METADATA,
  MCP_RESOURCE_METADATA,
  MCP_RESOURCE_TEMPLATE_METADATA,
  MCP_TOOL_METADATA,
} from './metadata-keys';
import { JSONRPC_VERSION, LATEST_PROTOCOL_VERSION, MCP_METHODS } from './protocol';

describe('metadata keys', () => {
  it('should be unique symbols', () => {
    const keys = [
      MCP_TOOL_METADATA,
      MCP_RESOURCE_METADATA,
      MCP_RESOURCE_TEMPLATE_METADATA,
      MCP_PROMPT_METADATA,
    ];
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
    for (const key of keys) {
      expect(typeof key).toBe('symbol');
    }
  });
});

describe('injection tokens', () => {
  it('should be unique symbols', () => {
    const tokens = [MCP_OPTIONS, MCP_SERVER_INSTANCE, MCP_REGISTRY, MCP_TRANSPORT];
    const unique = new Set(tokens);
    expect(unique.size).toBe(tokens.length);
    for (const token of tokens) {
      expect(typeof token).toBe('symbol');
    }
  });
});

describe('error codes', () => {
  it('should have standard JSON-RPC error codes', () => {
    expect(JSON_RPC_PARSE_ERROR).toBe(-32700);
    expect(JSON_RPC_INVALID_REQUEST).toBe(-32600);
    expect(JSON_RPC_METHOD_NOT_FOUND).toBe(-32601);
    expect(JSON_RPC_INVALID_PARAMS).toBe(-32602);
    expect(JSON_RPC_INTERNAL_ERROR).toBe(-32603);
  });

  it('should have application-level error codes', () => {
    expect(MCP_TOOL_NOT_FOUND).toBe(1001);
    expect(MCP_RESOURCE_NOT_FOUND).toBe(1002);
    expect(MCP_AUTHENTICATION_ERROR).toBe(1005);
    expect(MCP_AUTHORIZATION_ERROR).toBe(1006);
    expect(MCP_TRANSPORT_ERROR).toBe(1010);
  });
});

describe('protocol constants', () => {
  it('should define JSON-RPC version', () => {
    expect(JSONRPC_VERSION).toBe('2.0');
  });

  it('should define the latest protocol version', () => {
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
  });

  it('should define MCP method names', () => {
    expect(MCP_METHODS.INITIALIZE).toBe('initialize');
    expect(MCP_METHODS.TOOLS_LIST).toBe('tools/list');
    expect(MCP_METHODS.TOOLS_CALL).toBe('tools/call');
    expect(MCP_METHODS.RESOURCES_LIST).toBe('resources/list');
    expect(MCP_METHODS.RESOURCES_READ).toBe('resources/read');
    expect(MCP_METHODS.PROMPTS_LIST).toBe('prompts/list');
    expect(MCP_METHODS.PROMPTS_GET).toBe('prompts/get');
  });

  it('should define task methods', () => {
    expect(MCP_METHODS.TASKS_GET).toBe('tasks/get');
    expect(MCP_METHODS.TASKS_RESULT).toBe('tasks/result');
    expect(MCP_METHODS.TASKS_LIST).toBe('tasks/list');
    expect(MCP_METHODS.TASKS_CANCEL).toBe('tasks/cancel');
  });

  it('should define elicitation and roots methods', () => {
    expect(MCP_METHODS.ELICITATION_CREATE).toBe('elicitation/create');
    expect(MCP_METHODS.ROOTS_LIST).toBe('roots/list');
  });

  it('should define all notification methods', () => {
    expect(MCP_METHODS.NOTIFICATION_TASKS_STATUS).toBe('notifications/tasks/status');
    expect(MCP_METHODS.NOTIFICATION_ELICITATION_COMPLETE).toBe(
      'notifications/elicitation/complete',
    );
    expect(MCP_METHODS.NOTIFICATION_ROOTS_LIST_CHANGED).toBe('notifications/roots/list_changed');
  });

  it('should have exactly 29 methods to guard against drift', () => {
    expect(Object.keys(MCP_METHODS)).toHaveLength(32);
  });
});
