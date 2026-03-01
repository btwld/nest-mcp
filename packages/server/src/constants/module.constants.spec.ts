import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLEANUP_INTERVAL,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  DEFAULT_MCP_ENDPOINT,
  DEFAULT_PING_INTERVAL,
  DEFAULT_SERVER_MODULE_ID,
  DEFAULT_SESSION_TIMEOUT,
  DEFAULT_SSE_ENDPOINT,
  DEFAULT_SSE_MESSAGES_ENDPOINT,
} from './module.constants';

describe('module constants', () => {
  it('DEFAULT_MCP_ENDPOINT is /mcp', () => {
    expect(DEFAULT_MCP_ENDPOINT).toBe('/mcp');
  });

  it('DEFAULT_SSE_ENDPOINT is /sse', () => {
    expect(DEFAULT_SSE_ENDPOINT).toBe('/sse');
  });

  it('DEFAULT_SSE_MESSAGES_ENDPOINT is /messages', () => {
    expect(DEFAULT_SSE_MESSAGES_ENDPOINT).toBe('/messages');
  });

  it('DEFAULT_PING_INTERVAL is 30000ms', () => {
    expect(DEFAULT_PING_INTERVAL).toBe(30000);
  });

  it('DEFAULT_SESSION_TIMEOUT is 30 minutes in ms', () => {
    expect(DEFAULT_SESSION_TIMEOUT).toBe(30 * 60 * 1000);
  });

  it('DEFAULT_MAX_CONCURRENT_SESSIONS is 1000', () => {
    expect(DEFAULT_MAX_CONCURRENT_SESSIONS).toBe(1000);
  });

  it('DEFAULT_CLEANUP_INTERVAL is 5 minutes in ms', () => {
    expect(DEFAULT_CLEANUP_INTERVAL).toBe(5 * 60 * 1000);
  });

  it('DEFAULT_SERVER_MODULE_ID is "default"', () => {
    expect(DEFAULT_SERVER_MODULE_ID).toBe('default');
  });

  it('all endpoint constants start with /', () => {
    expect(DEFAULT_MCP_ENDPOINT.startsWith('/')).toBe(true);
    expect(DEFAULT_SSE_ENDPOINT.startsWith('/')).toBe(true);
    expect(DEFAULT_SSE_MESSAGES_ENDPOINT.startsWith('/')).toBe(true);
  });
});
